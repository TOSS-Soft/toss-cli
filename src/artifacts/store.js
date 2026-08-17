import {randomUUID} from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import {basename, dirname, join, relative} from "node:path";

import {assertKnownDocumentType,sha256Canonical} from "../contracts/acp.js";
import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  ArtifactOverwriteError,
  ArtifactReferenceError,
  ArtifactStoreError,
  ArtifactValidationError,
} from "./errors.js";

const ARTIFACT_ROOT_PARTS=["project-management","artifacts"];
const ARTIFACT_ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_PATTERN=/^[a-f0-9]{64}$/;
const REVISION_FILE_PATTERN=/^r(\d{6})-([a-f0-9]{64})\.json$/;
const LOCK_FILE_NAME=".append.lock";
const LOCK_RETRY_LIMIT=200;
const LOCK_RETRY_DELAY_MS=5;

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
  return new Promise(resolve => setTimeout(resolve,milliseconds));
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
      "artifact_id must use only letters, numbers, dots, underscores, and hyphens",
    );
  }
  return value;
}

function requireRevision(value,field="revision") {
  if (!Number.isSafeInteger(value) || value<1) {
    throw new ArtifactValidationError(`${field} must be a positive integer`);
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

function assertCoreArtifact(record,{requireRevision:mustHaveRevision,now}={}) {
  if (!isPlainObject(record)) {
    throw new ArtifactValidationError("artifact must be an object");
  }
  requireNonEmptyString(record.schema_version,"schema_version");
  requireNonEmptyString(record.document_type,"document_type");
  try {
    assertKnownDocumentType(record.document_type,record.schema_version);
  } catch (error) {
    throw new ArtifactValidationError(error.message,{cause:error});
  }
  requireArtifactId(record.artifact_id);
  if (mustHaveRevision || record.revision!==undefined) {
    requireRevision(record.revision);
  }
  requireNonEmptyString(record.run_id,"run_id");
  if (!isPlainObject(record.producer)) {
    throw new ArtifactValidationError("producer must be an object");
  }
  if (!isPlainObject(record.provenance)) {
    throw new ArtifactValidationError("provenance must be an object");
  }
  if (record.provenance.source_revision===undefined ||
      record.provenance.source_revision===null ||
      String(record.provenance.source_revision).length===0) {
    throw new ArtifactValidationError("provenance.source_revision is required");
  }
  requireHash(record.provenance.source_sha256,"provenance.source_sha256");
  if (record.created_at===undefined && now) {
    record.created_at=isoTimestamp(now());
  }
  requireNonEmptyString(record.created_at,"created_at");
  record.parents=normalizeReferenceList(record.parents ?? [],"parents");
  record.inputs=normalizeReferenceList(record.inputs ?? [],"inputs");
  const contentHash=calculateContentHash(record.content);
  if (record.content_sha256!==undefined && record.content_sha256!==contentHash) {
    throw new ArtifactIntegrityError("Content hash mismatch for artifact content");
  }
  record.content_sha256=contentHash;
  return record;
}

function artifactFileName(revision,contentSha256) {
  return `r${String(revision).padStart(6,"0")}-${contentSha256}.json`;
}

function isFinalArtifactFile(name) {
  return REVISION_FILE_PATTERN.test(name);
}

function isTransientFile(name) {
  return name===LOCK_FILE_NAME || name.includes(".tmp-") || name.endsWith(".tmp");
}

async function pathExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code==="ENOENT") return false;
    throw error;
  }
}

async function filesRecursively(directory) {
  let entries;
  try {
    entries=await readdir(directory,{withFileTypes:true});
  } catch (error) {
    if (error.code==="ENOENT") return [];
    throw error;
  }
  const files=[];
  for (const entry of entries) {
    const path=join(directory,entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesRecursively(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

async function acquireArtifactLock(directory) {
  const path=join(directory,LOCK_FILE_NAME);
  for (let attempt=0;attempt<LOCK_RETRY_LIMIT;attempt+=1) {
    try {
      return {path,handle:await open(path,"wx")};
    } catch (error) {
      if (error.code!=="EEXIST") throw error;
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
  throw new ArtifactStoreError(`Timed out waiting for artifact append lock: ${path}`);
}

async function withArtifactLock(directory,operation) {
  const lock=await acquireArtifactLock(directory);
  try {
    return await operation();
  } finally {
    await lock.handle.close();
    await rm(lock.path,{force:true});
  }
}

export function createArtifactStore({root,now=() => new Date(),randomId=randomUUID}={}) {
  if (typeof root!=="string" || root.length===0) {
    throw new TypeError("createArtifactStore requires a root path");
  }
  if (typeof now!=="function" || typeof randomId!=="function") {
    throw new TypeError("createArtifactStore now and randomId must be functions");
  }

  const artifactRoot=join(root,...ARTIFACT_ROOT_PARTS);

  function artifactDirectory(documentType,artifactId) {
    return join(artifactRoot,documentType,artifactId);
  }

  async function readArtifact(path) {
    let value;
    try {
      value=JSON.parse(await readFile(path,"utf8"));
    } catch (error) {
      throw new ArtifactIntegrityError(
        `Corrupted artifact at ${pathForDisplay(root,path)}`,
        {cause:error},
      );
    }
    try {
      assertCoreArtifact(value,{requireRevision:true});
    } catch (error) {
      if (error instanceof ArtifactIntegrityError) throw error;
      throw new ArtifactIntegrityError(
        `Invalid artifact at ${pathForDisplay(root,path)}: ${error.message}`,
        {cause:error},
      );
    }
    const fileMatch=REVISION_FILE_PATTERN.exec(basename(path));
    if (!fileMatch) {
      throw new ArtifactIntegrityError(
        `Artifact filename is invalid: ${pathForDisplay(root,path)}`,
      );
    }
    const [,revisionText,hashFromName]=fileMatch;
    if (Number(revisionText)!==value.revision || hashFromName!==value.content_sha256) {
      throw new ArtifactIntegrityError(
        `Artifact filename does not match content at ${pathForDisplay(root,path)}`,
      );
    }
    const expectedRelative=join(
      ...ARTIFACT_ROOT_PARTS,
      value.document_type,
      value.artifact_id,
    );
    const actualRelative=relative(root,dirname(path));
    if (actualRelative!==expectedRelative) {
      throw new ArtifactIntegrityError(
        `Artifact path does not match its identity: ${pathForDisplay(root,path)}`,
      );
    }
    return value;
  }

  async function artifactPaths() {
    const all=await filesRecursively(artifactRoot);
    return all.filter(path => isFinalArtifactFile(basename(path)));
  }

  async function findArtifact(reference) {
    const normalized=normalizeReference(reference);
    const matches=[];
    for (const path of await artifactPaths()) {
      const artifact=await readArtifact(path);
      if (artifact.artifact_id===normalized.artifact_id &&
          artifact.revision===normalized.revision &&
          (normalized.document_type===undefined ||
            artifact.document_type===normalized.document_type)) {
        matches.push({artifact,path});
      }
    }
    if (matches.length===0) {
      throw new ArtifactNotFoundError(`Artifact not found: ${describeReference(normalized)}`);
    }
    if (matches.length>1) {
      throw new ArtifactIntegrityError(
        `Multiple artifacts share identity ${describeReference(normalized)}`,
      );
    }
    const match=matches[0];
    if (match.artifact.content_sha256!==normalized.content_sha256) {
      throw new ArtifactIntegrityError(
        `Content hash mismatch for ${describeReference(normalized)}`,
      );
    }
    return match;
  }

  async function verifyReferences(artifact,visited) {
    const key=`${artifact.artifact_id}\u0000${artifact.revision}`;
    if (visited.has(key)) {
      throw new ArtifactIntegrityError(`Cyclic artifact reference at ${key}`);
    }
    visited.add(key);
    try {
      for (const [kind,references] of [["parent",artifact.parents],["input",artifact.inputs]]) {
        for (const reference of references) {
          try {
            const target=await findArtifact(reference);
            await verifyReferences(target.artifact,visited);
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
    const match=await findArtifact(reference);
    await verifyReferences(match.artifact,new Set());
    return match.artifact;
  }

  async function get(reference) {
    return verify(reference);
  }

  async function artifactsForIdentity(documentType,artifactId) {
    const directory=artifactDirectory(documentType,artifactId);
    let entries;
    try {
      entries=await readdir(directory,{withFileTypes:true});
    } catch (error) {
      if (error.code==="ENOENT") return [];
      throw error;
    }
    const artifacts=[];
    for (const entry of entries.filter(entry => entry.isFile() && isFinalArtifactFile(entry.name))) {
      const path=join(directory,entry.name);
      const artifact=await readArtifact(path);
      if (artifact.document_type!==documentType || artifact.artifact_id!==artifactId) {
        throw new ArtifactIntegrityError(
          `Artifact path does not match its identity: ${pathForDisplay(root,path)}`,
        );
      }
      await verifyReferences(artifact,new Set());
      artifacts.push(artifact);
    }
    return artifacts.sort((left,right) => left.revision-right.revision);
  }

  async function assertArtifactIdDocumentType(documentType,artifactId) {
    for (const path of await artifactPaths()) {
      const artifact=await readArtifact(path);
      if (artifact.artifact_id===artifactId &&
          artifact.document_type!==documentType) {
        throw new ArtifactValidationError(
          `artifact_id ${artifactId} is already bound to document type ${artifact.document_type}`,
        );
      }
    }
  }

  async function writeAtomically(path,artifact) {
    const directory=dirname(path);
    const serialized=`${JSON.stringify(artifact,null,2)}\n`;
    let temporaryPath;
    let handle;
    for (let attempt=0;attempt<10;attempt+=1) {
      temporaryPath=join(
        directory,
        `.${basename(path)}.tmp-${String(randomId())}-${attempt}`,
      );
      try {
        handle=await open(temporaryPath,"wx");
        break;
      } catch (error) {
        if (error.code!=="EEXIST") throw error;
      }
    }
    if (!handle) {
      throw new ArtifactStoreError(`Could not allocate temporary artifact file for ${path}`);
    }
    try {
      await handle.writeFile(serialized,"utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      const temporary=JSON.parse(await readFile(temporaryPath,"utf8"));
      assertCoreArtifact(temporary,{requireRevision:true});
      if (temporary.content_sha256!==artifact.content_sha256 ||
          temporary.revision!==artifact.revision) {
        throw new ArtifactIntegrityError("Temporary artifact verification failed");
      }
      await verifyReferences(temporary,new Set());
      if (await pathExists(path)) {
        throw new ArtifactOverwriteError(`Refusing to overwrite artifact revision ${artifact.revision}`);
      }
      await rename(temporaryPath,path);
    } catch (error) {
      await rm(temporaryPath,{force:true});
      throw error;
    }
  }

  async function append(draft) {
    if (!isPlainObject(draft)) {
      throw new ArtifactValidationError("draft must be an object");
    }
    const artifact={...draft};
    assertCoreArtifact(artifact,{now});
    const requestedRevision=artifact.revision;
    const directory=artifactDirectory(artifact.document_type,artifact.artifact_id);
    await mkdir(directory,{recursive:true});

    return withArtifactLock(artifactRoot,async () => {
      await assertArtifactIdDocumentType(artifact.document_type,artifact.artifact_id);
      const existing=await artifactsForIdentity(
        artifact.document_type,
        artifact.artifact_id,
      );
      const atRequestedRevision=requestedRevision===undefined ? undefined :
        existing.find(candidate => candidate.revision===requestedRevision);
      if (atRequestedRevision) {
        if (atRequestedRevision.content_sha256===artifact.content_sha256) {
          return atRequestedRevision;
        }
        throw new ArtifactOverwriteError(
          `Refusing to overwrite artifact revision ${requestedRevision}`,
        );
      }
      const sameContent=existing.find(candidate =>
        candidate.content_sha256===artifact.content_sha256,
      );
      if (sameContent) return sameContent;

      const highestRevision=existing.at(-1)?.revision ?? 0;
      const nextRevision=highestRevision+1;
      if (requestedRevision!==undefined && requestedRevision!==nextRevision) {
        throw new ArtifactValidationError(
          `Revision ${requestedRevision} is not the next monotonic revision ${nextRevision}`,
        );
      }
      const predecessor=existing.at(-1);
      if (predecessor && !artifact.parents.some(parent =>
        isExactReference(parent,predecessor),
      )) {
        throw new ArtifactReferenceError(
          `Revision ${nextRevision} requires a parent reference to the previous revision`,
        );
      }
      artifact.revision=requestedRevision ?? nextRevision;
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
      const path=join(directory,artifactFileName(artifact.revision,artifact.content_sha256));
      await writeAtomically(path,artifact);
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
    const artifacts=[];
    for (const path of await artifactPaths()) {
      const artifact=await readArtifact(path);
      await verifyReferences(artifact,new Set());
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
    const removed=[];
    for (const path of await filesRecursively(artifactRoot)) {
      if (!isTransientFile(basename(path))) continue;
      await unlink(path);
      removed.push(path);
    }
    return {removed:removed.sort()};
  }

  return {append,get,list,verify,recover};
}
