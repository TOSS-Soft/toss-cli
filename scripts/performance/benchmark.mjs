import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {lstat,readFile,realpath,rename,writeFile} from "node:fs/promises";
import {arch,platform} from "node:os";
import {dirname,relative,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {canonicalJson} from "../../src/contracts/acp.js";
import {
  FAST_MAX_WALL_MS,HISTORICAL_FULL_WALL_MS,PERFORMANCE_BASELINE_VERSION,
  canonicalPerformanceJson,createPerformanceReport,
} from "./report.mjs";
import {runSuiteOnce} from "./run-suite.mjs";

const executeFile=promisify(execFile);

function nonemptyString(value,label) {
  if (typeof value!=="string" || value.length===0) throw new TypeError(`${label} must be a nonempty string`);
  return value;
}

function validateLane(lane) {
  if (lane!=="fast" && lane!=="full") throw new TypeError("benchmark lane must be fast or full");
  return lane;
}

function underRoot(candidate,root) {
  const contained=relative(root,candidate);
  return contained!=="" && contained!==".." && !contained.startsWith(`..${sep}`) && !contained.includes("\0");
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
  const report=createPerformanceReport({
    lane:"full",identity,
    samples:Array.from({length:3},() => ({
      wall_ms:0,user_cpu_ms:0,system_cpu_ms:0,exit_status:0,
      fresh_process_count:0,peak_process_count:0,duplicates:[],slowest_files:[],slowest_tests:[],
    })),
  });
  if (report.identity.runner_id!==runnerId) {
    throw new TypeError("benchmark runner ID must match identity runner_id");
  }
  return report.identity;
}

export async function runBenchmark({runs,lane,runnerId,cwd,identity,runOnce=runSuiteOnce}) {
  if (runs!==3) throw new TypeError("benchmark requires exactly three runs");
  validateLane(lane);
  nonemptyString(runnerId,"benchmark runner ID");
  nonemptyString(cwd,"benchmark cwd");
  if (typeof runOnce!=="function") throw new TypeError("benchmark runOnce must be a function");
  const exactIdentity=identity===undefined ? await collectIdentity(cwd,runnerId) : validateIdentity(identity,runnerId);
  const npm=process.platform==="win32" ? "npm.cmd" : "npm";
  const samples=[];
  for (let index=0;index<3;index+=1) {
    samples.push(await runOnce({
      command:npm,args:["test"],cwd,
      runId:`${exactIdentity.commit}-${index+1}`,env:{},
    }));
  }
  return createPerformanceReport({lane,identity:exactIdentity,samples});
}

export function createBaseline(report) {
  const normalized=JSON.parse(canonicalPerformanceJson(report));
  if (normalized.lane!=="full") throw new TypeError("baseline requires the full lane");
  const basis=Math.min(HISTORICAL_FULL_WALL_MS,normalized.medians.wall_ms);
  return Object.freeze({
    schema_version:PERFORMANCE_BASELINE_VERSION,
    identity:normalized.identity,
    historical:{full_wall_ms:HISTORICAL_FULL_WALL_MS},
    samples:normalized.samples,medians:normalized.medians,
    budgets:{
      fast_max_wall_ms:FAST_MAX_WALL_MS,
      full_max_wall_ms:Math.floor(basis*0.70),
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
  return Object.freeze(options);
}

export async function writeCanonicalReport(path,value,root) {
  nonemptyString(path,"report path");
  nonemptyString(root,"repository root");
  const canonicalRoot=await realpath(root);
  const destination=resolve(root,path);
  const parent=dirname(destination);
  const canonicalParent=await realpath(parent);
  if (!underRoot(canonicalParent,canonicalRoot)) throw new TypeError("report destination must remain under repository root");
  if (!underRoot(destination,canonicalRoot)) throw new TypeError("report destination must remain under repository root");
  try {
    if ((await lstat(destination)).isSymbolicLink()) throw new TypeError("report destination must not be a symbolic link");
  } catch (error) {
    if (error?.code!=="ENOENT") throw error;
  }
  const output=value?.schema_version==="toss-test-performance-report.v1" ?
    canonicalPerformanceJson(value) : canonicalJson(value);
  const temporary=resolve(parent,`.${destination.split(sep).at(-1)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary,output,{encoding:"utf8",flag:"wx",mode:0o600});
  await rename(temporary,destination);
}

async function main(argv) {
  const options=parseBenchmarkOptions(argv);
  const root=process.cwd();
  const report=await runBenchmark({...options,cwd:root});
  if (options.output!==undefined) await writeCanonicalReport(options.output,report,root);
  if (options.updateBaseline!==undefined) {
    await writeCanonicalReport(options.updateBaseline,createBaseline(report),root);
  }
  const output=renderBenchmarkOutput(report,options.json);
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
}

if (process.argv[1]===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const usage=error instanceof TypeError;
    process.stderr.write(`${error.message}\n`);
    process.exitCode=usage ? 2 : 70;
  });
}
