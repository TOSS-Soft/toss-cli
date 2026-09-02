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
    const prototype=Object.getPrototypeOf(value);
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const keys=Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      const lengthDescriptor=Object.getOwnPropertyDescriptor(descriptors,"length")?.value;
      const length=lengthDescriptor?.value;
      if (prototype!==Array.prototype || !lengthDescriptor || !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(length) || length<0 || length>0xffffffff ||
          lengthDescriptor.enumerable!==false || lengthDescriptor.configurable!==false ||
          typeof lengthDescriptor.writable!=="boolean" ||
          (lengthDescriptor.writable===false && Object.isExtensible(value)) ||
          keys.length!==length+1) {
        throw new CoreValidationError(`${label} ${path} must be a dense plain array`);
      }
      const output=[];
      for (let index=0;index<length;index+=1) {
        const captured=Object.getOwnPropertyDescriptor(descriptors,String(index));
        const descriptor=captured?.value;
        if (!captured || !("value" in captured) || !descriptor ||
            !("value" in descriptor) || !descriptor.enumerable ||
            (lengthDescriptor.writable===false &&
             (descriptor.writable!==false || descriptor.configurable!==false))) {
          throw new CoreValidationError(`${label} ${path} must contain dense own data`);
        }
        output.push(closedData(descriptor.value,label,`${path}[${index}]`,ancestors));
      }
      return Object.freeze(output);
    }
    if (![Object.prototype,null].includes(prototype) ||
        keys.some(key => typeof key!=="string")) {
      throw new CoreValidationError(`${label} ${path} must be a plain object`);
    }
    const output=Object.create(null);
    for (const key of keys) {
      const descriptor=Object.getOwnPropertyDescriptor(descriptors,key)?.value;
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

export function ownDataValue(value,key,label) {
  if (!value || typeof value!=="object" || types.isProxy(value)) throw new CoreValidationError(`${label} must be a non-proxy object`);
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw new CoreValidationError(`${label}.${key} must be an own enumerable data property`);
  }
  return descriptor.value;
}

export function requireAuthority(command,services) {
  if (command.options.apply!==true) return Promise.resolve(null);
  if (command.options.authority===null) throw new CoreBlockedError("Apply requires an explicit authority record");
  return ownDataFunction(services,"readAuthority","services")(command.options.authority);
}
