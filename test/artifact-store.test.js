import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";

import {createArtifactStore} from "../src/artifacts/store.js";

const parentFixture=JSON.parse(await readFile(
  new URL("./fixtures/artifacts/parent.json",import.meta.url),
  "utf8",
));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function draft(overrides={}) {
  return {
    ...clone(parentFixture),
    ...overrides,
    producer:{...parentFixture.producer,...overrides.producer},
    provenance:{...parentFixture.provenance,...overrides.provenance},
    parents:overrides.parents ?? clone(parentFixture.parents),
    inputs:overrides.inputs ?? clone(parentFixture.inputs),
    content:overrides.content ?? clone(parentFixture.content),
  };
}

function withoutContentHash(value) {
  const result={...value};
  delete result.content_sha256;
  return result;
}

function reference(artifact) {
  return {
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  };
}

async function createTestStore(t) {
  const root=await mkdtemp(join(tmpdir(),"toss-artifact-store-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  return {
    root,
    store:createArtifactStore({
      root,
      now:() => new Date("2026-08-17T12:00:00.000Z"),
      randomId:() => "test-temporary-id",
    }),
  };
}

function artifactPath(root,artifact) {
  return join(
    root,
    "project-management",
    "artifacts",
    artifact.document_type,
    artifact.artifact_id,
    `r${String(artifact.revision).padStart(6,"0")}-${artifact.content_sha256}.json`,
  );
}

test("append persists a content-addressed revision and is idempotent",async (t) => {
  const {root,store}=await createTestStore(t);
  const first=await store.append(draft());
  const repeated=await store.append(draft());

  assert.equal(first.revision,1);
  assert.equal(repeated.revision,1);
  assert.equal(repeated.content_sha256,
    "b2a83b35b27af47c303843834ec758c9a8dede233fa0a958a2a8e9afbf6480d6");
  assert.deepEqual(await store.list({artifact_id:"ART-PARENT-001"}),[first]);

  const stored=JSON.parse(await readFile(artifactPath(root,first),"utf8"));
  assert.equal(stored.run_id,"run-parent-001");
  assert.equal(stored.provenance.source_revision,"source-r1");
  assert.equal(stored.content_sha256,first.content_sha256);
  assert.deepEqual(await readdir(dirname(artifactPath(root,first))),[
    `r000001-${first.content_sha256}.json`,
  ]);
});

test("append rejects overwritten revisions and unresolved exact references",async (t) => {
  const {store}=await createTestStore(t);
  const first=await store.append(draft());
  const changed=withoutContentHash(draft({
    revision:first.revision,
    content:{entities:[{id:"REQ-001",kind:"requirement",meaning:"Changed"}]},
  }));
  await assert.rejects(store.append(changed),/overwrite/i);

  await assert.rejects(store.append(withoutContentHash(draft({
    artifact_id:"ART-MISSING-PARENT-001",
    parents:[{
      artifact_id:"ART-MISSING-001",
      revision:1,
      content_sha256:"f".repeat(64),
    }],
  }))),/missing parent/i);
  await assert.rejects(store.append(withoutContentHash(draft({
    document_type:"architecture",
    artifact_id:"ART-MISSING-INPUT-001",
    run_id:"run-architecture-001",
    producer:{role:"architect",identity:"toss-test"},
    inputs:[{
      artifact_id:"REQ-MISSING",
      revision:1,
      content_sha256:"e".repeat(64),
    }],
  }))),/missing input/i);

  const child=await store.append(withoutContentHash(draft({
    document_type:"architecture",
    artifact_id:"ART-ARCHITECTURE-001",
    run_id:"run-architecture-001",
    producer:{role:"architect",identity:"toss-test"},
    inputs:[reference(first)],
    content:{entities:[{id:"ARCHQ-001",kind:"question",meaning:"Choose a store"}]},
  })));
  assert.deepEqual(child.inputs,[reference(first)]);
});

test("append assigns monotonic revisions and preserves prior bytes",async (t) => {
  const {root,store}=await createTestStore(t);
  const first=await store.append(draft());
  const second=await store.append(withoutContentHash(draft({
    run_id:"run-parent-002",
    provenance:{source_revision:"source-r2"},
    parents:[reference(first)],
    content:{entities:[{id:"REQ-001",kind:"requirement",meaning:"Revised requirement"}]},
  })));

  assert.equal(second.revision,2);
  assert.equal(second.parents[0].revision,1);
  assert.equal((await store.get(reference(first))).content.entities[0].meaning,
    "Parent requirement");
  assert.equal((await store.get(reference(second))).content.entities[0].meaning,
    "Revised requirement");
  assert.equal((await stat(artifactPath(root,first))).isFile(),true);
  assert.equal((await stat(artifactPath(root,second))).isFile(),true);
});

test("a changed revision requires an exact parent reference to its predecessor",async (t) => {
  const {store}=await createTestStore(t);
  await store.append(draft());

  await assert.rejects(store.append(withoutContentHash(draft({
    run_id:"run-parent-without-parent",
    content:{entities:[{id:"REQ-001",kind:"requirement",meaning:"Unlinked revision"}]},
  }))),/parent.*previous revision/i);
});

test("append rejects an artifact ID reused for another document type",async (t) => {
  const {store}=await createTestStore(t);
  const first=await store.append(draft());

  await assert.rejects(store.append(withoutContentHash(draft({
    document_type:"architecture",
    artifact_id:first.artifact_id,
    run_id:"run-architecture-duplicate",
    producer:{role:"architect",identity:"toss-test"},
    content:{entities:[{id:"ARCHQ-001",kind:"question",meaning:"Duplicate identity"}]},
  }))),/artifact_id.*document type/i);
});

test("verification fails closed for a mismatched reference and corrupted bytes",async (t) => {
  const {root,store}=await createTestStore(t);
  const first=await store.append(draft());

  await assert.rejects(store.get({...reference(first),content_sha256:"0".repeat(64)}),
    /content hash mismatch/i);

  const path=artifactPath(root,first);
  const corrupted=JSON.parse(await readFile(path,"utf8"));
  corrupted.content.entities[0].meaning="Silently changed";
  await writeFile(path,JSON.stringify(corrupted),"utf8");
  await assert.rejects(store.verify(reference(first)),/content hash mismatch/i);
  await assert.rejects(store.list(),/content hash mismatch/i);
});

test("recovery removes interrupted same-directory temporary files from discovery",async (t) => {
  const {root,store}=await createTestStore(t);
  const first=await store.append(draft());
  const finalPath=artifactPath(root,first);
  const temporaryPath=`${finalPath}.tmp-interrupted`;
  await writeFile(temporaryPath,"half-written","utf8");

  assert.deepEqual(await store.list({artifact_id:first.artifact_id}),[first]);
  const recovery=await store.recover();
  assert.deepEqual(recovery.removed,[temporaryPath]);
  await assert.rejects(stat(temporaryPath));
  assert.deepEqual(await store.list({artifact_id:first.artifact_id}),[first]);
});
