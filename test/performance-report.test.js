import assert from "node:assert/strict";
import test from "node:test";

import {median,parseNamedDurations} from "../scripts/performance/report.mjs";
import {
  canonicalPerformanceJson,
  comparePerformanceBudget,
  createPerformanceReport,
  summarizeProcessEvents,
} from "../scripts/performance/report.mjs";

test("median accepts exactly three finite nonnegative samples",() => {
  assert.equal(median([134960,126284,130000]),130000);
  assert.throws(() => median([1,2]),/exactly three/);
  assert.throws(() => median([1,Number.NaN,3]),/finite nonnegative/);
});

test("named duration parsing is stable and ignores unrelated output",() => {
  assert.deepEqual(parseNamedDurations([
    "setup output",
    "✔ fast contract case (4.25ms)",
    "✖ blocked command case (18ms)",
    "ℹ tests 2",
  ].join("\n")),[
    {name:"blocked command case",duration_ms:18,status:"fail"},
    {name:"fast contract case",duration_ms:4.25,status:"pass"},
  ]);
});

const identity={
  commit:"4472175eac91275cafab2993f68722febdb9eb59",
  node_version:"v26.6.0",platform:"darwin",arch:"arm64",
  lock_sha256:"a".repeat(64),runner_id:"toss-reference-macos-node26",
};
const command={executable:"npm",arguments:["test"]};

const sample=wall_ms => ({
  wall_ms,user_cpu_ms:200000,system_cpu_ms:300000,exit_status:0,
  fresh_process_count:80,peak_process_count:12,duplicates:[],
  slowest_files:[],slowest_tests:[],
});

function reportDocument({
  lane="full",walls=[139000,140000,141000],exactIdentity=identity,exactCommand=command,
  sampleFactory=sample,
}={}) {
  return createPerformanceReport({
    command:exactCommand,lane,identity:exactIdentity,samples:walls.map(sampleFactory),
  });
}

function baselineDocument({walls,fullLimit=94472,exactIdentity,exactCommand}={}) {
  const report=reportDocument({walls,exactIdentity,exactCommand});
  return {
    ...report,
    schema_version:"toss-test-performance-baseline.v1",
    historical:{full_wall_ms:134960},
    budgets:{fast_max_wall_ms:15000,full_max_wall_ms:fullLimit},
  };
}

test("process events produce counts, CPU totals, and duplicates",() => {
  const summary=summarizeProcessEvents([
    {kind:"start",run_id:"run-1",pid:10,at_ms:1000,argv:["/repo/test/a.test.js"]},
    {kind:"end",run_id:"run-1",pid:10,at_ms:1030,user_cpu_us:10000,system_cpu_us:5000},
    {kind:"start",run_id:"run-1",pid:11,at_ms:1010,argv:["/repo/test/a.test.js"]},
    {kind:"end",run_id:"run-1",pid:11,at_ms:1050,user_cpu_us:20000,system_cpu_us:7000},
  ],"/repo","run-1");
  assert.equal(summary.fresh_process_count,2);
  assert.equal(summary.peak_process_count,2);
  assert.equal(summary.user_cpu_ms,30);
  assert.equal(summary.system_cpu_ms,12);
  assert.deepEqual(summary.duplicates,[{entry_path:"test/a.test.js",count:2}]);
});

test("process summaries reject empty evidence",() => {
  assert.throws(
    () => summarizeProcessEvents([],"/repo","run-1"),
    error => error.code==="INCOMPLETE_PROCESS_EVIDENCE",
  );
});

test("process summaries retain external processes but duplicate only repository tests",() => {
  const summary=summarizeProcessEvents([
    {kind:"start",run_id:"run-1",pid:10,at_ms:1000,argv:["/usr/local/bin/node","/repo/test/a.test.js"]},
    {kind:"end",run_id:"run-1",pid:10,at_ms:1030,user_cpu_us:10000,system_cpu_us:5000},
    {kind:"start",run_id:"run-1",pid:11,at_ms:1010,argv:["/usr/bin/git","status"]},
    {kind:"end",run_id:"run-1",pid:11,at_ms:1050,user_cpu_us:2000,system_cpu_us:1000},
    {kind:"start",run_id:"run-1",pid:12,at_ms:1020,argv:["/usr/local/bin/node","/repo/test/a.test.js"]},
    {kind:"end",run_id:"run-1",pid:12,at_ms:1060,user_cpu_us:20000,system_cpu_us:7000},
  ],"/repo","run-1");
  assert.equal(summary.fresh_process_count,3);
  assert.equal(summary.user_cpu_ms,32);
  assert.equal(summary.system_cpu_ms,13);
  assert.deepEqual(summary.duplicates,[{entry_path:"test/a.test.js",count:2}]);
});

test("process summaries expose only repository entry paths for slow-file analysis",() => {
  const summary=summarizeProcessEvents([
    {kind:"start",run_id:"run-1",pid:10,at_ms:1000,argv:["/usr/local/bin/node","/repo/test/a.test.js"]},
    {kind:"end",run_id:"run-1",pid:10,at_ms:1030,user_cpu_us:10000,system_cpu_us:5000},
    {kind:"start",run_id:"run-1",pid:11,at_ms:1010,argv:["/usr/bin/git","status"]},
    {kind:"end",run_id:"run-1",pid:11,at_ms:1050,user_cpu_us:2000,system_cpu_us:1000},
  ],"/repo","run-1");
  assert.deepEqual(summary.entries,[{name:"test/a.test.js",duration_ms:30,status:"pass"}]);
});

test("process summaries use the Node entry point instead of later repository arguments",() => {
  const summary=summarizeProcessEvents([
    {kind:"start",run_id:"run-1",pid:10,at_ms:1000,
      argv:[process.execPath,"/opt/npm/npm-cli.js","/repo/test/a.test.js"]},
    {kind:"end",run_id:"run-1",pid:10,at_ms:1030,user_cpu_us:10000,system_cpu_us:5000},
    {kind:"start",run_id:"run-1",pid:11,at_ms:1010,
      argv:[process.execPath,"/repo/test/a.test.js"]},
    {kind:"end",run_id:"run-1",pid:11,at_ms:1050,user_cpu_us:20000,system_cpu_us:7000},
  ],"/repo","run-1");
  assert.equal(summary.fresh_process_count,2);
  assert.equal(summary.user_cpu_ms,30);
  assert.equal(summary.system_cpu_ms,12);
  assert.deepEqual(summary.entries,[{name:"test/a.test.js",duration_ms:40,status:"pass"}]);
  assert.deepEqual(summary.duplicates,[]);
});

test("report requires three compatible successful samples",() => {
  const report=createPerformanceReport({
    command,lane:"full",identity,
    samples:[sample(134000),sample(132000),sample(133000)],
  });
  assert.equal(report.schema_version,"toss-test-performance-report.v1");
  assert.equal(report.medians.wall_ms,133000);
  assert.equal(JSON.parse(canonicalPerformanceJson(report)).medians.wall_ms,133000);
  assert.throws(() => createPerformanceReport({
    command,lane:"full",identity,samples:[sample(1),sample(2)],
  }),/exactly three/);
});

test("report records one exact closed executable and argument vector",() => {
  const report=createPerformanceReport({
    command,lane:"full",identity,
    samples:[sample(134000),sample(132000),sample(133000)],
  });
  assert.deepEqual(report.command,command);
  assert.throws(() => createPerformanceReport({
    command:{...command,shell:false},lane:"full",identity,
    samples:[sample(134000),sample(132000),sample(133000)],
  }),/unknown property/);
});

test("full budget has stable passing and failing results",() => {
  const baseline=baselineDocument();
  const candidate=reportDocument({walls:[95000,95000,95000]});
  assert.equal(comparePerformanceBudget(baseline,candidate,"full").code,"FULL_WALL_BUDGET_EXCEEDED");
});

test("budget comparison accepts a report produced by the report model",() => {
  const baseline=baselineDocument();
  const candidate=reportDocument({walls:[94000,93000,92000]});
  assert.equal(comparePerformanceBudget(baseline,candidate,"full").code,"PERFORMANCE_BUDGET_OK");
});

test("budget comparison accepts a complete historical baseline",() => {
  const baseline=baselineDocument();
  const candidate=reportDocument({walls:[94000,93000,92000]});
  assert.equal(comparePerformanceBudget(baseline,candidate,"full").code,"PERFORMANCE_BUDGET_OK");
});

test("budget comparison rejects a candidate report from another lane",() => {
  const baseline=baselineDocument();
  const candidate=reportDocument({lane:"fast",walls:[1000,1100,1200]});
  assert.throws(() => comparePerformanceBudget(baseline,candidate,"full"),/candidate lane/);
});

test("budget comparison requires complete canonical evidence",() => {
  const partialBaseline={
    schema_version:"toss-test-performance-baseline.v1",identity,
    budgets:{fast_max_wall_ms:15000,full_max_wall_ms:94472},
  };
  const partialCandidate={
    schema_version:"toss-test-performance-report.v1",lane:"full",identity,
    medians:{wall_ms:90000},
  };
  assert.throws(() => comparePerformanceBudget(partialBaseline,partialCandidate,"full"));

  const relaxed=baselineDocument({fullLimit:94473});
  assert.throws(
    () => comparePerformanceBudget(relaxed,reportDocument({walls:[90000,90000,90000]}),"full"),
    /full budget/,
  );

  const failed=reportDocument({walls:[90000,90000,90000]});
  failed.samples[1].exit_status=7;
  assert.throws(() => comparePerformanceBudget(baselineDocument(),failed,"full"),/successful/);

  const noncanonical=reportDocument({walls:[90000,90000,90000]});
  noncanonical.samples[0].stdout="captured output is not canonical evidence";
  assert.throws(() => comparePerformanceBudget(baselineDocument(),noncanonical,"full"));
});

test("budget comparison binds command and lane while allowing a stricter baseline",() => {
  const stricter=baselineDocument({fullLimit:90000});
  assert.equal(
    comparePerformanceBudget(stricter,reportDocument({walls:[89000,89000,89000]}),"full").code,
    "PERFORMANCE_BUDGET_OK",
  );
  assert.throws(
    () => comparePerformanceBudget(stricter,reportDocument({
      walls:[89000,89000,89000],exactCommand:{executable:"node",arguments:["--test"]},
    }),"full"),
    /command/,
  );
});

test("canonical report serialization rejects unknown report fields",() => {
  const report=createPerformanceReport({
    command,lane:"fast",identity,
    samples:[sample(1000),sample(1100),sample(1200)],
  });
  assert.throws(() => canonicalPerformanceJson({...report,extra:true}),/unknown property/);
});

test("report creation rejects hidden and symbol input properties",() => {
  const hidden={command,lane:"fast",identity,samples:[sample(1000),sample(1100),sample(1200)]};
  Object.defineProperty(hidden,"hidden",{value:true});
  assert.throws(() => createPerformanceReport(hidden),/unknown property/);
  const symbolic={command,lane:"fast",identity,samples:[sample(1000),sample(1100),sample(1200)]};
  symbolic[Symbol("hidden")]=true;
  assert.throws(() => createPerformanceReport(symbolic),/symbol property/);
});

test("report creation rejects sparse JSON arrays before sample validation",() => {
  const samples=[sample(1000),sample(1100),sample(1200)];
  delete samples[1];
  assert.throws(() => createPerformanceReport({command,lane:"fast",identity,samples}),/dense/);
});
