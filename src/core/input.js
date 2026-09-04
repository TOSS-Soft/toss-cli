import {constants} from "node:fs";
import {lstat,open} from "node:fs/promises";
import {relative,resolve,sep} from "node:path";
import {types} from "node:util";

import {canonicalJson} from "../contracts/acp.js";
import {fromYamlProjection} from "../contracts/yaml-projection.js";
import {validateCoreDocument} from "./contracts.js";
import {CoreValidationError} from "./errors.js";

const DEFAULT_MAX_BYTES=1024*1024;
const EXTENSIONS=new Set([".json",".yaml",".yml"]);

function ownDataOptions(options) {
  if (!options || typeof options!=="object" || Array.isArray(options) || types.isProxy(options) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(options))) {
    throw new TypeError("core input options must be a plain non-proxy object");
  }
  const descriptors=Object.getOwnPropertyDescriptors(options);
  const result=Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor=descriptors[key];
    if (typeof key!=="string" || !descriptor.enumerable || !("value" in descriptor) ||
        !new Set(["cwd","maxBytes"]).has(key)) {
      throw new TypeError("core input options contain an accessor, hidden, symbol, or unexpected property");
    }
    result[key]=descriptor.value;
  }
  if (typeof result.cwd!=="string" || !result.cwd.trim()) throw new TypeError("core input cwd must be a nonblank path");
  if (Object.hasOwn(result,"maxBytes") && (!Number.isSafeInteger(result.maxBytes) || result.maxBytes<1)) {
    throw new TypeError("core input maxBytes must be a positive safe integer");
  }
  return result;
}

function safePath(root,value) {
  if (typeof value!=="string" || !value || value.includes("\0") || value.includes("\\") ||
      value.startsWith("/") || /^[A-Za-z]:/u.test(value)) {
    throw new CoreValidationError("Input path must be a safe relative path");
  }
  if (value.split("/").some(segment => !segment || segment==="." || segment==="..")) {
    throw new CoreValidationError("Input path must be a safe relative path with non-dot segments");
  }
  const target=resolve(root,value);
  const rel=relative(root,target);
  if (!rel || rel===".." || rel.startsWith(`..${sep}`) || resolve(root,rel)!==target) {
    throw new CoreValidationError("Input path must be a safe relative path within cwd");
  }
  const extension=[...EXTENSIONS].find(candidate => target.endsWith(candidate));
  if (!extension) throw new CoreValidationError("Input path must use a JSON or YAML extension");
  return {target,extension};
}

function statIdentity(stat) {
  return Object.freeze({dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs});
}

function sameIdentity(before,after) {
  return before.dev===after.dev && before.ino===after.ino && before.size===after.size &&
    before.mtimeMs===after.mtimeMs && before.ctimeMs===after.ctimeMs;
}

async function checkedParents(root,target) {
  let current=root;
  const rootStat=await lstat(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new CoreValidationError("Input cwd must be a real directory, not a symbolic link");
  const snapshots=[[current,statIdentity(rootStat)]];
  const parts=relative(root,target).split(sep);
  for (const part of parts.slice(0,-1)) {
    current=resolve(current,part);
    const stat=await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreValidationError("Input path may not traverse a symbolic link");
    snapshots.push([current,statIdentity(stat)]);
  }
  const finalStat=await lstat(target);
  if (finalStat.isSymbolicLink()) throw new CoreValidationError("Input path may not traverse a symbolic link");
  return snapshots;
}

async function revalidateParents(snapshots) {
  for (const [path,before] of snapshots) {
    const after=await lstat(path);
    if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(before,statIdentity(after))) {
      throw new CoreValidationError("Input path changed while it was being opened");
    }
  }
}

async function readFixed(handle,maxBytes) {
  const stat=await handle.stat(); const before=statIdentity(stat);
  if (!stat.isFile()) throw new CoreValidationError("Input must be a regular file");
  if (stat.size>maxBytes) throw new CoreValidationError("Input exceeds the fixed maximum size");
  const chunks=[]; let total=0; const buffer=Buffer.allocUnsafe(Math.min(65536,maxBytes+1));
  for (;;) {
    const {bytesRead}=await handle.read(buffer,0,buffer.length,null);
    if (bytesRead===0) break;
    total+=bytesRead;
    if (total>maxBytes) throw new CoreValidationError("Input exceeds the fixed maximum size");
    chunks.push(Buffer.from(buffer.subarray(0,bytesRead)));
  }
  const after=statIdentity(await handle.stat());
  if (!sameIdentity(before,after)) throw new CoreValidationError("Input changed while it was being read");
  try { return new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)); } catch (error) {
    throw new CoreValidationError("Input must be valid UTF-8",{cause:error});
  }
}

function noMerge(value,path="$") {
  if (Array.isArray(value)) return value.forEach((item,index) => noMerge(item,`${path}[${index}]`));
  if (!value || typeof value!=="object") return;
  if (Object.hasOwn(value,"<<")) throw new CoreValidationError(`YAML merge keys are unsupported at ${path}`);
  for (const [key,item] of Object.entries(value)) noMerge(item,`${path}.${key}`);
}

function parse(text,extension) {
  let value;
  try { value=extension===".json" ? JSON.parse(text) : fromYamlProjection(text); } catch (error) {
    const detail=error instanceof Error ? error.message : "invalid syntax";
    throw new CoreValidationError(`Input is not valid closed JSON/YAML: ${detail}`,{cause:error});
  }
  noMerge(value);
  try { return Object.freeze(JSON.parse(canonicalJson(value))); } catch (error) {
    throw new CoreValidationError("Input must be plain canonical JSON data",{cause:error});
  }
}

export function createCoreInputReader(options) {
  const normalized=ownDataOptions(options);
  const root=resolve(normalized.cwd);
  const maxBytes=normalized.maxBytes ?? DEFAULT_MAX_BYTES;

  async function readInput(path) {
    const {target,extension}=safePath(root,path);
    let parents;
    let handle;
    try {
      parents=await checkedParents(root,target);
      handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
      await revalidateParents(parents);
      const value=await readFixed(handle,maxBytes);
      await revalidateParents(parents);
      return parse(value,extension);
    } catch (error) {
      if (error instanceof CoreValidationError) throw error;
      throw new CoreValidationError("Input file could not be read safely",{cause:error});
    } finally { await handle?.close(); }
  }

  async function readAuthority(path) {
    const value=await readInput(path);
    return validateCoreDocument(value,"authority-record.v1");
  }

  return Object.freeze({readInput,readAuthority});
}
