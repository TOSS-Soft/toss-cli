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

const sample=wall_ms => ({
  wall_ms,user_cpu_ms:200000,system_cpu_ms:300000,exit_status:0,
  fresh_process_count:80,peak_process_count:12,duplicates:[],
  slowest_files:[],slowest_tests:[],
});

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

test("report requires three compatible successful samples",() => {
  const report=createPerformanceReport({
    lane:"full",identity,
    samples:[sample(134000),sample(132000),sample(133000)],
  });
  assert.equal(report.schema_version,"toss-test-performance-report.v1");
  assert.equal(report.medians.wall_ms,133000);
  assert.equal(JSON.parse(canonicalPerformanceJson(report)).medians.wall_ms,133000);
  assert.throws(() => createPerformanceReport({lane:"full",identity,samples:[sample(1),sample(2)]}),/exactly three/);
});

test("full budget has stable passing and failing results",() => {
  const baseline={
    schema_version:"toss-test-performance-baseline.v1",identity,
    medians:{wall_ms:140000},
    budgets:{fast_max_wall_ms:15000,full_max_wall_ms:94472},
  };
  const candidate={...baseline,schema_version:"toss-test-performance-report.v1",medians:{wall_ms:95000}};
  assert.equal(comparePerformanceBudget(baseline,candidate,"full").code,"FULL_WALL_BUDGET_EXCEEDED");
});

test("budget comparison accepts a report produced by the report model",() => {
  const baseline={
    schema_version:"toss-test-performance-baseline.v1",identity,
    medians:{wall_ms:140000},
    budgets:{fast_max_wall_ms:15000,full_max_wall_ms:94472},
  };
  const candidate=createPerformanceReport({
    lane:"full",identity,
    samples:[sample(94000),sample(93000),sample(92000)],
  });
  assert.equal(comparePerformanceBudget(baseline,candidate,"full").code,"PERFORMANCE_BUDGET_OK");
});

test("canonical report serialization rejects unknown report fields",() => {
  const report=createPerformanceReport({
    lane:"fast",identity,
    samples:[sample(1000),sample(1100),sample(1200)],
  });
  assert.throws(() => canonicalPerformanceJson({...report,extra:true}),/unknown property/);
});
