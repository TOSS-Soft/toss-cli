import assert from "node:assert/strict";
import {readFile,stat} from "node:fs/promises";
import test from "node:test";

import {canonicalJson} from "../src/contracts/acp.js";
import * as commandFixture from "./support/command-fixture.js";

const inventoryUrl=new URL("../scripts/test-boundaries.json",import.meta.url);
const manifestUrl=new URL("../scripts/test-manifest.json",import.meta.url);

function copy(value) {
  return structuredClone(value);
}

function reference(artifact) {
  return {
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  };
}

function nextRevision(first) {
  const next=copy(first);
  next.run_id="run-command-store-revision-002";
  next.parents=[reference(first)];
  delete next.revision;
  delete next.content_sha256;
  return next;
}

async function errorCategory(operation) {
  try {
    await operation();
  } catch (error) {
    if (/overwrite|reinterpret/i.test(error.message)) return "immutable-overwrite";
    if (/missing|not found/i.test(error.message)) return "missing-reference";
    throw error;
  }
  assert.fail("expected operation to reject");
}

async function parity(operation) {
  const [memory,real]=await Promise.all([operation.memory,operation.real]);
  assert.equal(canonicalJson(memory),canonicalJson(real));
  return {memory,real};
}

test("command-store fixture export provides isolated roots and idempotent cleanup",async t => {
  assert.equal(typeof commandFixture.commandStoreFixture,"function");
  const left=await commandFixture.commandStoreFixture(t,{prefix:"toss-command-left-"});
  const right=await commandFixture.commandStoreFixture(t,{prefix:"toss-command-right-"});
  assert.equal(Object.isFrozen(left),true);
  assert.notEqual(left.root,right.root);
  const draft=commandFixture.projectCommandInput().artifacts.pm_analysis;
  await Promise.all([left.store.append(draft),right.store.append(draft)]);
  assert.equal((await left.store.list()).length,1);
  assert.equal((await right.store.list()).length,1);
  await left.cleanup();
  await left.cleanup();
  await assert.rejects(stat(left.root),error => error?.code==="ENOENT");
  assert.equal((await right.store.list()).length,1);
  await right.cleanup();
});

test("command-store fixture cleanup retains an injected failure as primary",async t => {
  const fixture=await commandFixture.commandStoreFixture(t);
  await fixture.store.append(commandFixture.projectCommandInput().artifacts.pm_analysis);
  const primary=new Error("injected operation failure");
  let observed;
  try {
    throw primary;
  } catch (error) {
    observed=error;
  } finally {
    await fixture.cleanup();
  }
  assert.equal(observed,primary);
  await assert.rejects(stat(fixture.root),error => error?.code==="ENOENT");
});

test("parallel command-store fixtures cannot cross-read identical artifacts",async t => {
  const fixtures=await Promise.all([
    commandFixture.commandStoreFixture(t,{prefix:"toss-command-parallel-a-"}),
    commandFixture.commandStoreFixture(t,{prefix:"toss-command-parallel-b-"}),
    commandFixture.commandStoreFixture(t,{prefix:"toss-command-parallel-c-"}),
  ]);
  const drafts=fixtures.map((_,index) => {
    const draft=copy(commandFixture.projectCommandInput().artifacts.pm_analysis);
    draft.run_id=`run-command-store-parallel-${index}`;
    draft.content.summary=`isolated command-store content ${index}`;
    delete draft.content_sha256;
    return draft;
  });
  const appended=await Promise.all(fixtures.map((fixture,index) =>
    fixture.store.append(drafts[index])));
  await Promise.all(fixtures.map(async (fixture,index) => {
    assert.deepEqual(await fixture.store.get(reference(appended[index])),appended[index]);
    const foreign=appended[(index+1)%appended.length];
    await assert.rejects(fixture.store.get(reference(foreign)),/not found|hash mismatch/i);
  }));
});

test("memory command store matches real command-store semantic behavior",async t => {
  const memory=commandFixture.memoryCommandStore();
  const real=await commandFixture.commandStore(t);
  assert.equal(Object.isFrozen(memory),true);
  const firstDraft=commandFixture.projectCommandInput().artifacts.pm_analysis;
  const first=await parity({
    memory:memory.append(copy(firstDraft)),
    real:real.append(copy(firstDraft)),
  });
  await parity({
    memory:memory.append(copy(firstDraft)),
    real:real.append(copy(firstDraft)),
  });
  await parity({
    memory:memory.get(reference(first.memory)),
    real:real.get(reference(first.real)),
  });
  await parity({
    memory:memory.verify(reference(first.memory)),
    real:real.verify(reference(first.real)),
  });
  await parity({
    memory:memory.list({document_type:first.memory.document_type}),
    real:real.list({document_type:first.real.document_type}),
  });

  const second=await parity({
    memory:memory.append(nextRevision(first.memory)),
    real:real.append(nextRevision(first.real)),
  });
  assert.equal(second.memory.revision,2);
  assert.deepEqual(second.memory.parents,[reference(first.memory)]);

  const overwritten=copy(first.memory);
  overwritten.run_id="run-command-store-overwrite";
  delete overwritten.content_sha256;
  assert.equal(await errorCategory(() => memory.append(copy(overwritten))),
    await errorCategory(() => real.append(copy(overwritten))));

  const missing=copy(firstDraft);
  missing.artifact_id="ART-MISSING-COMMAND-REFERENCE";
  missing.run_id="run-command-store-missing-reference";
  missing.parents=[{
    artifact_id:"ART-UNKNOWN-COMMAND-REFERENCE",
    revision:1,
    content_sha256:"f".repeat(64),
  }];
  delete missing.content_sha256;
  assert.equal(await errorCategory(() => memory.append(copy(missing))),
    await errorCategory(() => real.append(copy(missing))));

  const leaked=await memory.get(reference(first.memory));
  leaked.content.summary="mutated response";
  assert.notEqual((await memory.get(reference(first.memory))).content.summary,"mutated response");
  const listed=await memory.list();
  listed[0].content.summary="mutated list response";
  assert.notEqual((await memory.get(reference(first.memory))).content.summary,
    "mutated list response");
});

test("command-store fixture prefix is constrained to the safe toss-command grammar",async t => {
  await assert.rejects(
    commandFixture.commandStoreFixture(t,{prefix:"toss-command-unsafe_"}),
    /safe toss-command prefix/i,
  );
});

test("checked-in manifest and boundary inventory own command-store fixture behavior",async () => {
  const [manifest,inventory]=await Promise.all([
    readFile(manifestUrl,"utf8").then(JSON.parse),
    readFile(inventoryUrl,"utf8").then(JSON.parse),
  ]);
  assert.equal(manifest.lanes.integration.includes("test/command-store-fixture.test.js"),true);
  assert.deepEqual(inventory.guarantees.find(row =>
    row.id==="artifact.concurrent-writer-lock"),{
    id:"artifact.concurrent-writer-lock",
    classification:"durability-atomicity",
    owner:"test/artifact-store.test.js",
  });
  assert.deepEqual(inventory.guarantees.find(row =>
    row.id==="store.fixture-root-isolation"),{
    id:"store.fixture-root-isolation",
    classification:"store-integration",
    owner:"test/command-store-fixture.test.js",
  });
  assert.deepEqual(inventory.semantic_delegations.find(row =>
    row.entry==="test/command-store-fixture.test.js"),{
    entry:"test/command-store-fixture.test.js",
    guarantees:[
      "artifact.atomic-append",
      "artifact.exact-reference-verification",
      "artifact.immutable-revision-bytes",
      "artifact.monotonic-parent-lineage",
    ],
  });
});
