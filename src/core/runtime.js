import * as path from "node:path";
import {lstatSync,realpathSync} from "node:fs";
import {types} from "node:util";

import {createCoreInputReader} from "./input.js";
import {createGitControlRepository} from "./control/git-repository.js";
import {createCoreControlStore} from "./control/store.js";
import {createOperationRunner} from "./operations/runner.js";

const OPTION_KEYS=new Set(["cwd","controlPath","execFile","github","clock","idGenerator","authorityRegistry","inputReader","policyRevision"]);
function ownOptions(options) {
  if (!options || typeof options!=="object" || Array.isArray(options) || types.isProxy(options) || ![Object.prototype,null].includes(Object.getPrototypeOf(options))) throw new TypeError("core runtime options must be a plain non-proxy object");
  const out=Object.create(null);
  for (const key of Reflect.ownKeys(options)) {
    const descriptor=Object.getOwnPropertyDescriptor(options,key);
    if (typeof key!=="string" || !descriptor.enumerable || !("value" in descriptor) || !OPTION_KEYS.has(key)) throw new TypeError("core runtime options contain an accessor, hidden, symbol, or unexpected property");
    out[key]=descriptor.value;
  }
  for (const key of ["cwd","controlPath","execFile","github","clock","idGenerator","authorityRegistry","policyRevision"]) if (!Object.hasOwn(out,key)) throw new TypeError(`core runtime options require ${key}`);
  return out;
}
function ownFunction(value,key,label) {
  if (!value || typeof value!=="object" || types.isProxy(value)) throw new TypeError(`${label} must be a non-proxy object`);
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value!=="function" || types.isProxy(descriptor.value)) throw new TypeError(`${label}.${key} must be an own-data non-proxy function`);
  return descriptor.value;
}
function functionValue(value,label) {
  if (typeof value!=="function" || types.isProxy(value)) throw new TypeError(`${label} must be an own-data non-proxy function`);
  return value;
}
function port(value,label,methods) {
  if (!value || typeof value!=="object" || types.isProxy(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain non-proxy object`);
  const keys=Reflect.ownKeys(value);
  if (keys.length!==methods.length || methods.some(key => !Object.hasOwn(value,key))) throw new TypeError(`${label} must have the exact required port methods`);
  for (const key of methods) {
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if (!descriptor?.enumerable) throw new TypeError(`${label} must not contain hidden port methods`);
    ownFunction(value,key,label);
  }
  return value;
}
export function assertNoSymlinkRelativePath(root,segments,{pathApi=path,lstat=lstatSync}={}) {
  let current=root;
  for (const segment of segments) {
    current=pathApi.join(current,segment);
    try {
      if (lstat(current).isSymbolicLink()) throw new TypeError("core runtime controlPath must not traverse a symbolic link");
    } catch (error) {
      if (error?.code!=="ENOENT") throw error;
    }
  }
}

function safeControlPath(cwd,value) {
  if (typeof value!=="string" || !value || value.includes("\0") || value.includes("\\") || path.isAbsolute(value) || /^[A-Za-z]:/u.test(value) || value.split("/").some(segment => !segment || segment==="." || segment==="..")) throw new TypeError("core runtime controlPath must use safe relative segments");
  const lexicalRoot=path.resolve(cwd);
  let root=lexicalRoot;
  try {
    root=realpathSync(lexicalRoot);
  } catch (error) {
    if (error?.code!=="ENOENT") throw error;
  }
  const target=path.resolve(root,value); const rel=path.relative(root,target);
  if (!rel || rel===".." || rel.startsWith(`..${path.sep}`)) throw new TypeError("core runtime controlPath must remain within cwd");
  assertNoSymlinkRelativePath(root,rel.split(path.sep).filter(Boolean));
  return target;
}

function controlClock(clock) {
  return () => {
    const value=clock();
    if (typeof value!=="string") return value;
    const milliseconds=Date.parse(value);
    return Number.isSafeInteger(milliseconds) && milliseconds>=0 ? milliseconds : value;
  };
}

export function createCoreRuntime(options) {
  const value=ownOptions(options);
  if (typeof value.cwd!=="string" || !value.cwd.trim() || typeof value.controlPath!=="string" || !value.controlPath.trim()) throw new TypeError("core runtime cwd and controlPath must be nonblank paths");
  const execFile=functionValue(value.execFile,"core runtime execFile");
  const github=port(value.github,"github",["snapshot","inspect","apply"]);
  const clock=functionValue(value.clock,"core runtime clock");
  const idGenerator=functionValue(value.idGenerator,"core runtime idGenerator");
  const policyRevision=functionValue(value.policyRevision,"core runtime policyRevision");
  if (!value.authorityRegistry || typeof value.authorityRegistry!=="object" || types.isProxy(value.authorityRegistry)) throw new TypeError("core runtime authorityRegistry must be explicit non-proxy data");
  const reader=value.inputReader===undefined ? createCoreInputReader({cwd:value.cwd}) : port(value.inputReader,"inputReader",["readInput","readAuthority"]);
  const repository=createGitControlRepository({
    root:safeControlPath(value.cwd,value.controlPath),
    execFile,
    clock:controlClock(clock),
  });
  const control=createCoreControlStore({repository});
  const operations=createOperationRunner({control,github,authorityRegistry:value.authorityRegistry,clock,idGenerator,policyRevision});
  return Object.freeze({control,github,operations,clock,idGenerator,readInput:reader.readInput,readAuthority:reader.readAuthority});
}
