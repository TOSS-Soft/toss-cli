import assert from "node:assert/strict";
import {execFileSync,spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {chmod,mkdir,mkdtemp,readdir,rm,symlink,writeFile} from "node:fs/promises";
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
const benchmarkCli=fileURLToPath(new URL("../scripts/performance/benchmark.mjs",import.meta.url));

test("package exposes opt-in performance commands without weakening full verification",() => {
  const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
  assert.equal(pkg.scripts["test:benchmark"],"node ./scripts/performance/benchmark.mjs");
  assert.equal(pkg.scripts["test:performance-budget"],"node ./scripts/performance/budget.mjs");
  assert.equal(pkg.scripts.prepack,"npm test");
  assert.match(pkg.scripts.test,/release-workflow-test\.js/);
  assert.match(pkg.scripts.test,/node --test$/);
});

async function benchmarkFixture(t) {
  const root=await mkdtemp(join(tmpdir(),"toss-benchmark-cli-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(join(root,"bin"));
  await mkdir(join(root,"docs","performance"),{recursive:true});
  await mkdir(join(root,"tracked-directory"));
  await writeFile(join(root,"package-lock.json"),"{}\n");
  await writeFile(join(root,"tracked.json"),"tracked\n");
  await writeFile(join(root,"tracked-directory","inside.json"),"tracked directory\n");
  execFileSync("git",["init","--quiet"],{cwd:root});
  execFileSync("git",["config","user.email","test@example.invalid"],{cwd:root});
  execFileSync("git",["config","user.name","Test"],{cwd:root});
  execFileSync("git",["add","package-lock.json","tracked.json","tracked-directory/inside.json"],{cwd:root});
  execFileSync("git",["commit","--quiet","-m","fixture"],{cwd:root});
  const npm=join(root,"bin","npm");
  async function setNpm(source) {
    await writeFile(npm,`#!/bin/sh\n${source}\n`);
    await chmod(npm,0o755);
  }
  await setNpm("exit 0");
  return {
    root,setNpm,
    run:(argumentsToCli,{lane="full"}={}) => spawnSync(process.execPath,[benchmarkCli,
      "--runs","3","--lane",lane,"--runner-id","fixture",...argumentsToCli,
    ],{cwd:root,encoding:"utf8",env:{...process.env,PATH:`${join(root,"bin")}:${process.env.PATH}`}}),
  };
}

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
  assert.deepEqual(invocations.map(row => row.runId),[
    `${identity.commit}-1`,`${identity.commit}-2`,`${identity.commit}-3`,
  ]);
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

test("benchmark CLI maps failed samples and invalid process evidence to exit five",async t => {
  if (process.platform==="win32") return t.skip("fixture npm script is POSIX-only");
  const fixture=await benchmarkFixture(t);
  for (const [script,diagnostic] of [
    ["exit 7","INVALID_PERFORMANCE_EVIDENCE"],
    ["printf '{not-json}\\n' > \"$TOSS_PERFORMANCE_PROCESS_LOG\"\nexit 0","INVALID_PROCESS_LOG"],
  ]) {
    await fixture.setNpm(script);
    const result=fixture.run(["--json"]);
    assert.equal(result.status,5,result.stderr);
    assert.match(result.stderr,new RegExp(diagnostic));
  }
});

test("benchmark CLI blocks unsafe outputs and reserves baseline updates",async t => {
  if (process.platform==="win32") return t.skip("fixture npm script is POSIX-only");
  const fixture=await benchmarkFixture(t);
  const link=join(fixture.root,"linked.json");
  await symlink("tracked.json",link);
  await symlink(".",join(fixture.root,"alias"));
  await symlink("tracked-directory",join(fixture.root,"alias-directory"));
  for (const output of [
    ".","linked.json","tracked.json","alias/tracked.json","alias-directory/inside.json",
    "docs/performance/v2.1.1-baseline.json",
  ]) {
    const result=fixture.run(["--output",output]);
    assert.equal(result.status,5,result.stderr);
    assert.match(result.stderr,/UNSAFE_PERFORMANCE_OUTPUT/);
  }
  const unauthorized=fixture.run(["--update-baseline","tracked.json"]);
  assert.equal(unauthorized.status,2,unauthorized.stderr);
  assert.match(unauthorized.stderr,/--update-baseline/);
  const updated=fixture.run(["--update-baseline","docs/performance/v2.1.1-baseline.json"]);
  assert.equal(updated.status,0,updated.stderr);
  const ordinary=fixture.run(["--output","ordinary-report.json"]);
  assert.equal(ordinary.status,0,ordinary.stderr);
});

test("baseline updates require the full lane before any benchmark run",async t => {
  if (process.platform==="win32") return t.skip("fixture npm script is POSIX-only");
  let calls=0;
  assert.throws(() => parseBenchmarkOptions([
    "--runs","3","--lane","fast","--runner-id",identity.runner_id,
    "--update-baseline","docs/performance/v2.1.1-baseline.json",
  ]),/baseline update requires the full lane/);
  assert.equal(calls,0);
  const fixture=await benchmarkFixture(t);
  await fixture.setNpm("printf invoked > invoked\nexit 0");
  const result=fixture.run(["--update-baseline","docs/performance/v2.1.1-baseline.json"],{lane:"fast"});
  assert.equal(result.status,2,result.stderr);
  assert.ok(!(await readdir(fixture.root)).includes("invoked"));
  assert.ok(!(await readdir(join(fixture.root,"docs","performance"))).includes("v2.1.1-baseline.json"));
});

test("benchmark and budget CLIs reject duplicate and missing options",() => {
  const benchmarkMissing=spawnSync(process.execPath,[benchmarkCli,"--runs","3","--lane","full"],{
    encoding:"utf8",
  });
  assert.equal(benchmarkMissing.status,2);
  const benchmarkDuplicate=spawnSync(process.execPath,[benchmarkCli,
    "--runs","3","--runs","3","--lane","full","--runner-id","fixture",
  ],{encoding:"utf8"});
  assert.equal(benchmarkDuplicate.status,2);
  const budgetMissing=spawnSync(process.execPath,[budgetCli,
    "--baseline","baseline.json","--report","report.json",
  ],{encoding:"utf8"});
  assert.equal(budgetMissing.status,2);
  const budgetDuplicate=spawnSync(process.execPath,[budgetCli,
    "--baseline","baseline.json","--report","report.json","--lane","full","--lane","full",
  ],{encoding:"utf8"});
  assert.equal(budgetDuplicate.status,2);
});
