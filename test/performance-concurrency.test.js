import assert from "node:assert/strict";
import {execFile as execFileCallback,spawnSync} from "node:child_process";
import {mkdir,mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {runConcurrencyCandidate} from "../scripts/performance/concurrency-worker.mjs";
import {
  parseConcurrencyBenchmarkOptions,
  runConcurrencyBenchmark,
} from "../scripts/performance/concurrency-benchmark.mjs";
import {
  CONCURRENCY_CANDIDATES,
  CONCURRENCY_REPORT_VERSION,
  canonicalConcurrencyJson,
  createConcurrencyReport,
  parseFullLaneHeadings,
  selectStableConcurrency,
} from "../scripts/performance/concurrency-report.mjs";
import {
  discoverEligibleTestEntries,
  selectTestEntries,
  validateTestManifest,
} from "../scripts/test-manifest.mjs";

const execFile=promisify(execFileCallback);
const root=fileURLToPath(new URL("..",import.meta.url));
const workerCli=fileURLToPath(new URL(
  "../scripts/performance/concurrency-worker.mjs",import.meta.url,
));
const benchmarkCli=fileURLToPath(new URL(
  "../scripts/performance/concurrency-benchmark.mjs",import.meta.url,
));

const identity=Object.freeze({
  commit:"1e9ef243174aa8b3d56aed83085717a896473664",
  node_version:"v26.6.0",
  platform:"darwin",
  arch:"arm64",
  lock_sha256:"a".repeat(64),
  runner_id:"toss-reference-macos-node26",
});

const entries=Object.freeze([
  "test/a.test.js",
  "test/command-store-fixture.test.js",
  "test/c.test.js",
  "test/d.test.js",
]);

function entryResult(entry,{outcome="passed",duration_ms=1}={}) {
  if (outcome==="passed") {
    return {entry,outcome,exit_status:0,signal:null,error_code:null,duration_ms};
  }
  if (outcome==="failed") {
    return {entry,outcome,exit_status:7,signal:null,error_code:null,duration_ms};
  }
  if (outcome==="signaled") {
    return {entry,outcome,exit_status:null,signal:"SIGTERM",error_code:null,duration_ms};
  }
  return {entry,outcome:"spawn_error",exit_status:null,signal:null,error_code:"ENOENT",duration_ms};
}

function evidence(wall_ms,{failureEntry,orphan_process_count=0}={}) {
  const entry_results=entries.map((entry,index) => entryResult(entry,{
    outcome:entry===failureEntry ? "failed" : "passed",
    duration_ms:wall_ms+index,
  }));
  return {
    wall_ms,
    user_cpu_ms:wall_ms/2,
    system_cpu_ms:wall_ms/4,
    exit_status:failureEntry===undefined ? 0 : 7,
    fresh_process_count:8,
    peak_process_count:4,
    duplicates:[],
    entry_results,
    orphan_process_count,
    isolation_passed:entry_results.find(
      row => row.entry==="test/command-store-fixture.test.js",
    ).outcome==="passed",
  };
}

function completed(run,wall_ms,options) {
  return {run,capture_error:null,evidence:evidence(wall_ms,options)};
}

function captureFailure(run,code="EIO",message="capture failed") {
  return {run,capture_error:{code,message},evidence:null};
}

function candidate(concurrency,walls,options={}) {
  const samples=walls.map((wall,index) => completed(index+1,wall,options));
  if (options.captureFailureAt!==undefined) {
    samples[options.captureFailureAt-1]=captureFailure(options.captureFailureAt);
  }
  return {concurrency,samples};
}

function reportInput() {
  return {
    identity:{...identity},
    entries:[...entries],
    candidates:[
      candidate(1,[100,101,102]),
      candidate(2,[80,81,82]),
      candidate(3,[80,81,82]),
      candidate(4,[70,71,72],{failureEntry:"test/command-store-fixture.test.js"}),
    ],
  };
}

function clone(value) {
  return structuredClone(value);
}

function cliEnvironment() {
  const env={...process.env};
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function workerManifest() {
  return {
    schema_version:"toss-test-manifest.v1",
    concurrency:1,
    lanes:{
      fast:[entries[0]],
      integration:[entries[1]],
      e2e:[entries[2]],
      package:[entries[3]],
      release:[],
    },
  };
}

test("concurrency report derives stable medians and selects the lower concurrency on an exact tie",() => {
  const report=createConcurrencyReport(reportInput());
  assert.equal(CONCURRENCY_REPORT_VERSION,"toss-test-concurrency-report.v1");
  assert.deepEqual(CONCURRENCY_CANDIDATES,[1,2,3,4]);
  assert.equal(Object.isFrozen(CONCURRENCY_CANDIDATES),true);
  assert.deepEqual(report.candidates.map(row => ({
    concurrency:row.concurrency,stable:row.stable,wall_ms:row.medians?.wall_ms ?? null,
  })),[
    {concurrency:1,stable:true,wall_ms:101},
    {concurrency:2,stable:true,wall_ms:81},
    {concurrency:3,stable:true,wall_ms:81},
    {concurrency:4,stable:false,wall_ms:null},
  ]);
  assert.deepEqual(report.selection,{
    concurrency:2,
    reason:"LOWEST_STABLE_WALL_MEDIAN",
  });
  assert.deepEqual(selectStableConcurrency(report.candidates),report.selection);
  assert.deepEqual(JSON.parse(canonicalConcurrencyJson(report)),report);
});

test("concurrency report returns fresh deeply frozen evidence",() => {
  const input=reportInput();
  const report=createConcurrencyReport(input);
  input.identity.runner_id="mutated";
  input.entries[0]="test/mutated.test.js";
  input.candidates[0].samples[0].evidence.entry_results[0].outcome="failed";
  assert.equal(report.identity.runner_id,identity.runner_id);
  assert.equal(report.entries[0],entries[0]);
  assert.equal(report.candidates[0].samples[0].evidence.entry_results[0].outcome,"passed");
  assert.equal(Object.isFrozen(report),true);
  assert.equal(Object.isFrozen(report.identity),true);
  assert.equal(Object.isFrozen(report.entries),true);
  assert.equal(Object.isFrozen(report.candidates[0].samples[0].evidence.entry_results[0]),true);
});

test("failed and capture-error samples are retained and make medians unavailable",() => {
  const input=reportInput();
  input.candidates[0]=candidate(1,[100,101,102],{failureEntry:"test/a.test.js"});
  input.candidates[1]=candidate(2,[80,81,82],{captureFailureAt:2});
  const report=createConcurrencyReport(input);
  assert.equal(report.candidates[0].stable,false);
  assert.equal(report.candidates[0].medians,null);
  assert.equal(report.candidates[0].samples[0].evidence.entry_results[0].exit_status,7);
  assert.deepEqual(report.candidates[1].samples[1],{
    run:2,capture_error:{code:"EIO",message:"capture failed"},evidence:null,
  });
  assert.equal(report.candidates[1].stable,false);
  assert.equal(report.candidates[1].medians,null);
});

test("selection returns null when no candidate is stable",() => {
  const report=createConcurrencyReport({
    ...reportInput(),
    candidates:CONCURRENCY_CANDIDATES.map(concurrency =>
      candidate(concurrency,[10,11,12],{captureFailureAt:1})),
  });
  assert.equal(report.selection,null);
  assert.equal(selectStableConcurrency(report.candidates),null);
});

test("full-lane headings parse exact failure evidence in expected order",() => {
  const output=[
    "TAP version 13",
    "[test] lane=full entry=test/a.test.js outcome=passed status=0 duration_ms=1",
    "child stdout",
    "[test] lane=full entry=test/command-store-fixture.test.js outcome=failed status=7 duration_ms=2.5",
    "[test] lane=full entry=test/c.test.js outcome=signaled signal=SIGTERM duration_ms=3",
    "[test] lane=full entry=test/d.test.js outcome=spawn_error error_code=ENOENT duration_ms=4",
    "",
  ].join("\n");
  const parsed=parseFullLaneHeadings(output,entries);
  assert.deepEqual(parsed,[
    entryResult(entries[0],{duration_ms:1}),
    entryResult(entries[1],{outcome:"failed",duration_ms:2.5}),
    entryResult(entries[2],{outcome:"signaled",duration_ms:3}),
    entryResult(entries[3],{outcome:"spawn_error",duration_ms:4}),
  ]);
  assert.equal(Object.isFrozen(parsed),true);
  assert.equal(Object.isFrozen(parsed[0]),true);
});

for (const [name,output,expected] of [
  ["another lane","[test] lane=fast entry=test/a.test.js outcome=passed status=0 duration_ms=1",/full lane|heading/i],
  ["an unsafe entry","[test] lane=full entry=../a.test.js outcome=passed status=0 duration_ms=1",/unsafe|unknown/i],
  ["an unknown entry","[test] lane=full entry=test/unknown.test.js outcome=passed status=0 duration_ms=1",/unknown/i],
  ["a malformed outcome payload","[test] lane=full entry=test/a.test.js outcome=passed signal=SIGTERM duration_ms=1",/heading|status/i],
]) {
  test(`full-lane heading parser rejects ${name}`,() => {
    assert.throws(() => parseFullLaneHeadings(output,entries),expected);
  });
}

for (const [name,change,expected] of [
  ["a missing heading",lines => lines.pop(),/missing/i],
  ["a duplicate heading",lines => lines.splice(1,0,lines[0]),/duplicate|order/i],
  ["out-of-order headings",lines => lines.reverse(),/order/i],
]) {
  test(`full-lane heading parser rejects ${name}`,() => {
    const lines=entries.map((entry,index) =>
      `[test] lane=full entry=${entry} outcome=passed status=0 duration_ms=${index+1}`);
    change(lines);
    assert.throws(() => parseFullLaneHeadings(lines.join("\n"),entries),expected);
  });
}

for (const [name,change,expected] of [
  ["a missing candidate",value => value.candidates.pop(),/candidates.*1.*4|exactly four/i],
  ["a duplicate candidate",value => { value.candidates[2].concurrency=2; },/canonical order|candidate/i],
  ["out-of-order candidates",value => { [value.candidates[0],value.candidates[1]]=[value.candidates[1],value.candidates[0]]; },/canonical order|candidate/i],
  ["fewer than three runs",value => value.candidates[0].samples.pop(),/exactly three/i],
  ["a duplicate run number",value => { value.candidates[0].samples[1].run=1; },/run.*order|run number/i],
  ["an unknown root field",value => { value.extra=true; },/unknown property/i],
  ["an unknown candidate field",value => { value.candidates[0].extra=true; },/unknown property/i],
  ["an unknown sample field",value => { value.candidates[0].samples[0].extra=true; },/unknown property/i],
  ["an unknown evidence field",value => { value.candidates[0].samples[0].evidence.extra=true; },/unknown property/i],
  ["an unknown entry-result field",value => { value.candidates[0].samples[0].evidence.entry_results[0].extra=true; },/unknown property/i],
  ["a malformed identity commit",value => { value.identity.commit="not-a-commit"; },/commit/i],
  ["a malformed lock digest",value => { value.identity.lock_sha256="abc"; },/lock_sha256/i],
  ["a missing entry result",value => value.candidates[0].samples[0].evidence.entry_results.pop(),/entry results|exact/i],
  ["a duplicate entry result",value => { value.candidates[0].samples[0].evidence.entry_results[2].entry=entries[1]; },/entry.*order|mismatch|duplicate/i],
  ["an unexpected entry result",value => { value.candidates[0].samples[0].evidence.entry_results[2].entry="test/unknown.test.js"; },/entry.*order|mismatch|unknown/i],
  ["out-of-order entry results",value => value.candidates[0].samples[0].evidence.entry_results.reverse(),/entry.*order|mismatch/i],
  ["a passing aggregate with a failed entry",value => { value.candidates[0].samples[0].evidence.entry_results[0]=entryResult(entries[0],{outcome:"failed"}); },/aggregate|exit_status/i],
  ["a nonzero aggregate with all entries passing",value => { value.candidates[0].samples[0].evidence.exit_status=7; },/aggregate|exit_status/i],
  ["an inconsistent isolation result",value => { value.candidates[0].samples[0].evidence.isolation_passed=false; },/isolation/i],
  ["a malformed capture error",value => { value.candidates[0].samples[0]=captureFailure(1,"",""); },/capture error/i],
]) {
  test(`concurrency report rejects ${name}`,() => {
    const value=reportInput();
    change(value);
    assert.throws(() => createConcurrencyReport(value),expected);
  });
}

for (const [name,makeValue,expected] of [
  ["an exotic root record",() => Object.assign(Object.create(null),reportInput()),/plain object/i],
  ["an exotic candidates array",() => { const value=reportInput(); value.candidates=Object.setPrototypeOf(value.candidates,{}); return value; },/array/i],
  ["a sparse samples array",() => { const value=reportInput(); delete value.candidates[0].samples[1]; return value; },/dense/i],
  ["an accessor",() => { const value=reportInput(); Object.defineProperty(value.identity,"runner_id",{enumerable:true,get:() => "fixture"}); return value; },/enumerable data/i],
  ["a symbol field",() => { const value=reportInput(); value.candidates[0][Symbol("extra")]=true; return value; },/symbol/i],
  ["a hidden field",() => { const value=reportInput(); Object.defineProperty(value.candidates[0].samples[0],"hidden",{value:true}); return value; },/unknown property|enumerable data/i],
]) {
  test(`concurrency report rejects ${name}`,() => {
    assert.throws(() => createConcurrencyReport(makeValue()),expected);
  });
}

test("canonical concurrency JSON rejects inconsistent derived fields",() => {
  const report=clone(createConcurrencyReport(reportInput()));
  report.candidates[3].stable=true;
  report.candidates[3].medians={
    wall_ms:71,user_cpu_ms:35.5,system_cpu_ms:17.75,
    fresh_process_count:8,peak_process_count:4,
  };
  report.selection={concurrency:4,reason:"LOWEST_STABLE_WALL_MEDIAN"};
  assert.throws(() => canonicalConcurrencyJson(report),/invalid concurrency report|derived/i);
});

test("canonical concurrency JSON rejects an invented median for a failed candidate",() => {
  const report=clone(createConcurrencyReport(reportInput()));
  report.candidates[3].medians={
    wall_ms:71,user_cpu_ms:35.5,system_cpu_ms:17.75,
    fresh_process_count:8,peak_process_count:4,
  };
  assert.throws(() => canonicalConcurrencyJson(report),/invalid concurrency report|derived/i);
});

for (const concurrency of CONCURRENCY_CANDIDATES) {
  test(`candidate worker bounds concurrency ${concurrency} and preserves ordered failure evidence`,async () => {
    const manifest=workerManifest();
    const output=[];
    const diagnostics=[];
    let active=0;
    let peak=0;
    const result=await runConcurrencyCandidate({
      concurrency,
      cwd:process.cwd(),
      manifest,
      eligibleEntries:[...entries].sort(),
      executeEntry:async entry => {
        active+=1;
        peak=Math.max(peak,active);
        await new Promise(resolve => setImmediate(resolve));
        active-=1;
        return entry===entries[2] ? {
          entry,outcome:"failed",exit_status:7,signal:null,error_code:null,
          stdout:"failed stdout\n",stderr:"failed stderr\n",duration_ms:3,
        } : {
          entry,outcome:"passed",exit_status:0,signal:null,error_code:null,
          stdout:`${entry} stdout\n`,stderr:"",duration_ms:1,
        };
      },
      stdout:{write:value => output.push(value)},
      stderr:{write:value => diagnostics.push(value)},
    });
    assert.equal(peak,Math.min(concurrency,entries.length));
    assert.deepEqual(result.entries,entries);
    assert.deepEqual(result.results.map(row => row.entry),entries);
    assert.equal(result.exit_status,7);
    assert.deepEqual(result.first_failure,{
      entry:entries[2],outcome:"failed",exit_status:7,signal:null,error_code:null,
    });
    const headings=output.filter(value => value.startsWith("[test]"));
    assert.deepEqual(headings.map(value => entries.find(entry => value.includes(entry))),entries);
    assert.match(output.join(""),/failed stdout/);
    assert.match(diagnostics.join(""),/failed stderr/);
    assert.equal(manifest.concurrency,1);
  });
}

for (const concurrency of [0,5,1.5,"2"]) {
  test(`candidate worker rejects invalid bound ${JSON.stringify(concurrency)} before execution`,async () => {
    let calls=0;
    await assert.rejects(() => runConcurrencyCandidate({
      concurrency,cwd:process.cwd(),manifest:workerManifest(),eligibleEntries:[...entries].sort(),
      executeEntry:async () => { calls+=1; },
      stdout:{write() {}},stderr:{write() {}},
    }),/integer from 1 to 4/);
    assert.equal(calls,0);
  });
}

test("concurrency benchmark grammar is closed and requires exactly three runs",() => {
  assert.deepEqual(parseConcurrencyBenchmarkOptions([
    "--runs","3","--runner-id","reference",
    "--output",".superpowers/evidence/concurrency.json",
  ]),{
    runs:3,runnerId:"reference",output:".superpowers/evidence/concurrency.json",
  });
  for (const argv of [
    ["--runs","2","--runner-id","reference","--output",".superpowers/a.json"],
    ["--runs","3","--runs","3","--runner-id","reference","--output",".superpowers/a.json"],
    ["--runs","3","--runner-id","reference"],
    ["--unknown","value"],
  ]) {
    assert.throws(() => parseConcurrencyBenchmarkOptions(argv),/runs|duplicate|requires|unknown/i);
  }
});

test("concurrency benchmark runs candidates outermost, retains failures, and never overlaps",async () => {
  const manifest=JSON.parse(await (await import("node:fs/promises")).readFile(
    new URL("../scripts/test-manifest.json",import.meta.url),"utf8",
  ));
  const eligibleEntries=await discoverEligibleTestEntries(root);
  const normalizedManifest=validateTestManifest(manifest,{eligibleEntries});
  const fullEntries=selectTestEntries(normalizedManifest,"full");
  const invocations=[];
  let active=0;
  const report=await runConcurrencyBenchmark({
    runs:3,runnerId:identity.runner_id,cwd:root,identity,
    runOnce:async invocation => {
      assert.equal(active,0);
      active+=1;
      invocations.push(invocation);
      const concurrency=Number(invocation.args.at(-1));
      const run=invocations.filter(row => Number(row.args.at(-1))===concurrency).length;
      try {
        if (concurrency===3 && run===2) {
          throw Object.assign(new Error("intentional capture failure"),{code:"EIO"});
        }
        const failureEntry=concurrency===4 && run===2 ? fullEntries[2] : undefined;
        return {
          wall_ms:concurrency*100+run,
          user_cpu_ms:concurrency*50+run,
          system_cpu_ms:concurrency*25+run,
          exit_status:failureEntry===undefined ? 0 : 7,
          fresh_process_count:fullEntries.length+1,
          peak_process_count:concurrency,
          duplicates:[],
          stdout:fullEntries.map((entry,index) => {
            const failed=entry===failureEntry;
            return `[test] lane=full entry=${entry} outcome=${failed ? "failed" : "passed"} status=${failed ? 7 : 0} duration_ms=${index+1}`;
          }).join("\n"),
          stderr:failureEntry===undefined ? "" : "intentional failure\n",
        };
      } finally {
        active-=1;
      }
    },
  });
  assert.equal(invocations.length,12);
  assert.deepEqual(invocations.map(row => Number(row.args.at(-1))),[
    1,1,1,2,2,2,3,3,3,4,4,4,
  ]);
  assert.ok(invocations.every(row => row.command===process.execPath));
  assert.ok(invocations.every(row => row.args[0]===workerCli));
  assert.deepEqual(invocations.map(row => row.runId),[
    `${identity.commit}-concurrency-1-1`,`${identity.commit}-concurrency-1-2`,`${identity.commit}-concurrency-1-3`,
    `${identity.commit}-concurrency-2-1`,`${identity.commit}-concurrency-2-2`,`${identity.commit}-concurrency-2-3`,
    `${identity.commit}-concurrency-3-1`,`${identity.commit}-concurrency-3-2`,`${identity.commit}-concurrency-3-3`,
    `${identity.commit}-concurrency-4-1`,`${identity.commit}-concurrency-4-2`,`${identity.commit}-concurrency-4-3`,
  ]);
  assert.equal(report.candidates[0].stable,true);
  assert.equal(report.candidates[1].stable,true);
  assert.deepEqual(report.candidates[2].samples[1],{
    run:2,capture_error:{code:"EIO",message:"intentional capture failure"},evidence:null,
  });
  assert.equal(report.candidates[2].medians,null);
  assert.equal(report.candidates[3].samples[1].evidence.exit_status,7);
  assert.equal(report.candidates[3].samples[1].evidence.entry_results[2].outcome,"failed");
  assert.equal(report.candidates[3].medians,null);
  assert.deepEqual(report.selection,{
    concurrency:1,reason:"LOWEST_STABLE_WALL_MEDIAN",
  });
});

test("concurrency worker and benchmark modules are inert under node --test",async () => {
  for (const module of [workerCli,benchmarkCli]) {
    const result=await execFile(process.execPath,["--test",module],{
      cwd:root,env:{...process.env,NODE_TEST_CONTEXT:undefined},
    });
    assert.equal(result.stderr,"");
    assert.match(result.stdout,/pass 1/i);
    assert.doesNotMatch(result.stdout,/usage:|lane=full/);
  }
});

test("concurrency CLIs reject closed usage without starting a capture",() => {
  for (const [cli,argv] of [
    [workerCli,[]],
    [workerCli,["--concurrency","5"]],
    [workerCli,["--concurrency","2","extra"]],
    [benchmarkCli,[]],
    [benchmarkCli,["--runs","2","--runner-id","fixture","--output",".superpowers/a.json"]],
  ]) {
    const result=spawnSync(process.execPath,[cli,...argv],{
      cwd:root,encoding:"utf8",env:cliEnvironment(),
    });
    assert.equal(result.status,2,result.stderr);
    assert.equal(result.stdout,"");
    assert.match(result.stderr,/usage|runs|requires/i);
  }
});

test("concurrency benchmark keeps missing package-lock failures unexpected",async t => {
  const fixture=await mkdtemp(join(tmpdir(),"toss-concurrency-missing-lock-"));
  t.after(() => rm(fixture,{recursive:true,force:true}));
  await mkdir(join(fixture,".superpowers","evidence"),{recursive:true});
  await writeFile(join(fixture,"tracked.txt"),"fixture\n");
  const git=spawnSync("git",["init","--quiet"],{cwd:fixture,encoding:"utf8"});
  assert.equal(git.status,0,git.stderr);
  spawnSync("git",["config","user.email","test@example.invalid"],{cwd:fixture});
  spawnSync("git",["config","user.name","Test"],{cwd:fixture});
  spawnSync("git",["add","tracked.txt"],{cwd:fixture});
  spawnSync("git",["commit","--quiet","-m","fixture"],{cwd:fixture});
  const result=spawnSync(process.execPath,[benchmarkCli,
    "--runs","3","--runner-id","fixture",
    "--output",".superpowers/evidence/concurrency.json",
  ],{cwd:fixture,encoding:"utf8",env:cliEnvironment()});
  assert.equal(result.status,70,result.stderr);
  assert.match(result.stderr,/ENOENT.*package-lock\.json/i);
  assert.doesNotMatch(result.stderr,/INVALID_CONCURRENCY_EVIDENCE|UNSAFE_/);
});
