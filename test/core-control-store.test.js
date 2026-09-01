import assert from "node:assert/strict";
import {execFile as childExecFile} from "node:child_process";
import {chmod, mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import test from "node:test";

import {createGitControlRepository} from "../src/core/control/git-repository.js";
import {
  CONTROL_PATHS,
  createCoreControlStore,
  repositoryFilename,
  repositoryPath,
} from "../src/core/control/store.js";

const execFile=promisify(childExecFile);

async function git(root,args) {
  return execFile("git",args,{cwd:root});
}

async function createRepository(t) {
  const root=await mkdtemp(join(tmpdir(),"toss-core-control-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  await git(root,["init"]);
  await git(root,["config","user.email","test@example.invalid"]);
  await git(root,["config","user.name","TOSS Core Test"]);
  return root;
}

function control(root) {
  return createGitControlRepository({root,execFile,clock:() => 1700000000000});
}

function organization() {
  return {
    schema_version:"organization-config.v1",
    organization:"TOSS-Soft",
    project:{node_id:"PVT_kwDO",number:2},
    control_repository:"TOSS-Soft/toss-os-control",
    policy_revision:"POLICY-0001",
    repositories:["TOSS-Soft/toss-cli"],
  };
}

function repositoryConfig() {
  return {
    schema_version:"repository-config.v1",
    repository:"TOSS-Soft/toss-cli",
    repository_node_id:"R_kgDO",
    default_branch:"main",
    active_release:null,
    project_item_id:"PVTI_01",
    project_fields:{status:"PVTSSF_status",gate:"PVTSSF_gate"},
    registered_at:"2026-09-01T08:00:00.000Z",
  };
}

function intent() {
  return {
    schema_version:"operation-intent.v1",
    document_type:"operation-intent",
    intent_id:"INTENT-20260901-0001",
    command:"repo.add",
    created_at:"2026-09-01T08:00:00.000Z",
    policy_revision:"POLICY-0001",
    source:{repository:"TOSS-Soft/toss-cli",revision:"abc123",sha256:"a".repeat(64)},
    authority:null,
    operations:[{
      operation_id:"OP-0001",
      resource:"repository",
      action:"register",
      repository:"TOSS-Soft/toss-cli",
      expected_revision:null,
      payload:{default_branch:"main"},
    }],
  };
}

function receipt() {
  return {
    schema_version:"operation-receipt.v1",
    document_type:"operation-receipt",
    receipt_id:"RECEIPT-20260901-0001",
    intent_id:"INTENT-20260901-0001",
    intent_sha256:"b".repeat(64),
    created_at:"2026-09-01T08:01:00.000Z",
    status:"completed",
    observed_revisions:[],
  };
}

test("control repository bootstraps canonical documents and reports its exact head",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);

  assert.equal(await repositoryControl.head(),null);
  const committed=await repositoryControl.commitFiles({
    expectedHead:null,
    message:"bootstrap control repository",
    files:{"config/organization.yaml":organization()},
  });

  assert.match(committed.commit_sha,/^[a-f0-9]{40}$/u);
  assert.equal(await repositoryControl.head(),committed.commit_sha);
  assert.equal(
    await readFile(join(root,"config","organization.yaml"),"utf8"),
    "control_repository: TOSS-Soft/toss-os-control\norganization: TOSS-Soft\npolicy_revision: POLICY-0001\nproject:\n  node_id: PVT_kwDO\n  number: 2\nrepositories:\n  - TOSS-Soft/toss-cli\nschema_version: organization-config.v1\n",
  );
  assert.deepEqual(await repositoryControl.readDocument("config/organization.yaml"),organization());
});

test("control repository accepts only an own-data non-proxy Git execution port",() => {
  assert.throws(() => createGitControlRepository({
    root:".",
    get execFile() { return execFile; },
  }),/own data property/i);
  assert.throws(() => createGitControlRepository({
    root:".",
    execFile:new Proxy(execFile,{}),
  }),/non-proxy function/i);
});

test("control repository rejects a stale exact head without changing documents",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const first=await repositoryControl.commitFiles({
    expectedHead:null,
    message:"first",
    files:{"config/organization.yaml":organization()},
  });

  await assert.rejects(repositoryControl.commitFiles({
    expectedHead:null,
    message:"stale",
    files:{"policies/lifecycle.yaml":{revision:"POLICY-0001"}},
  }),/expected head|conflict/i);
  assert.equal(await repositoryControl.head(),first.commit_sha);
  assert.equal(await repositoryControl.readDocument("policies/lifecycle.yaml"),null);
});

test("control repository rejects traversal and symlink targets",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const outside=await mkdtemp(join(tmpdir(),"toss-core-outside-"));
  t.after(() => rm(outside,{recursive:true,force:true}));
  await symlink(outside,join(root,"config"));

  await assert.rejects(repositoryControl.readDocument("../outside.json"),/safe relative path|path/i);
  await assert.rejects(repositoryControl.commitFiles({
    expectedHead:null,
    message:"unsafe",
    files:{"config/../outside.json":{}},
  }),/safe relative path|path/i);
  await assert.rejects(repositoryControl.commitFiles({
    expectedHead:null,
    message:"symlink",
    files:{"config/organization.yaml":organization()},
  }),/symbolic link|symlink/i);
});

test("repository configuration uses the approved reversible percent filename exception only",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const store=createCoreControlStore({repository:repositoryControl});
  const path=repositoryPath("TOSS-Soft/toss-cli");

  assert.equal(repositoryFilename("TOSS-Soft/toss-cli"),"toss-soft%2Ftoss-cli.yaml");
  assert.equal(path,"config/repositories/toss-soft%2Ftoss-cli.yaml");
  assert.equal(decodeURIComponent(repositoryFilename("TOSS-Soft/toss-cli").slice(0,-5)),"toss-soft/toss-cli");
  await store.commitConfiguration({
    expectedHead:null,
    files:{[path]:repositoryConfig()},
  });
  assert.deepEqual(await repositoryControl.readDocument(path),repositoryConfig());
  await assert.rejects(repositoryControl.readDocument("config/repositories/toss-soft%2ftoss-cli.yaml"),/unsafe relative path/i);
  await assert.rejects(repositoryControl.readDocument("config/repositories/toss-soft%20toss-cli.yaml"),/unsafe relative path/i);
  await assert.rejects(repositoryControl.readDocument("config/toss-soft%2Ftoss-cli.yaml"),/unsafe relative path/i);
  await assert.rejects(repositoryControl.readDocument("config/repositories/toss-soft%2Ftoss-cli.json"),/unsafe relative path|unsupported/i);
});

test("receipt identities are immutable while exact duplicate content is idempotent",async t => {
  const root=await createRepository(t);
  const store=createCoreControlStore({repository:control(root)});
  const first=await store.commitReceipt({expectedHead:null,receipt:receipt()});
  const repeated=await store.commitReceipt({expectedHead:first.commit_sha,receipt:receipt()});

  assert.equal(repeated.commit_sha,first.commit_sha);
  await assert.rejects(store.commitReceipt({
    expectedHead:first.commit_sha,
    receipt:{...receipt(),status:"failed"},
  }),/immutable|different content|receipt/i);
  const withoutCreatedAt={...receipt()};
  delete withoutCreatedAt.created_at;
  await assert.rejects(store.commitReceipt({expectedHead:first.commit_sha,receipt:withoutCreatedAt}),/created_at|invalid/i);
});

test("organization state reads every document at one resolved revision",async () => {
  const revisions=[];
  const snapshot="a".repeat(40);
  const repository={
    head:async () => snapshot,
    readDocument:async (path,{at}) => {
      revisions.push(at);
      if (path===CONTROL_PATHS.organization) return organization();
      if (path===repositoryPath("TOSS-Soft/toss-cli")) return repositoryConfig();
      return null;
    },
    commitFiles:async () => { throw new Error("not used"); },
  };
  const store=createCoreControlStore({repository});

  const state=await store.loadOrganizationState();

  assert.equal(state.organization.organization,"TOSS-Soft");
  assert.deepEqual(state.repositories,[repositoryConfig()]);
  assert.ok(revisions.length>=2);
  assert.deepEqual([...new Set(revisions)],[snapshot]);
});

test("failed pre-commit hook restores control files and preserves unrelated index and worktree changes",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const initial=await repositoryControl.commitFiles({
    expectedHead:null,
    message:"initial",
    files:{"config/organization.yaml":organization()},
  });
  await writeFile(join(root,"unrelated-staged.txt"),"staged\n");
  await git(root,["add","--","unrelated-staged.txt"]);
  await writeFile(join(root,"unrelated-worktree.txt"),"worktree\n");
  const hook=join(root,".git","hooks","pre-commit");
  await writeFile(hook,"#!/bin/sh\nexit 1\n");
  await chmod(hook,0o755);

  await assert.rejects(repositoryControl.commitFiles({
    expectedHead:initial.commit_sha,
    message:"must fail",
    files:{"policies/lifecycle.yaml":{revision:"POLICY-0001"}},
  }),/failed|hook|commit/i);

  assert.equal(await repositoryControl.head(),initial.commit_sha);
  assert.equal(await repositoryControl.readDocument("policies/lifecycle.yaml"),null);
  assert.equal(await readFile(join(root,"unrelated-worktree.txt"),"utf8"),"worktree\n");
  const cached=await git(root,["diff","--cached","--name-only"]);
  assert.equal(cached.stdout,"unrelated-staged.txt\n");
  assert.equal((await git(root,["status","--porcelain"])).stdout,
    "A  unrelated-staged.txt\n?? unrelated-worktree.txt\n");
});

test("store validates persisted core contracts and exposes exact intent lookup",async t => {
  const root=await createRepository(t);
  const store=createCoreControlStore({repository:control(root)});
  const saved=await store.commitIntent({expectedHead:null,intent:intent()});

  assert.equal((await store.findIntent(intent())).intent_id,intent().intent_id);
  await assert.rejects(store.commitIntent({
    expectedHead:saved.commit_sha,
    intent:{...intent(),command:"repo.remove"},
  }),/immutable|different content|intent/i);
});
