import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {arch,platform} from "node:os";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {runSuiteOnce} from "./run-suite.mjs";
import {PerformanceToolError} from "./report.mjs";
import {
  STORE_FOCUSED_ENTRIES,canonicalStoreFocusedJson,createStoreFocusedReport,
} from "./store-focused-report.mjs";
import {writeValidatorBenchmarkReport} from "./validator-benchmark.mjs";

const executeFile=promisify(execFile);
const UNSAFE_OUTPUT_CODE="UNSAFE_VALIDATOR_BENCHMARK_OUTPUT";

function isHandledFocusedBenchmarkError(error) {
  return error instanceof TypeError || error instanceof PerformanceToolError ||
    error?.code===UNSAFE_OUTPUT_CODE;
}

function nonemptyString(value,label) {
  if (typeof value!=="string" || value.length===0) throw new TypeError(`${label} must be a nonempty string`);
  return value;
}

function validatePhase(value) {
  if (value!=="before" && value!=="after") throw new TypeError("phase must be before or after");
  return value;
}

async function collectIdentity(cwd,runnerId) {
  const [{stdout:commit},lock]=await Promise.all([
    executeFile("git",["rev-parse","HEAD"],{cwd,encoding:"utf8",shell:false}),
    readFile(resolve(cwd,"package-lock.json")),
  ]);
  return {
    commit:commit.trim(),node_version:process.version,platform:platform(),arch:arch(),
    lock_sha256:createHash("sha256").update(lock).digest("hex"),runner_id:runnerId,
  };
}

export function parseStoreFocusedOptions(argv) {
  if (!Array.isArray(argv)) throw new TypeError("focused benchmark arguments must be an array");
  const options={};
  const seen=new Set();
  for (let index=0;index<argv.length;index+=1) {
    const option=argv[index];
    if (typeof option!=="string" || !option.startsWith("--") ||
        !["--runs","--phase","--runner-id","--output"].includes(option)) {
      throw new TypeError(`unknown option ${String(option)}`);
    }
    if (seen.has(option)) throw new TypeError(`duplicate option ${option}`);
    const value=argv[index+1];
    if (typeof value!=="string" || value.length===0 || value.startsWith("--")) {
      throw new TypeError(`${option} requires a value`);
    }
    seen.add(option);
    index+=1;
    if (option==="--runs") {
      if (value!=="3") throw new TypeError("focused benchmark requires exactly 3 runs");
      options.runs=3;
    } else if (option==="--phase") options.phase=validatePhase(value);
    else if (option==="--runner-id") options.runnerId=nonemptyString(value,"focused benchmark runner ID");
    else options.output=value;
  }
  for (const [key,option] of [["runs","--runs"],["phase","--phase"],["runnerId","--runner-id"],["output","--output"]]) {
    if (options[key]===undefined) throw new TypeError(`focused benchmark requires ${option}`);
  }
  return Object.freeze(options);
}

export async function runStoreFocusedBenchmark({runs,phase,runnerId,cwd,identity,runOnce=runSuiteOnce}) {
  if (runs!==3) throw new TypeError("focused benchmark requires exactly three runs");
  validatePhase(phase);
  nonemptyString(runnerId,"focused benchmark runner ID");
  nonemptyString(cwd,"focused benchmark cwd");
  if (typeof runOnce!=="function") throw new TypeError("focused benchmark runOnce must be a function");
  const exactIdentity=identity===undefined ? await collectIdentity(cwd,runnerId) : identity;
  if (exactIdentity?.runner_id!==runnerId) {
    throw new TypeError("focused benchmark runner ID must match identity runner_id");
  }
  const command=Object.freeze({
    executable:process.execPath,
    arguments:Object.freeze(["--test",...STORE_FOCUSED_ENTRIES]),
  });
  const samples=[];
  for (let run=1;run<=3;run+=1) {
    samples.push(await runOnce({
      command:command.executable,args:command.arguments,cwd,
      runId:`${exactIdentity.commit}-store-${phase}-${run}`,env:{},
    }));
  }
  return createStoreFocusedReport({phase,identity:exactIdentity,command,samples});
}

async function main(argv) {
  let options;
  try {
    options=parseStoreFocusedOptions(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode=2;
    return;
  }
  const cwd=process.cwd();
  try {
    const report=await runStoreFocusedBenchmark({...options,cwd});
    await writeValidatorBenchmarkReport(options.output,report,cwd,{canonicalize:canonicalStoreFocusedJson});
    process.stdout.write(canonicalStoreFocusedJson(report));
  } catch (error) {
    if (isHandledFocusedBenchmarkError(error)) {
      process.stderr.write(`${error.code ?? "INVALID_STORE_FOCUSED_EVIDENCE"}: ${error.message}\n`);
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
