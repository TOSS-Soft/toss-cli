import {canonicalJson} from "../../src/contracts/acp.js";
import {createHash} from "node:crypto";
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

export function performanceCommandForLane(lane,{executable}) {
  if (typeof executable!=="string" || executable.length===0) {
    throw new TypeError("performance executable must be a nonempty string");
  }
  if (lane==="full") return {executable,arguments:["test"]};
  if (lane==="fast") return {executable,arguments:["run","test:fast"]};
  throw new TypeError("performance lane must be fast or full");
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
  if (events.length===0) {
    throw new PerformanceToolError(PERFORMANCE_CODES.INCOMPLETE_PROCESS_EVIDENCE,
      "process evidence must contain at least one completed process pair");
  }
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

export function validatePerformanceIdentity(identity) {
  return validateIdentity(identity);
}

function validateCommand(command,label="performance command") {
  const record=closedRecord(command,label,["executable","arguments"]);
  nonemptyString(record.executable,`${label} executable`);
  const argumentsToCommand=denseArray(record.arguments,`${label} arguments`);
  for (const [index,value] of argumentsToCommand.entries()) {
    if (typeof value!=="string") throw new TypeError(`${label} argument ${index+1} must be a string`);
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
  ],["stdout","stderr","entry_processes"]);
  finiteNonnegative(sample.wall_ms,`sample ${index+1} wall_ms`);
  finiteNonnegative(sample.user_cpu_ms,`sample ${index+1} user_cpu_ms`);
  finiteNonnegative(sample.system_cpu_ms,`sample ${index+1} system_cpu_ms`);
  nonnegativeInteger(sample.exit_status,`sample ${index+1} exit_status`);
  if (sample.exit_status!==0) throw new TypeError(`sample ${index+1} must have successful exit_status`);
  nonnegativeInteger(sample.fresh_process_count,`sample ${index+1} fresh_process_count`);
  nonnegativeInteger(sample.peak_process_count,`sample ${index+1} peak_process_count`);
  if (sample.fresh_process_count===0 || sample.peak_process_count===0) {
    throw new TypeError(`sample ${index+1} must contain nonempty process evidence`);
  }
  if (sample.peak_process_count>sample.fresh_process_count) {
    throw new TypeError(`sample ${index+1} peak_process_count cannot exceed fresh_process_count`);
  }
  const duplicates=denseArray(sample.duplicates,`sample ${index+1} duplicates`);
  const slowestFiles=denseArray(sample.slowest_files,`sample ${index+1} slowest_files`);
  const slowestTests=denseArray(sample.slowest_tests,`sample ${index+1} slowest_tests`);
  const entryProcesses=sample.entry_processes===undefined ? undefined :
    denseArray(sample.entry_processes,`sample ${index+1} entry_processes`);
  duplicates.forEach((row,rowIndex) => validateDuplicate(row,`sample ${index+1} duplicate ${rowIndex+1}`));
  slowestFiles.forEach((row,rowIndex) => validateDurationRow(row,`sample ${index+1} slow file ${rowIndex+1}`));
  slowestTests.forEach((row,rowIndex) => validateDurationRow(row,`sample ${index+1} slow test ${rowIndex+1}`));
  entryProcesses?.forEach((row,rowIndex) =>
    validateDurationRow(row,`sample ${index+1} entry process ${rowIndex+1}`));
  if (sample.stdout!==undefined && typeof sample.stdout!=="string") {
    throw new TypeError(`sample ${index+1} stdout must be a string`);
  }
  if (sample.stderr!==undefined && typeof sample.stderr!=="string") {
    throw new TypeError(`sample ${index+1} stderr must be a string`);
  }
  return sample;
}

function validateReportInput(input) {
  const record=closedRecord(input,"performance report input",["command","lane","identity","samples"]);
  validateCommand(record.command);
  nonemptyString(record.lane,"performance lane");
  if (record.lane!=="fast" && record.lane!=="full") {
    throw new TypeError("performance lane must be fast or full");
  }
  validateIdentity(record.identity);
  denseArray(record.samples,"performance samples");
  if (record.samples.length!==3) {
    throw new TypeError("performance report requires exactly three samples");
  }
  record.samples.forEach(validateSample);
  return record;
}

export function createPerformanceReport(input) {
  const {command,lane,identity,samples}=validateReportInput(input);
  const normalizedSamples=samples.map(sample => ({
    wall_ms:sample.wall_ms,user_cpu_ms:sample.user_cpu_ms,system_cpu_ms:sample.system_cpu_ms,
    exit_status:sample.exit_status,fresh_process_count:sample.fresh_process_count,
    peak_process_count:sample.peak_process_count,duplicates:sample.duplicates,
    slowest_files:sample.slowest_files,slowest_tests:sample.slowest_tests,
  }));
  return {
    schema_version:PERFORMANCE_REPORT_VERSION,
    command,lane,
    identity,
    samples:normalizedSamples,
    medians:{
      wall_ms:median(normalizedSamples.map(sample => sample.wall_ms)),
      user_cpu_ms:median(normalizedSamples.map(sample => sample.user_cpu_ms)),
      system_cpu_ms:median(normalizedSamples.map(sample => sample.system_cpu_ms)),
      fresh_process_count:median(normalizedSamples.map(sample => sample.fresh_process_count)),
      peak_process_count:median(normalizedSamples.map(sample => sample.peak_process_count)),
    },
  };
}

export function canonicalPerformanceJson(report) {
  const complete=closedRecord(report,"performance report",[
    "schema_version","command","lane","identity","samples","medians",
  ]);
  const normalized=createPerformanceReport({
    command:complete.command,lane:complete.lane,
    identity:complete.identity,
    samples:complete.samples,
  });
  if (complete.schema_version!==PERFORMANCE_REPORT_VERSION ||
      canonicalJson(normalized.medians)!==canonicalJson(complete.medians)) {
    throw new TypeError("invalid performance report");
  }
  return canonicalJson(normalized);
}

function validateBudgetDocument(document,label,expectedVersion) {
  const isBaseline=expectedVersion===PERFORMANCE_BASELINE_VERSION;
  const reportFields=["schema_version","command","lane","identity","samples","medians"];
  const record=closedRecord(document,label,isBaseline ?
    [...reportFields,"historical","budgets"] : reportFields);
  if (record.schema_version!==expectedVersion) {
    throw new TypeError(`${label} has unexpected schema_version`);
  }
  if (record.lane!=="fast" && record.lane!=="full") {
    throw new TypeError(`${label} lane must be fast or full`);
  }
  const normalized=createPerformanceReport({
    command:record.command,lane:record.lane,identity:record.identity,samples:record.samples,
  });
  if (canonicalJson(normalized.medians)!==canonicalJson(record.medians)) {
    throw new TypeError(`${label} medians do not match samples`);
  }
  if (isBaseline) {
    const historical=closedRecord(record.historical,`${label} historical`,["full_wall_ms"]);
    finiteNonnegative(historical.full_wall_ms,`${label} historical full_wall_ms`);
    if (historical.full_wall_ms!==HISTORICAL_FULL_WALL_MS) {
      throw new TypeError(`${label} historical full_wall_ms must match the locked baseline`);
    }
    const budgets=closedRecord(record.budgets,`${label} budgets`,[
      "fast_max_wall_ms","full_max_wall_ms",
    ]);
    nonnegativeInteger(budgets.fast_max_wall_ms,`${label} fast budget`);
    nonnegativeInteger(budgets.full_max_wall_ms,`${label} full budget`);
    if (budgets.fast_max_wall_ms!==FAST_MAX_WALL_MS) {
      throw new TypeError(`${label} fast budget must match the locked limit`);
    }
    const calculated=Math.floor(Math.min(HISTORICAL_FULL_WALL_MS,normalized.medians.wall_ms)*0.70);
    if (budgets.full_max_wall_ms>calculated) {
      throw new TypeError(`${label} full budget must not exceed the conservative calculated limit`);
    }
    const normalizedBaseline={
      ...normalized,schema_version:PERFORMANCE_BASELINE_VERSION,
      historical:{full_wall_ms:HISTORICAL_FULL_WALL_MS},
      budgets:{
        fast_max_wall_ms:budgets.fast_max_wall_ms,
        full_max_wall_ms:budgets.full_max_wall_ms,
      },
    };
    if (canonicalJson(normalizedBaseline)!==canonicalJson(record)) {
      throw new TypeError(`${label} must be a complete canonical document`);
    }
    return normalizedBaseline;
  }
  if (canonicalJson(normalized)!==canonicalJson(record)) {
    throw new TypeError(`${label} must be a complete canonical document`);
  }
  return normalized;
}

export function validatePerformanceBaseline(baseline) {
  return validateBudgetDocument(
    baseline,"performance baseline",PERFORMANCE_BASELINE_VERSION,
  );
}

export function validatePerformanceReport(report) {
  return validateBudgetDocument(
    report,"performance candidate",PERFORMANCE_REPORT_VERSION,
  );
}

function parseLockSource(source,label) {
  if (typeof source!=="string") throw new TypeError(`${label} lock source must be a string`);
  let lockfile;
  try {
    lockfile=JSON.parse(source);
  } catch {
    throw new TypeError(`${label} lock source must contain valid JSON`);
  }
  const root=plainRecord(lockfile,`${label} lockfile`);
  if (!Object.hasOwn(root,"version") || typeof root.version!=="string") {
    throw new TypeError(`${label} lockfile requires string root version`);
  }
  const packages=plainRecord(root.packages,`${label} lockfile packages`);
  const packageRoot=plainRecord(packages[""],`${label} lockfile root package`);
  if (!Object.hasOwn(packageRoot,"version") || typeof packageRoot.version!=="string") {
    throw new TypeError(`${label} lockfile root package requires string version`);
  }
  const normalized=structuredClone(root);
  normalized.version="<release-version>";
  normalized.packages[""].version="<release-version>";
  return {
    sha256:createHash("sha256").update(source).digest("hex"),
    normalized,
  };
}

function pairedLockEvidence(value) {
  if (value===undefined) return undefined;
  const evidence=closedRecord(value,"performance lock evidence",[],[
    "baselineLockSource","candidateLockSource",
  ]);
  const hasBaseline=Object.hasOwn(evidence,"baselineLockSource");
  const hasCandidate=Object.hasOwn(evidence,"candidateLockSource");
  if (hasBaseline!==hasCandidate) {
    throw new TypeError(
      "performance lock evidence requires both baselineLockSource and candidateLockSource",
    );
  }
  return hasBaseline ? evidence : undefined;
}

export function compatiblePerformanceIdentity(baseline,candidate,lockEvidence) {
  const evidence=pairedLockEvidence(lockEvidence);
  let lockCompatible=baseline.lock_sha256===candidate.lock_sha256;
  if (evidence!==undefined) {
    const baselineLock=parseLockSource(evidence.baselineLockSource,"baseline");
    const candidateLock=parseLockSource(evidence.candidateLockSource,"candidate");
    if (baselineLock.sha256!==baseline.lock_sha256) {
      throw new TypeError("baseline lock source SHA-256 must match performance identity");
    }
    if (candidateLock.sha256!==candidate.lock_sha256) {
      throw new TypeError("candidate lock source SHA-256 must match performance identity");
    }
    if (canonicalJson(baselineLock.normalized)!==canonicalJson(candidateLock.normalized)) {
      throw new TypeError("performance lock evidence differs beyond release version fields");
    }
    lockCompatible=true;
  }
  return ["node_version","platform","arch","runner_id"]
    .every(key => baseline[key]===candidate[key]) && lockCompatible;
}

export function comparePerformanceBudget(baseline,candidate,lane,lockEvidence) {
  const baselineReport=validatePerformanceBaseline(baseline);
  if (lane!=="fast" && lane!=="full") throw new TypeError("performance lane must be fast or full");
  if (baselineReport.lane!=="full") {
    throw new TypeError("performance baseline must use the full lane");
  }
  const baselineCommand=performanceCommandForLane("full",{
    executable:baselineReport.command.executable,
  });
  if (canonicalJson(baselineReport.command)!==canonicalJson(baselineCommand)) {
    throw new TypeError("performance baseline command must match canonical full command");
  }
  const candidateReport=validatePerformanceReport(candidate);
  if (candidateReport.lane!==lane) {
    throw new TypeError("performance candidate lane must match requested lane");
  }
  const expectedCommand=lane==="full" ? baselineReport.command : performanceCommandForLane("fast",{
    executable:baselineReport.command.executable,
  });
  if (canonicalJson(candidateReport.command)!==canonicalJson(expectedCommand)) {
    throw new TypeError("performance candidate command must match the requested lane");
  }
  const limit_ms=lane==="fast" ? baselineReport.budgets.fast_max_wall_ms :
    baselineReport.budgets.full_max_wall_ms;
  const actual_ms=candidateReport.medians.wall_ms;
  if (!compatiblePerformanceIdentity(
    baselineReport.identity,candidateReport.identity,lockEvidence,
  )) {
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
