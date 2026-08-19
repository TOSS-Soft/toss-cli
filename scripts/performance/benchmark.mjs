import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {lstat,readFile,realpath,rename,rm,writeFile} from "node:fs/promises";
import {arch,platform} from "node:os";
import {dirname,relative,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {canonicalJson} from "../../src/contracts/acp.js";
import {
  FAST_MAX_WALL_MS,HISTORICAL_FULL_WALL_MS,PERFORMANCE_BASELINE_VERSION,
  PerformanceToolError,canonicalPerformanceJson,compatiblePerformanceIdentity,
  createPerformanceReport,validatePerformanceBaseline,validatePerformanceIdentity,
  validatePerformanceReport,
} from "./report.mjs";
import {runSuiteOnce} from "./run-suite.mjs";

const executeFile=promisify(execFile);
const BASELINE_RELATIVE_PATH="docs/performance/v2.1.1-baseline.json";

class BenchmarkOutputError extends Error {
  constructor(message) {
    super(message);
    this.code="UNSAFE_PERFORMANCE_OUTPUT";
  }
}

function nonemptyString(value,label) {
  if (typeof value!=="string" || value.length===0) throw new TypeError(`${label} must be a nonempty string`);
  return value;
}

function validateLane(lane) {
  if (lane!=="full") throw new TypeError("benchmark capture requires the full lane");
  return lane;
}

function underRoot(candidate,root) {
  const contained=relative(root,candidate);
  return contained!=="" && contained!==".." && !contained.startsWith(`..${sep}`) && !contained.includes("\0");
}

function isBaselineDestination(destination,root) {
  return relative(root,destination).split(sep).join("/")===BASELINE_RELATIVE_PATH;
}

async function isTrackedDestination(destination,root) {
  try {
    await executeFile("git",["ls-files","--error-unmatch","--",relative(root,destination)],{
      cwd:root,encoding:"utf8",
    });
    return true;
  } catch (error) {
    if (error?.code===1) return false;
    throw error;
  }
}

function validateBaselineDestination(path,root) {
  if (!isBaselineDestination(resolve(root,path),root)) {
    throw new TypeError(`--update-baseline must target ${BASELINE_RELATIVE_PATH}`);
  }
}

async function readExistingBaseline(path,root) {
  let source;
  try {
    source=await readFile(resolve(root,path),"utf8");
  } catch (error) {
    if (error?.code==="ENOENT") return undefined;
    if (error?.code==="EISDIR") {
      throw new BenchmarkOutputError("existing baseline destination must be a regular file");
    }
    throw error;
  }
  let baseline;
  try {
    baseline=JSON.parse(source);
  } catch {
    throw new TypeError("existing baseline must contain valid JSON evidence");
  }
  return validatePerformanceBaseline(baseline);
}

async function rejectSymlinkParents(destination,root) {
  const parts=relative(root,destination).split(sep);
  parts.pop();
  let parent=root;
  for (const part of parts) {
    parent=resolve(parent,part);
    let status;
    try {
      status=await lstat(parent);
    } catch (error) {
      if (error?.code==="ENOENT") return;
      throw error;
    }
    if (status.isSymbolicLink()) {
      throw new BenchmarkOutputError("report destination must not use a symbolic-link parent");
    }
  }
}

async function collectIdentity(cwd,runnerId) {
  nonemptyString(cwd,"benchmark cwd");
  nonemptyString(runnerId,"benchmark runner ID");
  const [{stdout:commit},lock]=await Promise.all([
    executeFile("git",["rev-parse","HEAD"],{cwd,encoding:"utf8"}),
    readFile(resolve(cwd,"package-lock.json")),
  ]);
  return {
    commit:commit.trim(),node_version:process.version,platform:platform(),arch:arch(),
    lock_sha256:createHash("sha256").update(lock).digest("hex"),runner_id:runnerId,
  };
}

function validateIdentity(identity,runnerId) {
  const normalized=validatePerformanceIdentity(identity);
  if (normalized.runner_id!==runnerId) {
    throw new TypeError("benchmark runner ID must match identity runner_id");
  }
  return normalized;
}

export async function runBenchmark({runs,lane,runnerId,cwd,identity,runOnce=runSuiteOnce}) {
  if (runs!==3) throw new TypeError("benchmark requires exactly three runs");
  validateLane(lane);
  nonemptyString(runnerId,"benchmark runner ID");
  nonemptyString(cwd,"benchmark cwd");
  if (typeof runOnce!=="function") throw new TypeError("benchmark runOnce must be a function");
  const exactIdentity=identity===undefined ? await collectIdentity(cwd,runnerId) : validateIdentity(identity,runnerId);
  const npm=process.platform==="win32" ? "npm.cmd" : "npm";
  const command={executable:npm,arguments:["test"]};
  const samples=[];
  for (let index=0;index<3;index+=1) {
    samples.push(await runOnce({
      command:npm,args:["test"],cwd,
      runId:`${exactIdentity.commit}-${index+1}`,env:{},
    }));
  }
  return createPerformanceReport({command,lane,identity:exactIdentity,samples});
}

export function createBaseline(report,existingBaseline) {
  const normalized=validatePerformanceReport(report);
  if (normalized.lane!=="full") throw new TypeError("baseline requires the full lane");
  const basis=Math.min(HISTORICAL_FULL_WALL_MS,normalized.medians.wall_ms);
  const calculatedLimit=Math.floor(basis*0.70);
  let fullLimit=calculatedLimit;
  if (existingBaseline!==undefined) {
    const existing=validatePerformanceBaseline(existingBaseline);
    if (existing.lane!==normalized.lane) {
      throw new TypeError("existing baseline lane must match captured report lane");
    }
    if (canonicalJson(existing.command)!==canonicalJson(normalized.command)) {
      throw new TypeError("existing baseline command must match captured report command");
    }
    if (!compatiblePerformanceIdentity(existing.identity,normalized.identity)) {
      throw new TypeError("existing baseline uses an incompatible performance environment");
    }
    fullLimit=Math.min(existing.budgets.full_max_wall_ms,calculatedLimit);
  }
  return Object.freeze({
    schema_version:PERFORMANCE_BASELINE_VERSION,
    command:normalized.command,lane:normalized.lane,identity:normalized.identity,
    historical:{full_wall_ms:HISTORICAL_FULL_WALL_MS},
    samples:normalized.samples,medians:normalized.medians,
    budgets:{
      fast_max_wall_ms:FAST_MAX_WALL_MS,
      full_max_wall_ms:fullLimit,
    },
  });
}

export function renderBenchmarkOutput(report,json) {
  if (json) return {stdout:canonicalPerformanceJson(report),stderr:""};
  const normalized=JSON.parse(canonicalPerformanceJson(report));
  return {
    stdout:[
      `${normalized.lane} median: ${normalized.medians.wall_ms}ms`,
      `user CPU: ${normalized.medians.user_cpu_ms}ms`,
      `system CPU: ${normalized.medians.system_cpu_ms}ms`,
      `processes: ${normalized.medians.fresh_process_count}`,
    ].join("\n")+"\n",
    stderr:"",
  };
}

export function parseBenchmarkOptions(argv) {
  if (!Array.isArray(argv)) throw new TypeError("benchmark arguments must be an array");
  const options={json:false};
  const seen=new Set();
  for (let index=0;index<argv.length;index+=1) {
    const option=argv[index];
    if (typeof option!=="string" || !option.startsWith("--")) throw new TypeError(`unknown option ${String(option)}`);
    if (option==="--json") {
      if (seen.has(option)) throw new TypeError("duplicate option --json");
      options.json=true;
      seen.add(option);
      continue;
    }
    if (!["--runs","--lane","--runner-id","--output","--update-baseline"].includes(option)) {
      throw new TypeError(`unknown option ${option}`);
    }
    if (seen.has(option)) throw new TypeError(`duplicate option ${option}`);
    const value=argv[index+1];
    if (typeof value!=="string" || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
    seen.add(option);
    index+=1;
    if (option==="--runs") {
      if (value!=="3") throw new TypeError("benchmark requires exactly 3 runs");
      options.runs=3;
    } else if (option==="--lane") {
      options.lane=validateLane(value);
    } else if (option==="--runner-id") {
      options.runnerId=nonemptyString(value,"benchmark runner ID");
    } else if (option==="--output") {
      options.output=value;
    } else {
      options.updateBaseline=value;
    }
  }
  for (const [key,option] of [["runs","--runs"],["lane","--lane"],["runnerId","--runner-id"]]) {
    if (options[key]===undefined) throw new TypeError(`benchmark requires ${option}`);
  }
  if (options.updateBaseline!==undefined && options.lane!=="full") {
    throw new TypeError("baseline update requires the full lane");
  }
  return Object.freeze(options);
}

export async function writeCanonicalReport(path,value,root,{
  allowBaseline=false,renameFile=rename,
}={}) {
  nonemptyString(path,"report path");
  nonemptyString(root,"repository root");
  const canonicalRoot=await realpath(root);
  const destination=resolve(root,path);
  const parent=dirname(destination);
  await rejectSymlinkParents(destination,root);
  const canonicalParent=await realpath(parent);
  if (canonicalParent!==canonicalRoot && !underRoot(canonicalParent,canonicalRoot)) {
    throw new BenchmarkOutputError("report destination must remain under repository root");
  }
  if (!underRoot(destination,canonicalRoot)) {
    throw new BenchmarkOutputError("report destination must remain under repository root");
  }
  try {
    const status=await lstat(destination);
    if (status.isSymbolicLink()) {
      throw new BenchmarkOutputError("report destination must not be a symbolic link");
    }
    if (!status.isFile()) {
      throw new BenchmarkOutputError("existing report destination must be a regular file");
    }
  } catch (error) {
    if (error?.code!=="ENOENT") throw error;
  }
  if (allowBaseline && !isBaselineDestination(destination,canonicalRoot)) {
    throw new BenchmarkOutputError("baseline updates require the approved baseline destination");
  }
  if ((!allowBaseline && isBaselineDestination(destination,canonicalRoot)) ||
      (!allowBaseline && await isTrackedDestination(destination,canonicalRoot))) {
    throw new BenchmarkOutputError("ordinary benchmark output cannot overwrite a tracked destination");
  }
  const output=value?.schema_version==="toss-test-performance-report.v1" ?
    canonicalPerformanceJson(value) : canonicalJson(value);
  const temporary=resolve(parent,`.${destination.split(sep).at(-1)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary,output,{encoding:"utf8",flag:"wx",mode:0o600});
  try {
    await renameFile(temporary,destination);
  } catch (error) {
    try {
      await rm(temporary,{force:true});
    } catch (cleanupError) {
      throw new AggregateError([error,cleanupError],"report rename and temporary cleanup failed");
    }
    throw error;
  }
}

async function main(argv) {
  let options;
  try {
    options=parseBenchmarkOptions(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode=2;
    return;
  }
  const root=process.cwd();
  try {
    if (options.updateBaseline!==undefined) validateBaselineDestination(options.updateBaseline,root);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode=2;
    return;
  }
  try {
    const existingBaseline=options.updateBaseline===undefined ? undefined :
      await readExistingBaseline(options.updateBaseline,root);
    const report=await runBenchmark({...options,cwd:root});
    if (options.output!==undefined) await writeCanonicalReport(options.output,report,root);
    if (options.updateBaseline!==undefined) {
      await writeCanonicalReport(
        options.updateBaseline,createBaseline(report,existingBaseline),root,{allowBaseline:true},
      );
    }
    const output=renderBenchmarkOutput(report,options.json);
    process.stdout.write(output.stdout);
    process.stderr.write(output.stderr);
  } catch (error) {
    if (error instanceof TypeError || error instanceof PerformanceToolError ||
        error instanceof BenchmarkOutputError) {
      const code=error.code ?? "INVALID_PERFORMANCE_EVIDENCE";
      process.stderr.write(`${code}: ${error.message}\n`);
      process.exitCode=5;
      return;
    }
    throw error;
  }
}

if (process.argv[1]===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode=70;
  });
}
