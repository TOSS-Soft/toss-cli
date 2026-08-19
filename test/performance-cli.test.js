import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,readdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {
  createBaseline,parseBenchmarkOptions,renderBenchmarkOutput,runBenchmark,
} from "../scripts/performance/benchmark.mjs";

const identity={
  commit:"4472175eac91275cafab2993f68722febdb9eb59",
  node_version:"v26.6.0",platform:"darwin",arch:"arm64",
  lock_sha256:"a".repeat(64),runner_id:"toss-reference-macos-node26",
};
const sample=wall_ms => ({
  wall_ms,user_cpu_ms:10,system_cpu_ms:5,exit_status:0,
  fresh_process_count:2,peak_process_count:1,duplicates:[],
  slowest_files:[],slowest_tests:[],stdout:"",stderr:"",
});

const budgetCli=fileURLToPath(new URL("../scripts/performance/budget.mjs",import.meta.url));

test("benchmark invokes exactly three samples",async () => {
  const walls=[130,110,120];
  let calls=0;
  const invocations=[];
  const report=await runBenchmark({
    runs:3,lane:"full",runnerId:identity.runner_id,cwd:process.cwd(),identity,
    runOnce:async invocation => {
      invocations.push(invocation);
      return sample(walls[calls++]);
    },
  });
  assert.equal(calls,3);
  assert.equal(report.medians.wall_ms,120);
  assert.ok(invocations.every(row => row.args[0]==="test"));
});

test("ordinary benchmark orchestration writes no file",async t => {
  const root=await mkdtemp(join(tmpdir(),"toss-performance-no-write-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const before=await readdir(root);
  await runBenchmark({
    runs:3,lane:"full",runnerId:identity.runner_id,cwd:root,identity,
    runOnce:async () => sample(100),
  });
  assert.deepEqual(await readdir(root),before);
});

test("benchmark grammar is closed",() => {
  assert.equal(parseBenchmarkOptions([
    "--runs","3","--lane","full","--runner-id","toss-reference-macos-node26",
  ]).runs,3);
  assert.throws(() => parseBenchmarkOptions(["--runs","2"]),/exactly 3/);
  assert.throws(() => parseBenchmarkOptions(["--unknown"]),/unknown option/);
});

test("baseline construction never relaxes budgets",() => {
  const report={
    schema_version:"toss-test-performance-report.v1",lane:"full",identity,
    samples:[sample(130000),sample(126000),sample(128000)],
    medians:{wall_ms:128000,user_cpu_ms:10,system_cpu_ms:5,fresh_process_count:2,peak_process_count:1},
  };
  const baseline=createBaseline(report);
  assert.equal(baseline.historical.full_wall_ms,134960);
  assert.equal(baseline.budgets.fast_max_wall_ms,15000);
  assert.equal(baseline.budgets.full_max_wall_ms,89600);
});

test("benchmark renders deterministic JSON and readable human output",() => {
  const report={
    schema_version:"toss-test-performance-report.v1",lane:"full",identity,
    samples:[sample(130),sample(110),sample(120)],
    medians:{wall_ms:120,user_cpu_ms:10,system_cpu_ms:5,fresh_process_count:2,peak_process_count:1},
  };
  const json=renderBenchmarkOutput(report,true);
  assert.equal(JSON.parse(json.stdout).medians.wall_ms,120);
  assert.equal(json.stderr,"");
  const human=renderBenchmarkOutput(report,false);
  assert.match(human.stdout,/full median: 120ms/);
  assert.match(human.stdout,/processes: 2/);
});

test("budget CLI returns stable pass, exceed, and incompatibility results",async t => {
  const root=await mkdtemp(join(tmpdir(),"toss-budget-cli-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const baseline={
    schema_version:"toss-test-performance-baseline.v1",identity,
    budgets:{fast_max_wall_ms:15000,full_max_wall_ms:100},
  };
  const baselinePath=join(root,"baseline.json");
  await writeFile(baselinePath,JSON.stringify(baseline));
  for (const [wall,identityOverride,status,code] of [
    [100,{},0,"PERFORMANCE_BUDGET_OK"],
    [101,{},5,"FULL_WALL_BUDGET_EXCEEDED"],
    [100,{node_version:"v24.0.0"},5,"INCOMPATIBLE_PERFORMANCE_ENVIRONMENT"],
  ]) {
    const reportPath=join(root,`report-${code}.json`);
    await writeFile(reportPath,JSON.stringify({
      schema_version:"toss-test-performance-report.v1",lane:"full",
      identity:{...identity,...identityOverride},medians:{wall_ms:wall},
    }));
    const result=spawnSync(process.execPath,[budgetCli,
      "--baseline",baselinePath,"--report",reportPath,"--lane","full","--json",
    ],{encoding:"utf8"});
    assert.equal(result.status,status,result.stderr);
    assert.equal(result.stderr,"");
    assert.equal(JSON.parse(result.stdout).code,code);
  }
});

test("budget CLI requires both input paths",() => {
  const result=spawnSync(process.execPath,[budgetCli,"--lane","full"],{
    encoding:"utf8",
  });
  assert.equal(result.status,2);
  assert.match(result.stderr,/--baseline.*--report/);
});
