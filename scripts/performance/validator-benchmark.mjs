import {execFile} from "node:child_process";
import {createHash,randomBytes} from "node:crypto";
import {lstat,readFile,realpath,rename,rm,writeFile} from "node:fs/promises";
import {arch,platform} from "node:os";
import * as nativePath from "node:path";
import {dirname,relative,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {
  VALIDATOR_PHASES,
  VALIDATOR_STRATEGIES,
  canonicalValidatorColdStartJson,
  createValidatorColdStartReport,
} from "./validator-report.mjs";

const executeFile=promisify(execFile);
const WORKER_PATH=fileURLToPath(new URL("./validator-phase-worker.mjs",import.meta.url));
const FOCUSED_ARGUMENTS=Object.freeze(["--test","test/gate-cli-round1.test.js"]);
const FOCUSED_BASE_COMMIT="2caf811f521ee1c1664104a68ea35512fc87fdc8";
const FOCUSED_BEFORE_SAMPLES=Object.freeze([
  32581.98975,32685.560625,32656.405041,
]);
const WORKER_MODES=Object.freeze([
  "empty-process",
  "cli-module",
  "representative-command",
  "eager-reference",
  "demand-driven",
  "standalone-experiment",
]);
const PROBE_MODES=new Map([
  ["empty-process","empty_process"],
  ["cli-module","cli_module"],
  ["representative-command","representative_command"],
]);
const HASH=/^[a-f0-9]{64}$/u;

export class ValidatorBenchmarkEvidenceError extends TypeError {
  constructor(message) {
    super(message);
    this.code="INVALID_VALIDATOR_BENCHMARK_EVIDENCE";
  }
}

class ValidatorBenchmarkOutputError extends Error {
  constructor(message) {
    super(message);
    this.code="UNSAFE_VALIDATOR_BENCHMARK_OUTPUT";
  }
}

function nonemptyString(value,label) {
  if (typeof value!=="string" || value.length===0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
  return value;
}

function plainRecord(value,label) {
  if (!value || typeof value!=="object" || Array.isArray(value) ||
      Object.getPrototypeOf(value)!==Object.prototype) {
    throw new ValidatorBenchmarkEvidenceError(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value,label,required) {
  const record=plainRecord(value,label);
  const names=Object.getOwnPropertyNames(record);
  if (Object.getOwnPropertySymbols(record).length>0 || names.length!==required.length ||
      required.some(key => !Object.hasOwn(record,key))) {
    throw new ValidatorBenchmarkEvidenceError(
      `${label} requires exactly ${required.join(", ")}`,
    );
  }
  for (const key of names) {
    const descriptor=Object.getOwnPropertyDescriptor(record,key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new ValidatorBenchmarkEvidenceError(`${label} ${key} must be enumerable data`);
    }
  }
  return record;
}

function finiteNonnegative(value,label) {
  if (!Number.isFinite(value) || value<0) {
    throw new ValidatorBenchmarkEvidenceError(`${label} must be finite nonnegative`);
  }
  return value;
}

function sha256(value,label) {
  if (typeof value!=="string" || !HASH.test(value)) {
    throw new ValidatorBenchmarkEvidenceError(`${label} must be a SHA-256 hex digest`);
  }
  return value;
}

function workerKeys(mode) {
  const keys=["mode","exit_status",...VALIDATOR_PHASES];
  if (["eager-reference","demand-driven","standalone-experiment"].includes(mode)) {
    keys.push("result_sha256");
  }
  if (mode==="standalone-experiment") {
    keys.push(
      "standalone_source_sha256","standalone_source_bytes","input_schema_sha256",
    );
  }
  return keys;
}

function normalizeWorkerRecord(value,mode) {
  if (!WORKER_MODES.includes(mode)) {
    throw new ValidatorBenchmarkEvidenceError(`unknown validator worker mode ${mode}`);
  }
  const record=exactKeys(value,`${mode} worker evidence`,workerKeys(mode));
  if (record.mode!==mode) {
    throw new ValidatorBenchmarkEvidenceError(
      `${mode} worker mode must match requested mode`,
    );
  }
  if (!Number.isInteger(record.exit_status) || record.exit_status!==0) {
    throw new ValidatorBenchmarkEvidenceError(
      `${mode} worker must have successful exit_status 0`,
    );
  }
  const sample={exit_status:0};
  for (const phase of VALIDATOR_PHASES) {
    sample[phase]=finiteNonnegative(record[phase],`${mode} worker ${phase}`);
    if (phase!=="total_ms" && sample[phase]>record.total_ms) {
      throw new ValidatorBenchmarkEvidenceError(
        `${mode} worker total_ms must be at least ${phase}`,
      );
    }
  }
  const diagnostics={};
  if (Object.hasOwn(record,"result_sha256")) {
    diagnostics.result_sha256=sha256(
      record.result_sha256,`${mode} worker result_sha256`,
    );
  }
  if (mode==="standalone-experiment") {
    diagnostics.standalone_source_sha256=sha256(
      record.standalone_source_sha256,
      `${mode} worker standalone_source_sha256`,
    );
    if (!Number.isSafeInteger(record.standalone_source_bytes) ||
        record.standalone_source_bytes<=0) {
      throw new ValidatorBenchmarkEvidenceError(
        `${mode} worker standalone_source_bytes must be a positive safe integer`,
      );
    }
    diagnostics.standalone_source_bytes=record.standalone_source_bytes;
    diagnostics.input_schema_sha256=sha256(
      record.input_schema_sha256,`${mode} worker input_schema_sha256`,
    );
  }
  return {sample,diagnostics};
}

function normalizeFocused(value) {
  const record=exactKeys(value,"focused gate evidence",["exit_status","wall_ms"]);
  if (!Number.isInteger(record.exit_status) || record.exit_status!==0) {
    throw new ValidatorBenchmarkEvidenceError(
      "focused gate evidence must have successful exit_status 0",
    );
  }
  return finiteNonnegative(record.wall_ms,"focused gate evidence wall_ms");
}

async function collectIdentity(cwd,runnerId) {
  const [{stdout:commit},lock]=await Promise.all([
    executeFile("git",["rev-parse","HEAD"],{cwd,encoding:"utf8",shell:false}),
    readFile(resolve(cwd,"package-lock.json")),
  ]);
  return {
    commit:commit.trim(),
    node_version:process.version,
    platform:platform(),
    arch:arch(),
    lock_sha256:createHash("sha256").update(lock).digest("hex"),
    runner_id:runnerId,
  };
}

function runChild(command,args,cwd) {
  return new Promise(resolvePromise => {
    const started=performance.now();
    execFile(command,args,{cwd,encoding:"utf8",shell:false},(error,stdout,stderr) => {
      resolvePromise({
        exit_status:error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
        wall_ms:performance.now()-started,
        stdout:stdout ?? error?.stdout ?? "",
        stderr:stderr ?? error?.stderr ?? "",
      });
    });
  });
}

async function runWorkerProcess(mode,{cwd}) {
  const result=await runChild(process.execPath,[WORKER_PATH,mode],cwd);
  if (result.exit_status!==0) {
    throw new ValidatorBenchmarkEvidenceError(
      `${mode} worker exited ${result.exit_status}: ${result.stderr.trim()}`,
    );
  }
  let record;
  try {
    record=JSON.parse(result.stdout);
  } catch {
    throw new ValidatorBenchmarkEvidenceError(`${mode} worker emitted malformed JSON`);
  }
  const internalTotal=finiteNonnegative(record?.total_ms,`${mode} worker total_ms`);
  return {
    ...record,
    process_ms:Math.max(0,result.wall_ms-internalTotal),
    total_ms:result.wall_ms,
  };
}

async function runFocusedProcess({command,args,cwd}) {
  const result=await runChild(command,args,cwd);
  return {exit_status:result.exit_status,wall_ms:result.wall_ms};
}

function allEqual(values) {
  return values.length>0 && values.every(value => value===values[0]);
}

export async function runValidatorBenchmark(options) {
  const input=exactKeys(options,"validator benchmark options",[
    "runs","runnerId","cwd","identity","runWorker","runFocused",
  ]);
  if (input.runs!==3) throw new TypeError("validator benchmark requires exactly three runs");
  nonemptyString(input.runnerId,"validator benchmark runner ID");
  nonemptyString(input.cwd,"validator benchmark cwd");
  if (typeof input.runWorker!=="function" || typeof input.runFocused!=="function") {
    throw new TypeError("validator benchmark runners must be functions");
  }
  const identity=input.identity===undefined ?
    await collectIdentity(input.cwd,input.runnerId) : input.identity;
  if (identity?.runner_id!==input.runnerId) {
    throw new TypeError("validator benchmark runner ID must match identity runner_id");
  }

  const captured=new Map();
  const diagnostics=new Map();
  for (const mode of WORKER_MODES) {
    const samples=[];
    const modeDiagnostics=[];
    for (let index=0;index<3;index+=1) {
      const normalized=normalizeWorkerRecord(await input.runWorker(mode),mode);
      samples.push(normalized.sample);
      modeDiagnostics.push(normalized.diagnostics);
    }
    captured.set(mode,samples);
    diagnostics.set(mode,modeDiagnostics);
  }

  const focused=[];
  const focusedInvocation={
    command:process.execPath,
    args:[...FOCUSED_ARGUMENTS],
    cwd:input.cwd,
  };
  for (let index=0;index<3;index+=1) {
    focused.push(normalizeFocused(await input.runFocused({...focusedInvocation})));
  }

  const probes={};
  for (const [mode,name] of PROBE_MODES) probes[name]={samples:captured.get(mode)};
  const strategies=VALIDATOR_STRATEGIES.map(name => ({name,samples:captured.get(name)}));
  const sourceHashes=diagnostics.get("standalone-experiment")
    .map(row => row.standalone_source_sha256);
  const resultHashes=VALIDATOR_STRATEGIES.flatMap(name =>
    diagnostics.get(name).map(row => row.result_sha256));

  return createValidatorColdStartReport({
    identity,
    probes,
    strategies,
    focused_gate_cli:{
      base_commit:FOCUSED_BASE_COMMIT,
      before_samples_ms:[...FOCUSED_BEFORE_SAMPLES],
      after_samples_ms:focused,
    },
    evidence:{
      standalone_deterministic:allEqual(sourceHashes),
      // One schema cannot establish drift protection for the closed 37-schema catalog.
      standalone_drift_verified:false,
      standalone_equivalent:allEqual(resultHashes),
      standalone_focused_samples_ms:null,
    },
  });
}

export function parseValidatorBenchmarkOptions(argv) {
  if (!Array.isArray(argv)) throw new TypeError("validator benchmark arguments must be an array");
  const options={json:false};
  const seen=new Set();
  for (let index=0;index<argv.length;index+=1) {
    const option=argv[index];
    if (typeof option!=="string" || !option.startsWith("--")) {
      throw new TypeError(`unknown option ${String(option)}`);
    }
    if (option==="--json") {
      if (seen.has(option)) throw new TypeError("duplicate option --json");
      seen.add(option);
      options.json=true;
      continue;
    }
    if (!["--runs","--runner-id","--output"].includes(option)) {
      throw new TypeError(`unknown option ${option}`);
    }
    if (seen.has(option)) throw new TypeError(`duplicate option ${option}`);
    const value=argv[index+1];
    if (typeof value!=="string" || value.length===0 || value.startsWith("--")) {
      throw new TypeError(`${option} requires a value`);
    }
    seen.add(option);
    index+=1;
    if (option==="--runs") {
      if (value!=="3") throw new TypeError("validator benchmark requires exactly 3 runs");
      options.runs=3;
    } else if (option==="--runner-id") {
      options.runnerId=value;
    } else {
      options.output=value;
    }
  }
  if (options.runs===undefined) throw new TypeError("validator benchmark requires --runs");
  if (options.runnerId===undefined) {
    throw new TypeError("validator benchmark requires --runner-id");
  }
  return options;
}

export function isPathContained(candidate,root,{
  allowRoot=false,pathImplementation=nativePath,
}={}) {
  const path=pathImplementation.relative(root,candidate);
  return (allowRoot && path==="") ||
    (path!=="" && path!==".." && !pathImplementation.isAbsolute(path) &&
      !path.startsWith(`..${pathImplementation.sep}`) && !path.includes("\0"));
}

async function rejectSymlinkPath(destination,root) {
  const parts=relative(root,destination).split(sep);
  let current=root;
  for (const part of parts) {
    current=resolve(current,part);
    try {
      const status=await lstat(current);
      if (status.isSymbolicLink()) {
        throw new ValidatorBenchmarkOutputError(
          "validator report destination must not use symbolic links",
        );
      }
    } catch (error) {
      if (error?.code==="ENOENT") return;
      throw error;
    }
  }
}

async function tracked(destination,root) {
  const entry=relative(root,destination).split(sep).join("/").toLowerCase();
  const {stdout}=await executeFile("git",[
    "ls-files","-z","--full-name","--",".superpowers",
  ],{cwd:root,encoding:"utf8",shell:false});
  return stdout.split("\0").some(candidate =>
    candidate!=="" && candidate.toLowerCase()===entry);
}

async function safeOutputDestination(path,root) {
  nonemptyString(path,"validator report path");
  nonemptyString(root,"repository root");
  const canonicalRoot=await realpath(root);
  const superpowers=resolve(canonicalRoot,".superpowers");
  const destination=resolve(canonicalRoot,path);
  if (!isPathContained(destination,superpowers,{allowRoot:false})) {
    throw new ValidatorBenchmarkOutputError(
      "validator report output must be below repository .superpowers",
    );
  }
  const parent=dirname(destination);
  let canonicalParent;
  try {
    await rejectSymlinkPath(destination,canonicalRoot);
    canonicalParent=await realpath(parent);
  } catch (error) {
    if (error instanceof ValidatorBenchmarkOutputError) throw error;
    if (error?.code==="ENOENT" || error?.code==="ENOTDIR") {
      throw new ValidatorBenchmarkOutputError(
        "validator report parent must be an existing directory",
      );
    }
    throw error;
  }
  const canonicalSuperpowers=await realpath(superpowers);
  if (!isPathContained(canonicalParent,canonicalSuperpowers,{allowRoot:true})) {
    throw new ValidatorBenchmarkOutputError(
      "validator report output must remain below repository .superpowers",
    );
  }
  try {
    const status=await lstat(destination);
    if (!status.isFile()) {
      throw new ValidatorBenchmarkOutputError(
        "validator report destination must be a regular file",
      );
    }
  } catch (error) {
    if (error?.code!=="ENOENT") throw error;
  }
  if (await tracked(destination,canonicalRoot)) {
    throw new ValidatorBenchmarkOutputError(
      "validator report destination must be untracked",
    );
  }
  return {destination,parent};
}

export async function writeValidatorBenchmarkReport(path,value,root,{
  canonicalize=canonicalValidatorColdStartJson,
  renameFile=rename,
  writeTemporary=writeFile,
  removeTemporary=rm,
}={}) {
  if (typeof canonicalize!=="function" || typeof renameFile!=="function" ||
      typeof writeTemporary!=="function" || typeof removeTemporary!=="function") {
    throw new TypeError("validator report writer dependencies must be functions");
  }
  const {destination,parent}=await safeOutputDestination(path,root);
  const output=canonicalize(value);
  const leaf=destination.split(sep).at(-1);
  const nonce=randomBytes(16).toString("hex");
  const temporary=resolve(parent,`.${leaf}.${process.pid}.${nonce}.tmp`);
  let completed=false;
  let primaryFailure;
  try {
    await writeTemporary(temporary,output,{encoding:"utf8",flag:"wx",mode:0o600});
    await renameFile(temporary,destination);
    completed=true;
  } catch (error) {
    primaryFailure=error;
    throw error;
  } finally {
    if (!completed) {
      try {
        await removeTemporary(temporary,{force:true});
      } catch (cleanupError) {
        try {
          if (((typeof primaryFailure==="object" && primaryFailure!==null) ||
              typeof primaryFailure==="function") && Object.isExtensible(primaryFailure)) {
            Object.defineProperty(primaryFailure,"cleanupError",{
              value:cleanupError,enumerable:false,configurable:true,
            });
          }
        } catch {
          // Cleanup diagnostics must never replace the primary write or rename failure.
        }
      }
    }
  }
}

async function main(argv) {
  let options;
  try {
    options=parseValidatorBenchmarkOptions(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode=2;
    return;
  }
  const cwd=process.cwd();
  try {
    if (options.output!==undefined) await safeOutputDestination(options.output,cwd);
    const identity=await collectIdentity(cwd,options.runnerId);
    const report=await runValidatorBenchmark({
      runs:options.runs,
      runnerId:options.runnerId,
      cwd,
      identity,
      runWorker:mode => runWorkerProcess(mode,{cwd}),
      runFocused:runFocusedProcess,
    });
    if (options.output!==undefined) {
      await writeValidatorBenchmarkReport(options.output,report,cwd);
    }
    process.stdout.write(canonicalValidatorColdStartJson(report));
  } catch (error) {
    if (error instanceof TypeError || error instanceof ValidatorBenchmarkOutputError) {
      process.stderr.write(`${error.code ?? "INVALID_VALIDATOR_BENCHMARK_EVIDENCE"}: ${error.message}\n`);
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
