import {types} from "node:util";

import {canonicalJson} from "../../contracts/acp.js";
import {CoreBlockedError,CoreValidationError} from "../errors.js";

export function closedData(value,label,path="$",ancestors=new Set()) {
  if (value===null || ["string","boolean"].includes(typeof value)) return value;
  if (typeof value==="number") {
    if (!Number.isFinite(value)) throw new CoreValidationError(`${label} ${path} must be finite`);
    return value;
  }
  if (!value || typeof value!=="object" || types.isProxy(value) || ancestors.has(value)) {
    throw new CoreValidationError(`${label} ${path} must be closed plain non-proxy data`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value)!==Array.prototype || Object.getOwnPropertySymbols(value).length!==0 ||
          Object.getOwnPropertyNames(value).length!==value.length+1) throw new CoreValidationError(`${label} ${path} must be a dense plain array`);
      return Object.freeze(value.map((_,index) => {
        const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new CoreValidationError(`${label} ${path} contains an accessor`);
        return closedData(descriptor.value,label,`${path}[${index}]`,ancestors);
      }));
    }
    if (![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length!==0) throw new CoreValidationError(`${label} ${path} must be a plain object`);
    const output=Object.create(null);
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new CoreValidationError(`${label} ${path}.${key} contains an accessor or hidden property`);
      output[key]=closedData(descriptor.value,label,`${path}.${key}`,ancestors);
    }
    return Object.freeze(output);
  } finally { ancestors.delete(value); }
}

export function exact(value,keys,label) {
  if (!value || typeof value!=="object" || Array.isArray(value) ||
      canonicalJson(Object.keys(value).sort())!==canonicalJson([...keys].sort())) {
    throw new CoreValidationError(`${label} must use an exact closed shape`);
  }
  return value;
}

export function ownDataFunction(value,key,label) {
  if (!value || typeof value!=="object" || types.isProxy(value)) throw new CoreValidationError(`${label} must be a non-proxy object`);
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value!=="function" || types.isProxy(descriptor.value)) {
    throw new CoreValidationError(`${label}.${key} must be an own-data non-proxy function`);
  }
  return descriptor.value;
}

export function requireAuthority(command,services) {
  if (command.options.apply!==true) return Promise.resolve(null);
  if (command.options.authority===null) throw new CoreBlockedError("Apply requires an explicit authority record");
  return ownDataFunction(services,"readAuthority","services")(command.options.authority);
}
