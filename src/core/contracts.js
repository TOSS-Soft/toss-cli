import {types} from "node:util";

import {validateDocument} from "../contracts/validator.js";

import {CoreValidationError} from "./errors.js";

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
  for (const operation of value.operations) {
    if (previousOperationId!==undefined && previousOperationId>=operation.operation_id) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: operation IDs must use strict ascending ASCII order");
    }
    previousOperationId=operation.operation_id;
  }
}

function assertNoProxies(value,seen=new Set()) {
  if (value===null || typeof value!=="object") return;
  if (types.isProxy(value)) {
    throw new CoreValidationError("Invalid core contract: proxy values are not allowed");
  }
  if (seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if (descriptor && "value" in descriptor) assertNoProxies(descriptor.value,seen);
  }
}

export {CoreValidationError};

export function validateCoreDocument(value,schemaId) {
  assertNoProxies(value);
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
