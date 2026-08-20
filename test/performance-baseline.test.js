import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import test from "node:test";

const baselineSource=readFileSync(
  new URL("../docs/performance/v2.1.1-baseline.json",import.meta.url),"utf8",
);
const baseline=JSON.parse(baselineSource);
const protocol=readFileSync(
  new URL("../docs/testing/performance-baseline.md",import.meta.url),"utf8",
);
const lock=readFileSync(new URL("../package-lock.json",import.meta.url));
const BASELINE_SHA256="f84798183d695a7ddbcef775a9b502d3d4c393259d94ff53993303a44ed699a9";

function median(samples,field) {
  return samples.map(sample => sample[field]).sort((left,right) => left-right)[1];
}

function assertBaselineIntegrity(candidate,source=baselineSource) {
  assert.equal(createHash("sha256").update(source).digest("hex"),BASELINE_SHA256);
  assert.equal(candidate.schema_version,"toss-test-performance-baseline.v1");
  assert.deepEqual(candidate.command,{arguments:["test"],executable:"npm"});
  assert.equal(candidate.lane,"full");
  assert.equal(candidate.identity.commit,"e82a1e814f9f9eaae5c6bbd055c00062796a4f87");
  assert.equal(candidate.identity.runner_id,"toss-reference-macos-node26");
  assert.equal(candidate.identity.node_version,"v26.6.0");
  assert.equal(candidate.identity.platform,"darwin");
  assert.equal(candidate.identity.arch,"arm64");
  assert.equal(candidate.identity.lock_sha256,createHash("sha256").update(lock).digest("hex"));
  assert.equal(candidate.samples.length,3);
  assert.ok(candidate.samples.every(sample => sample.exit_status===0));
  assert.equal(candidate.historical.full_wall_ms,134960);
  assert.equal(candidate.budgets.fast_max_wall_ms,15000);
  assert.equal(candidate.medians.wall_ms,128718.79316700001);
  assert.equal(candidate.medians.user_cpu_ms,192557.43);
  assert.equal(candidate.medians.system_cpu_ms,293169.077);
  assert.equal(candidate.medians.fresh_process_count,441);
  assert.equal(candidate.medians.peak_process_count,26);
  assert.equal(candidate.medians.wall_ms,median(candidate.samples,"wall_ms"));
  assert.equal(candidate.medians.user_cpu_ms,median(candidate.samples,"user_cpu_ms"));
  assert.equal(candidate.medians.system_cpu_ms,median(candidate.samples,"system_cpu_ms"));
  assert.equal(candidate.medians.fresh_process_count,median(candidate.samples,"fresh_process_count"));
  assert.equal(candidate.medians.peak_process_count,median(candidate.samples,"peak_process_count"));
  assert.equal(candidate.budgets.full_max_wall_ms,90103);
  assert.equal(
    candidate.budgets.full_max_wall_ms,
    Math.floor(Math.min(134960,candidate.medians.wall_ms)*0.70),
  );
  assert.ok(candidate.samples.every(sample => sample.duplicates.length>0));
}

test("v2.1.1 baseline is exact and cannot relax its budgets",() => {
  assertBaselineIntegrity(baseline);
});

test("integrity rejects a correlated full-budget relaxation",() => {
  const mutated=structuredClone(baseline);
  mutated.medians.wall_ms=130000;
  mutated.budgets.full_max_wall_ms=Math.floor(Math.min(134960,mutated.medians.wall_ms)*0.70);
  assert.throws(() => assertBaselineIntegrity(mutated),assert.AssertionError);
});

test("integrity rejects an altered captured median",() => {
  const mutated=structuredClone(baseline);
  mutated.medians.user_cpu_ms=200000;
  assert.throws(() => assertBaselineIntegrity(mutated),assert.AssertionError);
});

test("integrity rejects a replacement captured commit",() => {
  const mutated=structuredClone(baseline);
  mutated.identity.commit="0".repeat(40);
  assert.throws(() => assertBaselineIntegrity(mutated),assert.AssertionError);
});

test("integrity rejects drift in a raw nonmedian CPU sample",() => {
  const mutatedSource=baselineSource.replace('"system_cpu_ms":292498.801','"system_cpu_ms":292498.802');
  assert.notEqual(mutatedSource,baselineSource);
  assert.throws(
    () => assertBaselineIntegrity(JSON.parse(mutatedSource),mutatedSource),
    assert.AssertionError,
  );
});

test("integrity rejects drift in captured diagnostic evidence",() => {
  const mutatedSource=baselineSource.replace('"entry_path":"bin/toss.js"','"entry_path":"bin/toss.mjs"');
  assert.notEqual(mutatedSource,baselineSource);
  assert.throws(
    () => assertBaselineIntegrity(JSON.parse(mutatedSource),mutatedSource),
    assert.AssertionError,
  );
});

test("protocol names exact capture and refresh boundaries",() => {
  assert.match(protocol,/--runs 3/);
  assert.match(protocol,/--update-baseline/);
  assert.match(protocol,/Ordinary benchmark execution does not update/);
  assert.match(protocol,/A slower capture cannot relax an existing budget/);
  assert.match(protocol,/FULL_WALL_BUDGET_EXCEEDED/);
});
