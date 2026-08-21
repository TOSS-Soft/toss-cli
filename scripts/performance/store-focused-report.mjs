import {canonicalJson} from "../../src/contracts/acp.js";
import {median} from "./report.mjs";

export const STORE_FOCUSED_REPORT_VERSION="toss-store-focused-report.v1";
export const STORE_FOCUSED_ENTRIES=Object.freeze([
  "test/design-commands.test.js",
  "test/feature-commands.test.js",
  "test/project-commands.test.js",
]);

const HASH=/^[a-f0-9]{64}$/u;
const COMMIT=/^[a-f0-9]{40}$/u;
const SAMPLE_FIELDS=Object.freeze([
  "wall_ms","user_cpu_ms","system_cpu_ms","exit_status","fresh_process_count",
  "peak_process_count","duplicates","entry_processes",
]);

function plainRecord(value,label) {
  if (!value || typeof value!=="object" || Array.isArray(value) ||
      Object.getPrototypeOf(value)!==Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function closedRecord(value,label,required,optional=[]) {
  const record=plainRecord(value,label);
  const allowed=new Set([...required,...optional]);
  const keys=Object.getOwnPropertyNames(record);
  if (Object.getOwnPropertySymbols(record).length>0) {
    throw new TypeError(`${label} has symbol property`);
  }
  for (const key of keys) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unknown property ${key}`);
    const descriptor=Object.getOwnPropertyDescriptor(record,key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} property ${key} must be enumerable data`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record,key)) throw new TypeError(`${label} requires ${key}`);
  }
  return record;
}

function denseArray(value,label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype) {
    throw new TypeError(`${label} must be an array`);
  }
  const names=Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length>0 || names.length!==value.length+1 ||
      names.filter(name => name!=="length").some((name,index) => name!==String(index))) {
    throw new TypeError(`${label} must be dense`);
  }
  for (let index=0;index<value.length;index+=1) {
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} items must be enumerable data`);
    }
  }
  return value;
}

function nonemptyString(value,label) {
  if (typeof value!=="string" || value.length===0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
  return value;
}

function finiteNonnegative(value,label) {
  if (!Number.isFinite(value) || value<0) {
    throw new TypeError(`${label} must be finite nonnegative`);
  }
  return value;
}

function nonnegativeInteger(value,label) {
  finiteNonnegative(value,label);
  if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer`);
  return value;
}

function freeze(value) {
  if (value && typeof value==="object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeIdentity(value) {
  const identity=closedRecord(value,"focused identity",[
    "commit","node_version","platform","arch","lock_sha256","runner_id",
  ]);
  for (const key of Object.keys(identity)) nonemptyString(identity[key],`identity ${key}`);
  if (!COMMIT.test(identity.commit)) throw new TypeError("identity commit must be a Git commit SHA");
  if (!HASH.test(identity.lock_sha256)) {
    throw new TypeError("identity lock_sha256 must be a SHA-256 hex digest");
  }
  return {
    commit:identity.commit,node_version:identity.node_version,platform:identity.platform,
    arch:identity.arch,lock_sha256:identity.lock_sha256,runner_id:identity.runner_id,
  };
}

function normalizeCommand(value) {
  const command=closedRecord(value,"focused command",["executable","arguments"]);
  if (command.executable!==process.execPath) {
    throw new TypeError("focused command must use process.execPath");
  }
  const argumentsToCommand=denseArray(command.arguments,"focused command arguments");
  const expected=["--test",...STORE_FOCUSED_ENTRIES];
  if (argumentsToCommand.length!==expected.length ||
      argumentsToCommand.some((argument,index) => argument!==expected[index])) {
    throw new TypeError("focused command must use canonical focused command entries");
  }
  return {executable:command.executable,arguments:[...argumentsToCommand]};
}

function normalizeDuplicate(value,index,sampleIndex) {
  const duplicate=closedRecord(value,`sample ${sampleIndex} duplicate ${index}`,['entry_path','count']);
  nonemptyString(duplicate.entry_path,`sample ${sampleIndex} duplicate ${index} entry_path`);
  nonnegativeInteger(duplicate.count,`sample ${sampleIndex} duplicate ${index} count`);
  if (duplicate.count<2) throw new TypeError(`sample ${sampleIndex} duplicate ${index} count must be at least two`);
  return {entry_path:duplicate.entry_path,count:duplicate.count};
}

function normalizeEntry(value,index,sampleIndex) {
  const entry=closedRecord(value,`sample ${sampleIndex} entry process ${index}`,["name","duration_ms","status"]);
  nonemptyString(entry.name,`sample ${sampleIndex} entry process ${index} name`);
  finiteNonnegative(entry.duration_ms,`sample ${sampleIndex} entry process ${index} duration_ms`);
  if (entry.status!=="pass" && entry.status!=="fail") {
    throw new TypeError(`sample ${sampleIndex} entry process ${index} status must be pass or fail`);
  }
  return {name:entry.name,duration_ms:entry.duration_ms,status:entry.status};
}

function validateDiagnosticEntry(value,index,sampleIndex,label) {
  const entry=closedRecord(value,`sample ${sampleIndex} ${label} ${index}`,["name","duration_ms","status"]);
  nonemptyString(entry.name,`sample ${sampleIndex} ${label} ${index} name`);
  finiteNonnegative(entry.duration_ms,`sample ${sampleIndex} ${label} ${index} duration_ms`);
  if (entry.status!=="pass" && entry.status!=="fail") {
    throw new TypeError(`sample ${sampleIndex} ${label} ${index} status must be pass or fail`);
  }
}

function normalizeSample(value,index) {
  const sampleIndex=index+1;
  const sample=closedRecord(value,`sample ${sampleIndex}`,SAMPLE_FIELDS,[
    "stdout","stderr","slowest_files","slowest_tests",
  ]);
  const normalized={};
  for (const field of ["wall_ms","user_cpu_ms","system_cpu_ms"]) {
    normalized[field]=finiteNonnegative(sample[field],`sample ${sampleIndex} ${field}`);
  }
  normalized.exit_status=nonnegativeInteger(sample.exit_status,`sample ${sampleIndex} exit_status`);
  if (normalized.exit_status!==0) throw new TypeError(`sample ${sampleIndex} must have successful exit_status`);
  for (const field of ["fresh_process_count","peak_process_count"]) {
    normalized[field]=nonnegativeInteger(sample[field],`sample ${sampleIndex} ${field}`);
  }
  if (normalized.peak_process_count>normalized.fresh_process_count) {
    throw new TypeError(`sample ${sampleIndex} peak_process_count cannot exceed fresh_process_count`);
  }
  normalized.duplicates=denseArray(sample.duplicates,`sample ${sampleIndex} duplicates`).map(
    (duplicate,duplicateIndex) => normalizeDuplicate(duplicate,duplicateIndex+1,sampleIndex),
  );
  for (const [field,label] of [["slowest_files","slow file"],["slowest_tests","slow test"]]) {
    if (sample[field]!==undefined) {
      denseArray(sample[field],`sample ${sampleIndex} ${field}`).forEach((entry,entryIndex) =>
        validateDiagnosticEntry(entry,entryIndex+1,sampleIndex,label));
    }
  }
  for (const field of ["stdout","stderr"]) {
    if (sample[field]!==undefined && typeof sample[field]!=="string") {
      throw new TypeError(`sample ${sampleIndex} ${field} must be a string`);
    }
  }
  const entries=denseArray(sample.entry_processes,`sample ${sampleIndex} entry_processes`).map(
    (entry,entryIndex) => normalizeEntry(entry,entryIndex+1,sampleIndex),
  );
  const byName=new Map();
  for (const entry of entries) {
    if (!STORE_FOCUSED_ENTRIES.includes(entry.name)) continue;
    if (byName.has(entry.name)) {
      throw new TypeError(`sample ${sampleIndex} requires exactly one evidence row for ${entry.name}`);
    }
    if (entry.status!=="pass") throw new TypeError(`sample ${sampleIndex} target entry must pass`);
    byName.set(entry.name,entry);
  }
  normalized.entry_processes=STORE_FOCUSED_ENTRIES.map(name => {
    const entry=byName.get(name);
    if (!entry) throw new TypeError(`sample ${sampleIndex} requires exactly one evidence row for ${name}`);
    return entry;
  });
  return normalized;
}

function createNormalizedReport({phase,identity,command,samples}) {
  if (phase!=="before" && phase!=="after") {
    throw new TypeError("focused phase must be before or after");
  }
  const normalizedSamples=denseArray(samples,"focused samples").map(normalizeSample);
  if (normalizedSamples.length!==3) throw new TypeError("focused report requires exactly three samples");
  const medians={};
  for (const field of ["wall_ms","user_cpu_ms","system_cpu_ms","fresh_process_count","peak_process_count"]) {
    medians[field]=median(normalizedSamples.map(sample => sample[field]));
  }
  medians.owners=STORE_FOCUSED_ENTRIES.map((entry,entryIndex) => ({
    entry,
    wall_ms:median(normalizedSamples.map(sample => sample.entry_processes[entryIndex].duration_ms)),
  }));
  return {
    schema_version:STORE_FOCUSED_REPORT_VERSION,phase,
    identity:normalizeIdentity(identity),command:normalizeCommand(command),
    samples:normalizedSamples,medians,
  };
}

export function createStoreFocusedReport(input) {
  const record=closedRecord(input,"focused report input",["phase","identity","command","samples"]);
  return freeze(createNormalizedReport(record));
}

export function canonicalStoreFocusedJson(report) {
  const complete=closedRecord(report,"focused report",[
    "schema_version","phase","identity","command","samples","medians",
  ]);
  if (complete.schema_version!==STORE_FOCUSED_REPORT_VERSION) {
    throw new TypeError("invalid focused report");
  }
  const normalized=createNormalizedReport(complete);
  if (canonicalJson(normalized.medians)!==canonicalJson(complete.medians)) {
    throw new TypeError("invalid focused report");
  }
  return canonicalJson(normalized);
}
