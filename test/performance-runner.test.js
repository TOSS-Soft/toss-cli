import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {parseProcessLog,runSuiteOnce} from "../scripts/performance/run-suite.mjs";

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const passing=fileURLToPath(new URL("./fixtures/performance/passing-suite.mjs",import.meta.url));
const failing=fileURLToPath(new URL("./fixtures/performance/failing-suite.mjs",import.meta.url));

function event(value) {
  return `${JSON.stringify(value)}\n`;
}

async function probeRecords(argumentsToProbe=[]) {
  const scratch=await mkdtemp(join(tmpdir(),"toss-performance-probe-"));
  const log=join(scratch,"processes.jsonl");
  const probe=new URL("../scripts/performance/process-probe.mjs",import.meta.url);
  try {
    const result=spawnSync(process.execPath,[`--import=${probe.href}`,"-e","",...argumentsToProbe],{
      cwd:root,encoding:"utf8",
      env:{...process.env,TOSS_PERFORMANCE_PROCESS_LOG:log,TOSS_PERFORMANCE_RUN_ID:"bounded"},
    });
    assert.equal(result.status,0);
    return (await readFile(log,"utf8")).trim().split("\n");
  } finally {
    await rm(scratch,{recursive:true,force:true});
  }
}

test("one run captures the inherited Node process tree",async () => {
  const sample=await runSuiteOnce({
    command:process.execPath,args:[passing],cwd:root,runId:"fixture-pass",env:{},
  });
  assert.equal(sample.exit_status,0);
  assert.equal(sample.fresh_process_count,2);
  assert.ok(sample.peak_process_count>=1);
  assert.match(sample.stdout,/child-complete/);
  assert.deepEqual(sample.slowest_tests,[
    {name:"deterministic fixture case",duration_ms:20,status:"pass"},
  ]);
});

test("one run preserves nonzero status and stderr",async () => {
  const sample=await runSuiteOnce({
    command:process.execPath,args:[failing],cwd:root,runId:"fixture-fail",env:{},
  });
  assert.equal(sample.exit_status,5);
  assert.match(sample.stderr,/intentional benchmark fixture failure/);
});

test("one run rejects a command that produces no process evidence",async () => {
  await assert.rejects(
    runSuiteOnce({
      command:"git",args:["--version"],cwd:root,runId:"fixture-empty",env:{},
    }),
    error => error.code==="INCOMPLETE_PROCESS_EVIDENCE",
  );
});

test("the intentional failing fixture is inert under Node test discovery",() => {
  const environment={...process.env};
  delete environment.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,["--test",failing],{
    cwd:root,encoding:"utf8",env:environment,
  });
  assert.equal(result.status,0);
});

test("process logs reject malformed JSON and mixed run identities",() => {
  assert.throws(
    () => parseProcessLog("{not-json}\n",root,"expected"),
    error => error.code==="INVALID_PROCESS_LOG",
  );
  assert.throws(
    () => parseProcessLog(event({
      kind:"start",run_id:"other",pid:1,at_ms:1,argv:[passing],
    }),root,"expected"),
    error => error.code==="MIXED_PERFORMANCE_RUN_ID",
  );
});

test("process logs reject valid JSON with invalid event schemas",() => {
  for (const invalidEvent of [null,{kind:"start"},{kind:"unknown"}]) {
    assert.throws(
      () => parseProcessLog(event(invalidEvent),root,"expected"),
      error => error.code==="INVALID_PROCESS_LOG",
    );
  }
});

test("process logs reject duplicate and incomplete evidence",() => {
  const start={kind:"start",run_id:"expected",pid:1,at_ms:1,argv:[passing]};
  assert.throws(
    () => parseProcessLog(event(start)+event(start),root,"expected"),
    error => error.code==="DUPLICATE_PROCESS_START",
  );
  assert.throws(
    () => parseProcessLog(event(start),root,"expected"),
    error => error.code==="INCOMPLETE_PROCESS_EVIDENCE",
  );
});

test("outside tool processes count without becoming test entries",() => {
  const outside={
    kind:"start",run_id:"expected",pid:1,at_ms:1,
    argv:["/opt/npm/npm-cli.js"],
  };
  const end={
    kind:"end",run_id:"expected",pid:1,at_ms:2,
    user_cpu_us:1,system_cpu_us:1,
  };
  const summary=parseProcessLog(event(outside)+event(end),root,"expected");
  assert.equal(summary.fresh_process_count,1);
  assert.deepEqual(summary.entries,[]);
});

test("process probe writes bounded JSONL records for large Unicode arguments",async () => {
  const argumentsToProbe=Array.from({length:6},() => "🙂".repeat(512));
  const lines=await probeRecords(argumentsToProbe);
  assert.ok(lines.length>=2);
  assert.ok(lines.every(line => Buffer.byteLength(line,"utf8")<4096));
});

test("process probe keeps the terminating newline below the record limit",async () => {
  const baseline=JSON.parse((await probeRecords())[0]);
  const paddingLength=4095-Buffer.byteLength(JSON.stringify(baseline),"utf8")-3;
  assert.ok(paddingLength>0);
  const lines=await probeRecords(["x".repeat(paddingLength)]);
  assert.ok(lines.every(line => Buffer.byteLength(`${line}\n`,"utf8")<4096));
});
