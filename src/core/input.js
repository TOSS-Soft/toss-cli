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
  const target=resolve(root,value);
  const rel=relative(root,target);
  if (!rel || rel===".." || rel.startsWith(`..${sep}`) || resolve(root,rel)!==target) {
    throw new CoreValidationError("Input path must be a safe relative path within cwd");
  }
  const extension=[...EXTENSIONS].find(candidate => target.endsWith(candidate));
  if (!extension) throw new CoreValidationError("Input path must use a JSON or YAML extension");
  return {target,extension};
}

async function rejectSymlinkParents(root,target) {
  let current=root;
  const parts=relative(root,target).split(sep);
  for (const part of parts) {
    current=resolve(current,part);
    const stat=await lstat(current);
    if (stat.isSymbolicLink()) throw new CoreValidationError("Input path may not traverse a symbolic link");
  }
}

async function readFixed(handle,maxBytes) {
  const stat=await handle.stat();
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
  return Buffer.concat(chunks).toString("utf8");
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
    await rejectSymlinkParents(root,target);
    let handle;
    try {
      handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
      return parse(await readFixed(handle,maxBytes),extension);
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
