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

export {CoreValidationError};

export function validateCoreDocument(value,schemaId) {
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
  return value;
}
