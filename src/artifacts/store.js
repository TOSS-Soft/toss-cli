import {randomUUID} from "node:crypto";
import {constants,readFileSync} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from "node:path";

import {
  assertKnownDocumentType,
  canonicalJson,
  sha256Canonical,
} from "../contracts/acp.js";
import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  ArtifactOverwriteError,
  ArtifactReferenceError,
  ArtifactStoreError,
  ArtifactValidationError,
} from "./errors.js";

const ARTIFACT_ROOT_PARTS=["project-management","artifacts"];
const ARTIFACT_ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const SHA256_PATTERN=/^[a-f0-9]{64}$/;
const MAX_REVISION=999999;
const REVISION_FILE_PATTERN=/^r(\d{6})-([a-f0-9]{64})\.json$/;
const REVISION_LIKE_FILE_PATTERN=/^r(\d+)-([a-f0-9]{64})\.json$/;
const TEMPORARY_FILE_PATTERN=/^\.r\d{6}-[a-f0-9]{64}\.json\.tmp-([1-9]\d*)-([A-Za-z0-9_-]+)-(\d+)$/;
const LOCK_FILE_NAME=".append.lock";
const LOCK_OWNER_TOKEN_PATTERN=/^[A-Za-z0-9_-]+$/;
const LOCK_RETRY_LIMIT=200;
const LOCK_RETRY_DELAY_MS=5;
const LOCK_INITIALIZING_GRACE_MS=1000;
const NO_FOLLOW=constants.O_NOFOLLOW ?? 0;

const registry=JSON.parse(readFileSync(
  new URL("../../contracts/registry.json",import.meta.url),
  "utf8",
));
const documentDefinitions=new Map(registry.documents.map(document => [
  `${document.document_type}\u0000${document.schema_version}`,
  document,
]));
const documentTypes=new Set(registry.documents.map(document => document.document_type));

function isPlainObject(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function describeReference(reference) {
  return `${reference.artifact_id}@${reference.revision}`;
}

function isExactReference(reference,artifact) {
  return reference.artifact_id===artifact.artifact_id &&
    reference.revision===artifact.revision &&
    reference.content_sha256===artifact.content_sha256 &&
    (reference.document_type===undefined ||
      reference.document_type===artifact.document_type);
}

function pathForDisplay(root,path) {
  return relative(root,path) || ".";
}

function sleep(milliseconds) {
  return new Promise(resolveSleep => setTimeout(resolveSleep,milliseconds));
}

function requireNonEmptyString(value,field) {
  if (typeof value!=="string" || value.length===0) {
    throw new ArtifactValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireArtifactId(value) {
  if (typeof value!=="string" || !ARTIFACT_ID_PATTERN.test(value)) {
    throw new ArtifactValidationError(
      "artifact_id must match ^[A-Za-z0-9][A-Za-z0-9:._-]*$",
    );
  }
  return value;
}

function artifactDirectoryName(artifactId) {
  return encodeURIComponent(requireArtifactId(artifactId));
}

function artifactIdentityFromDirectoryName(name) {
  if (ARTIFACT_ID_PATTERN.test(name) && name.includes(":")) {
    return {artifactId:name,legacy:true};
  }
  let artifactId;
  try {
    artifactId=decodeURIComponent(name);
  } catch (error) {
    throw new ArtifactIntegrityError(
      `Artifact directory name is not a reversible encoded identity: ${name}`,
      {cause:error},
    );
  }
  if (!ARTIFACT_ID_PATTERN.test(artifactId) ||
      encodeURIComponent(artifactId)!==name) {
    throw new ArtifactIntegrityError(
      `Artifact directory name is not a canonical encoded identity: ${name}`,
    );
  }
  return {artifactId,legacy:false};
}

function requireRevision(value,field="revision") {
  if (!Number.isSafeInteger(value) || value<1) {
    throw new ArtifactValidationError(`${field} must be a positive integer`);
  }
  if (value>MAX_REVISION) {
    throw new ArtifactValidationError(
      `${field} exceeds maximum revision ${MAX_REVISION}`,
    );
  }
  return value;
}

function requireHash(value,field) {
  if (typeof value!=="string" || !SHA256_PATTERN.test(value)) {
    throw new ArtifactValidationError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function normalizeReference(reference,kind="artifact") {
  if (!isPlainObject(reference)) {
    throw new ArtifactValidationError(`${kind} reference must be an object`);
  }
  const normalized={
    artifact_id:requireArtifactId(reference.artifact_id),
    revision:requireRevision(reference.revision,`${kind} reference revision`),
    content_sha256:requireHash(
      reference.content_sha256,
      `${kind} reference content_sha256`,
    ),
  };
  if (reference.document_type!==undefined) {
    normalized.document_type=requireNonEmptyString(
      reference.document_type,
      `${kind} reference document_type`,
    );
  }
  return normalized;
}

function normalizeReferenceList(value,kind) {
  if (!Array.isArray(value)) {
    throw new ArtifactValidationError(`${kind} must be an array`);
  }
  return value.map(reference => normalizeReference(reference,kind.slice(0,-1)));
}

function isoTimestamp(value) {
  const date=value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new ArtifactValidationError("now must produce a valid timestamp");
  }
  return date.toISOString();
}

function calculateContentHash(content) {
  try {
    return sha256Canonical(content);
  } catch (error) {
    throw new ArtifactValidationError("content must be canonical JSON",{cause:error});
  }
}

function findDocumentDefinition(documentType,schemaVersion) {
  try {
    assertKnownDocumentType(documentType,schemaVersion);
  } catch (error) {
    throw new ArtifactValidationError(error.message,{cause:error});
  }
  return documentDefinitions.get(`${documentType}\u0000${schemaVersion}`);
}

function assertCanonicalArtifact(record) {
  try {
    canonicalJson(record);
  } catch (error) {
    throw new ArtifactValidationError("artifact must be canonical JSON",{cause:error});
  }
}

function assertCoreArtifact(record,{requireRevision:mustHaveRevision,now}={}) {
  if (!isPlainObject(record)) {
    throw new ArtifactValidationError("artifact must be an object");
  }
  requireNonEmptyString(record.schema_version,"schema_version");
  requireNonEmptyString(record.document_type,"document_type");
  const definition=findDocumentDefinition(record.document_type,record.schema_version);
  requireArtifactId(record.artifact_id);
  if (mustHaveRevision || record.revision!==undefined) {
    requireRevision(record.revision);
  }
  requireNonEmptyString(record.run_id,"run_id");
  if (!isPlainObject(record.producer)) {
    throw new ArtifactValidationError("producer must be an object");
  }
  const producerRole=requireNonEmptyString(record.producer.role,"producer.role");
  requireNonEmptyString(record.producer.identity,"producer.identity");
  if (producerRole!==definition.producer) {
    throw new ArtifactValidationError(
      `producer role ${producerRole} is not authorized for ${record.document_type}`,
    );
  }
  if (!isPlainObject(record.provenance)) {
    throw new ArtifactValidationError("provenance must be an object");
  }
  requireNonEmptyString(record.provenance.source_revision,"provenance.source_revision");
  requireHash(record.provenance.source_sha256,"provenance.source_sha256");
  if (!Array.isArray(record.provenance.locations) ||
      record.provenance.locations.length===0 ||
      record.provenance.locations.some(location =>
        typeof location!=="string" || location.length===0)) {
    throw new ArtifactValidationError(
      "provenance.locations must be a non-empty array of strings",
    );
  }
  if (record.created_at===undefined && now) {
    record.created_at=isoTimestamp(now());
  }
  requireNonEmptyString(record.created_at,"created_at");
  record.parents=normalizeReferenceList(record.parents,"parents");
  record.inputs=normalizeReferenceList(record.inputs,"inputs");
  const contentHash=calculateContentHash(record.content);
  if (record.content_sha256!==undefined && record.content_sha256!==contentHash) {
    throw new ArtifactIntegrityError("Content hash mismatch for artifact content");
  }
  record.content_sha256=contentHash;
  assertCanonicalArtifact(record);
  return record;
}

function artifactFileName(revision,contentSha256) {
  requireRevision(revision);
  return `r${String(revision).padStart(6,"0")}-${contentSha256}.json`;
}

function isWithin(root,path) {
  const pathRelative=relative(root,path);
  return pathRelative==="" || (!isAbsolute(pathRelative) &&
    pathRelative!==".." && !pathRelative.startsWith(`..${sep}`));
}

function sameFile(left,right) {
  return left.dev===right.dev && left.ino===right.ino;
}

async function lstatOptional(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code==="ENOENT") return undefined;
    throw error;
  }
}

function unexpectedEntry(path,detail) {
  return new ArtifactIntegrityError(`Unexpected artifact entry ${path}: ${detail}`);
}

async function prepareRoot(root) {
  const lexicalRoot=resolve(root);
  let rootEntry=await lstatOptional(lexicalRoot);
  if (!rootEntry) {
    await mkdir(lexicalRoot,{recursive:true});
    rootEntry=await lstat(lexicalRoot);
  }
  if (rootEntry.isSymbolicLink()) {
    throw new ArtifactIntegrityError("Artifact store root must not be a symbolic link");
  }
  if (!rootEntry.isDirectory()) {
    throw new ArtifactIntegrityError("Artifact store root must be a directory");
  }
  return {lexicalRoot,canonicalRoot:await realpath(lexicalRoot)};
}

async function assertSafeExistingPath(rootInfo,path,{kind,label}={}) {
  const absolute=resolve(path);
  const pathRelative=relative(rootInfo.lexicalRoot,absolute);
  if (!isWithin(rootInfo.lexicalRoot,absolute)) {
    throw new ArtifactIntegrityError(`Artifact path escapes store root: ${path}`);
  }
  let current=rootInfo.lexicalRoot;
  const components=pathRelative==="" ? [] : pathRelative.split(sep);
  const allComponents=[undefined,...components];
  for (let index=0;index<allComponents.length;index+=1) {
    if (index>0) current=join(current,allComponents[index]);
    const entry=await lstat(current);
    if (entry.isSymbolicLink()) {
      throw new ArtifactIntegrityError(
        `Artifact path contains a symbolic link: ${pathForDisplay(rootInfo.lexicalRoot,current)}`,
      );
    }
    const last=index===allComponents.length-1;
    if (!last && !entry.isDirectory()) {
      throw new ArtifactIntegrityError(
        `Artifact path component is not a directory: ${pathForDisplay(rootInfo.lexicalRoot,current)}`,
      );
    }
    if (last && kind==="directory" && !entry.isDirectory()) {
      throw new ArtifactIntegrityError(
        `${label ?? "Artifact path"} must be a directory: ${pathForDisplay(rootInfo.lexicalRoot,current)}`,
      );
    }
    if (last && kind==="file" && !entry.isFile()) {
      throw new ArtifactIntegrityError(
        `${label ?? "Artifact path"} must be a regular file: ${pathForDisplay(rootInfo.lexicalRoot,current)}`,
      );
    }
    const canonical=await realpath(current);
    if (!isWithin(rootInfo.canonicalRoot,canonical)) {
      throw new ArtifactIntegrityError(
        `Artifact path escapes store root: ${pathForDisplay(rootInfo.lexicalRoot,current)}`,
      );
    }
  }
  return lstat(path);
}

async function ensureContainedDirectory(rootInfo,parts) {
  let current=rootInfo.lexicalRoot;
  await assertSafeExistingPath(rootInfo,current,{kind:"directory",label:"Artifact store root"});
  for (const part of parts) {
    current=join(current,part);
    let entry=await lstatOptional(current);
    if (!entry) {
      try {
        await mkdir(current);
      } catch (error) {
        if (error.code!=="EEXIST") throw error;
      }
      entry=await lstat(current);
    }
    if (entry.isSymbolicLink()) {
      throw new ArtifactIntegrityError(
        `Artifact path contains a symbolic link: ${pathForDisplay(rootInfo.lexicalRoot,current)}`,
      );
    }
    if (!entry.isDirectory()) {
      throw new ArtifactIntegrityError(
        `Artifact path component is not a directory: ${pathForDisplay(rootInfo.lexicalRoot,current)}`,
      );
    }
    const canonical=await realpath(current);
    if (!isWithin(rootInfo.canonicalRoot,canonical)) {
      throw new ArtifactIntegrityError(
        `Artifact path escapes store root: ${pathForDisplay(rootInfo.lexicalRoot,current)}`,
      );
    }
  }
  return current;
}

async function artifactRootIfExists(rootInfo) {
  let current=rootInfo.lexicalRoot;
  await assertSafeExistingPath(rootInfo,current,{kind:"directory",label:"Artifact store root"});
  for (const part of ARTIFACT_ROOT_PARTS) {
    current=join(current,part);
    const entry=await lstatOptional(current);
    if (!entry) return undefined;
    if (entry.isSymbolicLink()) {
      throw new ArtifactIntegrityError(
        `Artifact path contains a symbolic link: ${pathForDisplay(rootInfo.lexicalRoot,current)}`,
      );
    }
    if (!entry.isDirectory()) {
      throw new ArtifactIntegrityError(
        `Artifact path component is not a directory: ${pathForDisplay(rootInfo.lexicalRoot,current)}`,
      );
    }
    const canonical=await realpath(current);
    if (!isWithin(rootInfo.canonicalRoot,canonical)) {
      throw new ArtifactIntegrityError(
        `Artifact path escapes store root: ${pathForDisplay(rootInfo.lexicalRoot,current)}`,
      );
    }
  }
  return current;
}

async function readRegularFileNoFollow(rootInfo,path,label) {
  const expected=await assertSafeExistingPath(rootInfo,path,{kind:"file",label});
  let handle;
  try {
    handle=await open(path,constants.O_RDONLY|NO_FOLLOW);
    const actual=await handle.stat();
    if (!actual.isFile() || !sameFile(expected,actual)) {
      throw new ArtifactIntegrityError(`${label ?? "Artifact path"} changed while opening`);
    }
    return {text:await handle.readFile({encoding:"utf8"}),stat:actual};
  } finally {
    if (handle) await handle.close();
  }
}

async function openNewRegularFile(rootInfo,path,label) {
  await assertSafeExistingPath(rootInfo,dirname(path),{
    kind:"directory",
    label:dirname(path),
  });
  const handle=await open(
    path,
    constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|NO_FOLLOW,
    0o600,
  );
  try {
    const expected=await lstat(path);
    const actual=await handle.stat();
    if (expected.isSymbolicLink() || !expected.isFile() || !sameFile(expected,actual)) {
      throw new ArtifactIntegrityError(`${label ?? "Artifact path"} changed while opening`);
    }
    return {handle,stat:actual};
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function safeReadDirectory(rootInfo,path,label) {
  const before=await assertSafeExistingPath(rootInfo,path,{kind:"directory",label});
  const entries=await readdir(path,{withFileTypes:true});
  const after=await assertSafeExistingPath(rootInfo,path,{kind:"directory",label});
  if (!sameFile(before,after)) {
    throw new ArtifactIntegrityError(`${label ?? "Artifact directory"} changed while reading`);
  }
  return entries.sort((left,right) => left.name.localeCompare(right.name));
}

async function secureFileExists(rootInfo,path) {
  await assertSafeExistingPath(rootInfo,dirname(path),{kind:"directory"});
  const entry=await lstatOptional(path);
  if (!entry) return false;
  await assertSafeExistingPath(rootInfo,path,{kind:"file"});
  return true;
}

async function unlinkIfSame(rootInfo,path,expected,label) {
  await assertSafeExistingPath(rootInfo,dirname(path),{kind:"directory",label});
  const actual=await lstatOptional(path);
  if (!actual) return false;
  if (actual.isSymbolicLink() || !actual.isFile()) {
    throw new ArtifactIntegrityError(`${label ?? "Artifact path"} is not a regular file`);
  }
  if (expected && !sameFile(actual,expected)) return false;
  await unlink(path);
  return true;
}

function temporaryOwnerFromName(name) {
  const match=TEMPORARY_FILE_PATTERN.exec(name);
  if (!match) return undefined;
  return {pid:Number(match[1])};
}

function isLiveProcess(pid) {
  try {
    process.kill(pid,0);
    return true;
  } catch (error) {
    if (error.code==="ESRCH") return false;
    return true;
  }
}

function isDirectorySyncUnsupported(error) {
  return process.platform==="win32" &&
    ["EINVAL","EISDIR","ENOTSUP","EPERM"].includes(error.code);
}

async function syncContainingDirectory(rootInfo,directory) {
  let handle;
  try {
    await assertSafeExistingPath(rootInfo,directory,{kind:"directory"});
    handle=await open(directory,constants.O_RDONLY|NO_FOLLOW);
    const directoryStat=await handle.stat();
    if (!directoryStat.isDirectory()) {
      throw new ArtifactIntegrityError("Artifact containing path is not a directory");
    }
    await handle.sync();
  } catch (error) {
    if (isDirectorySyncUnsupported(error)) return;
    if (error instanceof ArtifactStoreError) throw error;
    throw new ArtifactStoreError(
      `Could not sync artifact directory ${pathForDisplay(rootInfo.lexicalRoot,directory)}`,
      {cause:error},
    );
  } finally {
    if (handle) await handle.close();
  }
}

async function scanArtifactTree(rootInfo) {
  const artifactRoot=await artifactRootIfExists(rootInfo);
  if (!artifactRoot) return {artifactRoot:undefined,finalPaths:[],temporaryPaths:[]};

  const finalPaths=[];
  const temporaryPaths=[];
  for (const documentEntry of await safeReadDirectory(
    rootInfo,
    artifactRoot,
    "Artifact root",
  )) {
    const documentPath=join(artifactRoot,documentEntry.name);
    if (documentEntry.isSymbolicLink()) {
      throw unexpectedEntry(documentEntry.name,"symbolic links are forbidden");
    }
    if (documentEntry.name===LOCK_FILE_NAME) {
      if (!documentEntry.isFile()) {
        throw unexpectedEntry(documentEntry.name,"append lock must be a regular file");
      }
      await assertSafeExistingPath(rootInfo,documentPath,{kind:"file",label:"Append lock"});
      continue;
    }
    if (!documentEntry.isDirectory() || !documentTypes.has(documentEntry.name)) {
      throw unexpectedEntry(documentEntry.name,"expected a registered document type directory");
    }
    const identityDirectories=new Map();
    for (const artifactEntry of await safeReadDirectory(
      rootInfo,
      documentPath,
      `Document type ${documentEntry.name}`,
    )) {
      const artifactPath=join(documentPath,artifactEntry.name);
      if (artifactEntry.isSymbolicLink()) {
        throw unexpectedEntry(
          pathForDisplay(artifactRoot,artifactPath),
          "symbolic links are forbidden",
        );
      }
      if (!artifactEntry.isDirectory()) {
        throw unexpectedEntry(
          pathForDisplay(artifactRoot,artifactPath),
          "expected an artifact identity directory",
        );
      }
      const identity=artifactIdentityFromDirectoryName(artifactEntry.name);
      const existingDirectory=identityDirectories.get(identity.artifactId);
      if (existingDirectory!==undefined && existingDirectory!==artifactEntry.name) {
        throw new ArtifactIntegrityError(
          `Artifact identity ${identity.artifactId} has ambiguous raw and encoded directories`,
        );
      }
      identityDirectories.set(identity.artifactId,artifactEntry.name);
      for (const fileEntry of await safeReadDirectory(
        rootInfo,
        artifactPath,
        `Artifact ${artifactEntry.name}`,
      )) {
        const filePath=join(artifactPath,fileEntry.name);
        if (fileEntry.isSymbolicLink() || !fileEntry.isFile()) {
          throw unexpectedEntry(
            pathForDisplay(artifactRoot,filePath),
            "expected a regular artifact file",
          );
        }
        const revisionLikeMatch=REVISION_LIKE_FILE_PATTERN.exec(fileEntry.name);
        if (revisionLikeMatch && Number(revisionLikeMatch[1])>MAX_REVISION) {
          throw new ArtifactIntegrityError(
            `Artifact revision ${revisionLikeMatch[1]} exceeds maximum revision ${MAX_REVISION}`,
          );
        }
        if (REVISION_FILE_PATTERN.test(fileEntry.name)) {
          await assertSafeExistingPath(rootInfo,filePath,{kind:"file",label:"Artifact file"});
          finalPaths.push(filePath);
        } else if (TEMPORARY_FILE_PATTERN.test(fileEntry.name)) {
          await assertSafeExistingPath(rootInfo,filePath,{kind:"file",label:"Temporary artifact file"});
          temporaryPaths.push(filePath);
        } else {
          throw unexpectedEntry(
            pathForDisplay(artifactRoot,filePath),
            "unrecognized regular file",
          );
        }
      }
    }
  }
  return {
    artifactRoot,
    finalPaths:finalPaths.sort(),
    temporaryPaths:temporaryPaths.sort(),
  };
}

async function migrateLegacyArtifactDirectory(rootInfo,documentType,artifactId) {
  const encodedName=artifactDirectoryName(artifactId);
  if (encodedName===artifactId || process.platform==="win32") return;
  const parent=join(rootInfo.lexicalRoot,...ARTIFACT_ROOT_PARTS,documentType);
  const legacyPath=join(parent,artifactId);
  const encodedPath=join(parent,encodedName);
  const legacyStat=await lstatOptional(legacyPath);
  const encodedStat=await lstatOptional(encodedPath);
  if (legacyStat) {
    await assertSafeExistingPath(rootInfo,legacyPath,{
      kind:"directory",
      label:"Legacy artifact directory",
    });
  }
  if (encodedStat) {
    await assertSafeExistingPath(rootInfo,encodedPath,{
      kind:"directory",
      label:"Encoded artifact directory",
    });
  }
  if (legacyStat && encodedStat) {
    throw new ArtifactIntegrityError(
      `Artifact identity ${artifactId} has ambiguous raw and encoded directories`,
    );
  }
  if (!legacyStat) return;
  await rename(legacyPath,encodedPath);
  const migratedStat=await assertSafeExistingPath(rootInfo,encodedPath,{
    kind:"directory",
    label:"Migrated artifact directory",
  });
  if (!sameFile(legacyStat,migratedStat) || await lstatOptional(legacyPath)) {
    throw new ArtifactIntegrityError(
      `Artifact identity ${artifactId} legacy directory migration was not exact`,
    );
  }
  await syncContainingDirectory(rootInfo,parent);
}

export function createArtifactStore({root,now=() => new Date(),randomId=randomUUID}={}) {
  if (typeof root!=="string" || root.length===0) {
    throw new TypeError("createArtifactStore requires a root path");
  }
  if (typeof now!=="function" || typeof randomId!=="function") {
    throw new TypeError("createArtifactStore now and randomId must be functions");
  }

  let lockSequence=0;

  function nextLockOwner() {
    const token=String(randomId());
    if (!LOCK_OWNER_TOKEN_PATTERN.test(token)) {
      throw new ArtifactStoreError("randomId must produce a filesystem-safe temporary owner");
    }
    lockSequence+=1;
    return `${process.pid}-${lockSequence}-${token}`;
  }

  async function readArtifact(rootInfo,path) {
    let text;
    try {
      ({text}=await readRegularFileNoFollow(rootInfo,path,"Artifact file"));
    } catch (error) {
      if (error instanceof ArtifactIntegrityError) throw error;
      throw new ArtifactIntegrityError(
        `Corrupted artifact at ${pathForDisplay(rootInfo.lexicalRoot,path)}`,
        {cause:error},
      );
    }
    let value;
    try {
      value=JSON.parse(text);
    } catch (error) {
      throw new ArtifactIntegrityError(
        `Corrupted artifact at ${pathForDisplay(rootInfo.lexicalRoot,path)}`,
        {cause:error},
      );
    }
    try {
      assertCoreArtifact(value,{requireRevision:true});
    } catch (error) {
      if (error instanceof ArtifactIntegrityError) throw error;
      throw new ArtifactIntegrityError(
        `Invalid artifact at ${pathForDisplay(rootInfo.lexicalRoot,path)}: ${error.message}`,
        {cause:error},
      );
    }
    const fileMatch=REVISION_FILE_PATTERN.exec(basename(path));
    if (!fileMatch) {
      throw new ArtifactIntegrityError(
        `Artifact filename is invalid: ${pathForDisplay(rootInfo.lexicalRoot,path)}`,
      );
    }
    const [,revisionText,hashFromName]=fileMatch;
    if (Number(revisionText)!==value.revision || hashFromName!==value.content_sha256) {
      throw new ArtifactIntegrityError(
        `Artifact filename does not match content at ${pathForDisplay(rootInfo.lexicalRoot,path)}`,
      );
    }
    const directoryName=basename(dirname(path));
    const directoryIdentity=artifactIdentityFromDirectoryName(directoryName);
    if (directoryIdentity.artifactId!==value.artifact_id) {
      throw new ArtifactIntegrityError(
        `Artifact directory does not match content at ${
          pathForDisplay(rootInfo.lexicalRoot,path)}`,
      );
    }
    const expectedPath=join(
      rootInfo.lexicalRoot,
      ...ARTIFACT_ROOT_PARTS,
      value.document_type,
      directoryName,
      artifactFileName(value.revision,value.content_sha256),
    );
    if (resolve(path)!==resolve(expectedPath)) {
      throw new ArtifactIntegrityError(
        `Artifact path does not match its identity: ${pathForDisplay(rootInfo.lexicalRoot,path)}`,
      );
    }
    return value;
  }

  async function findArtifactByIdentity(rootInfo,reference) {
    const matches=[];
    for (const path of (await scanArtifactTree(rootInfo)).finalPaths) {
      const artifact=await readArtifact(rootInfo,path);
      if (artifact.artifact_id===reference.artifact_id &&
          artifact.revision===reference.revision &&
          (reference.document_type===undefined ||
            artifact.document_type===reference.document_type)) {
        matches.push({artifact,path});
      }
    }
    if (matches.length===0) {
      throw new ArtifactNotFoundError(`Artifact not found: ${describeReference(reference)}`);
    }
    if (matches.length>1) {
      throw new ArtifactIntegrityError(
        `Multiple artifacts share identity ${describeReference(reference)}`,
      );
    }
    return matches[0];
  }

  async function findArtifact(rootInfo,reference) {
    const normalized=normalizeReference(reference);
    const match=await findArtifactByIdentity(rootInfo,normalized);
    if (match.artifact.content_sha256!==normalized.content_sha256) {
      throw new ArtifactIntegrityError(
        `Content hash mismatch for ${describeReference(normalized)}`,
      );
    }
    return match;
  }

  async function assertPersistedLineage(rootInfo,artifact) {
    if (artifact.revision===1) {
      if (artifact.parents.length!==0) {
        throw new ArtifactIntegrityError("Revision 1 must have empty parents");
      }
      return;
    }
    let predecessor;
    try {
      predecessor=await findArtifactByIdentity(rootInfo,{
        artifact_id:artifact.artifact_id,
        revision:artifact.revision-1,
        document_type:artifact.document_type,
      });
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) {
        throw new ArtifactIntegrityError(
          `Revision ${artifact.revision} is missing the previous revision`,
          {cause:error},
        );
      }
      throw error;
    }
    if (artifact.parents.length!==1 ||
        !isExactReference(artifact.parents[0],predecessor.artifact)) {
      throw new ArtifactIntegrityError(
        `Revision ${artifact.revision} requires exactly one parent reference to the previous revision`,
      );
    }
  }

  async function verifyArtifact(rootInfo,artifact,visited) {
    const key=`${artifact.document_type}\u0000${artifact.artifact_id}\u0000${artifact.revision}`;
    if (visited.has(key)) {
      throw new ArtifactIntegrityError(`Cyclic artifact reference at ${key}`);
    }
    visited.add(key);
    try {
      await assertPersistedLineage(rootInfo,artifact);
      for (const [kind,references] of [["parent",artifact.parents],["input",artifact.inputs]]) {
        for (const reference of references) {
          try {
            const target=await findArtifact(rootInfo,reference);
            await verifyArtifact(rootInfo,target.artifact,visited);
          } catch (error) {
            if (error instanceof ArtifactNotFoundError) {
              throw new ArtifactReferenceError(
                `Missing ${kind} artifact ${describeReference(reference)}`,
                {cause:error},
              );
            }
            throw error;
          }
        }
      }
    } finally {
      visited.delete(key);
    }
  }

  async function verify(reference) {
    const rootInfo=await prepareRoot(root);
    const match=await findArtifact(rootInfo,reference);
    await verifyArtifact(rootInfo,match.artifact,new Set());
    return match.artifact;
  }

  async function get(reference) {
    return verify(reference);
  }

  async function artifactsForIdentity(rootInfo,documentType,artifactId) {
    const artifacts=[];
    for (const path of (await scanArtifactTree(rootInfo)).finalPaths) {
      const artifact=await readArtifact(rootInfo,path);
      if (artifact.document_type===documentType && artifact.artifact_id===artifactId) {
        await verifyArtifact(rootInfo,artifact,new Set());
        artifacts.push(artifact);
      }
    }
    return artifacts.sort((left,right) => left.revision-right.revision);
  }

  async function assertArtifactIdDocumentType(rootInfo,documentType,artifactId) {
    for (const path of (await scanArtifactTree(rootInfo)).finalPaths) {
      const artifact=await readArtifact(rootInfo,path);
      if (artifact.artifact_id===artifactId && artifact.document_type!==documentType) {
        throw new ArtifactValidationError(
          `artifact_id ${artifactId} is already bound to document type ${artifact.document_type}`,
        );
      }
    }
  }

  async function verifyDraftReferences(artifact) {
    for (const [kind,references] of [["parent",artifact.parents],["input",artifact.inputs]]) {
      for (const reference of references) {
        try {
          await verify(reference);
        } catch (error) {
          if (error instanceof ArtifactNotFoundError) {
            throw new ArtifactReferenceError(
              `Missing ${kind} artifact ${describeReference(reference)}`,
              {cause:error},
            );
          }
          throw error;
        }
      }
    }
  }

  function assertDraftLineage(artifact,predecessor) {
    if (!predecessor) {
      if (artifact.parents.length!==0) {
        throw new ArtifactReferenceError("Revision 1 must have empty parents");
      }
      return;
    }
    if (artifact.parents.length!==1 ||
        !isExactReference(artifact.parents[0],predecessor)) {
      throw new ArtifactReferenceError(
        `Revision ${artifact.revision} requires exactly one parent reference to the previous revision`,
      );
    }
  }

  function immutableEnvelopeEquivalent(existing,candidate,createdAtSupplied) {
    const comparable={
      ...candidate,
      revision:existing.revision,
      created_at:createdAtSupplied ? candidate.created_at : existing.created_at,
      content_sha256:existing.content_sha256,
    };
    return canonicalJson(comparable)===canonicalJson(existing);
  }

  async function readLockState(rootInfo,path) {
    let lock;
    try {
      lock=await readRegularFileNoFollow(rootInfo,path,"Append lock");
    } catch (error) {
      if (error.code==="ENOENT") return {state:"gone"};
      throw error;
    }
    let value;
    try {
      value=JSON.parse(lock.text);
    } catch (error) {
      if (Date.now()-lock.stat.mtimeMs<LOCK_INITIALIZING_GRACE_MS) {
        return {state:"initializing",stat:lock.stat};
      }
      throw new ArtifactIntegrityError("Append lock has invalid ownership metadata",{cause:error});
    }
    if (!isPlainObject(value) ||
        typeof value.owner!=="string" || !LOCK_OWNER_TOKEN_PATTERN.test(value.owner) ||
        !Number.isSafeInteger(value.pid) || value.pid<1 ||
        typeof value.created_at!=="string" || value.created_at.length===0) {
      throw new ArtifactIntegrityError("Append lock has invalid ownership metadata");
    }
    return {
      state:isLiveProcess(value.pid) ? "live" : "stale",
      stat:lock.stat,
      owner:value.owner,
      pid:value.pid,
    };
  }

  async function createStoreLock(rootInfo,owner) {
    const artifactRoot=await ensureContainedDirectory(rootInfo,ARTIFACT_ROOT_PARTS);
    const path=join(artifactRoot,LOCK_FILE_NAME);
    let created;
    try {
      created=await openNewRegularFile(rootInfo,path,"Append lock");
    } catch (error) {
      if (error.code==="EEXIST") return undefined;
      throw error;
    }
    const value={owner,pid:process.pid,created_at:isoTimestamp(now())};
    try {
      await created.handle.writeFile(JSON.stringify(value),"utf8");
      await created.handle.sync();
      return {path,handle:created.handle,stat:created.stat,owner};
    } catch (error) {
      await created.handle.close();
      await unlinkIfSame(rootInfo,path,created.stat,"Append lock");
      throw error;
    }
  }

  async function releaseStoreLock(rootInfo,lock) {
    await lock.handle.close();
    const removed=await unlinkIfSame(rootInfo,lock.path,lock.stat,"Append lock");
    if (!removed) {
      throw new ArtifactIntegrityError("Append lock ownership changed before release");
    }
  }

  async function acquireStoreLock(rootInfo,{wait=true}={}) {
    const owner=nextLockOwner();
    const lockPath=join(
      rootInfo.lexicalRoot,
      ...ARTIFACT_ROOT_PARTS,
      LOCK_FILE_NAME,
    );
    for (let attempt=0;attempt<LOCK_RETRY_LIMIT;attempt+=1) {
      const created=await createStoreLock(rootInfo,owner);
      if (created) return created;
      const state=await readLockState(rootInfo,lockPath);
      if (state.state==="gone") continue;
      if (state.state==="stale") {
        await unlinkIfSame(rootInfo,lockPath,state.stat,"Append lock");
        continue;
      }
      if (!wait) return undefined;
      await sleep(LOCK_RETRY_DELAY_MS);
    }
    if (!wait) return undefined;
    throw new ArtifactStoreError(`Timed out waiting for artifact append lock: ${lockPath}`);
  }

  async function withStoreLock(rootInfo,operation) {
    const lock=await acquireStoreLock(rootInfo);
    try {
      return await operation(lock);
    } finally {
      await releaseStoreLock(rootInfo,lock);
    }
  }

  async function writeAtomically(rootInfo,path,artifact,lock) {
    const directory=dirname(path);
    const serialized=`${JSON.stringify(artifact,null,2)}\n`;
    let temporaryPath;
    let temporaryStat;
    let temporaryHandle;
    for (let attempt=0;attempt<10;attempt+=1) {
      temporaryPath=join(
        directory,
        `.${basename(path)}.tmp-${lock.owner}-${attempt}`,
      );
      try {
        const created=await openNewRegularFile(
          rootInfo,
          temporaryPath,
          "Temporary artifact file",
        );
        temporaryHandle=created.handle;
        temporaryStat=created.stat;
        break;
      } catch (error) {
        if (error.code!=="EEXIST") throw error;
      }
    }
    if (!temporaryHandle) {
      throw new ArtifactStoreError(`Could not allocate temporary artifact file for ${path}`);
    }
    try {
      try {
        await temporaryHandle.writeFile(serialized,"utf8");
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
        temporaryHandle=undefined;
      }
      const temporary=JSON.parse((await readRegularFileNoFollow(
        rootInfo,
        temporaryPath,
        "Temporary artifact file",
      )).text);
      assertCoreArtifact(temporary,{requireRevision:true});
      if (canonicalJson(temporary)!==canonicalJson(artifact)) {
        throw new ArtifactIntegrityError("Temporary artifact verification failed");
      }
      if (await secureFileExists(rootInfo,path)) {
        throw new ArtifactOverwriteError(
          `Refusing to overwrite artifact revision ${artifact.revision}`,
        );
      }
      await rename(temporaryPath,path);
      temporaryPath=undefined;
      await assertSafeExistingPath(rootInfo,path,{kind:"file",label:"Artifact file"});
      await syncContainingDirectory(rootInfo,directory);
    } catch (error) {
      if (temporaryPath) {
        await unlinkIfSame(
          rootInfo,
          temporaryPath,
          temporaryStat,
          "Temporary artifact file",
        );
      }
      throw error;
    } finally {
      if (temporaryHandle) await temporaryHandle.close();
    }
  }

  async function append(draft) {
    if (!isPlainObject(draft)) {
      throw new ArtifactValidationError("draft must be an object");
    }
    const createdAtSupplied=draft.created_at!==undefined;
    const artifact={...draft};
    assertCoreArtifact(artifact,{now});
    const requestedRevision=artifact.revision;
    const rootInfo=await prepareRoot(root);

    return withStoreLock(rootInfo,async lock => {
      await migrateLegacyArtifactDirectory(
        rootInfo,
        artifact.document_type,
        artifact.artifact_id,
      );
      const directory=await ensureContainedDirectory(rootInfo,[
        ...ARTIFACT_ROOT_PARTS,
        artifact.document_type,
        artifactDirectoryName(artifact.artifact_id),
      ]);
      await assertArtifactIdDocumentType(
        rootInfo,
        artifact.document_type,
        artifact.artifact_id,
      );
      const existing=await artifactsForIdentity(
        rootInfo,
        artifact.document_type,
        artifact.artifact_id,
      );

      // References are intentionally verified before any content-hash reuse.
      await verifyDraftReferences(artifact);

      const atRequestedRevision=requestedRevision===undefined ? undefined :
        existing.find(candidate => candidate.revision===requestedRevision);
      if (atRequestedRevision) {
        if (atRequestedRevision.content_sha256!==artifact.content_sha256) {
          throw new ArtifactOverwriteError(
            `Refusing to overwrite artifact revision ${requestedRevision}`,
          );
        }
        if (immutableEnvelopeEquivalent(
          atRequestedRevision,
          artifact,
          createdAtSupplied,
        )) {
          return atRequestedRevision;
        }
        throw new ArtifactOverwriteError(
          `Refusing to reinterpret immutable artifact revision ${requestedRevision}`,
        );
      }

      if (requestedRevision===undefined) {
        const sameContent=existing.find(candidate =>
          candidate.content_sha256===artifact.content_sha256 &&
          immutableEnvelopeEquivalent(candidate,artifact,createdAtSupplied),
        );
        if (sameContent) return sameContent;
      }

      const predecessor=existing.at(-1);
      const nextRevision=(predecessor?.revision ?? 0)+1;
      requireRevision(nextRevision);
      if (requestedRevision!==undefined && requestedRevision!==nextRevision) {
        throw new ArtifactValidationError(
          `Revision ${requestedRevision} is not the next monotonic revision ${nextRevision}`,
        );
      }
      artifact.revision=requestedRevision ?? nextRevision;
      assertDraftLineage(artifact,predecessor);
      const path=join(
        directory,
        artifactFileName(artifact.revision,artifact.content_sha256),
      );
      await writeAtomically(rootInfo,path,artifact,lock);
      return verify({
        artifact_id:artifact.artifact_id,
        revision:artifact.revision,
        content_sha256:artifact.content_sha256,
        document_type:artifact.document_type,
      });
    });
  }

  async function list(filter={}) {
    if (!isPlainObject(filter)) {
      throw new ArtifactValidationError("list filter must be an object");
    }
    const rootInfo=await prepareRoot(root);
    const artifacts=[];
    for (const path of (await scanArtifactTree(rootInfo)).finalPaths) {
      const artifact=await readArtifact(rootInfo,path);
      await verifyArtifact(rootInfo,artifact,new Set());
      const matches=Object.entries(filter).every(([field,value]) =>
        artifact[field]===value,
      );
      if (matches) artifacts.push(artifact);
    }
    return artifacts.sort((left,right) =>
      left.document_type.localeCompare(right.document_type) ||
      left.artifact_id.localeCompare(right.artifact_id) ||
      left.revision-right.revision,
    );
  }

  async function recover() {
    const rootInfo=await prepareRoot(root);
    await ensureContainedDirectory(rootInfo,ARTIFACT_ROOT_PARTS);
    const lock=await acquireStoreLock(rootInfo,{wait:false});
    if (!lock) return {removed:[]};
    try {
      const removed=[];
      for (const path of (await scanArtifactTree(rootInfo)).temporaryPaths) {
        const owner=temporaryOwnerFromName(basename(path));
        if (!owner || isLiveProcess(owner.pid)) continue;
        const expected=await assertSafeExistingPath(rootInfo,path,{
          kind:"file",
          label:"Temporary artifact file",
        });
        if (await unlinkIfSame(rootInfo,path,expected,"Temporary artifact file")) {
          removed.push(path);
        }
      }
      return {removed:removed.sort()};
    } finally {
      await releaseStoreLock(rootInfo,lock);
    }
  }

  return {append,get,list,verify,recover};
}
