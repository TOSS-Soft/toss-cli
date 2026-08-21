import assert from "node:assert/strict";
import test from "node:test";

import {
  STORE_FOCUSED_ENTRIES,
  canonicalStoreFocusedJson,
  createStoreFocusedReport,
} from "../scripts/performance/store-focused-report.mjs";
import {
  parseStoreFocusedOptions,
  runStoreFocusedBenchmark,
} from "../scripts/performance/store-focused-benchmark.mjs";

const identity=Object.freeze({
  commit:"46c46b08a088c5678fd24ea75d02b641780c9f94",
  node_version:"v26.6.0",
  platform:"darwin",
  arch:"arm64",
  lock_sha256:"a".repeat(64),
  runner_id:"toss-reference-macos-node26",
});

function sample(wall_ms,offset=0) {
  return {
    wall_ms,user_cpu_ms:wall_ms/2,system_cpu_ms:wall_ms/4,exit_status:0,
    fresh_process_count:4,peak_process_count:2,duplicates:[],
    entry_processes:STORE_FOCUSED_ENTRIES.map((name,index) => ({
      name,duration_ms:1000+offset+index,status:"pass",
    })),
  };
}

function input(samples=[sample(3000),sample(2000,10),sample(4000,20)]) {
  return {
    phase:"before",identity,
    command:{executable:process.execPath,arguments:["--test",...STORE_FOCUSED_ENTRIES]},samples,
  };
}

function clone(value) { return structuredClone(value); }

function hidden(object,key,value) {
  Object.defineProperty(object,key,{value,enumerable:false});
  return object;
}

function accessor(object,key) {
  Object.defineProperty(object,key,{enumerable:true,get() { throw new Error("accessor was invoked"); }});
  return object;
}

test("focused report derives bundle and per-owner three-run medians",() => {
  const report=createStoreFocusedReport(input());
  assert.equal(Object.isFrozen(report),true);
  assert.equal(report.medians.wall_ms,3000);
  assert.deepEqual(report.medians.owners,STORE_FOCUSED_ENTRIES.map((entry,index) => ({
    entry,wall_ms:1010+index,
  })));
  assert.equal("stdout" in report.samples[0],false);
  assert.equal("stderr" in report.samples[0],false);
});

test("focused report omits legacy run-suite diagnostics",() => {
  const samples=[sample(3000),sample(2000,10),sample(4000,20)].map(value => ({
    ...value,
    slowest_files:[{name:"test/other.test.js",duration_ms:1,status:"pass"}],
    slowest_tests:[{name:"other assertion",duration_ms:1,status:"pass"}],
    stdout:"captured output",stderr:"captured error",
  }));
  const report=createStoreFocusedReport(input(samples));
  assert.equal("slowest_files" in report.samples[0],false);
  assert.equal("slowest_tests" in report.samples[0],false);
  assert.equal("stdout" in report.samples[0],false);
  assert.equal("stderr" in report.samples[0],false);
});

test("focused report filters unrelated process-entry diagnostics",() => {
  const samples=[sample(3000),sample(2000,10),sample(4000,20)].map(value => ({
    ...value,
    entry_processes:[...value.entry_processes,{name:"bin/toss.js",duration_ms:1,status:"pass"}],
  }));
  const report=createStoreFocusedReport(input(samples));
  assert.deepEqual(report.samples[0].entry_processes.map(entry => entry.name),STORE_FOCUSED_ENTRIES);
});

test("focused benchmark grammar is closed and requires exactly three runs",() => {
  assert.deepEqual(parseStoreFocusedOptions([
    "--runs","3","--phase","after","--runner-id","reference",
    "--output",".superpowers/evidence/focused-after.json",
  ]),{
    runs:3,phase:"after",runnerId:"reference",
    output:".superpowers/evidence/focused-after.json",
  });
  assert.throws(() => parseStoreFocusedOptions(["--runs","2"]),/exactly 3 runs/);
});

for (const [name,argv,expected] of [
  ["unknown option",["--runs","3","--phase","before","--runner-id","x","--wat"],/unknown option/],
  ["duplicate option",["--runs","3","--runs","3","--phase","before","--runner-id","x"],/duplicate option/],
  ["missing option",["--runs","3","--phase","before"],/requires --runner-id/],
  ["invalid phase",["--runs","3","--phase","later","--runner-id","x"],/phase must be before or after/],
]) {
  test(`focused benchmark rejects ${name}`,() => { assert.throws(() => parseStoreFocusedOptions(argv),expected); });
}

for (const [name,mutate,expected] of [
  ["command entry order drift",value => value.command.arguments.reverse(),/canonical focused command/],
  ["fewer than three samples",value => value.samples.pop(),/exactly three samples/],
  ["more than three samples",value => value.samples.push(sample(5000)),/exactly three samples/],
  ["a nonzero exit",value => { value.samples[0].exit_status=1; },/successful exit_status/],
  ["a duplicate target entry",value => value.samples[0].entry_processes.push({...value.samples[0].entry_processes[0]}),/exactly one evidence row/],
  ["a missing target entry",value => value.samples[0].entry_processes.pop(),/exactly one evidence row/],
  ["an unexpected target entry",value => { value.samples[0].entry_processes[0]={name:"test/unexpected.test.js",duration_ms:1,status:"pass"}; },/exactly one evidence row/],
  ["a failed target entry",value => { value.samples[0].entry_processes[0].status="fail"; },/must pass/],
  ["an exotic samples array",value => { value.samples=Object.assign([],value.samples); Object.setPrototypeOf(value.samples,null); },/samples must be an array/],
  ["an exotic identity object",value => { value.identity=Object.assign(Object.create(null),value.identity); },/identity must be a plain object/],
  ["an accessor",value => accessor(value.samples[0],"wall_ms"),/enumerable data/],
  ["a symbol",value => { value.samples[0][Symbol("extra")]=1; },/symbol property/],
  ["a hidden field",value => hidden(value.samples[0],"hidden",true),/unknown property/],
  ["identity digest drift",value => { value.identity.commit="z".repeat(40); },/commit must be a Git commit SHA/],
  ["lock digest drift",value => { value.identity.lock_sha256="z".repeat(64); },/SHA-256/],
]) {
  test(`focused report rejects ${name}`,() => {
    const value=clone(input());
    mutate(value);
    assert.throws(() => createStoreFocusedReport(value),expected);
  });
}

test("canonical report rejects an inconsistent owner median",() => {
  const report=clone(createStoreFocusedReport(input()));
  report.medians.owners[0].wall_ms+=1;
  assert.throws(() => canonicalStoreFocusedJson(report),/invalid focused report/);
});

test("focused benchmark runs exactly three serial canonical invocations",async () => {
  const calls=[];
  let active=0;
  const report=await runStoreFocusedBenchmark({
    runs:3,phase:"after",runnerId:identity.runner_id,cwd:"/fixture",identity,
    async runOnce(invocation) {
      calls.push(invocation);
      active+=1;
      assert.equal(active,1,"runs must not overlap");
      await Promise.resolve();
      active-=1;
      return sample(1000+calls.length);
    },
  });
  assert.equal(report.phase,"after");
  assert.equal(calls.length,3);
  assert.deepEqual(calls.map(call => call.runId),[
    "46c46b08a088c5678fd24ea75d02b641780c9f94-store-after-1",
    "46c46b08a088c5678fd24ea75d02b641780c9f94-store-after-2",
    "46c46b08a088c5678fd24ea75d02b641780c9f94-store-after-3",
  ]);
  assert.ok(calls.every(call => call.command===process.execPath &&
    JSON.stringify(call.args)===JSON.stringify(["--test",...STORE_FOCUSED_ENTRIES]) &&
    call.cwd==="/fixture" && JSON.stringify(call.env)==="{}"));
});
