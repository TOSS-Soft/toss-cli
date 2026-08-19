import {types as utilTypes} from "node:util";

import {canonicalJson} from "./contracts/acp.js";

const CAPABILITY_REGISTRIES=new WeakMap();
const RUNTIME_SERVICES=new WeakMap();

export class DesignRuntimeAuthorityError extends Error {
  constructor(code,message,exitCode=4) {
    super(message);
    this.name="DesignRuntimeAuthorityError";
    this.code=code;
    this.exitCode=exitCode;
  }
}

function dataRecord(value,label,allowed,{required=[]}={}) {
  if (!value || typeof value!=="object" || Array.isArray(value) ||
      utilTypes.isProxy(value) ||
      !new Set([Object.prototype,null]).has(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain non-proxy object`);
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const keys=Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key==="symbol")) {
    throw new TypeError(`${label} symbol properties are unsupported`);
  }
  const result=Object.create(null);
  for (const key of keys) {
    const descriptor=descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor) || !allowed.has(key)) {
      throw new TypeError(`${label} contains an accessor, hidden, or unexpected property`);
    }
    result[key]=descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(descriptors,key)) throw new TypeError(`${label} requires ${key}`);
  }
  return result;
}

function canonicalCopy(value,label) {
  const ancestors=new Set();
  function capture(item,pathLabel) {
    if (item===null || typeof item==="string" || typeof item==="boolean") return item;
    if (typeof item==="number" && Number.isFinite(item)) return item;
    if (!item || typeof item!=="object" || utilTypes.isProxy(item)) {
      throw new TypeError(`${pathLabel} must contain only canonical JSON values`);
    }
    if (ancestors.has(item)) throw new TypeError(`${pathLabel} must not contain cycles`);
    ancestors.add(item);
    try {
      const array=Array.isArray(item);
      const prototype=Object.getPrototypeOf(item);
      if (array ? prototype!==Array.prototype :
        (prototype!==Object.prototype && prototype!==null)) {
        throw new TypeError(`${pathLabel} must use canonical JSON prototypes`);
      }
      const descriptors=Object.getOwnPropertyDescriptors(item);
      const keys=Reflect.ownKeys(descriptors);
      if (keys.some(key => typeof key==="symbol")) {
        throw new TypeError(`${pathLabel} symbol properties are unsupported`);
      }
      if (array) {
        const names=keys.filter(key => key!=="length").sort((left,right) =>
          Number(left)-Number(right));
        if (names.length!==item.length ||
            names.some((key,index) => key!==String(index))) {
          throw new TypeError(`${pathLabel} arrays must be dense and closed`);
        }
        return names.map(key => {
          const descriptor=descriptors[key];
          if (!descriptor.enumerable || !("value" in descriptor)) {
            throw new TypeError(`${pathLabel} accessor or hidden values are unsupported`);
          }
          return capture(descriptor.value,`${pathLabel}[${key}]`);
        });
      }
      const result=Object.create(null);
      for (const key of keys.sort()) {
        const descriptor=descriptors[key];
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError(`${pathLabel} accessor or hidden values are unsupported`);
        }
        result[key]=capture(descriptor.value,`${pathLabel}.${key}`);
      }
      return result;
    } finally {
      ancestors.delete(item);
    }
  }
  try {
    return JSON.parse(canonicalJson(capture(value,label)));
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON`,{cause:error});
  }
}

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function callable(value,label) {
  if (typeof value!=="function" || utilTypes.isProxy(value)) {
    throw new TypeError(`${label} must be a non-proxy function`);
  }
  return value;
}

export function createLifecycleRuntimeProvider(value) {
  const record=dataRecord(
    value,"lifecycle runtime provider configuration",
    new Set(["authorityRegistry","prompt"]),
    {required:["authorityRegistry","prompt"]},
  );
  const authorityRegistry=deepFreeze(canonicalCopy(
    record.authorityRegistry,"lifecycle authority registry",
  ));
  const authorityCapability=Object.freeze(Object.create(null));
  CAPABILITY_REGISTRIES.set(authorityCapability,authorityRegistry);
  const services=Object.freeze({
    authorityCapability,
    prompt:callable(record.prompt,"lifecycle prompt"),
  });
  const provider=Object.freeze(Object.create(null));
  RUNTIME_SERVICES.set(provider,services);
  return provider;
}

export function lifecycleRuntimeServices(provider) {
  const services=RUNTIME_SERVICES.get(provider);
  if (!services) {
    throw new DesignRuntimeAuthorityError(
      "DESIGN_RUNTIME_INVALID","Lifecycle runtime provider is not constructor-bound",
    );
  }
  return services;
}

export function registryFromDesignAuthorityCapability(capability) {
  if (capability===undefined) return Object.freeze({actors:Object.freeze([])});
  const registry=CAPABILITY_REGISTRIES.get(capability);
  if (!registry) {
    throw new DesignRuntimeAuthorityError(
      "DESIGN_RUNTIME_INVALID","Design authority capability is not constructor-bound",
    );
  }
  return registry;
}
