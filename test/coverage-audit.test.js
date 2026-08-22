import assert from "node:assert/strict";
import {execFile as execFileCallback} from "node:child_process";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {
  COVERAGE_AUDIT_VERSION,
  discoverLegacyTestEntries,
  validateCoverageAudit,
} from "../scripts/coverage-audit.mjs";

const root=fileURLToPath(new URL("..",import.meta.url));
const auditUrl=new URL("../docs/testing/v2.1.1-coverage-audit.json",import.meta.url);
const auditModuleUrl=new URL("../scripts/coverage-audit.mjs",import.meta.url);
const execFile=promisify(execFileCallback);

const legacyEntries=Object.freeze([
  "scripts/a-test.js",
  "test/example.test.js",
]);

function manifestFixture() {
  return Object.freeze({
    schema_version:"toss-test-manifest.v1",
    concurrency:1,
    lanes:Object.freeze({
      fast:Object.freeze(["test/example.test.js"]),
      integration:Object.freeze([]),
      e2e:Object.freeze(["scripts/a-test.js"]),
      package:Object.freeze([]),
      release:Object.freeze([]),
    }),
  });
}

function boundariesFixture() {
  return Object.freeze({
    schema_version:"toss-test-boundaries.v1",
    guarantees:Object.freeze([
      Object.freeze({
        id:"release.example-preserved",
        classification:"release",
        owner:"test/example.test.js",
      }),
    ]),
    semantic_delegations:Object.freeze([]),
  });
}

function fixture() {
  return {
    schema_version:"toss-coverage-audit.v1",
    source:{
      tag:"v2.1.0",
      commit:"4472175eac91275cafab2993f68722febdb9eb59",
    },
    entries:[
      {
        legacy_entry:"scripts/a-test.js",
        final_owner:"scripts/a-test.js",
        final_lane:"e2e",
        disposition:"unchanged",
        retained_evidence:[],
      },
      {
        legacy_entry:"test/example.test.js",
        final_owner:"test/example.test.js",
        final_lane:"fast",
        disposition:"unchanged",
        retained_evidence:[],
      },
    ],
  };
}

function validate(value) {
  return validateCoverageAudit(value,{
    legacyEntries,
    manifest:manifestFixture(),
    boundaries:boundariesFixture(),
  });
}

test("coverage audit constants and normalization close the v2.1.0 source schema",() => {
  const value=fixture();
  const normalized=validate(value);
  assert.equal(COVERAGE_AUDIT_VERSION,"toss-coverage-audit.v1");
  assert.deepEqual(normalized,value);
  assert.equal(Object.isFrozen(normalized),true);
  assert.equal(Object.isFrozen(normalized.source),true);
  assert.equal(Object.isFrozen(normalized.entries),true);
  assert.equal(Object.isFrozen(normalized.entries[0]),true);
  assert.equal(Object.isFrozen(normalized.entries[0].retained_evidence),true);
  value.entries[0].final_lane="fast";
  assert.equal(normalized.entries[0].final_lane,"e2e");
});

for (const example of [
  {
    name:"an unknown root field",
    mutate:value => { value.extra=true; },
    expected:/unknown coverage audit field.*extra/i,
  },
  {
    name:"a missing root field",
    mutate:value => { delete value.entries; },
    expected:/missing coverage audit field.*entries/i,
  },
  {
    name:"an unknown source field",
    mutate:value => { value.source.extra=true; },
    expected:/unknown coverage source field.*extra/i,
  },
  {
    name:"a missing row field",
    mutate:value => { delete value.entries[0].final_lane; },
    expected:/missing coverage audit entry field.*final_lane/i,
  },
  {
    name:"a non-enumerable field",
    mutate:value => Object.defineProperty(value.entries[0],"hidden",{value:true}),
    expected:/own enumerable data properties/i,
  },
  {
    name:"a sparse entry array",
    mutate:value => { value.entries=new Array(2); value.entries[0]=fixture().entries[0]; },
    expected:/dense JSON array/i,
  },
  {
    name:"unsafe paths",
    mutate:value => { value.entries[0].legacy_entry="../test/escape.test.js"; },
    expected:/unsafe coverage audit entry/i,
  },
  {
    name:"the wrong tag",
    mutate:value => { value.source.tag="v2.0.0"; },
    expected:/locked coverage audit source tag/i,
  },
  {
    name:"the wrong commit",
    mutate:value => { value.source.commit="0".repeat(40); },
    expected:/locked coverage audit source commit/i,
  },
  {
    name:"duplicate legacy entries",
    mutate:value => { value.entries[1].legacy_entry="scripts/a-test.js"; },
    expected:/duplicate legacy audit entry/i,
  },
  {
    name:"unsorted legacy entries",
    mutate:value => { value.entries.reverse(); },
    expected:/stable ASCII order/i,
  },
  {
    name:"an unknown final owner",
    mutate:value => { value.entries[0].final_owner="test/missing.test.js"; },
    expected:/unknown final manifest owner/i,
  },
  {
    name:"a manifest-derived lane mismatch",
    mutate:value => { value.entries[0].final_lane="fast"; },
    expected:/does not match manifest lane/i,
  },
  {
    name:"an unknown disposition",
    mutate:value => { value.entries[0].disposition="deleted"; },
    expected:/unknown coverage audit disposition/i,
  },
  {
    name:"empty evidence for a moved row",
    mutate:value => { value.entries[0].disposition="moved"; },
    expected:/retained evidence/i,
  },
  {
    name:"empty evidence for a coalesced row",
    mutate:value => { value.entries[0].disposition="coalesced"; },
    expected:/retained evidence/i,
  },
  {
    name:"empty evidence for a replaced row",
    mutate:value => { value.entries[0].disposition="replaced"; },
    expected:/retained evidence/i,
  },
]) {
  test(`coverage audit validation rejects ${example.name}`,() => {
    const value=fixture();
    example.mutate(value);
    assert.throws(() => validate(value),example.expected);
  });
}

test("coverage audit validates retained evidence as a stable dense string array",() => {
  const sparse=fixture();
  sparse.entries[0].disposition="moved";
  sparse.entries[0].retained_evidence=new Array(1);
  assert.throws(() => validate(sparse),/dense JSON array/i);

  const unordered=fixture();
  unordered.entries[0].disposition="moved";
  unordered.entries[0].retained_evidence=["z evidence","a evidence"];
  assert.throws(() => validate(unordered),/stable ASCII order/i);
});

test("coverage audit keeps unchanged owners and changed evidence independent",() => {
  const changedOwner=fixture();
  changedOwner.entries[0].final_owner="test/example.test.js";
  changedOwner.entries[0].final_lane="fast";
  assert.throws(() => validate(changedOwner),/unchanged.*executable owner/i);

  const ownEvidence=fixture();
  ownEvidence.entries[0].disposition="replaced";
  ownEvidence.entries[0].legacy_entry="scripts/legacy-test.js";
  ownEvidence.entries[0].final_owner="test/example.test.js";
  ownEvidence.entries[0].final_lane="fast";
  ownEvidence.entries[0].retained_evidence=["test/example.test.js"];
  assert.throws(() => validate(ownEvidence),/own executable assertion/i);
});

test("coverage audit requires unchanged when the legacy executable remains manifest-owned",() => {
  const value=fixture();
  value.entries[0]={
    legacy_entry:"scripts/a-test.js",
    final_owner:"test/example.test.js",
    final_lane:"fast",
    disposition:"moved",
    retained_evidence:["release.example-preserved"],
  };
  assert.throws(
    () => validate(value),
    /surviving legacy entry must remain unchanged.*scripts\/a-test\.js/i,
  );
});

test("coverage audit permits only real manifest targets or boundary guarantees as changed evidence",() => {
  const changed={
    schema_version:"toss-coverage-audit.v1",
    source:{
      tag:"v2.1.0",
      commit:"4472175eac91275cafab2993f68722febdb9eb59",
    },
    entries:[{
      legacy_entry:"scripts/legacy-test.js",
      final_owner:"test/example.test.js",
      final_lane:"fast",
      disposition:"replaced",
      retained_evidence:["fabricated preservation claim"],
    }],
  };
  const inputs={
    legacyEntries:["scripts/legacy-test.js"],
    manifest:manifestFixture(),
    boundaries:boundariesFixture(),
  };
  assert.throws(
    () => validateCoverageAudit(changed,inputs),
    /unknown retained evidence target.*fabricated preservation claim/i,
  );

  changed.entries[0].retained_evidence=["release.example-preserved"];
  assert.equal(validateCoverageAudit(changed,inputs).entries[0].disposition,"replaced");

  changed.entries[0].retained_evidence=["scripts/a-test.js"];
  assert.equal(validateCoverageAudit(changed,inputs).entries[0].disposition,"replaced");
});

test("legacy discovery locks the annotated v2.1.0 tree without changing HEAD",async () => {
  const before=(await execFile("git",["rev-parse","HEAD"],{cwd:root})).stdout;
  const entries=await discoverLegacyTestEntries({repoRoot:root,tag:"v2.1.0"});
  const after=(await execFile("git",["rev-parse","HEAD"],{cwd:root})).stdout;
  assert.equal(before,after);
  assert.equal(Object.isFrozen(entries),true);
  assert.deepEqual(entries,[...entries].sort());
  assert.equal(entries.length,42);
  assert.equal(entries[0],"scripts/create-atomicity-test.js");
  assert.equal(entries.at(-1),"test/traceability.test.js");
  await assert.rejects(
    () => discoverLegacyTestEntries({repoRoot:root,tag:"HEAD"}),
    /locked coverage audit source tag/i,
  );
});

test("the checked-in coverage audit and CLI preserve the complete legacy inventory",async () => {
  const audit=JSON.parse(await readFile(auditUrl,"utf8"));
  const entries=await discoverLegacyTestEntries({repoRoot:root,tag:"v2.1.0"});
  assert.equal(audit.entries.length,entries.length);
  const {stdout,stderr}=await execFile(process.execPath,[auditModuleUrl.pathname],{cwd:root});
  assert.equal(stdout,"Coverage audit integrity: PASS\n");
  assert.equal(stderr,"");
});
