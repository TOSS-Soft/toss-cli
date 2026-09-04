import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {compareOperations} from "../operation-order.js";
import {CoreValidationError} from "../errors.js";

const MAX_CLOSED_DATA_DEPTH=64;

function invalid(message) {
  throw new CoreValidationError(message);
}

function copyClosed(value,label,ancestors=new Set(),depth=0) {
  if (depth>MAX_CLOSED_DATA_DEPTH) invalid(`${label} exceeds the maximum closed-data depth`);
  if (value===null || ["string","boolean"].includes(typeof value)) return value;
  if (typeof value==="number") {
    if (!Number.isFinite(value)) invalid(`${label} must contain finite JSON values`);
    return value;
  }
  if (typeof value!=="object" || types.isProxy(value) || ancestors.has(value)) {
    invalid(`${label} must contain acyclic plain non-proxy JSON data`);
  }
  ancestors.add(value);
  try {
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const keys=Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      const length=descriptors.length?.value;
      if (Object.getPrototypeOf(value)!==Array.prototype ||
          !Number.isSafeInteger(length) || length<0 || keys.length!==length+1) {
        invalid(`${label} arrays must be dense plain data`);
      }
      const result=[];
      for (let index=0;index<length;index+=1) {
        const descriptor=descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          invalid(`${label} arrays must contain only enumerable data`);
        }
        result.push(copyClosed(descriptor.value,`${label}[${index}]`,ancestors,depth+1));
      }
      return result;
    }
    if (![Object.prototype,null].includes(Object.getPrototypeOf(value))) {
      invalid(`${label} objects must be plain`);
    }
    const result={};
    for (const key of keys) {
      const descriptor=descriptors[key];
      if (typeof key!=="string" || !descriptor.enumerable || !("value" in descriptor)) {
        invalid(`${label} objects must contain only enumerable string data properties`);
      }
      result[key]=copyClosed(descriptor.value,`${label}.${key}`,ancestors,depth+1);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function exact(value,keys,label) {
  if (value===null || typeof value!=="object" || Array.isArray(value) ||
      canonicalJson(Object.keys(value).sort())!==canonicalJson([...keys].sort())) {
    invalid(`${label} must use the exact closed shape`);
  }
}

export function releaseApprovalEnvelopeSha256(input) {
  const value=copyClosed(input,"Release approval envelope");
  exact(value,["command","policy_revision","source","operations"],
    "Release approval envelope");
  exact(value.source,["repository","revision","sha256"],"Release approval envelope source");
  if (value.command!=="release.approve" || typeof value.policy_revision!=="string" ||
      !/\S/u.test(value.policy_revision) || typeof value.source.repository!=="string" ||
      !/\S/u.test(value.source.repository) || typeof value.source.revision!=="string" ||
      !/\S/u.test(value.source.revision) || typeof value.source.sha256!=="string" ||
      !/^[a-f0-9]{64}$/u.test(value.source.sha256) || !Array.isArray(value.operations) ||
      value.operations.length===0) {
    invalid("Release approval envelope command, policy, and operations are malformed");
  }
  const operations=value.operations.map(operation => {
    if (operation===null || typeof operation!=="object" || Array.isArray(operation)) {
      invalid("Release approval envelope operation must be a non-null object");
    }
    const operationKeys=Object.hasOwn(operation,"operation_id")
      ? (Object.hasOwn(operation,"compensation")
        ? ["operation_id","resource","action","repository","expected_revision","payload","compensation"]
        : ["operation_id","resource","action","repository","expected_revision","payload"])
      : (Object.hasOwn(operation,"compensation")
        ? ["resource","action","repository","expected_revision","payload","compensation"]
        : ["resource","action","repository","expected_revision","payload"]);
    exact(operation,operationKeys,"Release approval envelope operation");
    if (operation.payload===null || typeof operation.payload!=="object" ||
        Array.isArray(operation.payload)) {
      invalid("Release approval envelope operation payload must be a non-null object");
    }
    if (typeof operation.resource!=="string" || !/\S/u.test(operation.resource) ||
        typeof operation.action!=="string" || !/\S/u.test(operation.action) ||
        !(operation.repository===null || typeof operation.repository==="string" &&
          /\S/u.test(operation.repository)) ||
        !(operation.expected_revision===null || typeof operation.expected_revision==="string" &&
          /\S/u.test(operation.expected_revision))) {
      invalid("Release approval envelope operation identities are malformed");
    }
    if (!Object.hasOwn(operation.payload,"authority_binding")) {
      invalid("Release approval envelope operation must carry its authority binding");
    }
    const {authority_binding,...payload}=operation.payload;
    if (payload.kind==="release-program-manifest") {
      if (payload.program===null || typeof payload.program!=="object" ||
          Array.isArray(payload.program) || !Array.isArray(payload.program.repository_releases)) {
        invalid("Release approval envelope manifest must contain a repository release array");
      }
      const selected=payload.program.repository_releases.find(release =>
        release?.release_id===authority_binding?.release_id &&
        release?.program_id===authority_binding?.program_id);
      const reference=selected?.approval?.authority;
      if (!reference || typeof reference.record_id!=="string" ||
          typeof reference.sha256!=="string" || !/^[a-f0-9]{64}$/u.test(reference.sha256)) {
        invalid("Release approval envelope manifest must contain the selected authority reference");
      }
      reference.sha256="0".repeat(64);
    }
    return {
      resource:operation.resource,action:operation.action,repository:operation.repository,
      expected_revision:operation.expected_revision,payload,
      ...(Object.hasOwn(operation,"compensation")
        ? {compensation:operation.compensation}
        : {}),
    };
  }).sort(compareOperations);
  return sha256Canonical({command:value.command,policy_revision:value.policy_revision,
    source:value.source,operations});
}
