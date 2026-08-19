import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import test from "node:test";

const baseline=JSON.parse(readFileSync(
  new URL("../docs/performance/v2.1.1-baseline.json",import.meta.url),"utf8",
));
const protocol=readFileSync(
  new URL("../docs/testing/performance-baseline.md",import.meta.url),"utf8",
);
const lock=readFileSync(new URL("../package-lock.json",import.meta.url));

test("v2.1.1 baseline is exact and cannot relax its budgets",() => {
  assert.equal(baseline.schema_version,"toss-test-performance-baseline.v1");
  assert.equal(baseline.identity.runner_id,"toss-reference-macos-node26");
  assert.equal(baseline.identity.node_version,"v26.6.0");
  assert.equal(baseline.identity.platform,"darwin");
  assert.equal(baseline.identity.arch,"arm64");
  assert.equal(baseline.identity.lock_sha256,createHash("sha256").update(lock).digest("hex"));
  assert.equal(baseline.samples.length,3);
  assert.ok(baseline.samples.every(sample => sample.exit_status===0));
  assert.equal(baseline.historical.full_wall_ms,134960);
  assert.equal(baseline.budgets.fast_max_wall_ms,15000);
  assert.equal(
    baseline.budgets.full_max_wall_ms,
    Math.floor(Math.min(134960,baseline.medians.wall_ms)*0.70),
  );
  assert.ok(baseline.samples.every(sample => sample.duplicates.length>0));
});

test("protocol names exact capture and refresh boundaries",() => {
  assert.match(protocol,/--runs 3/);
  assert.match(protocol,/--update-baseline/);
  assert.match(protocol,/Ordinary benchmark execution does not update/);
  assert.match(protocol,/A slower capture cannot relax an existing budget/);
  assert.match(protocol,/FULL_WALL_BUDGET_EXCEEDED/);
});
