import {spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {
  closeSync,constants,fstatSync,linkSync,lstatSync,openSync,readFileSync,realpathSync,
  rmSync,writeFileSync,
} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {canonicalJson} from '../src/contracts/acp.js';

export const RELEASE_EVIDENCE_VERSION='toss-release-evidence.v1';

const TAG_PATTERN=/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const COMMIT_PATTERN=/^[0-9a-f]{40}$/u;
const SHA256_PATTERN=/^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN=/^[1-9][0-9]*$/u;
const SAFE_ASSET_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const REPOSITORY='TOSS-Soft/toss-cli';
const BENCHMARK_LIMITS=Object.freeze({fast:15000,full:90103});
const OUTPUT_NAME='release-evidence.json';

function ownDataProperties(value,label) {
  if (value===null || typeof value!=="object" || Array.isArray(value) ||
      Object.getPrototypeOf(value)!==Object.prototype) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor=descriptors[key];
    if (typeof key!=="string" || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain only own enumerable data properties`);
    }
  }
  return descriptors;
}

function exactFields(value,fields,label) {
  const descriptors=ownDataProperties(value,label);
  for (const key of Object.keys(descriptors)) {
    if (!fields.includes(key)) throw new TypeError(`${label} has unknown field: ${key}`);
  }
  for (const key of fields) {
    if (!(key in descriptors)) throw new TypeError(`${label} has missing field: ${key}`);
  }
  return descriptors;
}

function denseArray(value,label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype) {
    throw new TypeError(`${label} must be a dense JSON array`);
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const length=descriptors.length;
  if (!("value" in length)) throw new TypeError(`${label} must be a dense JSON array`);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key==="length") continue;
    const descriptor=descriptors[key];
    if (typeof key!=="string" || !/^(0|[1-9][0-9]*)$/u.test(key) ||
        Number(key)>=length.value || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must be a dense JSON array`);
    }
  }
  const copy=[];
  for (let index=0;index<length.value;index+=1) {
    const descriptor=descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`${label} must be a dense JSON array`);
    }
    copy.push(descriptor.value);
  }
  return copy;
}

function versionFromTag(tag) {
  if (typeof tag!=="string" || !TAG_PATTERN.test(tag)) {
    throw new TypeError(`Release tag must be an exact semantic version: ${String(tag)}`);
  }
  return tag.slice(1);
}

function lowercaseHash(value,label) {
  if (typeof value!=="string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function validateBenchmark(value,lane) {
  const fields=exactFields(
    value,["report_sha256","median_ms","limit_ms"],`${lane} benchmark`,
  );
  const reportSha256=lowercaseHash(fields.report_sha256.value,`${lane} report_sha256`);
  const medianMs=fields.median_ms.value;
  if (typeof medianMs!=="number" || !Number.isFinite(medianMs) || medianMs<0) {
    throw new TypeError(`${lane} median_ms must be a finite nonnegative number`);
  }
  const limitMs=fields.limit_ms.value;
  if (limitMs!==BENCHMARK_LIMITS[lane]) {
    throw new TypeError(`${lane} limit_ms must equal ${BENCHMARK_LIMITS[lane]}`);
  }
  if (medianMs>limitMs) throw new TypeError(`${lane} benchmark exceeds its limit`);
  return Object.freeze({report_sha256:reportSha256,median_ms:medianMs,limit_ms:limitMs});
}

function validateBenchmarks(value) {
  const fields=exactFields(value,["fast","full"],"benchmarks");
  return Object.freeze({
    fast:validateBenchmark(fields.fast.value,"fast"),
    full:validateBenchmark(fields.full.value,"full"),
  });
}

function validateWorkflow(value) {
  const fields=exactFields(value,["repository","run_id","run_url"],"workflow");
  const repository=fields.repository.value;
  const runId=fields.run_id.value;
  const runUrl=fields.run_url.value;
  if (repository!==REPOSITORY) {
    throw new TypeError(`workflow repository must equal ${REPOSITORY}`);
  }
  if (typeof runId!=="string" || !RUN_ID_PATTERN.test(runId)) {
    throw new TypeError("workflow run_id must be a canonical positive decimal string");
  }
  const expectedUrl=`https://github.com/${repository}/actions/runs/${runId}`;
  if (runUrl!==expectedUrl) throw new TypeError(`workflow run_url must equal ${expectedUrl}`);
  return Object.freeze({repository,run_id:runId,run_url:runUrl});
}

function validatePackages(value,version) {
  const fields=exactFields(value,["npm","github"],"packages");
  const expectedNpm=`@toss-software/cli@${version}`;
  const expectedGitHub=`@toss-soft/cli@${version}`;
  if (fields.npm.value!==expectedNpm) {
    throw new TypeError(`npm package identity must equal ${expectedNpm}`);
  }
  if (fields.github.value!==expectedGitHub) {
    throw new TypeError(`GitHub package identity must equal ${expectedGitHub}`);
  }
  return Object.freeze({npm:expectedNpm,github:expectedGitHub});
}

function safeAssetName(value) {
  if (typeof value!=="string" || value==="." || value===".." ||
      !SAFE_ASSET_PATTERN.test(value)) {
    throw new TypeError(`Release asset name must be a safe basename: ${String(value)}`);
  }
  return value;
}

function validateAssetNames(value,tarballName) {
  const assets=denseArray(value,"release assets");
  const normalized=[];
  for (let index=0;index<assets.length;index+=1) {
    const asset=safeAssetName(assets[index]);
    if (index>0 && normalized[index-1]>=asset) {
      if (normalized[index-1]===asset) {
        throw new TypeError(`duplicate release asset: ${asset}`);
      }
      throw new TypeError("release assets must use stable ASCII order");
    }
    normalized.push(asset);
  }
  if (!normalized.includes(tarballName)) {
    throw new TypeError(`release assets must include canonical tarball ${tarballName}`);
  }
  return Object.freeze(normalized);
}

export function validateReleaseEvidence(value) {
  const fields=exactFields(value,[
    "schema_version","tag","version","commit","benchmarks","tarball","workflow","packages","release",
  ],"release evidence");
  if (fields.schema_version.value!==RELEASE_EVIDENCE_VERSION) {
    throw new TypeError(`schema_version must equal ${RELEASE_EVIDENCE_VERSION}`);
  }
  const tag=fields.tag.value;
  const expectedVersion=versionFromTag(tag);
  const version=fields.version.value;
  if (version!==expectedVersion) {
    throw new TypeError(`release version must equal tag version ${expectedVersion}`);
  }
  const commit=fields.commit.value;
  if (typeof commit!=="string" || !COMMIT_PATTERN.test(commit)) {
    throw new TypeError("release commit must be a lowercase 40-character Git commit hash");
  }
  const benchmarks=validateBenchmarks(fields.benchmarks.value);
  const tarballFields=exactFields(fields.tarball.value,["name","sha256"],"tarball");
  const tarballName=`toss-software-cli-${version}.tgz`;
  if (tarballFields.name.value!==tarballName) {
    throw new TypeError(`tarball name must equal ${tarballName}`);
  }
  const tarball=Object.freeze({
    name:tarballName,
    sha256:lowercaseHash(tarballFields.sha256.value,"tarball sha256"),
  });
  const workflow=validateWorkflow(fields.workflow.value);
  const packages=validatePackages(fields.packages.value,version);
  const releaseFields=exactFields(
    fields.release.value,["tag","url","draft","prerelease","assets"],"release",
  );
  if (releaseFields.tag.value!==tag) throw new TypeError("release tag must match evidence tag");
  const expectedReleaseUrl=`https://github.com/${workflow.repository}/releases/tag/${tag}`;
  if (releaseFields.url.value!==expectedReleaseUrl) {
    throw new TypeError(`release url must equal ${expectedReleaseUrl}`);
  }
  if (releaseFields.draft.value!==false) throw new TypeError("release must not be draft");
  if (releaseFields.prerelease.value!==false) throw new TypeError("release must not be prerelease");
  const release=Object.freeze({
    tag,
    url:expectedReleaseUrl,
    draft:false,
    prerelease:false,
    assets:validateAssetNames(releaseFields.assets.value,tarballName),
  });
  return Object.freeze({
    schema_version:RELEASE_EVIDENCE_VERSION,
    tag,
    version,
    commit,
    benchmarks,
    tarball,
    workflow,
    packages,
    release,
  });
}

function validateMetadata(value,tag) {
  const fields=exactFields(
    value,["version","artifactName","notesPath","commit","benchmarks"],"release metadata",
  );
  const version=versionFromTag(tag);
  if (fields.version.value!==version) {
    throw new TypeError(`release metadata version must equal ${version}`);
  }
  if (fields.artifactName.value!==`npm-package-${version}`) {
    throw new TypeError(`release metadata artifactName must equal npm-package-${version}`);
  }
  if (fields.notesPath.value!==`docs/releases/v${version}.md`) {
    throw new TypeError(`release metadata notesPath must equal docs/releases/v${version}.md`);
  }
  const commit=fields.commit.value;
  if (typeof commit!=="string" || !COMMIT_PATTERN.test(commit)) {
    throw new TypeError("release metadata commit must be a lowercase Git commit hash");
  }
  return Object.freeze({
    version,
    artifactName:fields.artifactName.value,
    notesPath:fields.notesPath.value,
    commit,
    benchmarks:validateBenchmarks(fields.benchmarks.value),
  });
}

function tarballSha256(tarballPath,expectedName) {
  if (typeof tarballPath!=="string" || basename(tarballPath)!==expectedName) {
    throw new TypeError(`Tarball path must name the canonical artifact ${expectedName}`);
  }
  if (typeof constants.O_NOFOLLOW!=="number") {
    throw new Error("No-follow tarball reads are not supported on this platform");
  }
  let descriptor;
  let primaryFailure;
  try {
    descriptor=openSync(tarballPath,constants.O_RDONLY|constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) throw new TypeError("Tarball must be a regular file");
    return createHash("sha256").update(readFileSync(descriptor)).digest("hex");
  } catch (error) {
    primaryFailure=error;
    if (error?.code==="ELOOP") {
      throw new TypeError("Tarball must be a no-follow regular file, not a symbolic link",{cause:error});
    }
    throw error;
  } finally {
    if (descriptor!==undefined) {
      try {
        closeSync(descriptor);
      } catch (cleanupError) {
        if (!primaryFailure) throw cleanupError;
      }
    }
  }
}

function normalizeRelease(value,{tarballName,tarballDigest}) {
  const fields=exactFields(
    value,["tagName","url","isDraft","isPrerelease","assets"],"GitHub release JSON",
  );
  const assets=denseArray(fields.assets.value,"GitHub release assets");
  const names=[];
  let observedTarballDigest;
  for (const value of assets) {
    const asset=exactFields(value,["name","digest"],"GitHub release asset");
    const name=safeAssetName(asset.name.value);
    const digest=asset.digest.value;
    if (typeof digest!=="string" || !digest.startsWith("sha256:") ||
        !SHA256_PATTERN.test(digest.slice("sha256:".length))) {
      throw new TypeError(`GitHub release asset digest must be sha256:<lowercase hash>: ${name}`);
    }
    if (names.includes(name)) throw new TypeError(`duplicate release asset: ${name}`);
    names.push(name);
    if (name===tarballName) observedTarballDigest=digest.slice("sha256:".length);
  }
  if (observedTarballDigest===undefined) {
    throw new TypeError(`GitHub release assets must include canonical tarball ${tarballName}`);
  }
  if (observedTarballDigest!==tarballDigest) {
    throw new TypeError("GitHub release tarball digest does not match the local canonical tarball");
  }
  return {
    tag:fields.tagName.value,
    url:fields.url.value,
    draft:fields.isDraft.value,
    prerelease:fields.isPrerelease.value,
    assets:names.sort(),
  };
}

export function createReleaseEvidence(input) {
  const fields=exactFields(input,[
    "tag","metadata","tarballPath","workflow","packages","release",
  ],"release evidence input");
  const tag=fields.tag.value;
  const metadata=validateMetadata(fields.metadata.value,tag);
  const tarballName=`toss-software-cli-${metadata.version}.tgz`;
  const sha256=tarballSha256(fields.tarballPath.value,tarballName);
  const workflow=validateWorkflow(fields.workflow.value);
  const release=normalizeRelease(fields.release.value,{
    tarballName,
    tarballDigest:sha256,
  });
  return validateReleaseEvidence({
    schema_version:RELEASE_EVIDENCE_VERSION,
    tag,
    version:metadata.version,
    commit:metadata.commit,
    benchmarks:metadata.benchmarks,
    tarball:{name:tarballName,sha256},
    workflow,
    packages:fields.packages.value,
    release,
  });
}

function safeOutputDestination(cwd,outputPath,runGit) {
  if (typeof outputPath!=="string" || outputPath.includes("\0") || outputPath.includes("\\") ||
      outputPath.startsWith("/") || /^[A-Za-z]:/u.test(outputPath)) {
    throw new TypeError("Release evidence output must be a safe relative path");
  }
  const parts=outputPath.split("/");
  if (parts.length===0 || parts.some(part => !part || part==="." || part==="..") ||
      parts.at(-1)!==OUTPUT_NAME) {
    throw new TypeError(`Release evidence output must end with ${OUTPUT_NAME}`);
  }
  const root=realpathSync(cwd);
  const destination=resolve(root,...parts);
  let current=root;
  for (let index=0;index<parts.length;index+=1) {
    current=join(current,parts[index]);
    try {
      const status=lstatSync(current);
      if (status.isSymbolicLink()) {
        throw new TypeError("Release evidence output must not use symbolic links");
      }
      if (index===parts.length-1) {
        throw new TypeError("Release evidence output destination already exists");
      }
      if (!status.isDirectory()) {
        throw new TypeError("Release evidence output parent must be a directory");
      }
    } catch (error) {
      if (error?.code==="ENOENT") continue;
      throw error;
    }
  }
  const parent=dirname(destination);
  let parentReal;
  try {
    parentReal=realpathSync(parent);
  } catch (error) {
    if (error?.code==="ENOENT") {
      throw new TypeError("Release evidence output parent must be an existing safe directory",{
        cause:error,
      });
    }
    throw error;
  }
  if (parentReal!==parent) {
    throw new TypeError("Release evidence output parent must be an existing safe directory");
  }
  const tracked=runGit("git",[
    "ls-files","--error-unmatch","--",`:(top,literal)${outputPath}`,
  ],{
    cwd:root,stdio:"ignore",
  });
  if (tracked.error || tracked.signal || (tracked.status!==0 && tracked.status!==1)) {
    throw new Error("Unable to determine whether release evidence output is tracked by Git",{
      cause:tracked.error,
    });
  }
  if (tracked.status===0) throw new TypeError("Release evidence output must be untracked");
  return {destination,parent};
}

function attachCleanupFailure(primaryFailure,cleanupError) {
  try {
    if (((typeof primaryFailure==="object" && primaryFailure!==null) ||
        typeof primaryFailure==="function") && Object.isExtensible(primaryFailure) &&
        !Object.prototype.hasOwnProperty.call(primaryFailure,"cleanupError")) {
      Object.defineProperty(primaryFailure,"cleanupError",{
        value:cleanupError,enumerable:false,configurable:true,
      });
    }
  } catch {
    // Cleanup diagnostics must never replace the primary output failure.
  }
}

export function writeReleaseEvidenceJson(cwd,outputPath,evidence,{
  writeTemporary=writeFileSync,
  publishTemporary=linkSync,
  removeTemporary=rmSync,
  runGit=spawnSync,
}={}) {
  const normalized=validateReleaseEvidence(evidence);
  const {destination,parent}=safeOutputDestination(cwd,outputPath,runGit);
  const temporary=join(
    parent,`.release-evidence.json.${process.pid}.${randomBytes(16).toString("hex")}.tmp`,
  );
  let primaryFailure;
  let failed=false;
  try {
    writeTemporary(temporary,canonicalJson(normalized),{
      encoding:"utf8",flag:"wx",mode:0o600,
    });
    publishTemporary(temporary,destination);
  } catch (error) {
    failed=true;
    primaryFailure=error;
    throw error;
  } finally {
    try {
      removeTemporary(temporary,{force:true});
    } catch (cleanupError) {
      if (!failed) throw cleanupError;
      attachCleanupFailure(primaryFailure,cleanupError);
    }
  }
}

function readJson(path,label) {
  let parsed;
  try {
    parsed=JSON.parse(readFileSync(path,"utf8"));
  } catch (error) {
    throw new TypeError(`${label} must contain one JSON object`,{cause:error});
  }
  return parsed;
}

function requiredEnvironment(name) {
  const value=process.env[name];
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function runCli(argv) {
  if (argv.length===2 && argv[0]==="validate") {
    validateReleaseEvidence(readJson(argv[1],"Release evidence input"));
    return;
  }
  if (argv.length===7 && argv[0]==="create") {
    const [,metadataPath,tarballPath,npmPackage,githubPackage,releasePath,outputPath]=argv;
    const repository=requiredEnvironment("GITHUB_REPOSITORY");
    const runId=requiredEnvironment("GITHUB_RUN_ID");
    const evidence=createReleaseEvidence({
      tag:requiredEnvironment("GITHUB_REF_NAME"),
      metadata:readJson(metadataPath,"Release metadata input"),
      tarballPath,
      workflow:{
        repository,
        run_id:runId,
        run_url:`https://github.com/${repository}/actions/runs/${runId}`,
      },
      packages:{npm:npmPackage,github:githubPackage},
      release:readJson(releasePath,"GitHub release input"),
    });
    writeReleaseEvidenceJson(process.cwd(),outputPath,evidence);
    return;
  }
  throw new TypeError(
    "Usage: release-evidence.mjs create <metadata-json> <tarball> <npm-package> " +
    "<github-package> <release-json> <output-json> | validate <evidence-json>",
  );
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2));
}
