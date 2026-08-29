import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {arch,platform} from "node:os";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {
  CONCURRENCY_CANDIDATES,
  canonicalConcurrencyJson,
  createConcurrencyReport,
  parseFullLaneHeadings,
} from "./concurrency-report.mjs";
import {PerformanceToolError} from "./report.mjs";
import {runSuiteOnce} from "./run-suite.mjs";
import {writeValidatorBenchmarkReport} from "./validator-benchmark.mjs";
import {
  discoverEligibleTestEntries,
  selectTestEntries,
  validateTestManifest,
} from "../test-manifest.mjs";

const executeFile=promisify(execFile);
const worker=fileURLToPath(new URL("./concurrency-worker.mjs",import.meta.url));
const UNSAFE_OUTPUT_CODE="UNSAFE_VALIDATOR_BENCHMARK_OUTPUT";

function nonemptyString(value,label) {
  if (typeof value!=="string" || value.length===0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
  return value;
}

function isHandledConcurrencyBenchmarkError(error) {
  return error instanceof TypeError || error instanceof PerformanceToolError ||
    error?.code===UNSAFE_OUTPUT_CODE;
}

function captureError(error) {
  const code=typeof error?.code==="string" && error.code.length>0 ? error.code :
    typeof error?.name==="string" && error.name.length>0 ? error.name : "CAPTURE_ERROR";
  const message=typeof error?.message==="string" && error.message.length>0 ? error.message :
    String(error) || "concurrency capture failed";
  return {code,message};
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

async function checkedManifest(cwd) {
  const manifest=JSON.parse(await readFile(resolve(cwd,"scripts","test-manifest.json"),"utf8"));
  const eligibleEntries=await discoverEligibleTestEntries(cwd);
  return validateTestManifest(manifest,{eligibleEntries});
}

export function parseConcurrencyBenchmarkOptions(argv) {
  if (!Array.isArray(argv)) throw new TypeError("concurrency benchmark arguments must be an array");
  const options={};
  const seen=new Set();
  for (let index=0;index<argv.length;index+=1) {
    const option=argv[index];
    if (typeof option!=="string" || !option.startsWith("--") ||
        !["--runs","--runner-id","--output"].includes(option)) {
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
      if (value!=="3") throw new TypeError("concurrency benchmark requires exactly 3 runs");
      options.runs=3;
    } else if (option==="--runner-id") {
      options.runnerId=nonemptyString(value,"concurrency benchmark runner ID");
    } else {
      options.output=value;
    }
  }
  for (const [key,option] of [["runs","--runs"],["runnerId","--runner-id"],["output","--output"]]) {
    if (options[key]===undefined) throw new TypeError(`concurrency benchmark requires ${option}`);
  }
  return Object.freeze(options);
}

function completedEvidence(sample,entries) {
  const entry_results=parseFullLaneHeadings(sample.stdout,entries);
  const isolation=entry_results.find(
    result => result.entry==="test/command-store-fixture.test.js",
  );
  return {
    wall_ms:sample.wall_ms,
    user_cpu_ms:sample.user_cpu_ms,
    system_cpu_ms:sample.system_cpu_ms,
    exit_status:sample.exit_status,
    fresh_process_count:sample.fresh_process_count,
    peak_process_count:sample.peak_process_count,
    duplicates:sample.duplicates,
    entry_results,
    orphan_process_count:0,
    isolation_passed:isolation?.outcome==="passed",
  };
}

export async function runConcurrencyBenchmark({
  runs,runnerId,cwd,identity,runOnce=runSuiteOnce,
}) {
  if (runs!==3) throw new TypeError("concurrency benchmark requires exactly three runs");
  nonemptyString(runnerId,"concurrency benchmark runner ID");
  nonemptyString(cwd,"concurrency benchmark cwd");
  if (typeof runOnce!=="function") throw new TypeError("concurrency benchmark runOnce must be a function");
  const exactIdentity=identity===undefined ? await collectIdentity(cwd,runnerId) : identity;
  if (exactIdentity?.runner_id!==runnerId) {
    throw new TypeError("concurrency benchmark runner ID must match identity runner_id");
  }
  const manifest=await checkedManifest(cwd);
  const entries=selectTestEntries(manifest,"full");
  const candidates=[];
  for (const concurrency of CONCURRENCY_CANDIDATES) {
    const samples=[];
    for (let run=1;run<=3;run+=1) {
      try {
        const sample=await runOnce({
          command:process.execPath,
          args:[worker,"--concurrency",String(concurrency)],
          cwd,
          runId:`${exactIdentity.commit}-concurrency-${concurrency}-${run}`,
          env:{},
        });
        samples.push({run,capture_error:null,evidence:completedEvidence(sample,entries)});
      } catch (error) {
        samples.push({run,capture_error:captureError(error),evidence:null});
      }
    }
    candidates.push({concurrency,samples});
  }
  return createConcurrencyReport({identity:exactIdentity,entries,candidates});
}

async function main(argv) {
  let options;
  try {
    options=parseConcurrencyBenchmarkOptions(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode=2;
    return;
  }
  const cwd=process.cwd();
  try {
    const report=await runConcurrencyBenchmark({...options,cwd});
    await writeValidatorBenchmarkReport(options.output,report,cwd,{
      canonicalize:canonicalConcurrencyJson,
    });
    process.stdout.write(canonicalConcurrencyJson(report));
  } catch (error) {
    if (isHandledConcurrencyBenchmarkError(error)) {
      process.stderr.write(`${error.code ?? "INVALID_CONCURRENCY_EVIDENCE"}: ${error.message}\n`);
      process.exitCode=5;
      return;
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1])===fileURLToPath(import.meta.url) &&
  process.env.NODE_TEST_CONTEXT===undefined
) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode=70;
  });
}
