import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {isDeepStrictEqual} from "node:util";
import {fileURLToPath} from "node:url";

const root=fileURLToPath(new URL("../",import.meta.url));
const baselineSource=readFileSync(join(root,"docs/performance/v2.1.1-baseline.json"),"utf8");
const baseline=JSON.parse(baselineSource);
const protocol=readFileSync(join(root,"docs/testing/performance-baseline.md"),"utf8");
const lock=readFileSync(join(root,"package-lock.json"));
const historicalLockSource=readFileSync(
  join(root,"test/fixtures/performance/v2.1.1-baseline-package-lock.json"),"utf8",
);
const historicalLock=JSON.parse(historicalLockSource);
const currentLock=JSON.parse(lock);
const BASELINE_SHA256="f84798183d695a7ddbcef775a9b502d3d4c393259d94ff53993303a44ed699a9";
const HISTORICAL_ROOT_BIN=Object.freeze({toss:"bin/toss.js"});
const CORE_DUAL_BIN=Object.freeze({toss:"bin/toss.js","toss-core":"bin/toss-core.js"});
const FAST_URI_PATH="node_modules/fast-uri";
const HISTORICAL_FAST_URI=Object.freeze({
  version:"3.1.5",
  resolved:"https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.5.tgz",
  integrity:"sha512-gHwA1O9LDIcKunMKhObS/HimwtehO1nPUECKAu5TpKgaO19fcWEl4bliWe1jWxVFvIXztJjjQ4L8XQ1EU9f7Jw==",
  funding:[
    {type:"github",url:"https://github.com/sponsors/fastify"},
    {type:"opencollective",url:"https://opencollective.com/fastify"},
  ],
  license:"BSD-3-Clause",
});
const APPROVED_FAST_URI=Object.freeze({
  version:"3.1.7",
  resolved:"https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.7.tgz",
  integrity:"sha512-dOvZVzjdZdz7phd9v6jCbwxrBW3fK6n8Rc0CtdmM4bumzMnxywBYhuph6J819RRw/ku+rLbelwfMunktuzVVHg==",
  funding:[
    {type:"github",url:"https://github.com/sponsors/fastify"},
    {type:"opencollective",url:"https://opencollective.com/fastify"},
  ],
  license:"BSD-3-Clause",
});

function hasExactBin(value,expected) {
  const keys=Object.keys(expected);
  return value!==null && typeof value==="object" && !Array.isArray(value) &&
    Object.keys(value).length===keys.length &&
    keys.every(key => value[key]===expected[key]);
}

function hasExactRecord(value,expected) {
  return isDeepStrictEqual(value,expected);
}

function normalizedReleaseVersionLock(value,{normalizeHistoricalFastUri=false}={}) {
  const normalized=structuredClone(value);
  normalized.version="<release-version>";
  normalized.packages[""].version="<release-version>";
  // The v2.1.1 capture predates the approved second executable. Normalize
  // only that exact historical root metadata, never arbitrary bin drift.
  if (hasExactBin(normalized.packages[""].bin,HISTORICAL_ROOT_BIN)) {
    normalized.packages[""].bin=structuredClone(CORE_DUAL_BIN);
  }
  // The sole dependency normalization is the reviewed security repair. Any
  // field-level drift prevents an exact match and remains visible to the diff.
  if (normalizeHistoricalFastUri &&
    hasExactRecord(normalized.packages[FAST_URI_PATH],HISTORICAL_FAST_URI)) {
    normalized.packages[FAST_URI_PATH]=structuredClone(APPROVED_FAST_URI);
  }
  return normalized;
}

function normalizedHistoricalReleaseVersionLock(value) {
  return normalizedReleaseVersionLock(value,{normalizeHistoricalFastUri:true});
}

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
  assert.equal(
    candidate.identity.lock_sha256,
    createHash("sha256").update(historicalLockSource).digest("hex"),
  );
  assert.deepEqual(
    normalizedHistoricalReleaseVersionLock(historicalLock),
    normalizedReleaseVersionLock(currentLock),
  );
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

test("historical performance lock permits only approved metadata and fast-uri security updates",() => {
  assert.equal(
    createHash("sha256").update(historicalLockSource).digest("hex"),
    baseline.identity.lock_sha256,
  );
  assert.deepEqual(
    normalizedHistoricalReleaseVersionLock(historicalLock),
    normalizedReleaseVersionLock(currentLock),
  );
  assert.deepEqual(currentLock.packages[FAST_URI_PATH],APPROVED_FAST_URI);

  const fastUriReversion=structuredClone(currentLock);
  fastUriReversion.packages[FAST_URI_PATH]=structuredClone(HISTORICAL_FAST_URI);
  assert.notDeepEqual(
    normalizedHistoricalReleaseVersionLock(historicalLock),
    normalizedReleaseVersionLock(fastUriReversion),
  );

  const dependencyDrift=structuredClone(currentLock);
  dependencyDrift.packages["node_modules/ajv"].integrity="sha512-drift";
  assert.notDeepEqual(
    normalizedHistoricalReleaseVersionLock(historicalLock),
    normalizedReleaseVersionLock(dependencyDrift),
  );

  const fastUriVersionDrift=structuredClone(currentLock);
  fastUriVersionDrift.packages[FAST_URI_PATH].version="3.1.6";
  assert.notDeepEqual(
    normalizedHistoricalReleaseVersionLock(historicalLock),
    normalizedReleaseVersionLock(fastUriVersionDrift),
  );

  const fastUriIntegrityDrift=structuredClone(currentLock);
  fastUriIntegrityDrift.packages[FAST_URI_PATH].integrity="sha512-drift";
  assert.notDeepEqual(
    normalizedHistoricalReleaseVersionLock(historicalLock),
    normalizedReleaseVersionLock(fastUriIntegrityDrift),
  );

  const fastUriResolutionDrift=structuredClone(currentLock);
  fastUriResolutionDrift.packages[FAST_URI_PATH].resolved=
    "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.8.tgz";
  assert.notDeepEqual(
    normalizedHistoricalReleaseVersionLock(historicalLock),
    normalizedReleaseVersionLock(fastUriResolutionDrift),
  );

  const fastUriFundingDrift=structuredClone(currentLock);
  fastUriFundingDrift.packages[FAST_URI_PATH].funding[0].url=
    "https://example.invalid/fast-uri";
  assert.notDeepEqual(
    normalizedHistoricalReleaseVersionLock(historicalLock),
    normalizedReleaseVersionLock(fastUriFundingDrift),
  );

  const binDrift=structuredClone(currentLock);
  binDrift.packages[""].bin={toss:"bin/toss.js",forged:"bin/forged.js"};
  assert.notDeepEqual(
    normalizedHistoricalReleaseVersionLock(historicalLock),
    normalizedReleaseVersionLock(binDrift),
  );
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
