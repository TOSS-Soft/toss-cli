import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {discoverEligibleTestEntries,validateTestManifest} from "./test-manifest.mjs";

export const TEST_BOUNDARY_VERSION="toss-test-boundaries.v1";
export const BOUNDARY_CLASSIFICATIONS=Object.freeze([
  "semantic","store-integration","durability-atomicity","real-cli","package","release",
]);

const ALLOWED_LANES=Object.freeze({
  semantic:Object.freeze(["fast","integration","e2e"]),
  "store-integration":Object.freeze(["integration","e2e"]),
  "durability-atomicity":Object.freeze(["integration","e2e"]),
  "real-cli":Object.freeze(["e2e"]),
  package:Object.freeze(["package"]),
  release:Object.freeze(["release"]),
});

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
    if (!fields.includes(key)) {
      throw new TypeError(`unknown ${label} field: ${key}`);
    }
  }
  for (const key of fields) {
    if (!(key in descriptors)) {
      throw new TypeError(`missing ${label} field: ${key}`);
    }
  }
  return descriptors;
}

function denseArray(value,label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype) {
    throw new TypeError(`${label} must be a dense JSON array`);
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const length=descriptors.length;
  if (!("value" in length)) {
    throw new TypeError(`${label} must be a dense JSON array`);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key==="length") continue;
    if (typeof key!=="string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key)>=length.value || !("value" in descriptors[key]) || !descriptors[key].enumerable) {
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

function assertSafeBoundaryEntry(entry) {
  if (typeof entry!=="string" || entry.includes("\0") || entry.includes("\\") || entry.startsWith("/") || /^[A-Za-z]:/u.test(entry)) {
    throw new TypeError(`unsafe boundary entry: ${String(entry)}`);
  }
  const segments=entry.split("/");
  if (segments.length!==2 || segments.some(segment => !segment || segment==="." || segment==="..")) {
    throw new TypeError(`unsafe boundary entry: ${entry}`);
  }
  const [directory,file]=segments;
  if ((directory!=="scripts" || !file.endsWith("-test.js")) && (directory!=="test" || !file.endsWith(".test.js"))) {
    throw new TypeError(`unsafe boundary entry: ${entry}`);
  }
}

function ownerLanes(manifest) {
  if (manifest===null || typeof manifest!=="object" || manifest.lanes===null || typeof manifest.lanes!=="object") {
    throw new TypeError("manifest must be a normalized test manifest");
  }
  const lanes=new Map();
  for (const [lane,entries] of Object.entries(manifest.lanes)) {
    for (const entry of entries) lanes.set(entry,lane);
  }
  return lanes;
}

function stableUnique(values,{label,duplicate,unsorted}) {
  for (let index=0;index<values.length;index+=1) {
    if (typeof values[index]!=="string" || !values[index]) {
      throw new TypeError(`${label} must be non-empty strings`);
    }
    if (index>0 && values[index-1]>=values[index]) {
      if (values[index-1]===values[index]) {
        throw new TypeError(`${duplicate}: ${values[index]}`);
      }
      throw new TypeError(unsorted);
    }
  }
}

export function validateTestBoundaries(value,{manifest}={}) {
  const root=exactFields(value,["schema_version","guarantees","semantic_delegations"],"boundary inventory");
  if (root.schema_version.value!==TEST_BOUNDARY_VERSION) {
    throw new TypeError(`unsupported test boundary version: ${String(root.schema_version.value)}`);
  }
  const lanes=ownerLanes(manifest);
  const guaranteeRows=denseArray(root.guarantees.value,"guarantees");
  const guarantees=[];
  const guaranteeById=new Map();
  const guaranteeIds=[];
  for (const row of guaranteeRows) {
    const fields=exactFields(row,["id","classification","owner"],"guarantee");
    const {id,classification,owner}=Object.fromEntries(
      Object.entries(fields).map(([key,descriptor]) => [key,descriptor.value]),
    );
    guaranteeIds.push(id);
    if (!BOUNDARY_CLASSIFICATIONS.includes(classification)) {
      throw new TypeError(`unknown boundary classification: ${String(classification)}`);
    }
    assertSafeBoundaryEntry(owner);
    const lane=lanes.get(owner);
    if (!lane) throw new TypeError(`unknown manifest owner: ${owner}`);
    if (!ALLOWED_LANES[classification].includes(lane)) {
      throw new TypeError(`guarantee classification ${classification} is incompatible with lane ${lane}`);
    }
    const normalized=Object.freeze({id,classification,owner});
    guarantees.push(normalized);
    guaranteeById.set(id,normalized);
  }
  stableUnique(guaranteeIds,{
    label:"guarantee IDs",
    duplicate:"duplicate guarantee ID",
    unsorted:"guarantee IDs must use stable ASCII order",
  });

  const delegationRows=denseArray(root.semantic_delegations.value,"semantic delegations");
  const delegations=[];
  const entries=[];
  for (const row of delegationRows) {
    const fields=exactFields(row,["entry","guarantees"],"semantic delegation");
    const entry=fields.entry.value;
    assertSafeBoundaryEntry(entry);
    if (!lanes.has(entry)) throw new TypeError(`unknown manifest owner: ${entry}`);
    const delegatedIds=denseArray(fields.guarantees.value,"delegated guarantees");
    stableUnique(delegatedIds,{
      label:"delegated guarantees",
      duplicate:"duplicate delegated guarantee",
      unsorted:"delegated guarantees must use stable ASCII order",
    });
    for (const id of delegatedIds) {
      const guarantee=guaranteeById.get(id);
      if (!guarantee) throw new TypeError(`unknown delegated guarantee: ${id}`);
      if (guarantee.classification==="semantic") {
        throw new TypeError(`semantic delegation must not delegate semantic guarantee: ${id}`);
      }
    }
    entries.push(entry);
    delegations.push(Object.freeze({entry,guarantees:Object.freeze([...delegatedIds])}));
  }
  stableUnique(entries,{
    label:"semantic delegation entries",
    duplicate:"duplicate semantic delegation entry",
    unsorted:"semantic delegations must use stable ASCII order",
  });

  return Object.freeze({
    schema_version:root.schema_version.value,
    guarantees:Object.freeze(guarantees),
    semantic_delegations:Object.freeze(delegations),
  });
}

async function verifyCheckedInBoundaries() {
  const manifestValue=JSON.parse(await readFile(new URL("./test-manifest.json",import.meta.url),"utf8"));
  const root=fileURLToPath(new URL("..",import.meta.url));
  const manifest=validateTestManifest(manifestValue,{
    eligibleEntries:await discoverEligibleTestEntries(root),
  });
  const boundaries=JSON.parse(await readFile(new URL("./test-boundaries.json",import.meta.url),"utf8"));
  validateTestBoundaries(boundaries,{manifest});
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    await verifyCheckedInBoundaries();
    console.log("Test boundary integrity: PASS");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode=1;
  }
}
