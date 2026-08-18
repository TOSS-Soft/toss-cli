import {canonicalJson} from "../contracts/acp.js";
import {types as utilTypes} from "node:util";

export const COMMAND_RESULT_VERSION="command-result.v1";

function canonicalClone(value,label) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    let detail="invalid value";
    try {
      const descriptor=error && (typeof error==="object" || typeof error==="function") ?
        Object.getOwnPropertyDescriptor(error,"message") : null;
      if (descriptor && "value" in descriptor && typeof descriptor.value==="string") {
        detail=descriptor.value;
      }
    } catch {
      // Keep the literal fallback; caught values are untrusted.
    }
    throw new TypeError(
      `${label} must be canonical JSON: ${detail}`,
    );
  }
}

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const NATIVE_ERROR_KEYS=new Set([
  "message","stack","cause","code","exitCode","name",
]);

export function inspectNativeCommandError(error) {
  if (!error || (typeof error!=="object" && typeof error!=="function")) return null;
  try {
    if (utilTypes.isProxy(error) || !utilTypes.isNativeError(error)) return null;
  } catch {
    return null;
  }
  let descriptors;
  try {
    descriptors=Object.getOwnPropertyDescriptors(error);
  } catch {
    throw new TypeError("Native command error properties could not be inspected safely");
  }
  const keys=Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key==="symbol")) {
    throw new TypeError("Command error symbol properties are unsupported");
  }
  const names=keys.sort();
  if (names.some(key => !NATIVE_ERROR_KEYS.has(key))) {
    throw new TypeError("Command error has unknown properties");
  }
  for (const key of names) {
    const descriptor=descriptors[key];
    if (!("value" in descriptor)) {
      if (key==="stack") continue;
      throw new TypeError(`Command error accessor property is unsupported: ${key}`);
    }
  }
  const message=descriptors.message?.value;
  const code=Object.hasOwn(descriptors,"code") ?
    descriptors.code.value : "COMMAND_FAILED";
  const exitCode=Object.hasOwn(descriptors,"exitCode") ?
    descriptors.exitCode.value : null;
  if (typeof message!=="string" || typeof code!=="string" ||
      !(exitCode===null || typeof exitCode==="number")) {
    throw new TypeError("Native command error metadata must use primitive values");
  }
  return Object.freeze({
    error:Object.freeze({code,message}),
    exitCode,
  });
}

function errorRecord(error) {
  const native=inspectNativeCommandError(error);
  if (native) return native.error;
  let proxy;
  try {
    proxy=utilTypes.isProxy(error);
  } catch {
    throw new TypeError("Command error identity could not be inspected safely");
  }
  if (proxy) throw new TypeError("Command error proxies are unsupported");
  if (!error || typeof error!=="object" || Array.isArray(error)) {
    throw new TypeError("Command error must be a plain object");
  }
  const prototype=Object.getPrototypeOf(error);
  if (prototype!==Object.prototype && prototype!==null) {
    throw new TypeError("Command error must use a plain object prototype");
  }
  const descriptors=Object.getOwnPropertyDescriptors(error);
  const keys=Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key==="symbol") ||
      keys.sort().join(",")!=="code,message") {
    throw new TypeError("Command error must contain exactly code and message");
  }
  for (const key of keys) {
    const descriptor=descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Command error properties must be enumerable data properties");
    }
    if (typeof descriptor.value!=="string") {
      throw new TypeError("Command error code and message must be strings");
    }
  }
  const normalized=canonicalClone(error,"Command error");
  return normalized;
}

function assertErrorRecord(error) {
  if (typeof error.code!=="string" || !/^[A-Z][A-Z0-9_]*$/.test(error.code)) {
    throw new TypeError("Command error code must be a stable uppercase identifier");
  }
  if (typeof error.message!=="string" || !/\S/.test(error.message)) {
    throw new TypeError("Command error message must be a non-empty string");
  }
  return error;
}

export function successResult(data) {
  return deepFreeze({
    schema_version:COMMAND_RESULT_VERSION,
    document_type:"command-result",
    ok:true,
    data:canonicalClone(data,"Command result data"),
    error:null,
  });
}

export function failureResult(error) {
  return deepFreeze({
    schema_version:COMMAND_RESULT_VERSION,
    document_type:"command-result",
    ok:false,
    data:null,
    error:assertErrorRecord(errorRecord(error)),
  });
}

export function renderCommandJson(result) {
  return JSON.stringify(result,null,2);
}

export function renderCommandHuman(result) {
  if (!result.ok) return result.error.message;
  if (typeof result.data==="string") return result.data;
  if (result.data && typeof result.data.message==="string") {
    return result.data.message;
  }
  return JSON.stringify(result.data,null,2);
}
