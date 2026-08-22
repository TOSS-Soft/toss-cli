import {execFile as execFileCallback} from "node:child_process";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {
  OWNERSHIP_LANES,
  discoverEligibleTestEntries,
  validateTestManifest,
} from "./test-manifest.mjs";
import {validateTestBoundaries} from "./test-boundaries.mjs";

export const COVERAGE_AUDIT_VERSION="toss-coverage-audit.v1";

const LEGACY_SOURCE=Object.freeze({
  tag:"v2.1.0",
  commit:"4472175eac91275cafab2993f68722febdb9eb59",
});
const DISPOSITIONS=Object.freeze(["unchanged","moved","coalesced","replaced"]);
const execFile=promisify(execFileCallback);

function ownDataProperties(value,label) {
  if (value===null || typeof value!=="object" || Object.getPrototypeOf(value)!==Object.prototype) {
    throw new TypeError(`${label} must be a plain JSON record`);
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
    if (!fields.includes(key)) throw new TypeError(`unknown ${label} field: ${key}`);
  }
  for (const key of fields) {
    if (!(key in descriptors)) throw new TypeError(`missing ${label} field: ${key}`);
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
    if (typeof key!=="string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key)>=length.value ||
      !("value" in descriptors[key]) || !descriptors[key].enumerable) {
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

function assertSafeAuditEntry(entry) {
  if (typeof entry!=="string" || entry.includes("\0") || entry.includes("\\") ||
    entry.startsWith("/") || /^[A-Za-z]:/u.test(entry)) {
    throw new TypeError(`unsafe coverage audit entry: ${String(entry)}`);
  }
  const segments=entry.split("/");
  if (segments.length!==2 || segments.some(segment => !segment || segment==="." || segment==="..")) {
    throw new TypeError(`unsafe coverage audit entry: ${entry}`);
  }
  const [directory,file]=segments;
  if ((directory!=="scripts" || !file.endsWith("-test.js")) &&
    (directory!=="test" || !file.endsWith(".test.js"))) {
    throw new TypeError(`unsafe coverage audit entry: ${entry}`);
  }
}

function stableStrings(entries,{label,duplicate,unsorted,allowEmpty=false}) {
  for (let index=0;index<entries.length;index+=1) {
    const entry=entries[index];
    if (typeof entry!=="string" || (!allowEmpty && !entry)) {
      throw new TypeError(`${label} must be non-empty strings`);
    }
    if (index>0 && entries[index-1]>=entry) {
      if (entries[index-1]===entry) throw new TypeError(`${duplicate}: ${entry}`);
      throw new TypeError(unsorted);
    }
  }
}

function normalizedOwnerLanes(manifest) {
  if (manifest===null || typeof manifest!=="object" || !Object.isFrozen(manifest) ||
    manifest.lanes===null || typeof manifest.lanes!=="object" || !Object.isFrozen(manifest.lanes)) {
    throw new TypeError("manifest must be a normalized test manifest");
  }
  const owners=new Map();
  for (const lane of OWNERSHIP_LANES) {
    const entries=manifest.lanes[lane];
    if (!Array.isArray(entries) || !Object.isFrozen(entries)) {
      throw new TypeError("manifest must be a normalized test manifest");
    }
    for (const entry of entries) owners.set(entry,lane);
  }
  return owners;
}

function normalizedGuaranteeIds(boundaries) {
  if (boundaries===null || typeof boundaries!=="object" || !Object.isFrozen(boundaries) ||
    !Array.isArray(boundaries.guarantees) || !Object.isFrozen(boundaries.guarantees)) {
    throw new TypeError("boundaries must be a normalized test boundary inventory");
  }
  return new Set(boundaries.guarantees.map(row => row.id));
}

function validateLegacyEntries(legacyEntries) {
  const entries=denseArray(legacyEntries,"legacy entries");
  for (const entry of entries) assertSafeAuditEntry(entry);
  stableStrings(entries,{
    label:"legacy entries",
    duplicate:"duplicate legacy entry",
    unsorted:"legacy entries must use stable ASCII order",
  });
  return entries;
}

export async function discoverLegacyTestEntries({repoRoot,tag}={}) {
  if (typeof repoRoot!=="string") throw new TypeError("coverage audit repository root must be a string path");
  if (tag!==LEGACY_SOURCE.tag) throw new TypeError(`locked coverage audit source tag must be ${LEGACY_SOURCE.tag}`);
  const options={cwd:repoRoot,maxBuffer:1024*1024};
  const tagType=(await execFile("git",["cat-file","-t",`refs/tags/${tag}`],options)).stdout.trim();
  if (tagType!=="tag") throw new TypeError(`coverage audit source tag must be annotated: ${tag}`);
  const commit=(await execFile("git",["rev-parse",`${tag}^{}`],options)).stdout.trim();
  if (commit!==LEGACY_SOURCE.commit) {
    throw new TypeError(`coverage audit source tag resolves to unexpected commit: ${commit}`);
  }
  const {stdout}=await execFile("git",[
    "ls-tree","-r","-z","--name-only",tag,"--","test","scripts",
  ],options);
  const entries=stdout.split("\0").filter(entry => {
    const segments=entry.split("/");
    if (segments.length!==2) return false;
    const [directory,file]=segments;
    return (directory==="test" && file.endsWith(".test.js")) ||
      (directory==="scripts" && file.endsWith("-test.js"));
  }).sort();
  return Object.freeze(validateLegacyEntries(entries));
}

export function validateCoverageAudit(value,{legacyEntries,manifest,boundaries}={}) {
  const root=exactFields(value,["schema_version","source","entries"],"coverage audit");
  if (root.schema_version.value!==COVERAGE_AUDIT_VERSION) {
    throw new TypeError(`unsupported coverage audit version: ${String(root.schema_version.value)}`);
  }
  const source=exactFields(root.source.value,["tag","commit"],"coverage source");
  if (source.tag.value!==LEGACY_SOURCE.tag) {
    throw new TypeError(`locked coverage audit source tag must be ${LEGACY_SOURCE.tag}`);
  }
  if (source.commit.value!==LEGACY_SOURCE.commit) {
    throw new TypeError(`locked coverage audit source commit must be ${LEGACY_SOURCE.commit}`);
  }
  const expectedEntries=validateLegacyEntries(legacyEntries);
  const owners=normalizedOwnerLanes(manifest);
  const guaranteeIds=normalizedGuaranteeIds(boundaries);
  const rows=denseArray(root.entries.value,"coverage audit entries");
  const legacyAuditEntries=rows.map(row => {
    const fields=exactFields(row,[
      "legacy_entry","final_owner","final_lane","disposition","retained_evidence",
    ],"coverage audit entry");
    assertSafeAuditEntry(fields.legacy_entry.value);
    return fields.legacy_entry.value;
  });
  stableStrings(legacyAuditEntries,{
    label:"coverage audit entries",
    duplicate:"duplicate legacy audit entry",
    unsorted:"coverage audit entries must use stable ASCII order",
  });
  const normalized=[];
  for (const row of rows) {
    const fields=exactFields(row,[
      "legacy_entry","final_owner","final_lane","disposition","retained_evidence",
    ],"coverage audit entry");
    const legacyEntry=fields.legacy_entry.value;
    const finalOwner=fields.final_owner.value;
    const finalLane=fields.final_lane.value;
    const disposition=fields.disposition.value;
    assertSafeAuditEntry(legacyEntry);
    assertSafeAuditEntry(finalOwner);
    const lane=owners.get(finalOwner);
    if (!lane) throw new TypeError(`unknown final manifest owner: ${finalOwner}`);
    if (finalLane!==lane) {
      throw new TypeError(`coverage audit final lane ${String(finalLane)} does not match manifest lane ${lane}`);
    }
    if (!DISPOSITIONS.includes(disposition)) {
      throw new TypeError(`unknown coverage audit disposition: ${String(disposition)}`);
    }
    const evidence=denseArray(fields.retained_evidence.value,"retained evidence");
    stableStrings(evidence,{
      label:"retained evidence",
      duplicate:"duplicate retained evidence",
      unsorted:"retained evidence must use stable ASCII order",
    });
    if (disposition!=="unchanged" && evidence.length===0) {
      throw new TypeError(`coverage audit ${disposition} entries require retained evidence`);
    }
    const legacyLane=owners.get(legacyEntry);
    if (legacyLane) {
      if (disposition!=="unchanged") {
        throw new TypeError(`surviving legacy entry must remain unchanged: ${legacyEntry}`);
      }
      if (finalOwner!==legacyEntry) {
        throw new TypeError(`coverage audit unchanged entry must retain its executable owner: ${legacyEntry}`);
      }
      if (evidence.length!==0) {
        throw new TypeError(`coverage audit unchanged entry must not retain preservation evidence: ${legacyEntry}`);
      }
    } else {
      if (disposition==="unchanged") {
        throw new TypeError(`coverage audit unchanged entry must retain a surviving executable owner: ${legacyEntry}`);
      }
      for (const item of evidence) {
        if (item===legacyEntry || item===finalOwner) {
          throw new TypeError(`coverage audit entry cannot retain its own executable assertion: ${item}`);
        }
        if (!owners.has(item) && !guaranteeIds.has(item)) {
          throw new TypeError(`unknown retained evidence target: ${item}`);
        }
      }
    }
    normalized.push(Object.freeze({
      legacy_entry:legacyEntry,
      final_owner:finalOwner,
      final_lane:finalLane,
      disposition,
      retained_evidence:Object.freeze([...evidence]),
    }));
  }
  if (legacyAuditEntries.length!==expectedEntries.length ||
    legacyAuditEntries.some((entry,index) => entry!==expectedEntries[index])) {
    throw new TypeError("coverage audit entries do not match the locked legacy inventory");
  }
  return Object.freeze({
    schema_version:root.schema_version.value,
    source:Object.freeze({tag:source.tag.value,commit:source.commit.value}),
    entries:Object.freeze(normalized),
  });
}

async function verifyCheckedInCoverageAudit() {
  const repoRoot=fileURLToPath(new URL("..",import.meta.url));
  const manifestValue=JSON.parse(await readFile(new URL("./test-manifest.json",import.meta.url),"utf8"));
  const manifest=validateTestManifest(manifestValue,{
    eligibleEntries:await discoverEligibleTestEntries(repoRoot),
  });
  const boundariesValue=JSON.parse(await readFile(new URL("./test-boundaries.json",import.meta.url),"utf8"));
  const boundaries=validateTestBoundaries(boundariesValue,{manifest});
  const audit=JSON.parse(await readFile(
    new URL("../docs/testing/v2.1.1-coverage-audit.json",import.meta.url),"utf8",
  ));
  validateCoverageAudit(audit,{
    legacyEntries:await discoverLegacyTestEntries({repoRoot,tag:LEGACY_SOURCE.tag}),
    manifest,
    boundaries,
  });
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    await verifyCheckedInCoverageAudit();
    console.log("Coverage audit integrity: PASS");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode=1;
  }
}
