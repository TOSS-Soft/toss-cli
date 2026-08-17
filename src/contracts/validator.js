import fs from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

import {canonicalJson} from "./acp.js";

const schemaDefinitions=[
  ["artifact-envelope.v1","../../contracts/common/artifact-envelope.schema.json"],
  ["entity.v1","../../contracts/common/entity.schema.json"],
  ["provenance.v1","../../contracts/common/provenance.schema.json"],
  ["reference.v1","../../contracts/common/reference.schema.json"],
  ["question.v1","../../contracts/common/question.schema.json"],
  ["pm-analysis.v1","../../contracts/agents/pm-analysis.v1.schema.json"],
  ["architecture-constraint.v1","../../contracts/agents/architecture-constraint.v1.schema.json"],
  ["architecture.v1","../../contracts/agents/architecture.v1.schema.json"],
  ["adr.v1","../../contracts/agents/adr.v1.schema.json"],
  ["issue-plan.v1","../../contracts/agents/issue-plan.v1.schema.json"],
  ["finding.v1","../../contracts/agents/finding.v1.schema.json"],
  ["spec-audit.v1","../../contracts/agents/spec-audit.v1.schema.json"],
  ["decision-package.v1","../../contracts/pipeline/decision-package.v1.schema.json"],
  ["trace-graph.v1","../../contracts/pipeline/trace-graph.v1.schema.json"],
  ["trace-result.v1","../../contracts/pipeline/trace-result.v1.schema.json"],
];

function loadSchema(path) {
  return JSON.parse(fs.readFileSync(new URL(path,import.meta.url),"utf8"));
}

function copyErrors(errors) {
  return (errors ?? []).map(error => ({...error}));
}

function canonicalJsonError(error) {
  return [{
    instancePath:"",
    schemaPath:"#",
    keyword:"canonical-json",
    params:{},
    message:error instanceof Error ? error.message : "Value is not canonical JSON",
  }];
}

function isLeapYear(year) {
  return year%4===0 && (year%100!==0 || year%400===0);
}

function daysInMonth(year,month) {
  if (month===2) return isLeapYear(year) ? 29 : 28;
  return [4,6,9,11].includes(month) ? 30 : 31;
}

const RFC3339_DATE_TIME=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isRfc3339DateTime(value) {
  if (typeof value!=="string") return false;
  const match=RFC3339_DATE_TIME.exec(value);
  if (!match) return false;
  const [
    ,yearText,monthText,dayText,hourText,minuteText,secondText,
    offsetHourText,offsetMinuteText,
  ]=match;
  const year=Number(yearText);
  const month=Number(monthText);
  const day=Number(dayText);
  const hour=Number(hourText);
  const minute=Number(minuteText);
  const second=Number(secondText);
  if (month<1 || month>12 || day<1 || day>daysInMonth(year,month) ||
      hour>23 || minute>59 || second>59) {
    return false;
  }
  if (offsetHourText!==undefined &&
      (Number(offsetHourText)>23 || Number(offsetMinuteText)>59)) {
    return false;
  }
  return true;
}

function canonicalDocument(value) {
  try {
    return {value:JSON.parse(canonicalJson(value))};
  } catch (error) {
    return {errors:canonicalJsonError(error)};
  }
}

export function createContractValidator() {
  const ajv=new Ajv2020({
    allErrors:true,
    strict:true,
    validateFormats:true,
  });
  ajv.addFormat("rfc3339-date-time",{
    type:"string",
    validate:isRfc3339DateTime,
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
    const document=canonicalDocument(value);
    if (document.errors) return {valid:false,errors:document.errors};
    const valid=validate(document.value);
    return {valid,errors:valid ? [] : copyErrors(validate.errors)};
  }

  return Object.freeze({validateDocument});
}

const defaultValidator=createContractValidator();

export function validateDocument(value,schemaId) {
  return defaultValidator.validateDocument(value,schemaId);
}
