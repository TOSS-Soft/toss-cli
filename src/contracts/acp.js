import {createHash} from "node:crypto";
import fs from "node:fs";

export const ACP_VERSION="acp.v1";
export const ENTITY_ID_PATTERN=/^(?:REQ|NFR|BR|FLOW|ARCHQ|ADR|EPIC|ISSUE|AC|RISK|ASM|Q)-[A-Z0-9]+(?:[._-][A-Z0-9]+)*$/;

const registry=JSON.parse(fs.readFileSync(
  new URL("../../contracts/registry.json",import.meta.url),
  "utf8",
));

function nonJson(path,detail) {
  throw new TypeError(`Non-JSON value at ${path}: ${detail}`);
}

function encodeCanonical(value,path,ancestors) {
  if (value===null) return "null";

  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) nonJson(path,"number must be finite");
      return JSON.stringify(value);
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      return nonJson(path,`unsupported ${typeof value}`);
    default:
      break;
  }

  if (ancestors.has(value)) nonJson(path,"cyclic reference");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value)!==Array.prototype) {
        nonJson(path,"arrays must use Array.prototype");
      }
      const symbols=Object.getOwnPropertySymbols(value);
      if (symbols.length > 0) {
        nonJson(path,"symbol keys are unsupported");
      }
      const names=Object.getOwnPropertyNames(value);
      const keys=names.filter(key => key!=="length").sort((left,right) =>
        Number(left)-Number(right));
      if (names.length!==value.length+1 ||
          keys.length!==value.length ||
          keys.some((key,index) => key!==String(index))) {
        nonJson(path,"arrays must be dense and have no named properties");
      }
      const items=[];
      for (const key of keys) {
        const descriptor=Object.getOwnPropertyDescriptor(value,key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          nonJson(`${path}[${key}]`,"accessor properties are unsupported");
        }
        items.push(descriptor.value);
      }
      return `[${items.map((item,index) =>
        encodeCanonical(item,`${path}[${index}]`,ancestors)).join(",")}]`;
    }

    const prototype=Object.getPrototypeOf(value);
    if (prototype!==Object.prototype && prototype!==null) {
      nonJson(path,"objects must be plain JSON objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      nonJson(path,"symbol keys are unsupported");
    }

    const keys=Object.getOwnPropertyNames(value).sort();
    const entries=[];
    for (const key of keys) {
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if (!descriptor || !("value" in descriptor)) {
        nonJson(`${path}.${key}`,"accessor properties are unsupported");
      }
      if (!descriptor.enumerable) {
        nonJson(`${path}.${key}`,"non-enumerable properties are unsupported");
      }
      entries.push([key,descriptor.value]);
    }
    return `{${entries.map(([key,item]) =>
      `${JSON.stringify(key)}:${encodeCanonical(item,`${path}.${key}`,ancestors)}`
    ).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value) {
  return encodeCanonical(value,"$",new Set());
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value),"utf8").digest("hex");
}

export function assertKnownDocumentType(type,version) {
  const candidates=registry.documents.filter(row => row.document_type===type);
  if (candidates.length===0) {
    throw new Error(`Unknown document type: ${String(type)}`);
  }
  if (!candidates.some(row => row.schema_version===version)) {
    throw new Error(
      `Unknown schema version ${String(version)} for document type ${String(type)}`,
    );
  }
}

export function assertStableEntityMeanings(entities) {
  if (!Array.isArray(entities)) {
    throw new TypeError("Entities must be an array");
  }
  const meanings=new Map();
  for (const [index,entity] of entities.entries()) {
    if (!entity || typeof entity!=="object" || Array.isArray(entity)) {
      throw new TypeError(`Entity at index ${index} must be an object`);
    }
    if (typeof entity.id!=="string" || !ENTITY_ID_PATTERN.test(entity.id)) {
      throw new Error(`Invalid entity ID at index ${index}: ${String(entity.id)}`);
    }
    if (typeof entity.kind!=="string" || entity.kind.length===0 ||
        !("meaning" in entity)) {
      throw new TypeError(`Entity ${entity.id} must declare kind and meaning`);
    }
    const meaning=canonicalJson({kind:entity.kind,meaning:entity.meaning});
    if (meanings.has(entity.id) && meanings.get(entity.id)!==meaning) {
      throw new Error(`Entity ID ${entity.id} reused with a different meaning`);
    }
    meanings.set(entity.id,meaning);
  }
}
