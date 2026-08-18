import assert from "node:assert/strict";
import test from "node:test";

import {
  appendVerified,
  createVerifiedArtifactCatalog,
  exactReference,
  listedArtifacts,
  verifiedExact,
} from "../src/pipeline/project-input.js";
import {clone,rehash} from "./support/trace-fixture.js";
import {projectCommandInput} from "./support/command-fixture.js";

function pmArtifact() {
  return clone(projectCommandInput().artifacts.pm_analysis);
}

test("verifiedExact rejects a store that retargets its reference argument",async () => {
  const first=pmArtifact();
  const second=clone(first);
  second.revision=2;
  const store={
    async get(reference) {
      reference.revision=2;
      return clone(second);
    },
    async verify() {
      return clone(second);
    },
  };

  await assert.rejects(
    verifiedExact(store,exactReference(first)),
    error => error?.code==="REFERENCE_RETARGET",
  );
});

test("appendVerified rejects draft mutation and a forged same-reference return",async () => {
  const draft=pmArtifact();
  let appended;
  const store={
    async append(candidate) {
      candidate.producer.identity="mutated-by-store";
      appended=clone(candidate);
      return clone(appended);
    },
    async verify() {
      return clone(appended);
    },
    async get() {
      return clone(appended);
    },
  };

  await assert.rejects(
    appendVerified(store,draft,"pm-analysis.v1"),
    error => error?.code==="APPEND_MUTATION",
  );
});

test("verified catalog rejects a conflicting revision identity before store append",async () => {
  const first=pmArtifact();
  const conflicting=clone(first);
  conflicting.content.summary=`${conflicting.content.summary} Conflicting.`;
  rehash(conflicting);
  let appendCalls=0;
  let appended=null;
  const select=reference => reference.content_sha256===conflicting.content_sha256 ?
    appended : first;
  const catalog=createVerifiedArtifactCatalog({
    async append(candidate) {
      appendCalls+=1;
      appended=clone(candidate);
      return clone(appended);
    },
    async list() { return [clone(first)]; },
    async get(reference) { return clone(select(reference)); },
    async verify(reference) { return clone(select(reference)); },
  });
  await catalog.refresh();

  await assert.rejects(
    catalog.append(conflicting),
    error => error?.code==="DUPLICATE_REVISION_IDENTITY",
  );
  assert.equal(appendCalls,0);
});

test("catalog final refresh detects full-row drift without repeating exact reads",async () => {
  const first=pmArtifact();
  const drifted=clone(first);
  drifted.producer.identity="externally-drifted-envelope";
  const calls={get:0,list:0,verify:0};
  const catalog=createVerifiedArtifactCatalog({
    async append() { throw new Error("unexpected append"); },
    async list() {
      calls.list+=1;
      return [clone(calls.list===1 ? first : drifted)];
    },
    async get() {
      calls.get+=1;
      return clone(first);
    },
    async verify() {
      calls.verify+=1;
      return clone(first);
    },
  });
  await catalog.refresh();

  await assert.rejects(
    catalog.refresh(),
    error => error?.code==="UNEXPECTED_ARTIFACT_CHANGE",
  );
  assert.deepEqual(calls,{get:1,list:2,verify:1});
});

test("listedArtifacts rejects conflicting hashes for one revision identity",async () => {
  const first=pmArtifact();
  const conflicting=clone(first);
  conflicting.content.summary=`${conflicting.content.summary} Conflicting.`;
  rehash(conflicting);
  const rows=[first,conflicting];
  const store={
    async list() {
      return clone(rows);
    },
    async get(reference) {
      return clone(rows.find(row => row.content_sha256===reference.content_sha256));
    },
    async verify(reference) {
      return this.get(reference);
    },
  };

  await assert.rejects(
    listedArtifacts(store,{document_type:"pm-analysis"}),
    error => error?.code==="DUPLICATE_REVISION_IDENTITY",
  );
});

test("listedArtifacts rejects rows outside the requested filter",async () => {
  const unexpected=pmArtifact();
  const store={
    async list() {
      return [clone(unexpected)];
    },
    async get() {
      return clone(unexpected);
    },
    async verify() {
      return clone(unexpected);
    },
  };

  await assert.rejects(
    listedArtifacts(store,{document_type:"project-input"}),
    error => error?.code==="FILTER_VIOLATION",
  );
});

test("verifiedExact rejects get/verify TOCTOU disagreement",async () => {
  const got=pmArtifact();
  const verified=clone(got);
  verified.producer.identity="retargeted-envelope";
  const store={
    async get() { return clone(got); },
    async verify() { return clone(verified); },
  };
  await assert.rejects(
    verifiedExact(store,exactReference(got)),
    error => error?.code==="REFERENCE_RETARGET",
  );
});

test("store accessors and list-filter mutation are rejected without invoking accessors",async () => {
  const artifact=pmArtifact();
  let getterReads=0;
  const exotic=clone(artifact);
  Object.defineProperty(exotic,"content",{
    enumerable:true,
    get() {
      getterReads+=1;
      return artifact.content;
    },
  });
  await assert.rejects(
    verifiedExact({
      async get() { return exotic; },
      async verify() { return clone(artifact); },
    },exactReference(artifact)),
    /canonical|retarget/i,
  );
  assert.equal(getterReads,0);

  await assert.rejects(
    listedArtifacts({
      async list(filter) {
        filter.document_type="project-input";
        return [];
      },
      async get() { return clone(artifact); },
      async verify() { return clone(artifact); },
    },{document_type:"pm-analysis"}),
    error => error?.code==="FILTER_VIOLATION",
  );
});

test("listedArtifacts rejects malformed and noncontiguous discovery returns",async () => {
  await assert.rejects(
    listedArtifacts({async list() { return {}; }},{}),
    /array/,
  );
  const second=pmArtifact();
  second.revision=2;
  const store={
    async list() { return [clone(second)]; },
    async get() { return clone(second); },
    async verify() { return clone(second); },
  };
  await assert.rejects(
    listedArtifacts(store,{document_type:"pm-analysis"}),
    error => error?.code==="AMBIGUOUS_ARTIFACT_HISTORY",
  );
});
