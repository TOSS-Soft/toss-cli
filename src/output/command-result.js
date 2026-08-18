import {canonicalJson} from "../contracts/acp.js";

export const COMMAND_RESULT_VERSION="command-result.v1";

function canonicalClone(value,label) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(
      `${label} must be canonical JSON: ${error instanceof Error ? error.message : "invalid value"}`,
      {cause:error},
    );
  }
}

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function errorRecord(error) {
  if (error instanceof Error) {
    if (Object.getOwnPropertySymbols(error).length>0) {
      throw new TypeError("Command error symbol properties are unsupported");
    }
    const allowed=new Set(["message","stack","cause","code","exitCode","name"]);
    for (const key of Object.getOwnPropertyNames(error)) {
      const descriptor=Object.getOwnPropertyDescriptor(error,key);
      if (!descriptor || !("value" in descriptor)) {
        if (key==="stack") continue;
        throw new TypeError(`Command error accessor property is unsupported: ${key}`);
      }
      if (!allowed.has(key)) {
        throw new TypeError(`Unknown command error property: ${key}`);
      }
    }
    const message=Object.getOwnPropertyDescriptor(error,"message")?.value;
    const code=Object.getOwnPropertyDescriptor(error,"code")?.value ?? "COMMAND_FAILED";
    return {code,message};
  }
  const normalized=canonicalClone(error,"Command error");
  if (!normalized || typeof normalized!=="object" || Array.isArray(normalized)) {
    throw new TypeError("Command error must be a plain object or Error");
  }
  const keys=Object.keys(normalized).sort();
  if (keys.join(",")!=="code,message") {
    throw new TypeError("Command error must contain exactly code and message properties");
  }
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
