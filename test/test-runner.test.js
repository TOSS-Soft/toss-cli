import assert from "node:assert/strict";
import {execFile as execFileCallback} from "node:child_process";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

import {executeTestEntry,runTestLane} from "../scripts/test-runner.mjs";

const execFile=promisify(execFileCallback);
const root=fileURLToPath(new URL("..",import.meta.url));
const runner=fileURLToPath(new URL("../scripts/test-runner.mjs",import.meta.url));
const passingFixture=fileURLToPath(new URL(
  "./fixtures/test-runner/passing-entry.mjs",import.meta.url,
));
const failingFixture=fileURLToPath(new URL(
  "./fixtures/test-runner/failing-entry.mjs",import.meta.url,
));

function entryEnvironment(overrides={}) {
  const env={...process.env,...overrides};
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function manifest({fast=[],integration=[],concurrency=1}={}) {
  return {
    schema_version:"toss-test-manifest.v1",
    concurrency,
    lanes:{fast,integration,e2e:[],package:[],release:[]},
  };
}

function passed(entry,{stdout=`${entry}\n`,stderr="",duration_ms=1}={}) {
  return {
    entry,outcome:"passed",exit_status:0,signal:null,error_code:null,
    stdout,stderr,duration_ms,
  };
}

test("a lane runs only its explicit stable entries and preserves results",async () => {
  const calls=[];
  const output=[];
  const entries=["test/a.test.js","test/b.test.js"];
  const result=await runTestLane({
    lane:"fast",
    cwd:process.cwd(),
    manifest:manifest({fast:entries}),
    eligibleEntries:entries,
    executeEntry:async entry => {
      calls.push(entry);
      return passed(entry);
    },
    stdout:{write:value => output.push(value)},stderr:{write() {}},
  });
  assert.deepEqual(calls,entries);
  assert.deepEqual(result.entries,calls);
  assert.equal(result.exit_status,0);
  assert.match(output.join(""),/lane=fast.*test\/a\.test\.js/s);
});

test("a failure keeps child output, status, lane, and exact entry",async () => {
  const diagnostics=[];
  const entries=["test/a.test.js","test/b.test.js"];
  const result=await runTestLane({
    lane:"fast",cwd:process.cwd(),eligibleEntries:entries,
    manifest:manifest({fast:entries}),
    executeEntry:async entry => entry===entries[0] ? passed(entry,{
      stdout:"first stdout\n",
    }) : {
      entry,outcome:"failed",exit_status:7,signal:null,error_code:null,
      stdout:"second stdout\n",stderr:"second stderr\n",duration_ms:2,
    },
    stdout:{write() {}},stderr:{write:value => diagnostics.push(value)},
  });
  assert.equal(result.exit_status,7);
  assert.deepEqual(result.first_failure,{
    entry:"test/b.test.js",outcome:"failed",exit_status:7,
    signal:null,error_code:null,
  });
  assert.match(result.results[1].stdout,/second stdout/);
  assert.match(result.results[1].stderr,/second stderr/);
  assert.match(diagnostics.join(""),/lane=fast.*test\/b\.test\.js.*status=7/s);
});

test("invalid integrity starts no child",async () => {
  let calls=0;
  await assert.rejects(() => runTestLane({
    lane:"fast",cwd:process.cwd(),eligibleEntries:["test/a.test.js"],
    manifest:manifest(),
    executeEntry:async () => { calls+=1; },
    stdout:{write() {}},stderr:{write() {}},
  }),/missing owner.*test\/a\.test\.js/i);
  assert.equal(calls,0);
});

test("bounded execution and emitted results stay in manifest order",async () => {
  const entries=[
    "test/a.test.js","test/b.test.js","test/c.test.js","test/d.test.js",
  ];
  const pending=new Map();
  const calls=[];
  const output=[];
  let active=0;
  let peak=0;
  const executeEntry=entry => new Promise(resolve => {
    calls.push(entry);
    active+=1;
    peak=Math.max(peak,active);
    pending.set(entry,() => {
      active-=1;
      resolve(passed(entry));
    });
  });
  const running=runTestLane({
    lane:"fast",cwd:process.cwd(),manifest:manifest({fast:entries,concurrency:2}),
    eligibleEntries:entries,executeEntry,
    stdout:{write:value => output.push(value)},stderr:{write() {}},
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls,entries.slice(0,2));
  assert.equal(peak,2);
  pending.get(entries[1])();
  pending.get(entries[0])();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls,entries);
  pending.get(entries[3])();
  pending.get(entries[2])();

  const result=await running;
  assert.equal(peak,2);
  assert.deepEqual(result.entries,entries);
  assert.deepEqual(result.results.map(item => item.entry),entries);
  const headings=output.filter(value => value.includes("lane=fast"));
  assert.deepEqual(headings.map(value => entries.find(entry => value.includes(entry))),entries);
});

for (const concurrency of [1,2,3,4]) {
  test(`full lane keeps exact bound ${concurrency}, manifest order, and failure evidence`,async () => {
    const entries=[
      "test/a.test.js","test/b.test.js","test/c.test.js","test/d.test.js",
    ];
    const output=[];
    let active=0;
    let peak=0;
    const result=await runTestLane({
      lane:"full",cwd:process.cwd(),
      manifest:manifest({fast:entries,concurrency}),eligibleEntries:entries,
      executeEntry:async entry => {
        active+=1;
        peak=Math.max(peak,active);
        await new Promise(resolve => setImmediate(resolve));
        active-=1;
        return entry===entries[2] ? {
          entry,outcome:"failed",exit_status:9,signal:null,error_code:null,
          stdout:"failure stdout\n",stderr:"failure stderr\n",duration_ms:2,
        } : passed(entry);
      },
      stdout:{write:value => output.push(value)},stderr:{write() {}},
    });
    assert.equal(peak,concurrency);
    assert.deepEqual(result.results.map(row => row.entry),entries);
    assert.deepEqual(result.first_failure,{
      entry:entries[2],outcome:"failed",exit_status:9,signal:null,error_code:null,
    });
    assert.deepEqual(
      output.filter(value => value.startsWith("[test]")).map(value =>
        entries.find(entry => value.includes(entry))),
      entries,
    );
  });
}

for (const example of [
  {
    name:"a signal",
    result:{
      outcome:"signaled",exit_status:null,signal:"SIGTERM",error_code:null,
      stdout:"signal stdout\n",stderr:"signal stderr\n",duration_ms:3,
    },
    failure:{outcome:"signaled",exit_status:null,signal:"SIGTERM",error_code:null},
    diagnostic:/lane=fast.*test\/a\.test\.js.*signal=SIGTERM/s,
  },
  {
    name:"a spawn error",
    result:{
      outcome:"spawn_error",exit_status:null,signal:null,error_code:"ENOENT",
      stdout:"spawn stdout\n",stderr:"spawn stderr\n",duration_ms:4,
    },
    failure:{outcome:"spawn_error",exit_status:null,signal:null,error_code:"ENOENT"},
    diagnostic:/lane=fast.*test\/a\.test\.js.*error_code=ENOENT/s,
  },
]) {
  test(`${example.name} retains exact evidence and produces aggregate failure`,async () => {
    const entry="test/a.test.js";
    const diagnostics=[];
    const result=await runTestLane({
      lane:"fast",cwd:process.cwd(),manifest:manifest({fast:[entry]}),
      eligibleEntries:[entry],
      executeEntry:async () => ({entry,...example.result}),
      stdout:{write() {}},stderr:{write:value => diagnostics.push(value)},
    });
    assert.equal(result.exit_status,1);
    assert.deepEqual(result.first_failure,{entry,...example.failure});
    assert.equal(result.results[0].stdout,example.result.stdout);
    assert.equal(result.results[0].stderr,example.result.stderr);
    assert.match(diagnostics.join(""),example.diagnostic);
  });
}

for (const example of [
  {
    name:"a passing outcome without status",
    change:{exit_status:null},
  },
  {
    name:"a failed outcome with zero status",
    change:{outcome:"failed",exit_status:0},
  },
  {
    name:"a passing outcome with a signal",
    change:{signal:"SIGTERM"},
  },
  {
    name:"a result with non-string output",
    change:{stdout:7},
  },
  {
    name:"a mismatched returned entry",
    change:{entry:"test/b.test.js"},
  },
  {
    name:"an open result record",
    change:{extra:true},
  },
]) {
  test(`lane execution fails closed for ${example.name}`,async () => {
    const entry="test/a.test.js";
    await assert.rejects(() => runTestLane({
      lane:"fast",cwd:process.cwd(),manifest:manifest({fast:[entry]}),
      eligibleEntries:[entry],
      executeEntry:async () => ({...passed(entry),...example.change}),
      stdout:{write() {}},stderr:{write() {}},
    }),/result|entry|outcome|status|signal|stdout|unknown/i);
  });
}

test("executeTestEntry runs only one explicit passing platform path without an unsupported child flag",async () => {
  const entry="test/fixtures/test-runner/passing-entry.mjs";
  const result=await executeTestEntry(entry,{cwd:root,env:entryEnvironment()});
  assert.deepEqual({
    entry:result.entry,outcome:result.outcome,exit_status:result.exit_status,
    signal:result.signal,error_code:result.error_code,
  },{
    entry,outcome:"passed",exit_status:0,signal:null,error_code:null,
  });
  assert.match(`${result.stdout}${result.stderr}`,/PASSING_STDOUT_MARKER/);
  assert.match(`${result.stdout}${result.stderr}`,/PASSING_STDERR_MARKER/);
  const output=`${result.stdout}${result.stderr}`;
  const execArgv=output.match(/PASSING_EXEC_ARGV:(\[[^\n]*\])/);
  const argv=output.match(/PASSING_ARGV:(\[[^\n]+\])/);
  assert.notEqual(execArgv,null);
  assert.notEqual(argv,null);
  assert.equal(JSON.parse(execArgv[1]).includes("--test-concurrency=1"),false);
  assert.deepEqual(JSON.parse(argv[1]),[passingFixture]);
});

test("executeTestEntry retains a single explicit failing child result",async () => {
  const entry="test/fixtures/test-runner/failing-entry.mjs";
  const result=await executeTestEntry(entry,{
    cwd:root,
    env:entryEnvironment({TOSS_TEST_RUNNER_FIXTURE_MODE:"intentional-failure"}),
  });
  assert.equal(result.entry,entry);
  assert.equal(result.outcome,"failed");
  assert.equal(Number.isInteger(result.exit_status),true);
  assert.notEqual(result.exit_status,0);
  assert.equal(result.signal,null);
  assert.equal(result.error_code,null);
  assert.match(`${result.stdout}${result.stderr}`,/FAILING_STDOUT_MARKER/);
  assert.match(`${result.stdout}${result.stderr}`,/FAILING_STDERR_MARKER/);
});

test("the runner module is inert when loaded as a Node test entry",async () => {
  const result=await execFile(process.execPath,[
    "--test",runner,
  ],{cwd:root,env:entryEnvironment()});
  assert.equal(result.stderr,"");
  assert.match(result.stdout,/pass 1/i);
  assert.doesNotMatch(result.stdout,/requires exactly one lane/i);
});

test("the intentional failure fixture is inert without its explicit signal",async () => {
  const result=await execFile(process.execPath,[
    "--test",failingFixture,
  ],{cwd:root,env:entryEnvironment()});
  assert.equal(result.stderr,"");
  assert.match(result.stdout,/pass 1/i);
  assert.doesNotMatch(result.stdout,/intentional runner fixture failure/i);
  assert.doesNotMatch(result.stdout,/FAILING_(?:STDOUT|STDERR)_MARKER/);
});

for (const argumentsToRunner of [
  [],
  ["fast","integration"],
  ["unknown"],
  ["--fast"],
]) {
  test(`runner CLI rejects closed arguments ${JSON.stringify(argumentsToRunner)}`,async () => {
    await assert.rejects(
      () => execFile(process.execPath,[runner,...argumentsToRunner],{
        cwd:root,env:entryEnvironment(),
      }),
      error => {
        assert.equal(error.code,1);
        assert.equal(error.stdout,"");
        assert.match(error.stderr,/lane|usage/i);
        return true;
      },
    );
  });
}
