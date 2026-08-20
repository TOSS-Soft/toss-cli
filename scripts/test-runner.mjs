import {spawn} from "node:child_process";
import {readFile,realpath} from "node:fs/promises";
import {isAbsolute,relative,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";

import {
  REQUESTED_LANES,
  discoverEligibleTestEntries,
  selectTestEntries,
  validateTestManifest,
} from "./test-manifest.mjs";

const ENTRY_RESULT_FIELDS=Object.freeze([
  "entry","outcome","exit_status","signal","error_code",
  "stdout","stderr","duration_ms",
]);
const OUTCOMES=Object.freeze(["passed","failed","signaled","spawn_error"]);

function assertCanonicalEntry(entry) {
  if (typeof entry!=="string" || entry.length===0 || entry.includes("\0") || entry.includes("\\") || entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) {
    throw new TypeError(`unsafe test entry: ${String(entry)}`);
  }
  const segments=entry.split("/");
  if (segments.some(segment => !segment || segment==="." || segment==="..")) {
    throw new TypeError(`unsafe test entry: ${entry}`);
  }
  return segments;
}

function stableErrorCode(error) {
  if (typeof error?.code==="string" && error.code.length>0) return error.code;
  if (typeof error?.name==="string" && error.name.length>0) return error.name;
  return "SPAWN_ERROR";
}

function spawnErrorResult(entry,error,stdout,stderr,startedAt) {
  return {
    entry,
    outcome:"spawn_error",
    exit_status:null,
    signal:null,
    error_code:stableErrorCode(error),
    stdout,
    stderr,
    duration_ms:Date.now()-startedAt,
  };
}

export async function executeTestEntry(entry,{cwd,env}) {
  const segments=assertCanonicalEntry(entry);
  if (typeof cwd!=="string") {
    throw new TypeError("test repository root must be a string path");
  }
  cwd=await realpath(resolve(cwd));
  const absolutePlatformEntry=await realpath(resolve(cwd,...segments));
  const contained=relative(cwd,absolutePlatformEntry);
  if (contained==="" || contained===".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new TypeError(`test entry escapes repository root: ${entry}`);
  }

  const startedAt=Date.now();
  return new Promise(resolveResult => {
    let child;
    let stdout="";
    let stderr="";
    let settled=false;
    const settle=result => {
      if (settled) return;
      settled=true;
      resolveResult(result);
    };
    try {
      child=spawn(process.execPath,[
        "--test",
        absolutePlatformEntry,
      ],{
        cwd,
        env,
        shell:false,
        stdio:["ignore","pipe","pipe"],
      });
    } catch (error) {
      settle(spawnErrorResult(entry,error,stdout,stderr,startedAt));
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data",chunk => { stdout+=chunk; });
    child.stderr.on("data",chunk => { stderr+=chunk; });
    child.once("error",error => {
      settle(spawnErrorResult(entry,error,stdout,stderr,startedAt));
    });
    child.once("close",(exitStatus,signal) => {
      if (settled) return;
      const duration_ms=Date.now()-startedAt;
      if (signal!==null) {
        settle({
          entry,outcome:"signaled",exit_status:null,signal,error_code:null,
          stdout,stderr,duration_ms,
        });
        return;
      }
      settle({
        entry,
        outcome:exitStatus===0 ? "passed" : "failed",
        exit_status:exitStatus,
        signal:null,
        error_code:null,
        stdout,
        stderr,
        duration_ms,
      });
    });
  });
}

function resultDescriptors(value) {
  if (value===null || typeof value!=="object" || Object.getPrototypeOf(value)!==Object.prototype) {
    throw new TypeError("entry result must be a plain record");
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor=descriptors[key];
    if (typeof key!=="string" || !ENTRY_RESULT_FIELDS.includes(key)) {
      throw new TypeError(`unknown entry result field: ${String(key)}`);
    }
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("entry result must contain only own enumerable data properties");
    }
  }
  for (const field of ENTRY_RESULT_FIELDS) {
    if (!(field in descriptors)) {
      throw new TypeError(`missing entry result field: ${field}`);
    }
  }
  return descriptors;
}

function validateEntryResult(value,expectedEntry) {
  const descriptors=resultDescriptors(value);
  const result=Object.fromEntries(ENTRY_RESULT_FIELDS.map(field => [field,descriptors[field].value]));
  if (result.entry!==expectedEntry) {
    throw new TypeError(`entry result identifier mismatch: expected ${expectedEntry}`);
  }
  if (!OUTCOMES.includes(result.outcome)) {
    throw new TypeError(`unknown entry result outcome: ${String(result.outcome)}`);
  }
  if (typeof result.stdout!=="string" || typeof result.stderr!=="string") {
    throw new TypeError("entry result stdout and stderr must be strings");
  }
  if (typeof result.duration_ms!=="number" || !Number.isFinite(result.duration_ms) || result.duration_ms<0) {
    throw new TypeError("entry result duration_ms must be a nonnegative finite number");
  }

  if (result.outcome==="passed") {
    if (result.exit_status!==0 || result.signal!==null || result.error_code!==null) {
      throw new TypeError("passed entry result requires status 0 and no signal or error code");
    }
  } else if (result.outcome==="failed") {
    if (!Number.isInteger(result.exit_status) || result.exit_status===0 || result.signal!==null || result.error_code!==null) {
      throw new TypeError("failed entry result requires a nonzero integer status and no signal or error code");
    }
  } else if (result.outcome==="signaled") {
    if (result.exit_status!==null || typeof result.signal!=="string" || result.signal.length===0 || result.error_code!==null) {
      throw new TypeError("signaled entry result requires only a signal");
    }
  } else if (result.exit_status!==null || result.signal!==null || typeof result.error_code!=="string" || result.error_code.length===0) {
    throw new TypeError("spawn_error entry result requires only an error code");
  }
  return result;
}

function resultHeading(lane,result) {
  const evidence=result.outcome==="signaled" ? `signal=${result.signal}` :
    result.outcome==="spawn_error" ? `error_code=${result.error_code}` :
      `status=${result.exit_status}`;
  return `[test] lane=${lane} entry=${result.entry} outcome=${result.outcome} ${evidence} duration_ms=${result.duration_ms}\n`;
}

function failureEvidence(result) {
  return {
    entry:result.entry,
    outcome:result.outcome,
    exit_status:result.exit_status,
    signal:result.signal,
    error_code:result.error_code,
  };
}

export async function runTestLane({
  lane,cwd,manifest,eligibleEntries,executeEntry,stdout,stderr,
}) {
  const normalizedManifest=validateTestManifest(manifest,{eligibleEntries});
  const entries=selectTestEntries(normalizedManifest,lane);
  if (typeof executeEntry!=="function") {
    throw new TypeError("executeEntry must be a function");
  }
  if (!stdout || typeof stdout.write!=="function" || !stderr || typeof stderr.write!=="function") {
    throw new TypeError("stdout and stderr must provide write functions");
  }

  const results=new Array(entries.length);
  let nextIndex=0;
  const worker=async () => {
    while (nextIndex<entries.length) {
      const index=nextIndex;
      nextIndex+=1;
      const entry=entries[index];
      results[index]=validateEntryResult(await executeEntry(entry,{cwd}),entry);
    }
  };
  const workerCount=Math.min(normalizedManifest.concurrency,entries.length);
  await Promise.all(Array.from({length:workerCount},() => worker()));

  for (const result of results) {
    stdout.write(resultHeading(lane,result));
    if (result.stdout.length>0) stdout.write(result.stdout);
    if (result.stderr.length>0) stderr.write(result.stderr);
    if (result.outcome!=="passed") stderr.write(resultHeading(lane,result));
  }
  const firstFailure=results.find(result => result.outcome!=="passed") ?? null;
  return {
    lane,
    entries,
    results,
    exit_status:firstFailure===undefined || firstFailure===null ? 0 :
      firstFailure.outcome==="failed" ? firstFailure.exit_status : 1,
    first_failure:firstFailure===undefined || firstFailure===null ? null : failureEvidence(firstFailure),
  };
}

async function runCli(argumentsToRunner) {
  if (argumentsToRunner.length!==1) {
    throw new TypeError("test runner requires exactly one lane token");
  }
  const [lane]=argumentsToRunner;
  if (lane.startsWith("-") || !REQUESTED_LANES.includes(lane)) {
    throw new TypeError(`unknown test lane: ${lane}`);
  }
  const root=fileURLToPath(new URL("..",import.meta.url));
  const manifest=JSON.parse(await readFile(new URL("./test-manifest.json",import.meta.url),"utf8"));
  const eligibleEntries=await discoverEligibleTestEntries(root);
  validateTestManifest(manifest,{eligibleEntries});
  const result=await runTestLane({
    lane,
    cwd:root,
    manifest,
    eligibleEntries,
    executeEntry:entry => executeTestEntry(entry,{cwd:root,env:process.env}),
    stdout:process.stdout,
    stderr:process.stderr,
  });
  process.exitCode=result.exit_status;
}

if (
  process.argv[1] &&
  resolve(process.argv[1])===fileURLToPath(import.meta.url) &&
  process.env.NODE_TEST_CONTEXT===undefined
) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode=1;
  }
}
