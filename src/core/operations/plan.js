import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {validateCoreDocument} from "../contracts.js";
import {CoreValidationError} from "../errors.js";

function fail(message) {
  throw new CoreValidationError(message);
}

function closedClone(value,path="$",ancestors=new Set()) {
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
        return closedClone(descriptor.value,`${path}[${index}]`,ancestors);
      }));
    }
    if (![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length!==0) {
      fail(`Operation input ${path} must be a plain object`);
    }
    const clone=Object.create(null);
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`Operation input ${path}.${key} contains an accessor or hidden field`);
      clone[key]=closedClone(descriptor.value,`${path}.${key}`,ancestors);
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

function nullFirst(left,right) {
  if (left===right) return 0;
  if (left===null) return -1;
  if (right===null) return 1;
  return left<right ? -1 : 1;
}

function compareText(left,right) {
  if (left===right) return 0;
  return left<right ? -1 : 1;
}

function normalizeOperation(value) {
  exactKeys(value,["resource","action","repository","expected_revision","payload"],"operation");
  return Object.freeze({
    resource:value.resource,
    action:value.action,
    repository:value.repository,
    expected_revision:value.expected_revision,
    payload:value.payload,
  });
}

function compareOperations(left,right) {
  for (const [a,b] of [[left.repository,right.repository],[left.resource,right.resource],[left.action,right.action]]) {
    const comparison=nullFirst(a,b);
    if (comparison!==0) return comparison;
  }
  const payload=compareText(canonicalJson(left.payload),canonicalJson(right.payload));
  if (payload!==0) return payload;
  const revision=nullFirst(left.expected_revision,right.expected_revision);
  if (revision!==0) return revision;
  return compareText(canonicalJson(left),canonicalJson(right));
}

export function createOperationIntent(input) {
  const value=closedClone(input);
  exactKeys(value,["intent_id","created_at","command","policy_revision","source","authority","operations"],"operation intent input");
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
