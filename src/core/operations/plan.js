import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {validateCoreDocument} from "../contracts.js";
import {CoreValidationError} from "../errors.js";
import {compareOperations} from "../operation-order.js";

const MAX_OPERATION_INPUT_DEPTH=64;

function fail(message) {
  throw new CoreValidationError(message);
}

function closedClone(value,path="$",ancestors=new Set(),depth=0) {
  if (depth>MAX_OPERATION_INPUT_DEPTH) fail(`Operation input ${path} exceeds the maximum closed-data depth`);
  if (value===null || ["string","number","boolean"].includes(typeof value)) {
    if (typeof value==="number" && !Number.isFinite(value)) fail(`Operation input ${path} must be finite`);
    return value;
  }
  if (typeof value!=="object" || types.isProxy(value)) fail(`Operation input ${path} must be plain and non-proxy`);
  if (ancestors.has(value)) fail(`Operation input ${path} must not be cyclic`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value)!==Array.prototype || Object.getOwnPropertySymbols(value).length!==0 ||
          Object.getOwnPropertyNames(value).length!==value.length+1) fail(`Operation input ${path} must be a dense plain array`);
      return Object.freeze(value.map((_,index) => {
        const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`Operation input ${path}[${index}] contains an accessor`);
        return closedClone(descriptor.value,`${path}[${index}]`,ancestors,depth+1);
      }));
    }
    if (![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length!==0) {
      fail(`Operation input ${path} must be a plain object`);
    }
    const clone=Object.create(null);
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`Operation input ${path}.${key} contains an accessor or hidden field`);
      clone[key]=closedClone(descriptor.value,`${path}.${key}`,ancestors,depth+1);
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
}

function exactKeys(value,keys,label) {
  if (value===null || typeof value!=="object" || Array.isArray(value) ||
      canonicalJson(Object.keys(value).sort())!==canonicalJson([...keys].sort())) {
    fail(`${label} must use the exact closed shape`);
  }
}

function normalizeOperation(value) {
  const keys=Object.keys(value).sort();
  const required=["resource","action","repository","expected_revision","payload"].sort();
  if (canonicalJson(keys)!==canonicalJson(required) && canonicalJson(keys)!==canonicalJson([...required,"compensation"].sort())) fail("operation must use the exact closed shape");
  return Object.freeze({
    resource:value.resource,
    action:value.action,
    repository:value.repository,
    expected_revision:value.expected_revision,
    payload:value.payload,
    ...(Object.hasOwn(value,"compensation") ? {compensation:value.compensation} : {}),
  });
}

export function createOperationIntent(input) {
  const value=closedClone(input);
  const required=["intent_id","created_at","command","policy_revision","source","authority","operations"];
  const keys=Object.hasOwn(value,"planned_receipt_id") ? [...required,"planned_receipt_id"] : required;
  exactKeys(value,keys,"operation intent input");
  exactKeys(value.source,["repository","revision","sha256"],"operation intent source");
  if (!Array.isArray(value.operations) || value.operations.length===0) fail("Operation intent input must contain operations");
  const operations=value.operations.map(normalizeOperation).sort(compareOperations).map((operation,index) => Object.freeze({
    operation_id:`OP-${String(index+1).padStart(4,"0")}`,
    ...operation,
  }));
  const intent=Object.freeze({
    schema_version:"operation-intent.v1",
    document_type:"operation-intent",
    intent_id:value.intent_id,
    command:value.command,
    created_at:value.created_at,
    policy_revision:value.policy_revision,
    source:value.source,
    authority:value.authority,
    ...(Object.hasOwn(value,"planned_receipt_id")
      ? {planned_receipt_id:value.planned_receipt_id}
      : {}),
    operations:Object.freeze(operations),
  });
  validateCoreDocument(intent,"operation-intent.v1");
  return intent;
}

export function operationPreview(intent) {
  const valid=validateCoreDocument(closedClone(intent),"operation-intent.v1");
  return Object.freeze({
    schema_version:"operation-preview.v1",
    intent_id:valid.intent_id,
    intent_sha256:sha256Canonical(valid),
    command:valid.command,
    operations:valid.operations,
  });
}
