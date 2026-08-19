import {canonicalJson} from "../../src/contracts/acp.js";
import path from "node:path";

export const PERFORMANCE_REPORT_VERSION="toss-test-performance-report.v1";
export const PERFORMANCE_BASELINE_VERSION="toss-test-performance-baseline.v1";
export const HISTORICAL_FULL_WALL_MS=134960;
export const FAST_MAX_WALL_MS=15000;

export const PERFORMANCE_CODES=Object.freeze({
  INVALID_PROCESS_LOG:"INVALID_PROCESS_LOG",
  DUPLICATE_PROCESS_START:"DUPLICATE_PROCESS_START",
  DUPLICATE_PROCESS_END:"DUPLICATE_PROCESS_END",
  INCOMPLETE_PROCESS_EVIDENCE:"INCOMPLETE_PROCESS_EVIDENCE",
  MIXED_PERFORMANCE_RUN_ID:"MIXED_PERFORMANCE_RUN_ID",
  INCOMPATIBLE_ENVIRONMENT:"INCOMPATIBLE_PERFORMANCE_ENVIRONMENT",
  FAST_EXCEEDED:"FAST_WALL_BUDGET_EXCEEDED",
  FULL_EXCEEDED:"FULL_WALL_BUDGET_EXCEEDED",
  OK:"PERFORMANCE_BUDGET_OK",
});

export class PerformanceToolError extends Error {
  constructor(code,message) {
    super(message);
    this.name="PerformanceToolError";
    this.code=code;
  }
}

function finiteNonnegative(value,label) {
  if (!Number.isFinite(value) || value<0) {
    throw new TypeError(`${label} must be finite nonnegative`);
  }
  return value;
}

export function median(values) {
  denseArray(values,"median samples");
  if (values.length!==3) {
    throw new TypeError("median requires exactly three samples");
  }
  return [...values]
    .map((value,index) => finiteNonnegative(value,`sample ${index+1}`))
    .sort((left,right) => left-right)[1];
}

function ascii(left,right) {
  return left<right ? -1 : left>right ? 1 : 0;
}

function plainRecord(value,label) {
  if (!value || typeof value!=="object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function closedRecord(value,label,required,optional=[]) {
  const record=plainRecord(value,label);
  const allowed=new Set([...required,...optional]);
  const keys=Object.getOwnPropertyNames(record);
  const symbols=Object.getOwnPropertySymbols(record);
  if (symbols.length>0) throw new TypeError(`${label} has symbol property`);
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
  if (Object.getOwnPropertySymbols(value).length>0) {
    throw new TypeError(`${label} has symbol property`);
  }
  const names=Object.getOwnPropertyNames(value);
  const keys=names.filter(key => key!=="length").sort((left,right) => Number(left)-Number(right));
  if (names.length!==value.length+1 || keys.length!==value.length ||
      keys.some((key,index) => key!==String(index))) {
    throw new TypeError(`${label} must be dense`);
  }
  for (const key of keys) {
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
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

function nonnegativeInteger(value,label) {
  finiteNonnegative(value,label);
  if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer`);
  return value;
}

function entryPath(argv,root) {
  denseArray(argv,"process argv");
  if (argv.length===0 || argv.some(value => typeof value!=="string")) {
    throw new TypeError("process argv must be a nonempty string array");
  }
  const canonicalRoot=path.resolve(root);
  const entry=argv.length===1 ? argv[0] : argv[1];
  if (!path.isAbsolute(entry)) return undefined;
  const relative=path.relative(canonicalRoot,path.resolve(entry));
  if (relative==="" || relative===".." || relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

function validateStart(event,root,runId) {
  const record=closedRecord(event,"process start event",["kind","run_id","pid","at_ms","argv"]);
  if (record.kind!=="start") throw new TypeError("process start event kind must be start");
  if (record.run_id!==runId) {
    throw new PerformanceToolError(PERFORMANCE_CODES.MIXED_PERFORMANCE_RUN_ID,"mixed performance run ID");
  }
  nonnegativeInteger(record.pid,"process pid");
  finiteNonnegative(record.at_ms,"process start time");
  return {...record,entry_path:entryPath(record.argv,root)};
}

function validateEnd(event,runId) {
  const record=closedRecord(event,"process end event",[
    "kind","run_id","pid","at_ms","user_cpu_us","system_cpu_us",
  ]);
  if (record.kind!=="end") throw new TypeError("process end event kind must be end");
  if (record.run_id!==runId) {
    throw new PerformanceToolError(PERFORMANCE_CODES.MIXED_PERFORMANCE_RUN_ID,"mixed performance run ID");
  }
  nonnegativeInteger(record.pid,"process pid");
  finiteNonnegative(record.at_ms,"process end time");
  finiteNonnegative(record.user_cpu_us,"process user CPU");
  finiteNonnegative(record.system_cpu_us,"process system CPU");
  return record;
}

export function summarizeProcessEvents(events,root,runId) {
  denseArray(events,"process events");
  nonemptyString(root,"repository root");
  nonemptyString(runId,"performance run ID");
  const starts=new Map();
  const ends=new Map();
  const entries=[];
  for (const event of events) {
    plainRecord(event,"process event");
    if (event.kind==="start") {
      const start=validateStart(event,root,runId);
      if (starts.has(start.pid)) {
        throw new PerformanceToolError(PERFORMANCE_CODES.DUPLICATE_PROCESS_START,
          `duplicate process start for pid ${start.pid}`);
      }
      starts.set(start.pid,start);
      if (start.entry_path!==undefined) entries.push(start);
    } else if (event.kind==="end") {
      const end=validateEnd(event,runId);
      if (ends.has(end.pid) || !starts.has(end.pid)) {
        throw new PerformanceToolError(PERFORMANCE_CODES.DUPLICATE_PROCESS_END,
          `duplicate or unmatched process end for pid ${end.pid}`);
      }
      ends.set(end.pid,end);
    } else {
      throw new TypeError("process event kind must be start or end");
    }
  }
  if (starts.size!==ends.size) {
    throw new PerformanceToolError(PERFORMANCE_CODES.INCOMPLETE_PROCESS_EVIDENCE,
      "every process start must have an end");
  }
  const transitions=[];
  let userCpuUs=0;
  let systemCpuUs=0;
  for (const start of starts.values()) {
    const end=ends.get(start.pid);
    if (end.at_ms<start.at_ms) {
      throw new PerformanceToolError(PERFORMANCE_CODES.INCOMPLETE_PROCESS_EVIDENCE,
        `process end precedes start for pid ${start.pid}`);
    }
    transitions.push({at_ms:start.at_ms,delta:1},{at_ms:end.at_ms,delta:-1});
    userCpuUs+=end.user_cpu_us;
    systemCpuUs+=end.system_cpu_us;
  }
  transitions.sort((left,right) => left.at_ms-right.at_ms || left.delta-right.delta);
  let active=0;
  let peak=0;
  for (const transition of transitions) {
    active+=transition.delta;
    if (active>peak) peak=active;
  }
  const slowestFiles=[];
  const counts=new Map();
  for (const start of entries) {
    counts.set(start.entry_path,(counts.get(start.entry_path) ?? 0)+1);
    const end=ends.get(start.pid);
    slowestFiles.push({
      name:start.entry_path,duration_ms:end.at_ms-start.at_ms,status:"pass",
    });
  }
  const duplicates=[...counts.entries()]
    .filter(([,count]) => count>1)
    .map(([entry_path,count]) => ({entry_path,count}))
    .sort((left,right) => ascii(left.entry_path,right.entry_path) || left.count-right.count);
  return {
    fresh_process_count:starts.size,
    peak_process_count:peak,
    user_cpu_ms:userCpuUs/1000,
    system_cpu_ms:systemCpuUs/1000,
    duplicates,
    entries:slowestFiles.sort((left,right) => right.duration_ms-left.duration_ms ||
      ascii(left.name,right.name)),
  };
}

export function parseNamedDurations(output) {
  if (typeof output!=="string") throw new TypeError("output must be a string");
  const rows=[];
  for (const line of output.split(/\r?\n/u)) {
    const match=/^([✔✖])\s+(.+?)\s+\((\d+(?:\.\d+)?)ms\)$/u.exec(line.trim());
    if (!match) continue;
    rows.push({
      name:match[2],duration_ms:Number(match[3]),
      status:match[1]==="✔" ? "pass" : "fail",
    });
  }
  return rows.sort((left,right) => ascii(left.name,right.name) || left.duration_ms-right.duration_ms);
}

function validateIdentity(identity) {
  const record=closedRecord(identity,"performance identity",[
    "commit","node_version","platform","arch","lock_sha256","runner_id",
  ]);
  for (const key of Object.keys(record)) nonemptyString(record[key],`identity ${key}`);
  if (!/^[a-f0-9]{64}$/u.test(record.lock_sha256)) {
    throw new TypeError("identity lock_sha256 must be a SHA-256 hex digest");
  }
  return record;
}

function validateDurationRow(value,label) {
  const row=closedRecord(value,label,["name","duration_ms","status"]);
  nonemptyString(row.name,`${label} name`);
  finiteNonnegative(row.duration_ms,`${label} duration_ms`);
  if (row.status!=="pass" && row.status!=="fail") {
    throw new TypeError(`${label} status must be pass or fail`);
  }
  return row;
}

function validateDuplicate(value,label) {
  const duplicate=closedRecord(value,label,["entry_path","count"]);
  nonemptyString(duplicate.entry_path,`${label} entry_path`);
  nonnegativeInteger(duplicate.count,`${label} count`);
  if (duplicate.count<2) throw new TypeError(`${label} count must be at least two`);
  return duplicate;
}

function validateSample(value,index) {
  const sample=closedRecord(value,`sample ${index+1}`,[
    "wall_ms","user_cpu_ms","system_cpu_ms","exit_status","fresh_process_count",
    "peak_process_count","duplicates","slowest_files","slowest_tests",
  ]);
  finiteNonnegative(sample.wall_ms,`sample ${index+1} wall_ms`);
  finiteNonnegative(sample.user_cpu_ms,`sample ${index+1} user_cpu_ms`);
  finiteNonnegative(sample.system_cpu_ms,`sample ${index+1} system_cpu_ms`);
  nonnegativeInteger(sample.exit_status,`sample ${index+1} exit_status`);
  if (sample.exit_status!==0) throw new TypeError(`sample ${index+1} must have successful exit_status`);
  nonnegativeInteger(sample.fresh_process_count,`sample ${index+1} fresh_process_count`);
  nonnegativeInteger(sample.peak_process_count,`sample ${index+1} peak_process_count`);
  if (sample.peak_process_count>sample.fresh_process_count) {
    throw new TypeError(`sample ${index+1} peak_process_count cannot exceed fresh_process_count`);
  }
  const duplicates=denseArray(sample.duplicates,`sample ${index+1} duplicates`);
  const slowestFiles=denseArray(sample.slowest_files,`sample ${index+1} slowest_files`);
  const slowestTests=denseArray(sample.slowest_tests,`sample ${index+1} slowest_tests`);
  duplicates.forEach((row,rowIndex) => validateDuplicate(row,`sample ${index+1} duplicate ${rowIndex+1}`));
  slowestFiles.forEach((row,rowIndex) => validateDurationRow(row,`sample ${index+1} slow file ${rowIndex+1}`));
  slowestTests.forEach((row,rowIndex) => validateDurationRow(row,`sample ${index+1} slow test ${rowIndex+1}`));
  return sample;
}

function validateReportInput(input) {
  const record=closedRecord(input,"performance report input",["lane","identity","samples"]);
  nonemptyString(record.lane,"performance lane");
  validateIdentity(record.identity);
  denseArray(record.samples,"performance samples");
  if (record.samples.length!==3) {
    throw new TypeError("performance report requires exactly three samples");
  }
  record.samples.forEach(validateSample);
  return record;
}

export function createPerformanceReport(input) {
  const {lane,identity,samples}=validateReportInput(input);
  return {
    schema_version:PERFORMANCE_REPORT_VERSION,
    lane,
    identity,
    samples,
    medians:{
      wall_ms:median(samples.map(sample => sample.wall_ms)),
      user_cpu_ms:median(samples.map(sample => sample.user_cpu_ms)),
      system_cpu_ms:median(samples.map(sample => sample.system_cpu_ms)),
      fresh_process_count:median(samples.map(sample => sample.fresh_process_count)),
      peak_process_count:median(samples.map(sample => sample.peak_process_count)),
    },
  };
}

export function canonicalPerformanceJson(report) {
  const complete=closedRecord(report,"performance report",[
    "schema_version","lane","identity","samples","medians",
  ]);
  const normalized=createPerformanceReport({
    lane:complete.lane,
    identity:complete.identity,
    samples:complete.samples,
  });
  if (complete.schema_version!==PERFORMANCE_REPORT_VERSION ||
      canonicalJson(normalized.medians)!==canonicalJson(complete.medians)) {
    throw new TypeError("invalid performance report");
  }
  return canonicalJson(complete);
}

function validateBudgetDocument(document,label,expectedVersion,requiresBudgets) {
  const isBaseline=expectedVersion===PERFORMANCE_BASELINE_VERSION;
  const record=closedRecord(document,label,["schema_version","identity","medians"],isBaseline ?
    ["budgets","historical"] : ["budgets","lane","samples"]);
  if (record.schema_version!==expectedVersion) {
    throw new TypeError(`${label} has unexpected schema_version`);
  }
  validateIdentity(record.identity);
  if (isBaseline) {
    const historical=closedRecord(record.historical,`${label} historical`,["full_wall_ms"]);
    finiteNonnegative(historical.full_wall_ms,`${label} historical full_wall_ms`);
    if (historical.full_wall_ms!==HISTORICAL_FULL_WALL_MS) {
      throw new TypeError(`${label} historical full_wall_ms must match the locked baseline`);
    }
  }
  const medians=closedRecord(record.medians,`${label} medians`,["wall_ms"],[
    "user_cpu_ms","system_cpu_ms","fresh_process_count","peak_process_count",
  ]);
  for (const [key,value] of Object.entries(medians)) finiteNonnegative(value,`${label} medians ${key}`);
  if (record.budgets!==undefined) {
    const budgets=closedRecord(record.budgets,`${label} budgets`,[
      "fast_max_wall_ms","full_max_wall_ms",
    ]);
    finiteNonnegative(budgets.fast_max_wall_ms,`${label} fast budget`);
    finiteNonnegative(budgets.full_max_wall_ms,`${label} full budget`);
  } else if (requiresBudgets) {
    throw new TypeError(`${label} requires budgets`);
  }
  if (record.lane!==undefined || record.samples!==undefined) {
    const normalized=createPerformanceReport({
      lane:record.lane,
      identity:record.identity,
      samples:record.samples,
    });
    if (canonicalJson(normalized.medians)!==canonicalJson(record.medians)) {
      throw new TypeError(`${label} medians do not match samples`);
    }
  } else if (!isBaseline) {
    throw new TypeError(`${label} requires lane and samples`);
  }
  return record;
}

function compatibleIdentity(baseline,candidate) {
  return ["node_version","platform","arch","lock_sha256","runner_id"]
    .every(key => baseline[key]===candidate[key]);
}

export function comparePerformanceBudget(baseline,candidate,lane) {
  const baselineReport=validateBudgetDocument(
    baseline,"performance baseline",PERFORMANCE_BASELINE_VERSION,true,
  );
  const candidateReport=validateBudgetDocument(
    candidate,"performance candidate",PERFORMANCE_REPORT_VERSION,false,
  );
  if (lane!=="fast" && lane!=="full") throw new TypeError("performance lane must be fast or full");
  if (candidateReport.lane!==lane) {
    throw new TypeError("performance candidate lane must match requested lane");
  }
  const limit_ms=lane==="fast" ? baselineReport.budgets.fast_max_wall_ms :
    baselineReport.budgets.full_max_wall_ms;
  const actual_ms=candidateReport.medians.wall_ms;
  if (!compatibleIdentity(baselineReport.identity,candidateReport.identity)) {
    return {
      ok:false,code:PERFORMANCE_CODES.INCOMPATIBLE_ENVIRONMENT,limit_ms,actual_ms,
      message:"Performance reports use incompatible environments.",
    };
  }
  if (actual_ms>limit_ms) {
    const code=lane==="fast" ? PERFORMANCE_CODES.FAST_EXCEEDED : PERFORMANCE_CODES.FULL_EXCEEDED;
    return {
      ok:false,code,limit_ms,actual_ms,
      message:`${lane} wall time ${actual_ms}ms exceeds budget ${limit_ms}ms.`,
    };
  }
  return {
    ok:true,code:PERFORMANCE_CODES.OK,limit_ms,actual_ms,
    message:`${lane} wall time ${actual_ms}ms is within budget ${limit_ms}ms.`,
  };
}
