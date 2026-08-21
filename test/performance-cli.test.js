import assert from "node:assert/strict";
import {execFileSync,spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {chmod,link,mkdir,mkdtemp,readdir,realpath,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,win32} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {
  createBaseline,parseBenchmarkOptions,renderBenchmarkOutput,runBenchmark,writeCanonicalReport,
} from "../scripts/performance/benchmark.mjs";
import * as validatorBenchmark from "../scripts/performance/validator-benchmark.mjs";

const {writeValidatorBenchmarkReport}=validatorBenchmark;

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

function reportDocument({
  walls=[139,140,141],lane="full",exactIdentity=identity,exactCommand=command,
}={}) {
  const samples=walls.map(wall => {
    const {stdout,stderr,...evidence}=sample(wall);
    return evidence;
  });
  return {
    schema_version:"toss-test-performance-report.v1",command:exactCommand,lane,identity:exactIdentity,
    samples,
    medians:{
      wall_ms:walls[1],user_cpu_ms:10,system_cpu_ms:5,
      fresh_process_count:2,peak_process_count:1,
    },
  };
}

function baselineDocument({walls,fullLimit=100,exactIdentity,exactCommand}={}) {
  const report=reportDocument({
    walls:walls ?? [143,144,145],lane:"full",exactIdentity,exactCommand,
  });
  return {
    ...report,schema_version:"toss-test-performance-baseline.v1",
    historical:{full_wall_ms:134960},
    budgets:{fast_max_wall_ms:15000,full_max_wall_ms:fullLimit},
  };
}

const budgetCli=fileURLToPath(new URL("../scripts/performance/budget.mjs",import.meta.url));
const benchmarkCli=fileURLToPath(new URL("../scripts/performance/benchmark.mjs",import.meta.url));
const validatorBenchmarkCli=fileURLToPath(
  new URL("../scripts/performance/validator-benchmark.mjs",import.meta.url),
);
const storeFocusedBenchmarkCli=fileURLToPath(
  new URL("../scripts/performance/store-focused-benchmark.mjs",import.meta.url),
);

test("validator output containment rejects Win32 cross-volume paths",() => {
  const candidate="D:\\evidence\\validator-report.json";
  const root="C:\\repo\\.superpowers";
  assert.equal(
    validatorBenchmark.isPathContained(candidate,root,{pathImplementation:win32}),
    false,
  );
});

test("package exposes opt-in performance commands without weakening full verification",() => {
  const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
  assert.equal(pkg.scripts["test:benchmark"],"node ./scripts/performance/benchmark.mjs");
  assert.equal(pkg.scripts["test:performance-budget"],"node ./scripts/performance/budget.mjs");
  assert.equal(
    pkg.scripts["test:validator-benchmark"],
    "node ./scripts/performance/validator-benchmark.mjs",
  );
  assert.equal(
    pkg.scripts["test:store-focused-benchmark"],
    "node ./scripts/performance/store-focused-benchmark.mjs",
  );
  assert.equal(pkg.scripts.test,"npm run test:full");
  assert.equal(pkg.scripts["test:fast"],"node ./scripts/test-runner.mjs fast");
  assert.equal(pkg.scripts["test:integration"],"node ./scripts/test-runner.mjs integration");
  assert.equal(pkg.scripts["test:e2e"],"node ./scripts/test-runner.mjs e2e");
  assert.equal(pkg.scripts["test:package"],"node ./scripts/test-runner.mjs package");
  assert.equal(pkg.scripts["test:release"],"node ./scripts/test-runner.mjs release");
  assert.equal(pkg.scripts["test:full"],"node ./scripts/test-runner.mjs full");
  assert.equal(pkg.scripts.prepack,"npm test");
});

test("validator benchmark output is restricted to safe untracked .superpowers files",async t => {
  const root=await mkdtemp(join(tmpdir(),"toss-validator-output-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(join(root,".superpowers","evidence"),{recursive:true});
  await mkdir(join(root,"docs","performance"),{recursive:true});
  await writeFile(join(root,"package-lock.json"),"{}\n");
  await writeFile(join(root,".superpowers","tracked.json"),"tracked\n");
  await writeFile(join(root,".superpowers","Tracked [final] $.json"),"special tracked\n");
  await writeFile(join(root,"docs","performance","v2.1.1-baseline.json"),"protected\n");
  execFileSync("git",["init","--quiet"],{cwd:root});
  execFileSync("git",["config","user.email","test@example.invalid"],{cwd:root});
  execFileSync("git",["config","user.name","Test"],{cwd:root});
  execFileSync("git",["add","package-lock.json",".superpowers/tracked.json",
    ".superpowers/Tracked [final] $.json",
    "docs/performance/v2.1.1-baseline.json"],{cwd:root});
  execFileSync("git",["commit","--quiet","-m","fixture"],{cwd:root});
  const unsafe=[
    "outside.json",
    "../outside.json",
    "docs/performance/v2.1.1-baseline.json",
    ".superpowers/tracked.json",
    ".superpowers/TRACKED.JSON",
    ".superpowers/tracked [FINAL] $.json",
  ];
  if (process.platform!=="win32") {
    await symlink("tracked.json",join(root,".superpowers","linked.json"));
    await symlink("evidence",join(root,".superpowers","linked-parent"));
    unsafe.push(
      ".superpowers/linked.json",
      ".superpowers/linked-parent/report.json",
    );
  }

  for (const output of unsafe) {
    await assert.rejects(
      writeValidatorBenchmarkReport(output,{ok:true},root,{
        canonicalize:value => JSON.stringify(value),
      }),
      /\.superpowers|symbolic|tracked|baseline|safe/i,
      output,
    );
  }

  const output=".superpowers/evidence/validator-report.json";
  await writeValidatorBenchmarkReport(output,{ok:true},root,{
    canonicalize:value => JSON.stringify(value),
  });
  assert.equal(readFileSync(join(root,output),"utf8"),'{"ok":true}');
  assert.deepEqual(
    (await readdir(join(root,".superpowers","evidence"))).sort(),
    ["validator-report.json"],
  );
  assert.equal(readFileSync(join(root,".superpowers","tracked.json"),"utf8"),"tracked\n");
  assert.equal(
    readFileSync(join(root,".superpowers","Tracked [final] $.json"),"utf8"),
    "special tracked\n",
  );
});

function addTrackedIndexEntry(root,entry,contents="tracked\n") {
  const object=execFileSync("git",["hash-object","-w","--stdin"],{
    cwd:root,encoding:"utf8",input:contents,
  }).trim();
  execFileSync("git",["update-index","--add","--cacheinfo","100644",object,entry],{
    cwd:root,
  });
}

async function validatorAliasFixture(t) {
  const root=await mkdtemp(join(tmpdir(),"toss-validator-alias-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(join(root,".superpowers"));
  execFileSync("git",["init","--quiet"],{cwd:root});
  return root;
}

test("validator output rejects a tracked alias with differently cased .superpowers",async t => {
  const root=await validatorAliasFixture(t);
  addTrackedIndexEntry(root,".SUPERPOWERS/report.json");

  await assert.rejects(
    writeValidatorBenchmarkReport(".superpowers/report.json",{ok:true},root,{
      canonicalize:value => JSON.stringify(value),
    }),
    /tracked/i,
  );
  assert.deepEqual(await readdir(join(root,".superpowers")),[]);
});

test("validator output rejects canonically equivalent Unicode tracked aliases",async t => {
  const root=await validatorAliasFixture(t);
  addTrackedIndexEntry(root,".superpowers/caf\u00e9.json");

  await assert.rejects(
    writeValidatorBenchmarkReport(".superpowers/cafe\u0301.json",{ok:true},root,{
      canonicalize:value => JSON.stringify(value),
    }),
    /tracked/i,
  );
  assert.deepEqual(await readdir(join(root,".superpowers")),[]);
});

test("validator output rejects an existing destination sharing tracked file identity",async t => {
  const root=await validatorAliasFixture(t);
  const tracked=join(root,".superpowers","tracked-identity.json");
  const alias=join(root,".superpowers","identity-alias.json");
  await writeFile(tracked,"tracked identity\n");
  execFileSync("git",["add",".superpowers/tracked-identity.json"],{cwd:root});
  await link(tracked,alias);

  await assert.rejects(
    writeValidatorBenchmarkReport(".superpowers/identity-alias.json",{ok:true},root,{
      canonicalize:value => JSON.stringify(value),
    }),
    /tracked/i,
  );
  assert.equal(readFileSync(tracked,"utf8"),"tracked identity\n");
  assert.equal(readFileSync(alias,"utf8"),"tracked identity\n");
});

test("validator benchmark CLI maps invalid output parents to exit five",async t => {
  const root=await mkdtemp(join(tmpdir(),"toss-validator-parent-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(join(root,".superpowers"));
  await writeFile(join(root,".superpowers","not-a-directory"),"file\n");

  for (const output of [
    ".superpowers/missing/validator-report.json",
    ".superpowers/not-a-directory/validator-report.json",
  ]) {
    const result=spawnSync(process.execPath,[validatorBenchmarkCli,
      "--runs","3","--runner-id","fixture","--output",output,"--json",
    ],{cwd:root,encoding:"utf8"});
    assert.equal(result.status,5,`${output}: ${result.stderr}`);
    assert.match(result.stderr,/UNSAFE_VALIDATOR_BENCHMARK_OUTPUT/);
    assert.equal(result.stdout,"");
  }
});

test("focused benchmark leaves missing package-lock operational failures unexpected",async t => {
  const root=await mkdtemp(join(tmpdir(),"toss-store-focused-missing-lock-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(join(root,".superpowers","evidence"),{recursive:true});
  await writeFile(join(root,"tracked.txt"),"fixture\n");
  execFileSync("git",["init","--quiet"],{cwd:root});
  execFileSync("git",["config","user.email","test@example.invalid"],{cwd:root});
  execFileSync("git",["config","user.name","Test"],{cwd:root});
  execFileSync("git",["add","tracked.txt"],{cwd:root});
  execFileSync("git",["commit","--quiet","-m","fixture"],{cwd:root});

  const result=spawnSync(process.execPath,[storeFocusedBenchmarkCli,
    "--runs","3","--phase","before","--runner-id","fixture",
    "--output",".superpowers/evidence/focused.json",
  ],{cwd:root,encoding:"utf8"});
  assert.equal(result.status,70,result.stderr);
  assert.match(result.stderr,/ENOENT.*package-lock\.json/i);
  assert.doesNotMatch(result.stderr,/INVALID_STORE_FOCUSED_EVIDENCE|UNSAFE_/);
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

test("benchmark runs the truthful canonical command for each measurable lane",async () => {
  const rows=[];
  const executable=process.platform==="win32" ? "npm.cmd" : "npm";
  const runOnce=async input => {
    rows.push({command:input.command,args:input.args});
    return sample(1000);
  };
  const full=await runBenchmark({
    runs:3,lane:"full",runnerId:identity.runner_id,cwd:process.cwd(),identity,runOnce,
  });
  assert.deepEqual(full.command,{executable,arguments:["test"]});
  const fast=await runBenchmark({
    runs:3,lane:"fast",runnerId:identity.runner_id,cwd:process.cwd(),identity,runOnce,
  });
  assert.deepEqual(fast.command,{executable,arguments:["run","test:fast"]});
  assert.deepEqual(rows.slice(0,3),[
    {command:executable,args:["test"]},
    {command:executable,args:["test"]},
    {command:executable,args:["test"]},
  ]);
  assert.deepEqual(rows.slice(3),[
    {command:executable,args:["run","test:fast"]},
    {command:executable,args:["run","test:fast"]},
    {command:executable,args:["run","test:fast"]},
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

test("baseline construction requires canonical full-command evidence",() => {
  const noncanonical=reportDocument({
    exactCommand:{executable:"npm",arguments:["run","test:fast"]},
  });
  assert.throws(() => createBaseline(noncanonical),/canonical full command/);
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

test("budget CLI returns stable full pass, exceed, and incompatibility results",async t => {
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

test("budget CLI compares truthful fast reports against the full-origin baseline",async t => {
  const root=await mkdtemp(join(tmpdir(),"toss-fast-budget-cli-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const baselinePath=join(root,"baseline.json");
  await writeFile(baselinePath,JSON.stringify(baselineDocument()));
  const fastCommand={executable:"npm",arguments:["run","test:fast"]};
  for (const [name,walls,exactCommand,identityOverride,status,code,message] of [
    ["pass",[14999,14999,14999],fastCommand,{},0,"PERFORMANCE_BUDGET_OK",undefined],
    ["exceeds",[15001,15001,15001],fastCommand,{},5,"FAST_WALL_BUDGET_EXCEEDED",undefined],
    ["command-mismatch",[1000,1000,1000],command,{},5,"INVALID_PERFORMANCE_EVIDENCE",/candidate command/],
    ["identity-mismatch",[1000,1000,1000],fastCommand,{lock_sha256:"b".repeat(64)},5,
      "INCOMPATIBLE_PERFORMANCE_ENVIRONMENT",undefined],
  ]) {
    const reportPath=join(root,`${name}.json`);
    await writeFile(reportPath,JSON.stringify(reportDocument({
      walls,lane:"fast",exactCommand,exactIdentity:{...identity,...identityOverride},
    })));
    const result=spawnSync(process.execPath,[budgetCli,
      "--baseline",baselinePath,"--report",reportPath,"--lane","fast","--json",
    ],{encoding:"utf8"});
    assert.equal(result.status,status,result.stderr);
    const payload=JSON.parse(result.stdout);
    assert.equal(payload.code,code);
    if (message) assert.match(payload.message,message);
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

test("validator report write failure removes a partial temporary without masking the failure",async t => {
  const root=await mkdtemp(join(tmpdir(),"toss-validator-write-cleanup-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(join(root,".superpowers","evidence"),{recursive:true});
  execFileSync("git",["init","--quiet"],{cwd:root});
  const writeFailure=Object.assign(new Error("intentional partial write failure"),{
    code:"ENOSPC",
  });
  const cleanupFailure=Object.assign(new Error("intentional cleanup diagnostic"),{
    code:"EIO",
  });
  let temporary;
  await assert.rejects(
    writeValidatorBenchmarkReport(
      ".superpowers/evidence/validator-report.json",{ok:true},root,{
        canonicalize:value => JSON.stringify(value),
        writeTemporary:async (path,...argumentsToWrite) => {
          temporary=path;
          await writeFile(path,...argumentsToWrite);
          throw writeFailure;
        },
        removeTemporary:async path => {
          await rm(path,{force:true});
          throw cleanupFailure;
        },
      },
    ),
    error => error===writeFailure,
  );
  assert.equal(typeof temporary,"string");
  assert.equal(writeFailure.cleanupError,cleanupFailure);
  assert.deepEqual(await readdir(join(root,".superpowers","evidence")),[]);
});

test("baseline updates require the full lane while ordinary fast captures remain measurable",async t => {
  if (process.platform==="win32") return t.skip("fixture npm script is POSIX-only");
  let calls=0;
  assert.equal(parseBenchmarkOptions([
    "--runs","3","--lane","fast","--runner-id",identity.runner_id,
  ]).lane,"fast");
  const fast=await runBenchmark({
    runs:3,lane:"fast",runnerId:identity.runner_id,cwd:"/does-not-exist",identity,
    runOnce:async () => { calls+=1; return sample(1); },
  });
  assert.equal(fast.lane,"fast");
  assert.equal(calls,3);
  const fixture=await benchmarkFixture(t);
  await fixture.setNpm("printf invoked > invoked\nnode -e ''");
  const result=fixture.run([
    "--update-baseline","docs/performance/v2.1.1-baseline.json",
  ],{lane:"fast"});
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
