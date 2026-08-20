import assert from "node:assert/strict";
import {execFileSync,spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {chmod,mkdir,mkdtemp,readdir,realpath,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {
  createBaseline,parseBenchmarkOptions,renderBenchmarkOutput,runBenchmark,writeCanonicalReport,
} from "../scripts/performance/benchmark.mjs";

const identity={
  commit:"4472175eac91275cafab2993f68722febdb9eb59",
  node_version:"v26.6.0",platform:"darwin",arch:"arm64",
  lock_sha256:"a".repeat(64),runner_id:"toss-reference-macos-node26",
};
const command={executable:"npm",arguments:["test"]};
const sample=wall_ms => ({
  wall_ms,user_cpu_ms:10,system_cpu_ms:5,exit_status:0,
  fresh_process_count:2,peak_process_count:1,duplicates:[],
  slowest_files:[],slowest_tests:[],stdout:"",stderr:"",
});

function reportDocument({walls=[139,140,141],exactIdentity=identity}={}) {
  const samples=walls.map(wall => {
    const {stdout,stderr,...evidence}=sample(wall);
    return evidence;
  });
  return {
    schema_version:"toss-test-performance-report.v1",command,lane:"full",identity:exactIdentity,
    samples,
    medians:{
      wall_ms:walls[1],user_cpu_ms:10,system_cpu_ms:5,
      fresh_process_count:2,peak_process_count:1,
    },
  };
}

function baselineDocument({walls,fullLimit=100,exactIdentity}={}) {
  const report=reportDocument({walls:walls ?? [143,144,145],exactIdentity});
  return {
    ...report,schema_version:"toss-test-performance-baseline.v1",
    historical:{full_wall_ms:134960},
    budgets:{fast_max_wall_ms:15000,full_max_wall_ms:fullLimit},
  };
}

const budgetCli=fileURLToPath(new URL("../scripts/performance/budget.mjs",import.meta.url));
const benchmarkCli=fileURLToPath(new URL("../scripts/performance/benchmark.mjs",import.meta.url));

test("package exposes opt-in performance commands without weakening full verification",() => {
  const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
  assert.equal(pkg.scripts["test:benchmark"],"node ./scripts/performance/benchmark.mjs");
  assert.equal(pkg.scripts["test:performance-budget"],"node ./scripts/performance/budget.mjs");
  assert.equal(pkg.scripts.test,"npm run test:full");
  assert.equal(pkg.scripts["test:fast"],"node ./scripts/test-runner.mjs fast");
  assert.equal(pkg.scripts["test:integration"],"node ./scripts/test-runner.mjs integration");
  assert.equal(pkg.scripts["test:e2e"],"node ./scripts/test-runner.mjs e2e");
  assert.equal(pkg.scripts["test:package"],"node ./scripts/test-runner.mjs package");
  assert.equal(pkg.scripts["test:release"],"node ./scripts/test-runner.mjs release");
  assert.equal(pkg.scripts["test:full"],"node ./scripts/test-runner.mjs full");
  assert.equal(pkg.scripts.prepack,"npm test");
});

async function benchmarkFixture(t) {
  const root=await mkdtemp(join(tmpdir(),"toss-benchmark-cli-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(join(root,"bin"));
  await mkdir(join(root,"docs","performance"),{recursive:true});
  await mkdir(join(root,"tracked-directory"));
  await mkdir(join(root,"untracked-directory"));
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
  await setNpm("node -e ''");
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
  const executable=process.platform==="win32" ? "npm.cmd" : "npm";
  assert.deepEqual(report.command,{executable,arguments:["test"]});
  assert.ok(invocations.every(row => row.command===executable && row.args[0]==="test"));
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
  const report=reportDocument({walls:[126000,128000,130000]});
  const baseline=createBaseline(report);
  assert.equal(baseline.historical.full_wall_ms,134960);
  assert.equal(baseline.budgets.fast_max_wall_ms,15000);
  assert.equal(baseline.budgets.full_max_wall_ms,89600);
});

test("baseline refresh retains a stricter limit and tightens for a faster capture",() => {
  const existing=baselineDocument({walls:[127000,128000,129000],fullLimit:80000});
  const slower=reportDocument({walls:[129000,130000,131000]});
  const faster=reportDocument({walls:[99000,100000,101000]});
  assert.equal(createBaseline(slower,existing).budgets.full_max_wall_ms,80000);
  assert.equal(createBaseline(faster,existing).budgets.full_max_wall_ms,70000);
  const incompatible=baselineDocument({
    walls:[127000,128000,129000],fullLimit:80000,
    exactIdentity:{...identity,node_version:"v24.0.0"},
  });
  assert.throws(() => createBaseline(slower,incompatible),/incompatible/);
  const wrongCommand=structuredClone(existing);
  wrongCommand.command={executable:"node",arguments:["--test"]};
  assert.throws(() => createBaseline(slower,wrongCommand),/command/);
});

test("benchmark renders deterministic JSON and readable human output",() => {
  const report={
    schema_version:"toss-test-performance-report.v1",
    command:{executable:"npm",arguments:["test"]},lane:"full",identity,
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
  const baseline=baselineDocument();
  const baselinePath=join(root,"baseline.json");
  await writeFile(baselinePath,JSON.stringify(baseline));
  for (const [wall,identityOverride,status,code] of [
    [100,{},0,"PERFORMANCE_BUDGET_OK"],
    [101,{},5,"FULL_WALL_BUDGET_EXCEEDED"],
    [100,{node_version:"v24.0.0"},5,"INCOMPATIBLE_PERFORMANCE_ENVIRONMENT"],
  ]) {
    const reportPath=join(root,`report-${code}.json`);
    await writeFile(reportPath,JSON.stringify(reportDocument({
      walls:[wall,wall,wall],exactIdentity:{...identity,...identityOverride},
    })));
    const result=spawnSync(process.execPath,[budgetCli,
      "--baseline",baselinePath,"--report",reportPath,"--lane","full","--json",
    ],{encoding:"utf8"});
    assert.equal(result.status,status,result.stderr);
    assert.equal(result.stderr,"");
    assert.equal(JSON.parse(result.stdout).code,code);
  }
});

test("budget CLI maps incomplete evidence to its stable invalid code",async t => {
  const root=await mkdtemp(join(tmpdir(),"toss-budget-cli-invalid-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const baselinePath=join(root,"baseline.json");
  const reportPath=join(root,"report.json");
  await writeFile(baselinePath,JSON.stringify({
    schema_version:"toss-test-performance-baseline.v1",identity,
    budgets:{fast_max_wall_ms:15000,full_max_wall_ms:100},
  }));
  await writeFile(reportPath,JSON.stringify({
    schema_version:"toss-test-performance-report.v1",lane:"full",identity,
    medians:{wall_ms:100},
  }));
  const result=spawnSync(process.execPath,[budgetCli,
    "--baseline",baselinePath,"--report",reportPath,"--lane","full","--json",
  ],{encoding:"utf8"});
  assert.equal(result.status,5,result.stderr);
  assert.equal(JSON.parse(result.stdout).code,"INVALID_PERFORMANCE_EVIDENCE");
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
    ["node -e 'process.exit(7)'","INVALID_PERFORMANCE_EVIDENCE"],
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
    ".","linked.json","tracked.json","untracked-directory","alias/tracked.json",
    "alias-directory/inside.json",
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

test("failed atomic rename removes its exclusive temporary file",async t => {
  const root=await mkdtemp(join(tmpdir(),"toss-benchmark-rename-cleanup-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const canonicalRoot=await realpath(root);
  execFileSync("git",["init","--quiet"],{cwd:canonicalRoot});
  const renameFailure=Object.assign(new Error("intentional rename failure"),{code:"EACCES"});
  await assert.rejects(
    writeCanonicalReport("report.json",{value:true},canonicalRoot,{
      renameFile:async () => { throw renameFailure; },
    }),
    error => error===renameFailure,
  );
  assert.deepEqual((await readdir(canonicalRoot)).filter(name => name.includes("report")),[]);
});

test("baseline updates require the full lane before any benchmark run",async t => {
  if (process.platform==="win32") return t.skip("fixture npm script is POSIX-only");
  let calls=0;
  assert.throws(() => parseBenchmarkOptions([
    "--runs","3","--lane","fast","--runner-id",identity.runner_id,
  ]),/full lane/);
  await assert.rejects(runBenchmark({
    runs:3,lane:"fast",runnerId:identity.runner_id,cwd:"/does-not-exist",
    runOnce:async () => { calls+=1; return sample(1); },
  }),/full lane/);
  assert.equal(calls,0);
  const fixture=await benchmarkFixture(t);
  await fixture.setNpm("printf invoked > invoked\nnode -e ''");
  const result=fixture.run(["--output","fast-report.json"],{lane:"fast"});
  assert.equal(result.status,2,result.stderr);
  assert.ok(!(await readdir(fixture.root)).includes("invoked"));
  assert.ok(!(await readdir(fixture.root)).includes("fast-report.json"));
});

test("baseline refresh rejects invalid existing evidence before any run",async t => {
  if (process.platform==="win32") return t.skip("fixture npm script is POSIX-only");
  const fixture=await benchmarkFixture(t);
  await writeFile(join(fixture.root,"docs","performance","v2.1.1-baseline.json"),"{}\n");
  await fixture.setNpm("printf invoked > invoked\nnode -e ''");
  const result=fixture.run([
    "--update-baseline","docs/performance/v2.1.1-baseline.json",
  ]);
  assert.equal(result.status,5,result.stderr);
  assert.match(result.stderr,/INVALID_PERFORMANCE_EVIDENCE/);
  assert.ok(!(await readdir(fixture.root)).includes("invoked"));
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
