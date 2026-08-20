import fs from "node:fs";
import {createRequire} from "node:module";

import {CONTRACT_SCHEMA_CATALOG} from "./schema-catalog.js";
import {createValidatorRuntime} from "./validator-runtime.js";

const require=createRequire(import.meta.url);

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

function createAjv() {
  const loaded=require("ajv/dist/2020.js");
  const Ajv2020=loaded.default ?? loaded;
  const ajv=new Ajv2020({
    allErrors:true,
    strict:true,
    validateFormats:true,
  });
  ajv.addFormat("rfc3339-date-time",{
    type:"string",
    validate:isRfc3339DateTime,
  });
  return ajv;
}

function productionRuntime() {
  return createValidatorRuntime({
    catalog:CONTRACT_SCHEMA_CATALOG,
    readSchema:row => JSON.parse(fs.readFileSync(
      new URL(row.relativePath,import.meta.url),"utf8",
    )),
    createAjv,
    observe:() => {},
  });
}

export function createContractValidator() {
  return productionRuntime();
}

const defaultValidator=productionRuntime();

export function validateDocument(value,schemaId) {
  return defaultValidator.validateDocument(value,schemaId);
}
