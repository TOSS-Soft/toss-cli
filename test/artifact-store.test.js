import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join} from "node:path";
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
    encodeURIComponent(artifact.artifact_id),
    `r${String(artifact.revision).padStart(6,"0")}-${artifact.content_sha256}.json`,
  );
}

function artifactRoot(root) {
  return join(root,"project-management","artifacts");
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

test("concurrent same-root appends retain one immutable revision without live lock or temporary",async t => {
  const {root,store}=await createTestStore(t);
  const [left,right]=await Promise.all([store.append(draft()),store.append(draft())]);
  assert.deepEqual(left,right);
  assert.equal(left.revision,1);
  assert.deepEqual(await store.list({artifact_id:left.artifact_id}),[left]);
  const rootEntries=await readdir(artifactRoot(root));
  assert.equal(rootEntries.includes(".append.lock"),false);
  const revisionEntries=await readdir(dirname(artifactPath(root,left)));
  assert.deepEqual(revisionEntries,[`r000001-${left.content_sha256}.json`]);
});

test("contract-valid colon artifact IDs use a reversible filesystem-safe identity",async (t) => {
  const {root,store}=await createTestStore(t);
  const appended=await store.append(draft({
    artifact_id:"spec-audit:ISSUE-PLAN-001",
    run_id:"run-colon-artifact-001",
  }));
  const exact=reference(appended);

  assert.equal((await store.get(exact)).artifact_id,"spec-audit:ISSUE-PLAN-001");
  assert.equal((await store.verify(exact)).artifact_id,"spec-audit:ISSUE-PLAN-001");
  assert.deepEqual(await store.list({artifact_id:"spec-audit:ISSUE-PLAN-001"}),[
    appended,
  ]);
  assert.deepEqual(await store.recover(),{removed:[]});
  const typePath=join(artifactRoot(root),appended.document_type);
  assert.deepEqual(await readdir(typePath),["spec-audit%3AISSUE-PLAN-001"]);
  assert.equal((await stat(artifactPath(root,appended))).isFile(),true);
  await assert.rejects(stat(join(typePath,appended.artifact_id)));
});

test("encoded artifact directories cannot collide with public IDs or noncanonical encodings",async (t) => {
  const {root,store}=await createTestStore(t);
  const appended=await store.append(draft({
    artifact_id:"spec-audit:ISSUE-PLAN-001",
    run_id:"run-colon-collision-001",
  }));
  await assert.rejects(store.append(draft({
    artifact_id:"spec-audit%3AISSUE-PLAN-001",
    run_id:"run-encoded-collision-001",
  })),/artifact_id must match/i);

  const typePath=join(artifactRoot(root),appended.document_type);
  await rename(
    join(typePath,"spec-audit%3AISSUE-PLAN-001"),
    join(typePath,"spec-audit%3aISSUE-PLAN-001"),
  );
  await assert.rejects(store.list(),/noncanonical|artifact directory|unexpected/i);
});

test("legacy raw-colon directories remain readable and migrate before a new revision",async (t) => {
  const {root,store}=await createTestStore(t);
  const first=await store.append(draft({
    artifact_id:"spec-audit:ISSUE-PLAN-001",
    run_id:"run-legacy-colon-001",
  }));
  const encodedDirectory=dirname(artifactPath(root,first));
  const rawDirectory=join(dirname(encodedDirectory),first.artifact_id);
  await rename(encodedDirectory,rawDirectory);

  assert.deepEqual(await store.get(reference(first)),first);
  assert.deepEqual(await store.verify(reference(first)),first);
  assert.deepEqual(await store.list({artifact_id:first.artifact_id}),[first]);
  assert.deepEqual(await store.recover(),{removed:[]});

  const second=await store.append(withoutContentHash(draft({
    artifact_id:first.artifact_id,
    run_id:"run-legacy-colon-002",
    parents:[reference(first)],
    content:{entities:[{
      id:"REQ-001",
      kind:"requirement",
      meaning:"Legacy identity migrated safely",
    }]},
  })));
  assert.equal(second.revision,2);
  assert.deepEqual(await store.get(reference(first)),first);
  assert.deepEqual(await store.verify(reference(second)),second);
  assert.deepEqual(await store.list({artifact_id:first.artifact_id}),[first,second]);
  assert.equal((await stat(artifactPath(root,first))).isFile(),true);
  assert.equal((await stat(artifactPath(root,second))).isFile(),true);
  await assert.rejects(stat(rawDirectory));
});

test("raw and encoded directories for one public ID are rejected as ambiguous",async (t) => {
  const {root,store}=await createTestStore(t);
  const appended=await store.append(draft({
    artifact_id:"spec-audit:ISSUE-PLAN-001",
    run_id:"run-colon-ambiguity-001",
  }));
  const encodedFile=artifactPath(root,appended);
  const rawDirectory=join(dirname(dirname(encodedFile)),appended.artifact_id);
  await mkdir(rawDirectory);
  await copyFile(encodedFile,join(rawDirectory,basename(encodedFile)));

  await assert.rejects(store.list(),/ambiguous|collision|multiple directories/i);
  await assert.rejects(store.get(reference(appended)),/ambiguous|collision|multiple directories/i);
  await assert.rejects(store.recover(),/ambiguous|collision|multiple directories/i);
});

test("legacy discovery still rejects unsafe or encoded public identities",async (t) => {
  const {root,store}=await createTestStore(t);
  const typePath=join(artifactRoot(root),"pm-analysis");
  await mkdir(join(typePath,"unsafe%2Fidentity"),{recursive:true});

  await assert.rejects(
    store.list(),
    /artifact directory|canonical encoded identity|reversible encoded identity/i,
  );
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
  const temporaryPath=join(
    dirname(finalPath),
    `.${basename(finalPath)}.tmp-2147483647-stale-owner-0`,
  );
  await writeFile(temporaryPath,"half-written","utf8");

  assert.deepEqual(await store.list({artifact_id:first.artifact_id}),[first]);
  const recovery=await store.recover();
  assert.deepEqual(recovery.removed,[temporaryPath]);
  await assert.rejects(stat(temporaryPath));
  assert.deepEqual(await store.list({artifact_id:first.artifact_id}),[first]);
});

test("recovery does not remove temporary files owned by a live append lock",async (t) => {
  const {root,store}=await createTestStore(t);
  const first=await store.append(draft());
  const rootPath=artifactRoot(root);
  const lockPath=join(rootPath,".append.lock");
  const finalPath=artifactPath(root,first);
  const temporaryPath=join(
    dirname(finalPath),
    `.${basename(finalPath)}.tmp-${process.pid}-live-owner-0`,
  );
  await writeFile(lockPath,JSON.stringify({
    owner:"live-owner",
    pid:process.pid,
    created_at:"2026-08-17T12:00:00.000Z",
  }),"utf8");
  await writeFile(temporaryPath,"in-progress","utf8");

  await store.recover();

  assert.equal((await stat(lockPath)).isFile(),true);
  assert.equal((await stat(temporaryPath)).isFile(),true);
});

test("append rejects a symbolic-link root without modifying the external target",async (t) => {
  const parent=await mkdtemp(join(tmpdir(),"toss-artifact-root-parent-"));
  const outside=await mkdtemp(join(tmpdir(),"toss-artifact-root-outside-"));
  t.after(() => rm(parent,{recursive:true,force:true}));
  t.after(() => rm(outside,{recursive:true,force:true}));
  const root=join(parent,"linked-root");
  await symlink(outside,root);
  const store=createArtifactStore({root});

  await assert.rejects(store.append(draft()),/root.*symbolic link/i);
  assert.deepEqual(await readdir(outside),[]);
});

test("append rejects a symlinked artifact path before it escapes the store root",async (t) => {
  const {root,store}=await createTestStore(t);
  const outside=await mkdtemp(join(tmpdir(),"toss-artifact-outside-"));
  t.after(() => rm(outside,{recursive:true,force:true}));
  const typePath=join(artifactRoot(root),"pm-analysis");
  await mkdir(dirname(typePath),{recursive:true});
  await symlink(outside,typePath);

  await assert.rejects(store.append(draft()),/symbolic link|escape/i);
  assert.deepEqual(await readdir(outside),[]);
});

test("idempotent content still validates references and versions changed metadata",async (t) => {
  const {store}=await createTestStore(t);
  const first=await store.append(draft());
  await assert.rejects(store.append(withoutContentHash(draft({
    inputs:[{
      artifact_id:"ART-MISSING-IDEMPOTENCY-001",
      revision:1,
      content_sha256:"d".repeat(64),
    }],
  }))),/missing input/i);

  const second=await store.append(withoutContentHash(draft({
    run_id:"run-parent-metadata-revision",
    parents:[reference(first)],
  })));
  assert.equal(second.revision,2);
  assert.equal(second.run_id,"run-parent-metadata-revision");
  await assert.rejects(store.append(draft({
    revision:first.revision,
    run_id:"run-parent-reinterpreted",
  })),/reinterpret|overwrite/i);
});

test("first revisions and on-disk later revisions enforce immutable lineage",async (t) => {
  const {root,store}=await createTestStore(t);
  const upstream=await store.append(draft({artifact_id:"ART-UPSTREAM-001"}));
  await assert.rejects(store.append(withoutContentHash(draft({
    artifact_id:"ART-FIRST-WITH-PARENT-001",
    parents:[reference(upstream)],
  }))),/revision 1.*parents/i);

  const first=await store.append(draft({artifact_id:"ART-LINEAGE-001"}));
  const second=await store.append(withoutContentHash(draft({
    artifact_id:"ART-LINEAGE-001",
    run_id:"run-lineage-002",
    parents:[reference(first)],
    content:{entities:[{id:"REQ-001",kind:"requirement",meaning:"Lineage revision"}]},
  })));
  const stored=JSON.parse(await readFile(artifactPath(root,second),"utf8"));
  stored.parents=[];
  await writeFile(artifactPath(root,second),JSON.stringify(stored),"utf8");

  await assert.rejects(store.get(reference(second)),/parent.*previous revision/i);
  await assert.rejects(store.list({artifact_id:second.artifact_id}),
    /parent.*previous revision/i);
});

test("later revisions require exactly one immediate-predecessor parent",async (t) => {
  const {root,store}=await createTestStore(t);
  const unrelated=await store.append(draft({artifact_id:"ART-UNRELATED-PARENT-001"}));
  const first=await store.append(draft({artifact_id:"ART-EXACT-PARENT-001"}));
  const nextDraft=withoutContentHash(draft({
    artifact_id:first.artifact_id,
    run_id:"run-exact-parent-002",
    parents:[reference(first),reference(unrelated)],
    content:{entities:[{id:"REQ-001",kind:"requirement",meaning:"Exact parent revision"}]},
  }));
  await assert.rejects(store.append(nextDraft),/exactly one parent/i);

  const second=await store.append(withoutContentHash(draft({
    artifact_id:first.artifact_id,
    run_id:"run-exact-parent-002",
    parents:[reference(first)],
    content:{entities:[{id:"REQ-001",kind:"requirement",meaning:"Exact parent revision"}]},
  })));
  const path=artifactPath(root,second);
  const stored=JSON.parse(await readFile(path,"utf8"));
  stored.parents.push(reference(unrelated));
  await writeFile(path,JSON.stringify(stored),"utf8");

  await assert.rejects(store.get(reference(second)),/exactly one parent/i);
  await assert.rejects(store.verify(reference(second)),/exactly one parent/i);
  await assert.rejects(store.list({artifact_id:second.artifact_id}),
    /exactly one parent/i);
});

test("append enforces ACP producer ownership and complete provenance",async (t) => {
  const {store}=await createTestStore(t);
  const emptyProducer=draft({artifact_id:"ART-EMPTY-PRODUCER-001"});
  emptyProducer.producer={};
  await assert.rejects(store.append(emptyProducer),/producer\.role/i);

  await assert.rejects(store.append(draft({
    artifact_id:"ART-WRONG-PRODUCER-001",
    producer:{role:"architect",identity:"toss-test"},
  })),/producer role/i);

  const missingLocations=draft({artifact_id:"ART-MISSING-LOCATIONS-001"});
  delete missingLocations.provenance.locations;
  await assert.rejects(store.append(missingLocations),/provenance\.locations/i);
});

test("discovery fails closed for unexpected regular artifact files",async (t) => {
  const {root,store}=await createTestStore(t);
  const first=await store.append(draft());
  await writeFile(join(dirname(artifactPath(root,first)),"unexpected.txt"),"unknown","utf8");

  await assert.rejects(store.list(),/unexpected artifact entry/i);
});

test("append clearly rejects revisions beyond the supported filename width",async (t) => {
  const {store}=await createTestStore(t);
  await assert.rejects(store.append(draft({
    artifact_id:"ART-TOO-WIDE-REVISION-001",
    revision:1_000_000,
  })),/maximum revision/i);
});

test("discovery rejects persisted revisions beyond the supported filename width",async (t) => {
  const {root,store}=await createTestStore(t);
  const first=await store.append(draft());
  await writeFile(join(
    dirname(artifactPath(root,first)),
    `r1000000-${first.content_sha256}.json`,
  ),"{}","utf8");

  await assert.rejects(store.list(),/maximum revision/i);
});
