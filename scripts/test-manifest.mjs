import {lstat,readdir} from "node:fs/promises";
import {join} from "node:path";

export const TEST_MANIFEST_VERSION="toss-test-manifest.v1";
export const OWNERSHIP_LANES=Object.freeze([
  "fast","integration","e2e","package","release",
]);
export const REQUESTED_LANES=Object.freeze([...OWNERSHIP_LANES,"full"]);

const IGNORED_TREE_ROOTS=Object.freeze(["node_modules","worktrees","evidence"]);

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
    throw new TypeError(`${label} must contain only data properties`);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key==="length") continue;
    if (typeof key!=="string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key)>=length.value || !("value" in descriptors[key])) {
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

function asciiSortedUnique(entries,lane) {
  for (let index=0;index<entries.length;index+=1) {
    if (typeof entries[index]!=="string") {
      throw new TypeError(`lane ${lane} entries must be strings`);
    }
    if (index>0 && entries[index-1]>=entries[index]) {
      if (entries[index-1]===entries[index]) {
        throw new TypeError(`duplicate entry in lane ${lane}: ${entries[index]}`);
      }
      throw new TypeError(`lane ${lane} entries must use stable ASCII order`);
    }
  }
}

function assertSafeEntryPath(entry) {
  if (typeof entry!=="string" || entry.includes("\0") || entry.includes("\\") || entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) {
    throw new TypeError(`unsafe test entry: ${String(entry)}`);
  }
  const segments=entry.split("/");
  if (segments.length!==2 || segments.some(segment => !segment || segment==="." || segment==="..")) {
    throw new TypeError(`unsafe test entry: ${entry}`);
  }
  const [directory,file]=segments;
  if ((directory!=="scripts" || !file.endsWith("-test.js")) && (directory!=="test" || !file.endsWith(".test.js"))) {
    throw new TypeError(`unsafe test entry: ${entry}`);
  }
}

function relativePath(directory,segments) {
  return [directory,...segments].join("/");
}

async function directoryStat(path,label) {
  let stat;
  try {
    stat=await lstat(path);
  } catch (error) {
    if (error?.code==="ENOENT") {
      throw new TypeError(`missing declared test root: ${label}`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new TypeError(`symbolic link is not allowed: ${label}`);
  }
  if (!stat.isDirectory()) {
    throw new TypeError(`declared test root must be a directory: ${label}`);
  }
}

function isDirectCandidate(directory,name) {
  return directory==="scripts" ? name.endsWith("-test.js") : name.endsWith(".test.js");
}

function isNestedCandidate(directory,name) {
  return directory==="scripts"
    ? name.endsWith("-test.js") || name.endsWith(".test.js")
    : /\.(?:js|mjs|cjs)$/.test(name);
}

export async function discoverEligibleTestEntries(root) {
  if (typeof root!=="string") {
    throw new TypeError("test repository root must be a string path");
  }
  await directoryStat(root,"repository root");
  const eligible=[];
  for (const directory of ["scripts","test"]) {
    const directoryPath=join(root,directory);
    await directoryStat(directoryPath,directory);
    const audit=async (path,segments=[]) => {
      const children=await readdir(path);
      children.sort();
      for (const name of children) {
        const childPath=join(path,name);
        const childSegments=[...segments,name];
        const entry=relativePath(directory,childSegments);
        if (childSegments.length===1 && IGNORED_TREE_ROOTS.includes(name)) {
          continue;
        }
        const stat=await lstat(childPath);
        if (stat.isSymbolicLink()) {
          throw new TypeError(`symbolic link is not allowed: ${entry}`);
        }
        const direct=childSegments.length===1;
        const candidate=isDirectCandidate(directory,name);
        if (stat.isDirectory()) {
          if (direct && candidate) {
            throw new TypeError(`eligible entry must be a regular file: ${entry}`);
          }
          if (directory==="test" && direct && (name==="support" || name==="fixtures")) {
            continue;
          }
          await audit(childPath,childSegments);
          continue;
        }
        if (direct && candidate) {
          if (!stat.isFile()) {
            throw new TypeError(`eligible entry must be a regular file: ${entry}`);
          }
          eligible.push(entry);
          continue;
        }
        if (!direct && stat.isFile() && isNestedCandidate(directory,name)) {
          const type=directory==="scripts" ? "script test" : "test";
          throw new TypeError(`unexpected nested ${type} candidate: ${entry}`);
        }
      }
    };
    await audit(directoryPath);
  }
  return eligible.sort();
}

export function selectTestEntries(manifest,lane) {
  if (!REQUESTED_LANES.includes(lane)) {
    throw new TypeError(`unknown test lane: ${lane}`);
  }
  return lane==="full"
    ? OWNERSHIP_LANES.flatMap(owner => manifest.lanes[owner])
    : [...manifest.lanes[lane]];
}

export function validateTestManifest(manifest,{eligibleEntries}={}) {
  const root=exactFields(manifest,["schema_version","concurrency","lanes"],"manifest");
  if (root.schema_version.value!==TEST_MANIFEST_VERSION) {
    throw new TypeError(`unsupported test manifest version: ${String(root.schema_version.value)}`);
  }
  if (!Number.isInteger(root.concurrency.value) || root.concurrency.value<1 || root.concurrency.value>4) {
    throw new TypeError("manifest concurrency must be an integer from 1 to 4");
  }
  if (!Array.isArray(eligibleEntries)) {
    throw new TypeError("eligible entries must be an array");
  }
  const eligible=new Set(eligibleEntries);
  const lanes=exactFields(root.lanes.value,OWNERSHIP_LANES,"lanes");
  const owners=new Map();
  const normalizedLanes={};
  for (const lane of OWNERSHIP_LANES) {
    const entries=denseArray(lanes[lane].value,`lane ${lane}`);
    asciiSortedUnique(entries,lane);
    for (const entry of entries) {
      assertSafeEntryPath(entry);
      if (!eligible.has(entry)) {
        throw new TypeError(`unknown entry: ${entry}`);
      }
      if (owners.has(entry)) {
        throw new TypeError(`multiple owners for ${entry}: ${owners.get(entry)}, ${lane}`);
      }
      owners.set(entry,lane);
    }
    normalizedLanes[lane]=Object.freeze(entries);
  }
  for (const entry of eligibleEntries) {
    if (!owners.has(entry)) {
      throw new TypeError(`missing owner for ${entry}`);
    }
  }
  return Object.freeze({
    schema_version:root.schema_version.value,
    concurrency:root.concurrency.value,
    lanes:Object.freeze(normalizedLanes),
  });
}
