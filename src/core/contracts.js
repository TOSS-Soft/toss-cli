import {types} from "node:util";

import {validateDocument} from "../contracts/validator.js";

import {CoreValidationError} from "./errors.js";
import {compareOperations} from "./operation-order.js";
import {parseReservedBranch} from "./domain/identity.js";

function validationMessage(schemaId,errors) {
  const details=errors.map(error => error.message).filter(Boolean).join("; ");
  return `Invalid core contract ${schemaId}${details ? `: ${details}` : ""}`;
}

function assertUniqueOperationIds(value) {
  if (value.schema_version!=="operation-intent.v1") return;
  const operationIds=new Set();
  for (const operation of value.operations) {
    if (operationIds.has(operation.operation_id)) {
      throw new CoreValidationError(`Invalid core contract operation-intent.v1: duplicate operation_id ${operation.operation_id}`);
    }
    operationIds.add(operation.operation_id);
  }
}

function assertCanonicalOperationOrder(value) {
  if (value.schema_version!=="operation-intent.v1") return;
  let previousOperationId;
  let previousOperation;
  for (const operation of value.operations) {
    if (previousOperationId!==undefined && previousOperationId>=operation.operation_id) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: operation IDs must use strict ascending ASCII order");
    }
    if (previousOperation!==undefined && compareOperations(previousOperation,operation)>=0) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: operations must use canonical operation order");
    }
    previousOperationId=operation.operation_id;
    previousOperation=operation;
  }
}

function assertUniqueIds(values,key,label) {
  if (!Array.isArray(values)) return;
  const ids=new Set();
  for (const value of values) {
    const id=value?.[key];
    if (typeof id!=="string") continue;
    if (ids.has(id)) {
      throw new CoreValidationError(`Invalid core contract: duplicate ${label} ${id}`);
    }
    ids.add(id);
  }
}

function assertWorkItemIdentity(value) {
  if (!value || value.schema_version!=="work-item.v1" ||
      typeof value.repository!=="string" || !Number.isSafeInteger(value.issue_number) ||
      typeof value.id!=="string" || typeof value.kind!=="string" ||
      typeof value.branch!=="string") return;
  const expectedId=`${value.repository}#${value.issue_number}`;
  let branch;
  try {
    branch=parseReservedBranch(value.branch);
  } catch (error) {
    throw new CoreValidationError("Invalid core contract work-item.v1: reserved branch identity is not canonical",{cause:error});
  }
  const parentMatches=value.kind!=="issue" ||
    (typeof value.parent_id==="string" && value.parent_id.startsWith(`${value.repository}#`));
  if (value.id!==expectedId || branch.kind!==value.kind ||
      branch.issueNumber!==value.issue_number || !parentMatches) {
    throw new CoreValidationError("Invalid core contract work-item.v1: identity, repository, native issue number, and branch reservation must agree");
  }
}

function assertEpicPlanTopology(value) {
  const epic=value.epic;
  if (epic===null || typeof epic!=="object") return;
  if (epic.kind!=="epic") {
    throw new CoreValidationError("Invalid core contract epic-plan.v1: root work item must be an epic");
  }
  if (!Array.isArray(value.children) || typeof epic.id!=="string" ||
      typeof epic.repository!=="string") return;
  for (const child of value.children) {
    if (child===null || typeof child!=="object") continue;
    if (child.kind!=="issue" || child.repository!==epic.repository ||
        child.parent_id!==epic.id) {
      throw new CoreValidationError("Invalid core contract epic-plan.v1: children must be same-repository issues with the exact epic parent");
    }
  }
}

function assertWorkContractSemantics(value) {
  if (value===null || typeof value!=="object") return;
  assertWorkItemIdentity(value);
  if (value.schema_version==="epic-plan.v1") {
    assertUniqueIds(value.children,"id","work item id");
    assertUniqueIds(value.edges,"edge_id","dependency edge id");
    assertWorkItemIdentity(value.epic);
    if (Array.isArray(value.children)) {
      for (const child of value.children) assertWorkItemIdentity(child);
    }
    assertEpicPlanTopology(value);
  }
  if (value.schema_version==="review-result.v1") {
    assertUniqueIds(value.findings,"finding_id","review finding id");
  }
}

function assertClosedContract(value,seen=new Set()) {
  if (value===null || typeof value!=="object") return;
  if (types.isProxy(value)) {
    throw new CoreValidationError("Invalid core contract: proxy values are not allowed");
  }
  if (seen.has(value)) throw new CoreValidationError("Invalid core contract: cyclic values are not allowed");
  seen.add(value);
  try {
    const prototype=Object.getPrototypeOf(value);
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const keys=Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      if (prototype!==Array.prototype) throw new CoreValidationError("Invalid core contract: arrays must be plain");
      const lengthDescriptor=descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.enumerable ||
          !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value<0) {
        throw new CoreValidationError("Invalid core contract: arrays must have a valid length descriptor");
      }
      let count=0;
      for (const key of keys) {
        if (key==="length") continue;
        const descriptor=descriptors[key];
        const index=typeof key==="string" ? Number(key) : -1;
        if (typeof key!=="string" || !Number.isSafeInteger(index) || index<0 ||
            index>=lengthDescriptor.value || String(index)!==key || !("value" in descriptor) ||
            !descriptor.enumerable) {
          throw new CoreValidationError("Invalid core contract: arrays must be dense own data");
        }
        count+=1;
        assertClosedContract(descriptor.value,seen);
      }
      if (count!==lengthDescriptor.value) throw new CoreValidationError("Invalid core contract: arrays must be dense own data");
      return;
    }
    if (![Object.prototype,null].includes(prototype)) throw new CoreValidationError("Invalid core contract: objects must be plain");
    for (const key of keys) {
      const descriptor=descriptors[key];
      if (typeof key!=="string" || !("value" in descriptor) || !descriptor.enumerable) {
        throw new CoreValidationError("Invalid core contract: objects must contain only own enumerable data");
      }
      assertClosedContract(descriptor.value,seen);
    }
  } finally {
    seen.delete(value);
  }
}

export {CoreValidationError};

export function validateCoreDocument(value,schemaId) {
  assertClosedContract(value);
  assertWorkContractSemantics(value);
  let result;
  try {
    result=validateDocument(value,schemaId);
  } catch (error) {
    throw new CoreValidationError(`Invalid core contract ${schemaId}: ${error.message}`,{cause:error});
  }
  if (!result.valid) {
    throw new CoreValidationError(validationMessage(schemaId,result.errors));
  }
  assertUniqueOperationIds(value);
  assertCanonicalOperationOrder(value);
  return value;
}
