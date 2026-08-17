import fs from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

const schemaDefinitions=[
  ["artifact-envelope.v1","../../contracts/common/artifact-envelope.schema.json"],
  ["entity.v1","../../contracts/common/entity.schema.json"],
  ["provenance.v1","../../contracts/common/provenance.schema.json"],
  ["reference.v1","../../contracts/common/reference.schema.json"],
  ["question.v1","../../contracts/common/question.schema.json"],
];

function loadSchema(path) {
  return JSON.parse(fs.readFileSync(new URL(path,import.meta.url),"utf8"));
}

function copyErrors(errors) {
  return (errors ?? []).map(error => ({...error}));
}

export function createContractValidator() {
  const ajv=new Ajv2020({
    allErrors:true,
    strict:true,
    validateFormats:false,
  });
  const validators=new Map();

  for (const [schemaId,path] of schemaDefinitions) {
    const schema=loadSchema(path);
    ajv.addSchema(schema);
    validators.set(schemaId,schema.$id);
  }

  function validateDocument(value,schemaId) {
    const schemaUri=validators.get(schemaId) ?? schemaId;
    const validate=ajv.getSchema(schemaUri);
    if (!validate) {
      throw new Error(`Unknown contract schema: ${String(schemaId)}`);
    }
    const valid=validate(value);
    return {valid,errors:valid ? [] : copyErrors(validate.errors)};
  }

  return Object.freeze({validateDocument});
}

const defaultValidator=createContractValidator();

export function validateDocument(value,schemaId) {
  return defaultValidator.validateDocument(value,schemaId);
}
