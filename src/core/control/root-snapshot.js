import {types} from "node:util";

const SHA=/^[a-f0-9]{40}$/u;
const SEGMENT=/^[A-Za-z0-9._-]+$/u;
const REPOSITORY_FILENAME=/^[a-z0-9._-]+%2F[a-z0-9._-]+[.]yaml$/u;

export const CONTROL_ROOTS=Object.freeze([
  "config","intents","migrations","policies","programs","receipts",
]);

function rawCompare(left,right) {
  return left===right ? 0 : left<right ? -1 : 1;
}

export function assertSafeSnapshotPath(value) {
  if (typeof value!=="string" || !value || value.includes("\\") ||
      value.startsWith("/") || value.includes("\0") || /^[A-Za-z]:/u.test(value)) {
    throw new TypeError("root snapshot contains an unsafe path");
  }
  const segments=value.split("/");
  const generatedRepositoryPath=segments.length===3 && segments[0]==="config" &&
    segments[1]==="repositories" && REPOSITORY_FILENAME.test(segments[2]) &&
    encodeURIComponent(decodeURIComponent(segments[2].slice(0,-5)))===segments[2].slice(0,-5);
  if (!generatedRepositoryPath && segments.some(segment =>
    !segment || segment==="." || segment===".." || !SEGMENT.test(segment))) {
    throw new TypeError("root snapshot contains an unsafe path");
  }
  return value;
}

export function closeDocumentPaths(value,label) {
  if (!Array.isArray(value) || types.isProxy(value) ||
      Object.getPrototypeOf(value)!==Array.prototype) {
    throw new TypeError(`${label} must be an ordinary non-proxy array`);
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const keys=Reflect.ownKeys(descriptors);
  const expected=[...Array(value.length).keys()].map(String).concat("length");
  if (keys.some(key => typeof key!=="string") || keys.length!==expected.length ||
      expected.some(key => !Object.hasOwn(descriptors,key))) {
    throw new TypeError(`${label} must be dense and contain no extra properties`);
  }
  const paths=[];
  for (let index=0;index<value.length;index+=1) {
    const descriptor=descriptors[String(index)];
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain only enumerable data entries`);
    }
    paths.push(assertSafeSnapshotPath(descriptor.value));
  }
  for (let index=1;index<paths.length;index+=1) {
    if (rawCompare(paths[index-1],paths[index])>=0) {
      throw new TypeError(`${label} must be strictly sorted and unique`);
    }
  }
  return Object.freeze(paths);
}

export function closeRootSnapshot(value) {
  if (value===null || typeof value!=="object" || types.isProxy(value) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("root snapshot must be an ordinary non-proxy object");
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const keys=Reflect.ownKeys(descriptors);
  if (keys.length!==2 || keys.some(key => typeof key!=="string") ||
      !Object.hasOwn(descriptors,"revision") || !Object.hasOwn(descriptors,"paths")) {
    throw new TypeError("root snapshot must contain exactly revision and paths");
  }
  for (const key of ["revision","paths"]) {
    if (!("value" in descriptors[key]) || !descriptors[key].enumerable) {
      throw new TypeError("root snapshot fields must be own enumerable data");
    }
  }
  const revision=descriptors.revision.value;
  if (typeof revision!=="string" || !SHA.test(revision)) {
    throw new TypeError("root snapshot revision must be an exact Git SHA");
  }
  return Object.freeze({
    revision,
    paths:closeDocumentPaths(descriptors.paths.value,"root snapshot paths"),
  });
}

export function hasControlMaterial(paths) {
  return paths.some(path => CONTROL_ROOTS.some(root => path===root || path.startsWith(`${root}/`)));
}
