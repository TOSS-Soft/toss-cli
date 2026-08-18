import {canonicalJson} from "../contracts/acp.js";

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

function errorRecord(error) {
  if (!error || (typeof error!=="object" && typeof error!=="function")) {
    throw new TypeError("Command error must be a closed object");
  }
  let descriptors;
  try {
    descriptors=Object.getOwnPropertyDescriptors(error);
  } catch {
    throw new TypeError("Command error properties could not be inspected safely");
  }
  const keys=Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key==="symbol")) {
    throw new TypeError("Command error symbol properties are unsupported");
  }
  const names=keys.sort();
  const plain=names.join(",")==="code,message";
  if (plain) return canonicalClone(error,"Command error");
  const allowed=new Set(["message","stack","cause","code","exitCode","name"]);
  if (names.some(key => !allowed.has(key))) {
    throw new TypeError("Command error has unknown properties");
  }
  for (const key of names) {
    const descriptor=descriptors[key];
    if (!("value" in descriptor)) {
      if (key==="stack") continue;
      throw new TypeError(`Command error accessor property is unsupported: ${key}`);
    }
  }
  if (!Object.hasOwn(descriptors,"message")) {
    throw new TypeError("Command error must have an own message property");
  }
  return {
    code:Object.hasOwn(descriptors,"code") ? descriptors.code.value : "COMMAND_FAILED",
    message:descriptors.message?.value,
  };
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
