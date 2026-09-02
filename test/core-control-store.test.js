import assert from "node:assert/strict";
import {execFile as childExecFile} from "node:child_process";
import {chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import test from "node:test";
import YAML from "yaml";

import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {createOperationIntent} from "../src/core/operations/plan.js";
import {createOperationRunner} from "../src/core/operations/runner.js";
import {createGitControlRepository} from "../src/core/control/git-repository.js";
import {
  closeDocumentPaths,
  closeRootSnapshot,
  CONTROL_ROOTS,
  hasControlMaterial,
} from "../src/core/control/root-snapshot.js";
import {
  CONTROL_PATHS,
  createCoreControlStore,
  intentPath,
  receiptPath,
  repositoryFilename,
  repositoryPath,
  programPath,
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

function controlWith(root,overrides) {
  return createGitControlRepository({
    root,
    execFile,
    clock:() => 1700000000000,
    ...overrides,
  });
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

function receiptFor(number) {
  return {...receipt(),receipt_id:`RECEIPT-20260901-${number}`};
}

function receiptForIntent(value,{number="0001",observed_revisions=value.operations.map(operation => ({
  operation_id:operation.operation_id,
  repository:operation.repository,
  revision:operation.expected_revision,
}))}={}) {
  return {
    ...receiptFor(number),
    intent_id:value.intent_id,
    intent_sha256:sha256Canonical(value),
    observed_revisions,
  };
}

function bootstrapFixture({intentId="INTENT-20260901-0099",receiptNumber="0099"}={}) {
  const organizationDocument={...organization(),repositories:[]};
  const lifecycle={revision:"POLICY-0001"};
  const release={revision:"POLICY-0001"};
  const hashes={
    organization:sha256Canonical(organizationDocument),
    lifecycle:sha256Canonical(lifecycle),
    release:sha256Canonical(release),
  };
  const repository=organizationDocument.control_repository;
  const intent=createOperationIntent({
    intent_id:intentId,
    created_at:"2026-09-01T08:00:00.000Z",
    command:"init",
    policy_revision:organizationDocument.policy_revision,
    source:{repository,revision:"r0",sha256:"a".repeat(64)},
    authority:{record_id:"AUTH-20260901-0001",sha256:"a".repeat(64)},
    operations:[
      {resource:"repository",action:"create",repository,expected_revision:null,payload:{kind:"create-private-control-repository",private:true,files:hashes}},
      {resource:"repository",action:"update",repository,expected_revision:null,payload:{kind:"verify-default-branch-protection"}},
      {resource:"project",action:"update",repository:null,expected_revision:"project-r1",payload:{kind:"discover-project-fields",project:organizationDocument.project}},
      ...[["organization-config",hashes.organization],["lifecycle-policy",hashes.lifecycle],["release-policy",hashes.release]].map(([kind,sha256]) => ({resource:"repository",action:"commit",repository,expected_revision:null,payload:{kind,sha256}})),
      {resource:"repository",action:"commit",repository,expected_revision:null,payload:{kind:"first-control-transaction",files:hashes}},
    ],
  });
  const remoteKinds=new Set(["create-private-control-repository","verify-default-branch-protection","discover-project-fields"]);
  const receipt=receiptForIntent(intent,{number:receiptNumber,observed_revisions:intent.operations.filter(operation => remoteKinds.has(operation.payload.kind)).map(operation => ({operation_id:operation.operation_id,repository:operation.repository,revision:"r1"}))});
  const files={
    "config/organization.yaml":organizationDocument,
    "policies/lifecycle.yaml":lifecycle,
    "policies/release.yaml":release,
    [intentPath(intent)]:intent,
    [receiptPath(receipt)]:receipt,
  };
  return {organization:organizationDocument,lifecycle,release,intent,receipt,files};
}

async function createBootstrappedStore(t) {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const store=createCoreControlStore({repository:repositoryControl});
  const bootstrap=bootstrapFixture();
  const committed=await store.commitBootstrap({expectedHead:null,files:bootstrap.files});
  return {root,repositoryControl,store,bootstrap,head:committed.commit_sha};
}

async function createPopulatedBootstrappedStore(t) {
  const bootstrapped=await createBootstrappedStore(t);
  const planned=intent();
  const recorded=receiptForIntent(planned,{observed_revisions:[{
    operation_id:planned.operations[0].operation_id,
    repository:planned.operations[0].repository,
    revision:"observed-r1",
  }]});
  const configuration=repositoryConfig();
  const program={program_id:"PROGRAM-A",metadata:{owners:["team-a"]}};
  const committed=await bootstrapped.repositoryControl.commitFiles({
    expectedHead:bootstrapped.head,
    message:"populated immutable state",
    files:{
      "config/organization.yaml":{...bootstrapped.bootstrap.organization,repositories:[configuration.repository]},
      [repositoryPath(configuration.repository)]:configuration,
      "programs/PROGRAM-A/manifest.yaml":program,
      [intentPath(planned)]:planned,
      [receiptPath(recorded)]:recorded,
    },
  });
  return {...bootstrapped,planned,recorded,configuration,program,head:committed.commit_sha};
}

function assertDeeplyFrozen(value,seen=new Set()) {
  if (value===null || typeof value!=="object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value),true);
  for (const child of Object.values(value)) assertDeeplyFrozen(child,seen);
}

async function assertAllPublicReadersConflict(store,{identity="TOSS-Soft/toss-cli",targetIntent}) {
  for (const read of [
    () => store.loadBootstrapState(),
    () => store.loadOrganizationState(),
    () => store.loadOrganization(),
    () => store.loadRepository(identity),
    () => store.listRepositories(),
    () => store.loadRegistryState(),
    () => store.findReceipt(targetIntent),
    () => store.findIntent(targetIntent),
    () => store.findCompletedRepositoryRegistration(identity),
  ]) {
    await assert.rejects(read(),error => error?.code==="CONTROL_LEDGER_CONFLICT");
  }
}

function repositoryWithRootPort(rootPort) {
  const revision="a".repeat(40);
  return Object.freeze({
    async head() { return revision; },
    async readDocument() { return null; },
    async listDocuments() { return []; },
    rootSnapshotAt:rootPort,
    async commitFiles() { throw new Error("write is not expected"); },
  });
}

test("root snapshots close own data without invoking hostile values",() => {
  const sha="a".repeat(40);
  const source={revision:sha,paths:["README.md","config/organization.yaml"]};
  const closed=closeRootSnapshot(source);
  assert.deepEqual(closed,{revision:sha,paths:["README.md","config/organization.yaml"]});
  assert.equal(Object.isFrozen(closed),true);
  assert.equal(Object.isFrozen(closed.paths),true);
  source.paths[0]="CHANGED.md";
  assert.deepEqual(closed.paths,["README.md","config/organization.yaml"]);

  let getterCalls=0;
  const accessor={paths:[]};
  Object.defineProperty(accessor,"revision",{enumerable:true,get() { getterCalls+=1; return sha; }});
  assert.throws(() => closeRootSnapshot(accessor),/own.*data|snapshot/i);
  assert.equal(getterCalls,0);

  let trapCalls=0;
  const proxy=new Proxy({revision:sha,paths:[]},{getPrototypeOf() { trapCalls+=1; return Object.prototype; }});
  assert.throws(() => closeRootSnapshot(proxy),/proxy|snapshot/i);
  assert.equal(trapCalls,0);

  const withSymbol={revision:sha,paths:[]};
  withSymbol[Symbol("hidden")]=true;
  const extraEnumerable={revision:sha,paths:[],extra:true};
  const hiddenRoot={revision:sha,paths:[]};
  Object.defineProperty(hiddenRoot,"hidden",{value:true});
  const wrongPrototype=Object.assign(Object.create({}),{revision:sha,paths:[]});
  for (const [name,value] of [
    ["symbol",withSymbol],
    ["extra enumerable",extraEnumerable],
    ["hidden root key",hiddenRoot],
    ["wrong prototype",wrongPrototype],
  ]) {
    assert.throws(() => closeRootSnapshot(value),TypeError,name);
  }

  const paths=["config/organization.yaml"];
  Object.defineProperty(paths,"hidden",{value:"receipts/2026/09/hidden.json"});
  assert.throws(() => closeDocumentPaths(paths,"root snapshot paths"),/own|hidden|path/i);

  const nonWritableLength=[];
  Object.defineProperty(nonWritableLength,"length",{writable:false});
  assert.throws(() => closeDocumentPaths(nonWritableLength,"non-writable length"),TypeError);

  let arrayGetterCalls=0;
  const accessorIndex=[];
  Object.defineProperty(accessorIndex,"0",{enumerable:true,get() { arrayGetterCalls+=1; return "README.md"; }});
  const nestedProxy=new Proxy([],{});
  const symbolicPaths=[];
  symbolicPaths[Symbol("hidden")]=true;
  for (const [name,value] of [
    ["accessor index",accessorIndex],
    ["nested proxy",nestedProxy],
    ["symbolic paths",symbolicPaths],
  ]) {
    assert.throws(() => closeDocumentPaths(value,name),TypeError,name);
  }
  assert.equal(arrayGetterCalls,0);

  const invalidPaths=[
    ["sparse",Object.assign(Array(2),{0:"README.md"})],
    ["duplicate",["README.md","README.md"]],
    ["unsorted",["receipts/R.json","config/organization.yaml"]],
    ["traversal",["../outside.json"]],
    ["absolute",["/outside.json"]],
    ["backslash",["config\\outside.json"]],
    ["nul",["config/outside\0.json"]],
    ["drive",["C:/outside.json"]],
  ];
  for (const [name,value] of invalidPaths) {
    assert.throws(() => closeDocumentPaths(value,name),TypeError);
  }
  assert.deepEqual(
    closeDocumentPaths(["config/repositories/toss-soft%2Ftoss-cli.yaml"],"repository path"),
    ["config/repositories/toss-soft%2Ftoss-cli.yaml"],
  );
});

test("document path closure rejects huge sparse arrays within a bounded child process",async () => {
  const script=`import {closeDocumentPaths} from "./src/core/control/root-snapshot.js";
try {
  closeDocumentPaths(Array(0xffffffff),"huge sparse paths");
  throw new Error("huge sparse paths were accepted");
} catch (error) {
  if (!(error instanceof TypeError)) throw error;
  process.stdout.write(error.message);
}`;
  const result=await execFile(process.execPath,[
    "--max-old-space-size=32","--input-type=module","--eval",script,
  ],{cwd:process.cwd(),timeout:2000,maxBuffer:1024});
  assert.equal(result.stdout,"huge sparse paths must be dense and contain no extra properties");
  assert.equal(result.stderr,"");
});

test("control material classification is exact",() => {
  assert.equal(hasControlMaterial(["README.md"]),false);
  assert.equal(hasControlMaterial(["config/organization.yaml"]),true);
  assert.equal(hasControlMaterial(["programs/P1/manifest.yaml"]),true);
});

test("Git root snapshots accept unrelated safe blobs and retain safe paths",async t => {
  const root=await createRepository(t);
  await writeFile(join(root,"README.md"),"unrelated root\n","utf8");
  await git(root,["add","--","README.md"]);
  await git(root,["commit","-m","unrelated root"]);
  const repositoryControl=control(root);
  const at=await repositoryControl.head();
  assert.deepEqual(await repositoryControl.rootSnapshotAt({at}),{
    revision:at,
    paths:["README.md"],
  });
});

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

test("control repository compare-and-swaps publication when another writer advances HEAD",async t => {
  const root=await createRepository(t);
  const seed=control(root);
  const first=await seed.commitFiles({
    expectedHead:null,
    message:"first",
    files:{"config/organization.yaml":organization()},
  });
  let injected=false;
  let externalCommit;
  const repositoryControl=controlWith(root,{execFile:async (file,args,options) => {
    if (!injected && args[0]==="update-ref") {
      injected=true;
      const ref=(await execFile("git",["symbolic-ref","-q","HEAD"],options)).stdout.trim();
      const tree=(await execFile("git",["rev-parse",`${first.commit_sha}^{tree}`],options)).stdout.trim();
      externalCommit=(await execFile("git",["commit-tree",tree,"-p",first.commit_sha,"-m","external writer"],options)).stdout.trim();
      await execFile("git",["update-ref",ref,externalCommit,first.commit_sha],options);
    }
    return execFile(file,args,options);
  }});

  await assert.rejects(repositoryControl.commitFiles({
    expectedHead:first.commit_sha,
    message:"must not publish",
    files:{"policies/lifecycle.yaml":{revision:"POLICY-0001"}},
  }),/expected head|conflict/i);

  assert.equal(injected,true);
  assert.equal(await repositoryControl.head(),externalCommit);
  assert.equal(await repositoryControl.readDocument("policies/lifecycle.yaml"),null);
});

test("control repository publishes only requested files while retaining unrelated staged entries",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const initial=await repositoryControl.commitFiles({
    expectedHead:null,
    message:"first",
    files:{"config/organization.yaml":organization()},
  });
  await writeFile(join(root,"unrelated-staged.txt"),"staged\n");
  await git(root,["add","--","unrelated-staged.txt"]);

  const committed=await repositoryControl.commitFiles({
    expectedHead:initial.commit_sha,
    message:"control only",
    files:{"policies/lifecycle.yaml":{revision:"POLICY-0001"}},
  });

  assert.equal((await git(root,["diff-tree","--no-commit-id","--name-only","-r",committed.commit_sha])).stdout,
    "policies/lifecycle.yaml\n");
  assert.equal((await git(root,["diff","--cached","--name-only"])).stdout,"unrelated-staged.txt\n");
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

test("Git file maps reject symbol hidden accessor and proxy entries without invoking them",async t => {
  let hostileCalls=0;
  const buildCases=() => {
    const symbolic={"config/organization.yaml":organization()}; symbolic[Symbol("hidden")]=true;
    const hidden={"config/organization.yaml":organization()}; Object.defineProperty(hidden,"hidden",{value:true});
    const accessor={"config/organization.yaml":organization()}; Object.defineProperty(accessor,"hidden",{
      enumerable:true,
      get() { hostileCalls+=1; return true; },
    });
    const proxy=new Proxy({"config/organization.yaml":organization()},{
      ownKeys() { hostileCalls+=1; throw new Error("must not enumerate proxy"); },
      getOwnPropertyDescriptor() { hostileCalls+=1; throw new Error("must not inspect proxy"); },
    });
    return [symbolic,hidden,accessor,proxy];
  };
  for (const files of buildCases()) {
    const root=await createRepository(t);
    const repositoryControl=control(root);
    await assert.rejects(repositoryControl.commitFiles({expectedHead:null,message:"closed map",files}),TypeError);
    assert.equal(await repositoryControl.head(),null);
  }
  assert.equal(hostileCalls,0);
});

test("store bootstrap and configuration maps reject exotic own entries",async t => {
  let hostileCalls=0;
  const decorate=(base,kind) => {
    if (kind==="symbol") base[Symbol("hidden")]=true;
    if (kind==="hidden") Object.defineProperty(base,"hidden",{value:true});
    if (kind==="accessor") Object.defineProperty(base,"hidden",{
      enumerable:true,
      get() { hostileCalls+=1; return true; },
    });
    if (kind==="proxy") return new Proxy(base,{
      ownKeys() { hostileCalls+=1; throw new Error("must not enumerate proxy"); },
      getOwnPropertyDescriptor() { hostileCalls+=1; throw new Error("must not inspect proxy"); },
    });
    return base;
  };
  for (const kind of ["symbol","hidden","accessor","proxy"]) {
    const root=await createRepository(t);
    const store=createCoreControlStore({repository:control(root)});
    const fixture=bootstrapFixture();
    await assert.rejects(store.commitBootstrap({
      expectedHead:null,
      files:decorate({...fixture.files},kind),
    }),TypeError);
    assert.equal(await store.head(),null);
  }
  for (const kind of ["symbol","hidden","accessor","proxy"]) {
    const {store,bootstrap,head}=await createBootstrappedStore(t);
    await assert.rejects(store.commitConfiguration({
      expectedHead:head,
      files:decorate({[CONTROL_PATHS.organization]:bootstrap.organization},kind),
    }),TypeError);
    assert.equal(await store.head(),head);
  }

  const {store,bootstrap,head}=await createBootstrappedStore(t);
  const organizationDocument={...bootstrap.organization};
  Object.defineProperty(organizationDocument,"repositories",{
    enumerable:true,
    get() { hostileCalls+=1; return []; },
  });
  await assert.rejects(store.commitConfiguration({
    expectedHead:head,
    files:{[CONTROL_PATHS.organization]:organizationDocument},
  }),error => error?.code==="CORE_CONTRACT_INVALID");

  const root=await createRepository(t);
  const bootstrapStore=createCoreControlStore({repository:control(root)});
  const fixture=bootstrapFixture();
  const lifecycle={};
  Object.defineProperty(lifecycle,"revision",{
    enumerable:true,
    get() { hostileCalls+=1; return "POLICY-0001"; },
  });
  await assert.rejects(bootstrapStore.commitBootstrap({
    expectedHead:null,
    files:{...fixture.files,"policies/lifecycle.yaml":lifecycle},
  }));
  assert.equal(hostileCalls,0);
});

test("repository configuration uses the approved reversible percent filename exception only",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const store=createCoreControlStore({repository:repositoryControl});
  const path=repositoryPath("TOSS-Soft/toss-cli");

  assert.equal(repositoryFilename("TOSS-Soft/toss-cli"),"TOSS-Soft%2Ftoss-cli.yaml");
  assert.equal(path,"config/repositories/TOSS-Soft%2Ftoss-cli.yaml");
  assert.equal(decodeURIComponent(repositoryFilename("TOSS-Soft/toss-cli").slice(0,-5)),"TOSS-Soft/toss-cli");
  await store.commitConfiguration({
    expectedHead:null,
    files:{"config/organization.yaml":organization(),[path]:repositoryConfig()},
  });
  assert.deepEqual(await repositoryControl.readDocument(path),repositoryConfig());
  await assert.rejects(repositoryControl.readDocument("config/repositories/toss-soft%2ftoss-cli.yaml"),/unsafe relative path/i);
  await assert.rejects(repositoryControl.readDocument("config/repositories/toss-soft%20toss-cli.yaml"),/unsafe relative path/i);
  await assert.rejects(repositoryControl.readDocument("config/toss-soft%2Ftoss-cli.yaml"),/unsafe relative path/i);
  await assert.rejects(repositoryControl.readDocument("config/repositories/toss-soft%2Ftoss-cli.json"),/unsafe relative path|unsupported/i);
});

test("repository configuration rejects case-only identity replacement before commit",async t => {
  const {repositoryControl,store,bootstrap,head}=await createBootstrappedStore(t);
  const existing=repositoryConfig();
  const registered=await store.commitConfiguration({
    expectedHead:head,
    files:{
      [CONTROL_PATHS.organization]:{...bootstrap.organization,repositories:[existing.repository]},
      [repositoryPath(existing.repository)]:existing,
    },
  });
  const replacement={
    ...existing,
    repository:"toss-soft/toss-cli",
    repository_node_id:"R_case_only",
  };
  const desired={
    ...bootstrap.organization,
    repositories:[existing.repository,replacement.repository].sort(),
  };

  await assert.rejects(store.commitConfiguration({
    expectedHead:registered.commit_sha,
    files:{
      [CONTROL_PATHS.organization]:desired,
      [repositoryPath(replacement.repository)]:replacement,
    },
  }),error => error?.code==="CONTROL_LEDGER_CONFLICT");

  assert.equal(await repositoryControl.head(),registered.commit_sha);
  assert.deepEqual(await store.loadRepository(existing.repository),existing);
  assert.deepEqual((await store.loadOrganization()).repositories,[existing.repository]);
});

test("persisted case-only repository path collisions fail closed",async t => {
  const {root,store,bootstrap,head}=await createBootstrappedStore(t);
  const existing=repositoryConfig();
  const registered=await store.commitConfiguration({
    expectedHead:head,
    files:{
      [CONTROL_PATHS.organization]:{...bootstrap.organization,repositories:[existing.repository]},
      [repositoryPath(existing.repository)]:existing,
    },
  });
  const replacement={...existing,repository:"toss-soft/toss-cli",repository_node_id:"R_case_only"};
  const conflictingPath="config/repositories/toss-soft%2Ftoss-cli.yaml"===repositoryPath(existing.repository)
    ? "config/repositories/TOSS-Soft%2Ftoss-cli.yaml"
    : "config/repositories/toss-soft%2Ftoss-cli.yaml";
  await writeFile(join(root,conflictingPath),YAML.stringify(replacement,{sortMapEntries:true}),"utf8");
  await writeFile(join(root,CONTROL_PATHS.organization),YAML.stringify({
    ...bootstrap.organization,
    repositories:[existing.repository,replacement.repository].sort(),
  },{sortMapEntries:true}),"utf8");
  await git(root,["add","--",conflictingPath,CONTROL_PATHS.organization]);
  await git(root,["commit","-m","persist case-only repository collision"]);
  assert.notEqual(await store.head(),registered.commit_sha);
  await assertAllPublicReadersConflict(store,{targetIntent:bootstrap.intent});
});

test("configuration commits reject non-registry paths and registry drift without organization",async t => {
  const root=await createRepository(t); const repositoryControl=control(root); const store=createCoreControlStore({repository:repositoryControl});
  await assert.rejects(store.commitConfiguration({expectedHead:null,files:{"config/organization.yaml":organization(),"policies/unsafe.yaml":repositoryConfig()}}),/permitted/i);
  await repositoryControl.commitFiles({expectedHead:null,message:"orphan repository config",files:{[repositoryPath("TOSS-Soft/toss-cli")]:repositoryConfig()}});
  await assert.rejects(store.loadRegistryState(),error => error?.code==="CONTROL_LEDGER_CONFLICT");
});

test("receipts require one matching persisted intent and remain immutable when bound",async t => {
  const root=await createRepository(t);
  const store=createCoreControlStore({repository:control(root)});
  const planned=intent();
  const orphan=receiptForIntent(planned);

  await assert.rejects(store.commitReceipt({expectedHead:null,receipt:orphan}),/intent|orphan|persisted/i);

  const intentCommit=await store.commitIntent({expectedHead:null,intent:planned});
  const bound=receiptForIntent(planned,{observed_revisions:[{
    operation_id:"OP-0001",
    repository:"TOSS-Soft/toss-cli",
    revision:"observed-r1",
  }]});
  const first=await store.commitReceipt({expectedHead:intentCommit.commit_sha,receipt:bound});
  const repeated=await store.commitReceipt({expectedHead:first.commit_sha,receipt:bound});

  assert.equal(repeated.commit_sha,first.commit_sha);
  await assert.rejects(store.commitReceipt({
    expectedHead:first.commit_sha,
    receipt:receiptForIntent(planned,{number:"0002"}),
  }),/receipt.*intent|already.*receipt|immutable/i);
  await assert.rejects(store.commitReceipt({
    expectedHead:first.commit_sha,
    receipt:{...bound,status:"failed"},
  }),/immutable|different content|receipt/i);
  await assert.rejects(store.commitReceipt({
    expectedHead:first.commit_sha,
    receipt:{...receiptForIntent(planned,{number:"0002"}),intent_sha256:"0".repeat(64)},
  }),/hash|intent/i);
  await assert.rejects(store.commitReceipt({
    expectedHead:first.commit_sha,
    receipt:receiptForIntent(planned,{number:"0003",observed_revisions:[{
      operation_id:"OP-9999",
      repository:"TOSS-Soft/toss-cli",
      revision:"observed-r2",
    }]}),
  }),/operation|observed/i);
  const withoutCreatedAt={...bound};
  delete withoutCreatedAt.created_at;
  await assert.rejects(store.commitReceipt({expectedHead:first.commit_sha,receipt:withoutCreatedAt}),/created_at|invalid/i);
});

test("completed receipts require one observation for every intent operation",async t => {
  const root=await createRepository(t);
  const store=createCoreControlStore({repository:control(root)});
  const {schema_version,document_type,...input}=intent();
  void schema_version; void document_type;
  const planned=createOperationIntent({...input,operations:[
    {resource:"repository",action:"register",repository:"TOSS-Soft/toss-cli",expected_revision:"r1",payload:{kind:"one"}},
    {resource:"project",action:"update",repository:null,expected_revision:"p1",payload:{kind:"two"}},
  ]});
  const committed=await store.commitIntent({expectedHead:null,intent:planned});
  const incomplete=receiptForIntent(planned,{number:"0002",observed_revisions:[{
    operation_id:"OP-0001",repository:planned.operations[0].repository,revision:"r2",
  }]});
  await assert.rejects(
    store.commitReceipt({expectedHead:committed.commit_sha,receipt:incomplete}),
    /completed.*observation|coverage|intent operation/i,
  );
});

test("receipt binding rejects duplicate persisted intent identities",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const store=createCoreControlStore({repository:repositoryControl});
  const planned=intent();
  const first=await store.commitIntent({expectedHead:null,intent:planned});
  const duplicate={...planned,created_at:"2026-10-01T08:00:00.000Z"};
  const second=await repositoryControl.commitFiles({
    expectedHead:first.commit_sha,
    message:"duplicate intent identity",
    files:{"intents/2026/10/INTENT-20260901-0001.json":duplicate},
  });

  await assert.rejects(store.commitReceipt({
    expectedHead:second.commit_sha,
    receipt:receiptForIntent(planned),
  }),/exactly one persisted intent|duplicate/i);
});

test("public intent and receipt identities cannot be reused in another valid month",async t => {
  const root=await createRepository(t);
  const store=createCoreControlStore({repository:control(root)});
  const planned=intent();
  const intentCommit=await store.commitIntent({expectedHead:null,intent:planned});
  const reusedIntent={...planned,created_at:"2026-10-01T08:00:00.000Z"};

  await assert.rejects(store.commitIntent({
    expectedHead:intentCommit.commit_sha,
    intent:reusedIntent,
  }),/immutable|identity|conflict/i);

  const firstReceipt=receiptForIntent(planned);
  const receiptCommit=await store.commitReceipt({
    expectedHead:intentCommit.commit_sha,
    receipt:firstReceipt,
  });
  const reusedReceipt={...firstReceipt,created_at:"2026-10-01T08:01:00.000Z"};
  await assert.rejects(store.commitReceipt({
    expectedHead:receiptCommit.commit_sha,
    receipt:reusedReceipt,
  }),/immutable|identity|conflict/i);
});

test("organization state reads every document at one resolved revision",async t => {
  const {repositoryControl,store:seed,bootstrap,head:rootRevision}=await createBootstrappedStore(t);
  const committed=await seed.commitConfiguration({
    expectedHead:rootRevision,
    files:{
      "config/organization.yaml":{...bootstrap.organization,repositories:["TOSS-Soft/toss-cli"]},
      [repositoryPath("TOSS-Soft/toss-cli")]:repositoryConfig(),
    },
  });
  const revisions=[];
  const snapshot=committed.commit_sha;
  const repository={
    head:async () => snapshot,
    readDocument:async (path,{at}) => {
      revisions.push(at);
      return repositoryControl.readDocument(path,{at});
    },
    listDocuments:async (prefix,{at}) => {
      revisions.push(at);
      return repositoryControl.listDocuments(prefix,{at});
    },
    rootSnapshotAt:async ({at}) => repositoryControl.rootSnapshotAt({at}),
    commitFiles:async () => { throw new Error("not used"); },
  };
  const store=createCoreControlStore({repository});

  const state=await store.loadOrganizationState();

  assert.equal(state.organization.organization,"TOSS-Soft");
  assert.deepEqual(state.repositories,[repositoryConfig()]);
  assert.ok(revisions.length>=2);
  assert.deepEqual([...new Set(revisions)].sort(),[rootRevision,snapshot].sort());
});

test("organization state lists populated programs and receipts at its initially resolved revision",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const bootstrap=bootstrapFixture();
  const bootstrapped=await repositoryControl.commitFiles({
    expectedHead:null,
    message:"bootstrap state",
    files:bootstrap.files,
  });
  const firstIntent=intent(); const secondIntent={...intent(),intent_id:"INTENT-20260901-0002"};
  const initial=await repositoryControl.commitFiles({
    expectedHead:bootstrapped.commit_sha,
    message:"populated state",
    files:{
      "config/organization.yaml":{...bootstrap.organization,repositories:["TOSS-Soft/toss-cli"]},
      [repositoryPath("TOSS-Soft/toss-cli")]:repositoryConfig(),
      "programs/PROGRAM-A/manifest.yaml":{program_id:"PROGRAM-A"},
      "programs/PROGRAM-B/manifest.yaml":{program_id:"PROGRAM-B"},
      [intentPath(firstIntent)]:firstIntent,
      [intentPath(secondIntent)]:secondIntent,
      "receipts/2026/09/RECEIPT-20260901-0001.json":receiptForIntent(firstIntent),
      "receipts/2026/09/RECEIPT-20260901-0002.json":receiptForIntent(secondIntent,{number:"0002"}),
    },
  });
  const ref=(await git(root,["symbolic-ref","-q","HEAD"])).stdout.trim();
  const tree=(await git(root,["rev-parse",`${initial.commit_sha}^{tree}`])).stdout.trim();
  const later=(await git(root,["commit-tree",tree,"-p",initial.commit_sha,"-m","later writer"])).stdout.trim();
  const revisions=[];
  let advanced=false;
  const repository={
    head:repositoryControl.head,
    readDocument:async (path,{at}) => {
      revisions.push(at);
      return repositoryControl.readDocument(path,{at});
    },
    listDocuments:async (prefix,{at}) => {
      revisions.push(at);
      if (!advanced) {
        advanced=true;
        await git(root,["update-ref",ref,later,initial.commit_sha]);
      }
      return repositoryControl.listDocuments(prefix,{at});
    },
    rootSnapshotAt:repositoryControl.rootSnapshotAt,
    commitFiles:repositoryControl.commitFiles,
  };
  const store=createCoreControlStore({repository});

  const state=await store.loadOrganizationState();

  assert.equal(await repositoryControl.head(),later);
  assert.deepEqual(state.programs,[{program_id:"PROGRAM-A"},{program_id:"PROGRAM-B"}]);
  assert.deepEqual(state.receipts.map(value => value.receipt_id),[
    "RECEIPT-20260901-0001","RECEIPT-20260901-0002",
    bootstrap.receipt.receipt_id,
  ]);
  assert.deepEqual([...new Set(revisions)],[initial.commit_sha,bootstrapped.commit_sha]);
  assert.ok(Object.isFrozen(state.programs));
  assert.ok(Object.isFrozen(state.receipts));
});

test("organization state validates aggregate receipt coverage against exact persisted intents",async t => {
  const input={intent_id:"INTENT-20260901-0001",created_at:"2026-09-01T08:00:00.000Z",command:"repo.add",policy_revision:"POLICY-0001",source:{repository:"TOSS-Soft/toss-cli",revision:"abc123",sha256:"a".repeat(64)},authority:null,operations:[
    {resource:"repository",action:"register",repository:"TOSS-Soft/toss-cli",expected_revision:"repo-1",payload:{kind:"one"}},
    {resource:"project",action:"update",repository:null,expected_revision:"project-1",payload:{kind:"two"}},
  ]};
  const planned=createOperationIntent(input);
  const cases=[
    {name:"zero",receipt:receiptForIntent(planned,{observed_revisions:[]})},
    {name:"missing",receipt:receiptForIntent(planned,{observed_revisions:[{operation_id:"OP-0001",repository:planned.operations[0].repository,revision:"r1"}]})},
    {name:"duplicate",receipt:receiptForIntent(planned,{observed_revisions:[{operation_id:"OP-0001",repository:planned.operations[0].repository,revision:"r1"},{operation_id:"OP-0001",repository:planned.operations[0].repository,revision:"r2"}]})},
    {name:"mismatched",receipt:receiptForIntent(planned,{observed_revisions:[{operation_id:"OP-0001",repository:"TOSS-Soft/other",revision:"r1"},{operation_id:"OP-0002",repository:null,revision:"p1"}]})},
  ];
  for (const {name,receipt} of cases) {
    const root=await createRepository(t); const repositoryControl=control(root); const store=createCoreControlStore({repository:repositoryControl});
    await repositoryControl.commitFiles({expectedHead:null,message:`aggregate ${name}`,files:{[intentPath(planned)]:planned,[receiptPath(receipt)]:receipt}});
    await assert.rejects(store.loadOrganizationState(),error => error?.code==="CONTROL_LEDGER_CONFLICT");
  }
  const root=await createRepository(t); const repositoryControl=control(root); const store=createCoreControlStore({repository:repositoryControl});
  const failed={...receiptForIntent(planned),status:"failed",observed_revisions:[]};
  const bootstrap=bootstrapFixture();
  const bootstrapped=await repositoryControl.commitFiles({expectedHead:null,message:"aggregate bootstrap",files:bootstrap.files});
  await repositoryControl.commitFiles({expectedHead:bootstrapped.commit_sha,message:"aggregate valid",files:{[intentPath(planned)]:planned,[receiptPath(failed)]:failed}});
  const first=await store.loadOrganizationState(); const second=await store.loadOrganizationState();
  assert.deepEqual(first.receipts.map(value => value.receipt_id),[failed.receipt_id,bootstrap.receipt.receipt_id]); assert.deepEqual(second,first);
});

test("all public readers reject distinct receipt identities after a valid root bootstrap",async t => {
  const planned=intent();
  for (const receipts of [
    [receiptForIntent(planned),receiptForIntent(planned,{number:"0002"})],
    [receiptForIntent(planned),{...receiptForIntent(planned,{number:"0002"}),status:"failed",observed_revisions:[]}],
  ]) {
    const {repositoryControl,store,head}=await createBootstrappedStore(t);
    const committed=await repositoryControl.commitFiles({expectedHead:head,message:"duplicate receipt binding",files:{[intentPath(planned)]:planned,...Object.fromEntries(receipts.map(value => [receiptPath(value),value]))}});
    assert.equal(sha256Canonical(await repositoryControl.readDocument(intentPath(planned),{at:committed.commit_sha})),sha256Canonical(planned));
    assert.equal(sha256Canonical(await repositoryControl.readDocument(receiptPath(receipts[0]),{at:committed.commit_sha})),sha256Canonical(receipts[0]));
    assert.equal(sha256Canonical(await repositoryControl.readDocument(receiptPath(receipts[1]),{at:committed.commit_sha})),sha256Canonical(receipts[1]));
    await assertAllPublicReadersConflict(store,{targetIntent:planned});
  }
});

test("all public readers reject an ordinary init subset receipt after a valid root bootstrap",async t => {
  const planned=createOperationIntent({intent_id:"INTENT-20260901-0001",created_at:"2026-09-01T08:00:00.000Z",command:"init",policy_revision:"POLICY-0001",source:{repository:"TOSS-Soft/toss-os-control",revision:"r1",sha256:"a".repeat(64)},authority:null,operations:[
    {resource:"repository",action:"commit",repository:"TOSS-Soft/toss-os-control",expected_revision:null,payload:{kind:"organization-config"}},
  ]});
  const receipt=receiptForIntent(planned,{observed_revisions:[]});
  const {repositoryControl,store,head}=await createBootstrappedStore(t);
  const committed=await repositoryControl.commitFiles({expectedHead:head,message:"init-like partial receipt",files:{[intentPath(planned)]:planned,[receiptPath(receipt)]:receipt}});
  assert.equal(sha256Canonical(await repositoryControl.readDocument(intentPath(planned),{at:committed.commit_sha})),sha256Canonical(planned));
  assert.equal(sha256Canonical(await repositoryControl.readDocument(receiptPath(receipt),{at:committed.commit_sha})),sha256Canonical(receipt));
  await assertAllPublicReadersConflict(store,{targetIntent:planned});
});

test("all public readers reject a later bootstrap-shaped subset receipt",async t => {
  const {repositoryControl,store,head}=await createBootstrappedStore(t);
  const later=bootstrapFixture({intentId:"INTENT-20260901-0001",receiptNumber:"0001"});
  const committed=await repositoryControl.commitFiles({
    expectedHead:head,
    message:"late bootstrap-shaped subset receipt",
    files:{[intentPath(later.intent)]:later.intent,[receiptPath(later.receipt)]:later.receipt},
  });
  assert.equal(sha256Canonical(await repositoryControl.readDocument(intentPath(later.intent),{at:committed.commit_sha})),sha256Canonical(later.intent));
  assert.equal(sha256Canonical(await repositoryControl.readDocument(receiptPath(later.receipt),{at:committed.commit_sha})),sha256Canonical(later.receipt));
  await assertAllPublicReadersConflict(store,{targetIntent:later.intent});
});

test("all public readers reject changed immutable root records",async t => {
  for (const [name,changed] of [
    ["intent",bootstrap => {
      const intent={...bootstrap.intent,source:{...bootstrap.intent.source,revision:"r1"}};
      return {intent,receipt:{...bootstrap.receipt,intent_sha256:sha256Canonical(intent)}};
    }],
    ["receipt",bootstrap => ({
      intent:bootstrap.intent,
      receipt:{...bootstrap.receipt,observed_revisions:bootstrap.receipt.observed_revisions.map((value,index) =>
        index===0 ? {...value,revision:"r2"} : value)},
    })],
  ]) {
    const {repositoryControl,store,bootstrap,head}=await createBootstrappedStore(t);
    const {intent,receipt}=changed(bootstrap);
    assert.equal(intentPath(intent),intentPath(bootstrap.intent));
    assert.equal(receiptPath(receipt),receiptPath(bootstrap.receipt));
    const files=name==="intent"
      ? {[intentPath(intent)]:intent,[receiptPath(receipt)]:receipt}
      : {[receiptPath(receipt)]:receipt};
    const committed=await repositoryControl.commitFiles({
      expectedHead:head,
      message:`changed root ${name}`,
      files,
    });
    assert.equal(sha256Canonical(await repositoryControl.readDocument(intentPath(intent),{at:committed.commit_sha})),sha256Canonical(intent));
    assert.equal(sha256Canonical(await repositoryControl.readDocument(receiptPath(receipt),{at:committed.commit_sha})),sha256Canonical(receipt));
    await assertAllPublicReadersConflict(store,{targetIntent:bootstrap.intent});
  }
});

test("all public readers reject byte-different immutable root records",async t => {
  for (const [name,pathFor,documentFor] of [
    ["intent",intentPath,bootstrap => bootstrap.intent],
    ["receipt",receiptPath,bootstrap => bootstrap.receipt],
  ]) {
    await t.test(name,async t => {
      const {root,repositoryControl,store,bootstrap,head:rootRevision}=await createBootstrappedStore(t);
      const document=documentFor(bootstrap);
      const path=pathFor(document);
      const rootBytes=(await git(root,["show",`${rootRevision}:${path}`])).stdout;
      const reformatted=`${JSON.stringify(document,null,2)}\n`;
      assert.notEqual(reformatted,rootBytes);
      assert.deepEqual(JSON.parse(reformatted),JSON.parse(rootBytes));

      await writeFile(join(root,path),reformatted,"utf8");
      await git(root,["add","--",path]);
      await git(root,["commit","-m",`reformat root ${name}`]);
      const currentRevision=await repositoryControl.head();
      const currentBytes=(await git(root,["show",`${currentRevision}:${path}`])).stdout;
      const rootBlob=(await git(root,["rev-parse",`${rootRevision}:${path}`])).stdout.trim();
      const currentBlob=(await git(root,["rev-parse",`${currentRevision}:${path}`])).stdout.trim();

      assert.equal(currentBytes,reformatted);
      assert.deepEqual(JSON.parse(currentBytes),JSON.parse(rootBytes));
      assert.notEqual(currentBlob,rootBlob);
      await assertAllPublicReadersConflict(store,{targetIntent:bootstrap.intent});
    });
  }
});

test("blob identity provider failures remain typed control-ledger conflicts",async t => {
  for (const documentBlobAt of [
    async () => "not-a-git-blob",
    async () => { throw new Error("blob provider failed"); },
  ]) {
    const {repositoryControl,head}=await createBootstrappedStore(t);
    const repository={
      head:repositoryControl.head,
      readDocument:repositoryControl.readDocument,
      listDocuments:repositoryControl.listDocuments,
      rootSnapshotAt:repositoryControl.rootSnapshotAt,
      documentBlobAt,
      commitFiles:repositoryControl.commitFiles,
    };
    const store=createCoreControlStore({repository});

    await assert.rejects(store.loadBootstrapState(),error =>
      error?.code==="CONTROL_LEDGER_CONFLICT");
    assert.match(head,/^[a-f0-9]{40}$/u);
  }
});

test("validated readers preserve repository fakes without a blob identity port",async t => {
  const {repositoryControl,bootstrap,head}=await createBootstrappedStore(t);
  const repository={
    head:async () => head,
    readDocument:repositoryControl.readDocument,
    listDocuments:repositoryControl.listDocuments,
    rootSnapshotAt:repositoryControl.rootSnapshotAt,
    commitFiles:repositoryControl.commitFiles,
  };
  const store=createCoreControlStore({repository});

  assert.equal((await store.loadBootstrapState()).intent.intent_id,bootstrap.intent.intent_id);
  assert.equal((await store.findReceipt(bootstrap.intent)).receipt_id,bootstrap.receipt.receipt_id);
});

test("intent and receipt readers return deeply frozen safe documents",async t => {
  const {store,planned,recorded}=await createPopulatedBootstrappedStore(t);

  const foundIntent=await store.findIntent(planned);
  const foundReceipt=await store.findReceipt(planned);

  assertDeeplyFrozen(foundIntent);
  assertDeeplyFrozen(foundReceipt);
  assert.throws(() => { foundIntent.source.revision="changed"; },TypeError);
  assert.throws(() => { foundIntent.operations.push(foundIntent.operations[0]); },TypeError);
  assert.throws(() => { foundReceipt.status="failed"; },TypeError);
  assert.throws(() => { foundReceipt.observed_revisions[0].revision="changed"; },TypeError);
  assert.deepEqual(foundIntent,planned);
  assert.deepEqual(foundReceipt,recorded);
});

test("organization and registry readers deeply freeze every returned document",async t => {
  const {store,bootstrap,planned,configuration}=await createPopulatedBootstrappedStore(t);

  const state=await store.loadOrganizationState();
  const organizationDocument=await store.loadOrganization();
  const registry=await store.loadRegistryState();
  const repository=await store.loadRepository(configuration.repository);
  const repositories=await store.listRepositories();
  const bootstrapState=await store.loadBootstrapState();

  for (const value of [state,organizationDocument,registry,repository,repositories,bootstrapState]) {
    assertDeeplyFrozen(value);
  }
  assert.throws(() => { state.receipts.pop(); },TypeError);
  const ordinaryReceipt=state.receipts.find(value => value.intent_id===planned.intent_id);
  assert.throws(() => { ordinaryReceipt.observed_revisions[0].revision="changed"; },TypeError);
  assert.throws(() => { state.programs[0].metadata.owners.push("team-b"); },TypeError);
  assert.throws(() => { state.organization.project.number=3; },TypeError);
  assert.throws(() => { organizationDocument.repositories.push("TOSS-Soft/other"); },TypeError);
  assert.throws(() => { registry.repositories[0].project_fields.status="changed"; },TypeError);
  assert.throws(() => { repository.project_fields.gate="changed"; },TypeError);
  assert.throws(() => { repositories.pop(); },TypeError);
  assert.throws(() => { bootstrapState.intent.operations.pop(); },TypeError);
  assert.equal(bootstrapState.intent.intent_id,bootstrap.intent.intent_id);
});

test("validated readers copy shared fake-repository documents before freezing",async t => {
  const {repositoryControl,bootstrap,head}=await createBootstrappedStore(t);
  const shared=new Map(Object.entries(bootstrap.files).map(([path,document]) => [
    path,JSON.parse(JSON.stringify(document)),
  ]));
  const sharedIntent=shared.get(intentPath(bootstrap.intent));
  const sharedReceipt=shared.get(receiptPath(bootstrap.receipt));
  const repository={
    head:async () => head,
    readDocument:async (path,{at}) => shared.has(path)
      ? shared.get(path)
      : repositoryControl.readDocument(path,{at}),
    listDocuments:repositoryControl.listDocuments,
    rootSnapshotAt:repositoryControl.rootSnapshotAt,
    commitFiles:repositoryControl.commitFiles,
  };
  const store=createCoreControlStore({repository});

  const foundIntent=await store.findIntent(bootstrap.intent);
  const foundReceipt=await store.findReceipt(bootstrap.intent);

  assert.notStrictEqual(foundIntent,sharedIntent);
  assert.notStrictEqual(foundIntent.operations,sharedIntent.operations);
  assert.notStrictEqual(foundReceipt,sharedReceipt);
  assertDeeplyFrozen(foundIntent);
  assertDeeplyFrozen(foundReceipt);
  assert.equal(Object.isFrozen(sharedIntent),false);
  assert.equal(Object.isFrozen(sharedIntent.operations),false);
  assert.equal(Object.isFrozen(sharedReceipt),false);
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

test("commit-msg hook vetoes publication and restores the control transaction",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const initial=await repositoryControl.commitFiles({
    expectedHead:null,
    message:"initial",
    files:{"config/organization.yaml":organization()},
  });
  await writeFile(join(root,"unrelated-staged.txt"),"staged\n");
  await git(root,["add","--","unrelated-staged.txt"]);
  const hook=join(root,".git","hooks","commit-msg");
  await writeFile(hook,"#!/bin/sh\nexit 1\n");
  await chmod(hook,0o755);

  await assert.rejects(repositoryControl.commitFiles({
    expectedHead:initial.commit_sha,
    message:"must fail",
    files:{"policies/lifecycle.yaml":{revision:"POLICY-0001"}},
  }),/hook|commit-msg|failed/i);

  assert.equal(await repositoryControl.head(),initial.commit_sha);
  assert.equal(await repositoryControl.readDocument("policies/lifecycle.yaml"),null);
  assert.equal((await git(root,["diff","--cached","--name-only"])).stdout,"unrelated-staged.txt\n");
});

test("a vetoing commit-msg hook cannot impersonate Git's missing-hook diagnostic",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const initial=await repositoryControl.commitFiles({
    expectedHead:null,
    message:"initial",
    files:{"config/organization.yaml":organization()},
  });
  await writeFile(join(root,"unrelated-staged.txt"),"staged\n");
  await git(root,["add","--","unrelated-staged.txt"]);
  const hook=join(root,".git","hooks","commit-msg");
  await writeFile(hook,"#!/bin/sh\nprintf 'cannot find a hook named commit-msg\\n' >&2\nexit 1\n");
  await chmod(hook,0o755);

  await assert.rejects(repositoryControl.commitFiles({
    expectedHead:initial.commit_sha,
    message:"must veto",
    files:{"policies/lifecycle.yaml":{revision:"POLICY-0001"}},
  }),/hook|commit-msg|failed/i);

  assert.equal(await repositoryControl.head(),initial.commit_sha);
  assert.equal(await repositoryControl.readDocument("policies/lifecycle.yaml"),null);
  assert.equal((await git(root,["diff","--cached","--name-only"])).stdout,"unrelated-staged.txt\n");
});

test("a hook staging an unrelated path is rejected before a control tree is published",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const initial=await repositoryControl.commitFiles({
    expectedHead:null,
    message:"initial",
    files:{"config/organization.yaml":organization()},
  });
  const hook=join(root,".git","hooks","pre-commit");
  await writeFile(hook,"#!/bin/sh\nprintf unexpected > unexpected.txt\ngit add unexpected.txt\n");
  await chmod(hook,0o755);

  await assert.rejects(repositoryControl.commitFiles({
    expectedHead:initial.commit_sha,
    message:"must fail",
    files:{"policies/lifecycle.yaml":{revision:"POLICY-0001"}},
  }),/unexpected path|unsupported control document extension|hook/i);

  assert.equal(await repositoryControl.head(),initial.commit_sha);
  await assert.rejects(git(root,["show",`${initial.commit_sha}:unexpected.txt`]),/does not exist|not in/i);
  assert.equal(await repositoryControl.readDocument("policies/lifecycle.yaml"),null);
});

test("prepare-commit-msg edits are reflected in the committed message",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const hook=join(root,".git","hooks","prepare-commit-msg");
  await writeFile(hook,"#!/bin/sh\nprintf 'rewritten control message\\n' > \"$1\"\n");
  await chmod(hook,0o755);

  const committed=await repositoryControl.commitFiles({
    expectedHead:null,
    message:"original message",
    files:{"config/organization.yaml":organization()},
  });

  assert.match((await git(root,["log","-1","--format=%B",committed.commit_sha])).stdout,/^rewritten control message\n/u);
});

test("a nonzero post-commit hook cannot veto an already published control commit",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const hook=join(root,".git","hooks","post-commit");
  await writeFile(hook,"#!/bin/sh\nexit 1\n");
  await chmod(hook,0o755);

  const committed=await repositoryControl.commitFiles({
    expectedHead:null,
    message:"published despite hook",
    files:{"config/organization.yaml":organization()},
  });

  assert.equal(await repositoryControl.head(),committed.commit_sha);
});

test("final index entries come from the proposed commit instead of hook-mutated working files",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const hook=join(root,".git","hooks","commit-msg");
  await writeFile(hook,"#!/bin/sh\nprintf 'revision: HOOK-MUTATED\\n' > policies/lifecycle.yaml\n");
  await chmod(hook,0o755);

  const committed=await repositoryControl.commitFiles({
    expectedHead:null,
    message:"canonical proposed index",
    files:{"policies/lifecycle.yaml":{revision:"POLICY-0001"}},
  });

  assert.equal((await git(root,["show",":policies/lifecycle.yaml"])).stdout,
    (await git(root,["show",`${committed.commit_sha}:policies/lifecycle.yaml`])).stdout);
  assert.equal((await git(root,["show",":policies/lifecycle.yaml"])).stdout,"revision: POLICY-0001\n");
});

test("temporary write failure removes its temp, lock, target, and created directory",async t => {
  const root=await createRepository(t);
  const seed=control(root);
  const initial=await seed.commitFiles({
    expectedHead:null,
    message:"initial",
    files:{"config/organization.yaml":organization()},
  });
  await writeFile(join(root,"unrelated-staged.txt"),"staged\n");
  await git(root,["add","--","unrelated-staged.txt"]);
  await writeFile(join(root,"unrelated-worktree.txt"),"worktree\n");
  const repositoryControl=controlWith(root,{writeTempFile:async () => {
    throw new Error("injected temporary write failure");
  }});

  await assert.rejects(repositoryControl.commitFiles({
    expectedHead:initial.commit_sha,
    message:"must fail",
    files:{"policies/lifecycle.yaml":{revision:"POLICY-0001"}},
  }),/injected temporary write failure/i);

  assert.equal(await repositoryControl.readDocument("policies/lifecycle.yaml"),null);
  assert.equal((await readdir(root)).includes("policies"),false);
  assert.equal((await readdir(root)).some(name => name.includes(".toss-core-")),false);
  assert.equal((await readdir(root)).includes(".toss-core.lock"),false);
  assert.equal((await git(root,["diff","--cached","--name-only"])).stdout,"unrelated-staged.txt\n");
  assert.equal((await git(root,["status","--porcelain"])).stdout,
    "A  unrelated-staged.txt\n?? unrelated-worktree.txt\n");
});

test("final index preparation failure rolls back before the durable CAS",async t => {
  const root=await createRepository(t);
  const seed=control(root);
  const initial=await seed.commitFiles({
    expectedHead:null,
    message:"initial",
    files:{"config/organization.yaml":organization()},
  });
  await writeFile(join(root,"unrelated-staged.txt"),"staged\n");
  await git(root,["add","--","unrelated-staged.txt"]);
  const repositoryControl=controlWith(root,{stageFinalIndex:async () => {
    throw new Error("injected final index preparation failure");
  }});

  await assert.rejects(repositoryControl.commitFiles({
    expectedHead:initial.commit_sha,
    message:"must fail",
    files:{"policies/lifecycle.yaml":{revision:"POLICY-0001"}},
  }),/injected final index preparation failure/i);

  assert.equal(await repositoryControl.head(),initial.commit_sha);
  assert.equal(await repositoryControl.readDocument("policies/lifecycle.yaml"),null);
  assert.equal((await git(root,["diff","--cached","--name-only"])).stdout,"unrelated-staged.txt\n");
});

test("post-CAS lock cleanup failure preserves the published commit result",async t => {
  const root=await createRepository(t);
  const repositoryControl=controlWith(root,{removeLock:async () => {
    const error=new Error("injected lock cleanup denial"); error.code="EACCES"; throw error;
  }});
  const committed=await repositoryControl.commitFiles({
    expectedHead:null,
    message:"published despite stale lock",
    files:{"policies/lifecycle.yaml":{revision:"POLICY-0001"}},
  });
  assert.equal(await repositoryControl.head(),committed.commit_sha);
  assert.deepEqual(await repositoryControl.readDocument("policies/lifecycle.yaml"),{revision:"POLICY-0001"});
});

test("findIntent rejects a duplicated persisted identity outside its canonical month",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const store=createCoreControlStore({repository:repositoryControl});
  const planned=intent();
  const first=await store.commitIntent({expectedHead:null,intent:planned});
  const duplicate={...planned,created_at:"2026-10-01T08:00:00.000Z"};
  await repositoryControl.commitFiles({
    expectedHead:first.commit_sha,
    message:"corrupt duplicate intent",
    files:{"intents/2026/10/INTENT-20260901-0001.json":duplicate},
  });

  await assert.rejects(store.findIntent(planned),error => error?.code==="CONTROL_LEDGER_CONFLICT");
});

test("organization state rejects duplicated receipt identities across months",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const first=receipt();
  const duplicate={...first,created_at:"2026-10-01T08:01:00.000Z"};
  await repositoryControl.commitFiles({
    expectedHead:null,
    message:"corrupt duplicate receipts",
    files:{
      "receipts/2026/09/RECEIPT-20260901-0001.json":first,
      "receipts/2026/10/RECEIPT-20260901-0001.json":duplicate,
    },
  });
  const store=createCoreControlStore({repository:repositoryControl});

  await assert.rejects(store.loadOrganizationState(),/duplicate|receipt/i);
});

test("store validates persisted core contracts and exposes exact intent lookup",async t => {
  const {store,head}=await createBootstrappedStore(t);
  const saved=await store.commitIntent({expectedHead:head,intent:intent()});

  assert.equal((await store.findIntent(intent())).intent_id,intent().intent_id);
  await assert.rejects(store.commitIntent({
    expectedHead:saved.commit_sha,
    intent:{...intent(),command:"repo.remove"},
  }),/immutable|different content|intent/i);
});

test("store exposes a revision-pinned head and exact receipt lookup for operation retries",async t => {
  const root=await createRepository(t);
  const store=createCoreControlStore({repository:control(root)});
  const bootstrap=bootstrapFixture();
  const bootstrapped=await store.commitBootstrap({expectedHead:null,files:bootstrap.files});
  const planned=intent();
  const saved=await store.commitIntent({expectedHead:bootstrapped.commit_sha,intent:planned});
  const recorded=receiptForIntent(planned);
  const receiptCommit=await store.commitReceipt({expectedHead:saved.commit_sha,receipt:recorded});

  assert.equal(await store.head(),receiptCommit.commit_sha);
  assert.deepEqual(await store.findReceipt(planned),recorded);
});

test("all public readers reject late or partial control state consistently",async t => {
  const root=await createRepository(t);
  await writeFile(join(root,"README.md"),"unrelated root\n","utf8");
  await git(root,["add","--","README.md"]);
  await git(root,["commit","-m","unrelated root"]);
  const repositoryControl=control(root);
  const store=createCoreControlStore({repository:repositoryControl});
  const fixture=bootstrapFixture();
  await repositoryControl.commitFiles({
    expectedHead:await repositoryControl.head(),
    message:"late bootstrap",
    files:fixture.files,
  });
  await assertAllPublicReadersConflict(store,{targetIntent:fixture.intent});
});

test("validated readers preserve a root bootstrap across ordinary ledger and configuration commits",async t => {
  const {store,bootstrap,head}=await createBootstrappedStore(t);
  const ordinaryIntent={...intent(),intent_id:"INTENT-20260901-0001"};
  const saved=await store.commitIntent({expectedHead:head,intent:ordinaryIntent});
  const ordinaryReceipt=receiptForIntent(ordinaryIntent,{number:"0001"});
  const recorded=await store.commitReceipt({expectedHead:saved.commit_sha,receipt:ordinaryReceipt});
  const config=repositoryConfig();
  await store.commitConfiguration({
    expectedHead:recorded.commit_sha,
    files:{
      "config/organization.yaml":{...bootstrap.organization,repositories:[config.repository]},
      [repositoryPath(config.repository)]:config,
    },
  });
  assert.equal((await store.loadBootstrapState()).receipt.receipt_id,bootstrap.receipt.receipt_id);
  assert.equal((await store.findReceipt(bootstrap.intent)).receipt_id,bootstrap.receipt.receipt_id);
  assert.equal((await store.findReceipt(ordinaryIntent)).receipt_id,ordinaryReceipt.receipt_id);
  assert.equal((await store.loadOrganizationState()).receipts.length,2);
  assert.equal((await store.loadRegistryState()).repositories.length,1);
  assert.equal((await store.loadOrganization()).organization,"TOSS-Soft");
  assert.equal((await store.loadRepository(config.repository)).repository,config.repository);
  assert.equal((await store.listRepositories()).length,1);
});

test("all public readers require the current organization and policy baseline",async t => {
  for (const path of [
    CONTROL_PATHS.organization,
    `${CONTROL_PATHS.policies}/lifecycle.yaml`,
    `${CONTROL_PATHS.policies}/release.yaml`,
  ]) {
    await t.test(path,async t => {
      const {root,store,bootstrap}=await createBootstrappedStore(t);
      await git(root,["rm","--",path]);
      await git(root,["commit","-m",`remove current baseline ${path}`]);
      await assertAllPublicReadersConflict(store,{targetIntent:bootstrap.intent});
    });
  }
});

test("receipt lookup rejects persisted receipt corruption in a partial control history",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root); const store=createCoreControlStore({repository:repositoryControl});
  const planned=intent(); const saved=await store.commitIntent({expectedHead:null,intent:planned});
  const incomplete={...receiptForIntent(planned),observed_revisions:[]};
  const corrupted=await repositoryControl.commitFiles({expectedHead:saved.commit_sha,message:"corrupt completed receipt",files:{[receiptPath(incomplete)]:incomplete}});
  await assert.rejects(store.findReceipt(planned),error => error?.code==="CONTROL_LEDGER_CONFLICT");
  const failedIntent={...planned,intent_id:"INTENT-20260901-0002"};
  const failedIntentCommit=await store.commitIntent({expectedHead:corrupted.commit_sha,intent:failedIntent});
  const failed={...receiptForIntent(failedIntent,{number:"0002",observed_revisions:[]}),status:"failed"};
  await store.commitReceipt({expectedHead:failedIntentCommit.commit_sha,receipt:failed});
  await assert.rejects(store.findReceipt(failedIntent),error => error?.code==="CONTROL_LEDGER_CONFLICT");
});

test("receipt lookup tags a divergent immutable ledger as a stable conflict",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const store=createCoreControlStore({repository:repositoryControl});
  const planned=intent();
  const saved=await store.commitIntent({expectedHead:null,intent:planned});
  await repositoryControl.commitFiles({
    expectedHead:saved.commit_sha,
    message:"corrupt receipt binding",
    files:{"receipts/2026/09/RECEIPT-20260901-0001.json":receipt()},
  });

  await assert.rejects(store.findReceipt(planned),error => error?.code==="CONTROL_LEDGER_CONFLICT");
});

test("intent lookup tags divergent immutable content as a stable conflict",async t => {
  const root=await createRepository(t);
  const store=createCoreControlStore({repository:control(root)});
  const planned=intent();
  await store.commitIntent({expectedHead:null,intent:planned});

  await assert.rejects(store.findIntent({...planned,operations:[{
    ...planned.operations[0],payload:{default_branch:"trunk"},
  }]}),error => error?.code==="CONTROL_LEDGER_CONFLICT");
});

test("intent commit tags stale head and immutable identity conflicts",async t => {
  const root=await createRepository(t);
  const store=createCoreControlStore({repository:control(root)});
  const planned=intent();
  const saved=await store.commitIntent({expectedHead:null,intent:planned});

  await assert.rejects(store.commitIntent({expectedHead:null,intent:planned}),error => error?.code==="CONTROL_LEDGER_CONFLICT");
  await assert.rejects(store.commitIntent({expectedHead:saved.commit_sha,intent:{
    ...planned,operations:[{...planned.operations[0],payload:{default_branch:"trunk"}}],
  }}),error => error?.code==="CONTROL_LEDGER_CONFLICT");
});

test("bootstrap commits its closed configuration, intent, and receipt in one unborn-repository CAS",async t => {
  const root=await createRepository(t);
  const store=createCoreControlStore({repository:control(root)});
  const bootOrganization={...organization(),repositories:[]}; const lifecycle={revision:"POLICY-0001"}; const release={revision:"POLICY-0001"};
  const hashes={organization:sha256Canonical(bootOrganization),lifecycle:sha256Canonical(lifecycle),release:sha256Canonical(release)};
  const controlRepository="TOSS-Soft/toss-os-control";
  const planned=createOperationIntent({intent_id:"INTENT-20260901-0001",created_at:"2026-09-01T08:00:00.000Z",command:"init",policy_revision:"POLICY-0001",source:{repository:controlRepository,revision:"abc123",sha256:"a".repeat(64)},authority:{record_id:"AUTH-20260901-0001",sha256:"a".repeat(64)},operations:[
    {resource:"repository",action:"create",repository:controlRepository,expected_revision:null,payload:{kind:"create-private-control-repository",private:true,files:hashes}},
    {resource:"repository",action:"update",repository:controlRepository,expected_revision:null,payload:{kind:"verify-default-branch-protection"}},
    {resource:"project",action:"update",repository:null,expected_revision:"project-r1",payload:{kind:"discover-project-fields",project:bootOrganization.project}},
    ...[["organization-config",hashes.organization],["lifecycle-policy",hashes.lifecycle],["release-policy",hashes.release]].map(([kind,sha256]) => ({resource:"repository",action:"commit",repository:controlRepository,expected_revision:null,payload:{kind,sha256}})),
    {resource:"repository",action:"commit",repository:controlRepository,expected_revision:null,payload:{kind:"first-control-transaction",files:hashes}},
  ]});
  const recorded=receiptForIntent(planned);
  recorded.status="completed"; recorded.observed_revisions=planned.operations.filter(operation => !["organization-config","lifecycle-policy","release-policy","first-control-transaction"].includes(operation.payload.kind)).map(operation => ({operation_id:operation.operation_id,repository:operation.repository,revision:"abc123"}));
  const committed=await store.commitBootstrap({expectedHead:null,files:{
    "config/organization.yaml":bootOrganization,
    "policies/lifecycle.yaml":lifecycle,
    "policies/release.yaml":release,
    "intents/2026/09/INTENT-20260901-0001.json":planned,
    "receipts/2026/09/RECEIPT-20260901-0001.json":recorded,
  }});
  assert.match(committed.commit_sha,/^[a-f0-9]{40}$/u);
  assert.equal((await store.loadOrganization()).organization,"TOSS-Soft");
  assert.equal((await store.loadOrganizationState()).receipts[0].receipt_id,"RECEIPT-20260901-0001");
  assert.equal((await store.loadBootstrapState()).intent.intent_id,"INTENT-20260901-0001");
  await assert.rejects(store.commitBootstrap({expectedHead:committed.commit_sha,files:{"config/organization.yaml":organization()}}),/unborn|bootstrap|head/i);
});

test("persisted bootstrap corruption never establishes initialized state",async t => {
  const build=() => {
    const organization={schema_version:"organization-config.v1",organization:"TOSS-Soft",project:{node_id:"PVT_kwDO",number:2},control_repository:"TOSS-Soft/toss-os-control",policy_revision:"POLICY-0001",repositories:[]}; const lifecycle={revision:"POLICY-0001"}; const release={revision:"POLICY-0001"}; const hashes={organization:sha256Canonical(organization),lifecycle:sha256Canonical(lifecycle),release:sha256Canonical(release)}; const repository="TOSS-Soft/toss-os-control";
    const intent=createOperationIntent({intent_id:"INTENT-20260901-0099",created_at:"2026-09-01T08:00:00.000Z",command:"init",policy_revision:"POLICY-0001",source:{repository,revision:"r0",sha256:"a".repeat(64)},authority:{record_id:"AUTH-20260901-0001",sha256:"a".repeat(64)},operations:[
      {resource:"repository",action:"create",repository,expected_revision:null,payload:{kind:"create-private-control-repository",private:true,files:hashes}}, {resource:"repository",action:"update",repository,expected_revision:null,payload:{kind:"verify-default-branch-protection"}}, {resource:"project",action:"update",repository:null,expected_revision:null,payload:{kind:"discover-project-fields",project:organization.project}},
      ...[["organization-config",hashes.organization],["lifecycle-policy",hashes.lifecycle],["release-policy",hashes.release]].map(([kind,sha256]) => ({resource:"repository",action:"commit",repository,expected_revision:null,payload:{kind,sha256}})), {resource:"repository",action:"commit",repository,expected_revision:null,payload:{kind:"first-control-transaction",files:hashes}},
    ]});
    const receipt={...receiptForIntent(intent,{number:"0099",observed_revisions:intent.operations.filter(operation => !["organization-config","lifecycle-policy","release-policy","first-control-transaction"].includes(operation.payload.kind)).map(operation => ({operation_id:operation.operation_id,repository:operation.repository,revision:"r1"}))})};
    return {organization,lifecycle,release,intent,receipt};
  };
  for (const [index,mutation] of [
    value => ({...value,receipt:{...value.receipt,status:"failed"}}),
    value => ({...value,receipt:{...value.receipt,observed_revisions:value.receipt.observed_revisions.slice(1)}}),
    value => ({...value,receipt:{...value.receipt,observed_revisions:[...value.receipt.observed_revisions,{...value.receipt.observed_revisions[0]}]}}),
    value => { const intent={...value.intent,operations:value.intent.operations.map(operation => operation.payload.kind==="organization-config" ? {...operation,payload:{...operation.payload,sha256:"b".repeat(64)}} : operation)}; return {...value,intent,receipt:{...value.receipt,intent_sha256:sha256Canonical(intent)}}; },
    value => { const intent={...value.intent,operations:value.intent.operations.map(operation => operation.payload.kind==="verify-default-branch-protection" ? {...operation,action:"create",payload:{kind:"unexpected"}} : operation)}; return {...value,intent,receipt:{...value.receipt,intent_sha256:sha256Canonical(intent)}}; },
    value => { const intent={...value.intent,operations:value.intent.operations.map(operation => operation.payload.kind==="create-private-control-repository" ? {...operation,expected_revision:"unexpected"} : operation)}; return {...value,intent,receipt:{...value.receipt,intent_sha256:sha256Canonical(intent)}}; },
    value => { const operations=[...value.intent.operations]; [operations[0],operations[1]]=[operations[1],operations[0]]; const intent={...value.intent,operations}; return {...value,intent,receipt:{...value.receipt,intent_sha256:sha256Canonical(intent)}}; },
    value => ({...value,receipt:{...value.receipt,observed_revisions:value.receipt.observed_revisions.map((observation,index) => index===0 ? {...observation,revision:null} : observation)}}),
    value => ({...value,lifecycle:{revision:"POLICY-OTHER"}}),
    value => ({...value,organization:{...value.organization,project:{node_id:"PVT_other",number:8}}}),
  ].entries()) {
    const root=await createRepository(t); const repositoryControl=control(root); const store=createCoreControlStore({repository:repositoryControl}); const value=mutation(build());
    const files={"config/organization.yaml":value.organization,"policies/lifecycle.yaml":value.lifecycle,"policies/release.yaml":value.release,[`intents/2026/09/${value.intent.intent_id}.json`]:value.intent,[`receipts/2026/09/${value.receipt.receipt_id}.json`]:value.receipt};
    await repositoryControl.commitFiles({expectedHead:null,message:"corrupt bootstrap fixture",files});
    await assert.rejects(store.loadBootstrapState(),error => error?.code==="CONTROL_LEDGER_CONFLICT");
    if (index!==0) await assert.rejects(store.loadOrganizationState(),error => error?.code==="CONTROL_LEDGER_CONFLICT");
  }
});

test("bootstrap state validates current control material before returning absent",async t => {
  const root=await createRepository(t);
  await writeFile(join(root,"README.md"),"unrelated root\n","utf8");
  await git(root,["add","--","README.md"]);
  await git(root,["commit","-m","unrelated root"]);
  const repositoryControl=control(root);
  const store=createCoreControlStore({repository:repositoryControl});
  assert.equal(await store.loadBootstrapState(),null);

  const fixture=bootstrapFixture();
  await repositoryControl.commitFiles({
    expectedHead:await repositoryControl.head(),
    message:"late bootstrap-shaped transaction",
    files:fixture.files,
  });
  await assert.rejects(store.loadBootstrapState(),error =>
    error?.code==="CONTROL_LEDGER_CONFLICT");
});

test("partial control roots are corruption, never absent bootstrap",async t => {
  for (const [name,files] of [
    ["organization",{"config/organization.yaml":{...organization(),repositories:[]}}],
    ["policy",{"policies/lifecycle.yaml":{revision:"POLICY-0001"}}],
    ["program",{"programs/P1/manifest.yaml":{id:"P1"}}],
    ["migration",{"migrations/M1/snapshot.json":{id:"M1"}}],
  ]) {
    const root=await createRepository(t);
    const repositoryControl=control(root);
    await repositoryControl.commitFiles({expectedHead:null,message:`partial ${name}`,files});
    const store=createCoreControlStore({repository:repositoryControl});
    await assert.rejects(store.loadBootstrapState(),error =>
      error?.code==="CONTROL_LEDGER_CONFLICT");
  }
});

test("store wraps malformed root ports without invoking hostile fields",async () => {
  let getterCalls=0;
  const accessor={paths:[]};
  Object.defineProperty(accessor,"revision",{
    enumerable:true,
    get() { getterCalls+=1; return "a".repeat(40); },
  });
  const hostileProxy=new Proxy({}, {
    getOwnPropertyDescriptor() { getterCalls+=1; throw new Error("trap"); },
    ownKeys() { getterCalls+=1; throw new Error("trap"); },
  });
  const nestedPathsProxy=new Proxy([], {
    getOwnPropertyDescriptor() { getterCalls+=1; throw new Error("trap"); },
    ownKeys() { getterCalls+=1; throw new Error("trap"); },
  });
  const hidden={revision:"a".repeat(40),paths:[]};
  Object.defineProperty(hidden,"hidden",{enumerable:false,value:true});
  const symbolic={revision:"a".repeat(40),paths:[],[Symbol("hidden")]:true};
  const cases=[
    async () => accessor,
    async () => hostileProxy,
    async () => ({revision:"a".repeat(40),paths:nestedPathsProxy}),
    async () => hidden,
    async () => symbolic,
    async () => { throw new Error("provider failed"); },
  ];
  for (const rootPort of cases) {
    const store=createCoreControlStore({repository:repositoryWithRootPort(rootPort)});
    await assert.rejects(store.loadBootstrapState(),error =>
      error?.code==="CONTROL_LEDGER_CONFLICT");
  }
  assert.equal(getterCalls,0);
});

test("validated ledger closes each pinned path inventory before identity resolution",async () => {
  const revision="a".repeat(40);
  let hostileCalls=0;
  const accessor=[];
  Object.defineProperty(accessor,"0",{
    enumerable:true,
    configurable:true,
    get() { hostileCalls+=1; return "intents/2026/09/INTENT-20260901-0001.json"; },
  });
  const hidden=[];
  Object.defineProperty(hidden,"hidden",{value:"intents/hidden.json"});
  const extra=[];
  extra.extra="intents/extra.json";
  const sparse=Array(2);
  sparse[1]="intents/2026/09/INTENT-20260901-0001.json";
  const proxy=new Proxy([],{
    ownKeys() { hostileCalls+=1; throw new Error("must not enumerate proxy"); },
    getOwnPropertyDescriptor() { hostileCalls+=1; throw new Error("must not inspect proxy"); },
  });
  for (const paths of [accessor,hidden,extra,sparse,proxy]) {
    const repository=repositoryWithRootPort(async () => ({revision,paths:[]}));
    const store=createCoreControlStore({repository:Object.freeze({
      ...repository,
      async listDocuments(prefix) { return prefix===CONTROL_PATHS.intents ? paths : []; },
    })});
    await assert.rejects(store.loadOrganizationState(),error =>
      error?.code==="CONTROL_LEDGER_CONFLICT");
  }
  assert.equal(hostileCalls,0);

  let headCalls=0;
  const inventories=[];
  const store=createCoreControlStore({repository:Object.freeze({
    async head() { headCalls+=1; return revision; },
    async readDocument() { return null; },
    async listDocuments(prefix,{at}) {
      inventories.push({prefix,at});
      return [];
    },
    async rootSnapshotAt({at}) { assert.equal(at,revision); return {revision,paths:[]}; },
    async commitFiles() { throw new Error("write is not expected"); },
  })});
  assert.equal(await store.loadBootstrapState(),null);
  assert.equal(headCalls,1);
  assert.deepEqual(inventories.map(value => value.prefix).sort(),[...CONTROL_ROOTS].sort());
  assert.equal(inventories.every(value => value.at===revision),true);
});

test("bootstrap state returns a deeply frozen root proof",async t => {
  const root=await createRepository(t);
  const store=createCoreControlStore({repository:control(root)});
  const fixture=bootstrapFixture();
  await store.commitBootstrap({expectedHead:null,files:fixture.files});

  const state=await store.loadBootstrapState();

  assert.equal(Object.isFrozen(state.organization),true);
  assert.equal(Object.isFrozen(state.organization.project),true);
  assert.equal(Object.isFrozen(state.lifecycle),true);
  assert.equal(Object.isFrozen(state.intent.operations),true);
  assert.equal(Object.isFrozen(state.receipt.observed_revisions),true);
});

test("intent commit atomically reserves one globally unique planned receipt identity",async t => {
  const {store,repositoryControl,bootstrap,head}=await createBootstrappedStore(t);
  const operation={resource:"repository",action:"update",repository:"TOSS-Soft/toss-cli",
    expected_revision:"repository-1",payload:{kind:"planned-receipt-probe"}};
  const intentWith=(intentId,plannedReceiptId) => createOperationIntent({
    intent_id:intentId,created_at:"2026-09-03T08:00:00.000Z",command:"release.activate",
    policy_revision:"POLICY-0001",
    source:{repository:bootstrap.organization.control_repository,revision:head,sha256:"d".repeat(64)},
    authority:null,planned_receipt_id:plannedReceiptId,operations:[operation],
  });
  const colliding=intentWith("INTENT-20260903-0098",bootstrap.receipt.receipt_id);
  await assert.rejects(store.commitIntent({expectedHead:head,intent:colliding}),error =>
    error?.code==="CONTROL_LEDGER_CONFLICT");
  assert.equal(await store.head(),head);

  const planned=intentWith("INTENT-20260903-0099","RECEIPT-20260901-0100");
  const committed=await store.commitIntent({expectedHead:head,intent:planned});
  const {planned_receipt_id:_reservation,...legacyLookup}=planned;
  assert.equal(canonicalJson(await store.findIntent(legacyLookup)),canonicalJson(planned));
  const recorded=receiptForIntent(planned,{number:"0100",observed_revisions:[{
    operation_id:planned.operations[0].operation_id,repository:planned.operations[0].repository,
    revision:"repository-2",
  }]});
  const completed=await store.commitReceipt({expectedHead:committed.commit_sha,receipt:recorded});
  assert.deepEqual(await store.findReceipt(planned),recorded);

  const corrupt=intentWith("INTENT-20260903-0100",planned.planned_receipt_id);
  await repositoryControl.commitFiles({expectedHead:completed.commit_sha,
    message:"inject duplicate planned receipt reservation",
    files:{[intentPath(corrupt)]:corrupt}});
  await assert.rejects(store.loadOperationState(),error =>
    error?.code==="CONTROL_LEDGER_CONFLICT");
});

test("release program finalization atomically CAS-writes the manifest and its logical-revision receipt",async t => {
  const {store,bootstrap,head}=await createBootstrappedStore(t);
  const configuration=repositoryConfig();
  const configured=await store.commitConfiguration({
    expectedHead:head,
    files:{
      [CONTROL_PATHS.organization]:{...bootstrap.organization,repositories:[configuration.repository]},
      [repositoryPath(configuration.repository)]:configuration,
    },
  });
  const releaseId="REL-TOSS-OS-R0001-cli";
  const program={
    schema_version:"release-program.v1",program_id:"TOSS-OS-R0001",phase:"DRAFT",
    revision:"REV-0001",
    repository_releases:[{
      schema_version:"repository-release.v1",release_id:releaseId,
      program_id:"TOSS-OS-R0001",repository:configuration.repository,phase:"DRAFT",
      revision:"REV-0001",version:null,milestone:null,branch:null,release_pr_intent:null,
      scope:[`${configuration.repository}#10`],publication_evidence:null,transitions:[],
    }],
    dependency_stages:[{stage:1,repository_release_ids:[releaseId]}],
    selected_scope:[{epic_id:`${configuration.repository}#10`,outcome:"release-store",
      eligibility:{approved:true,unversioned:true,decomposed:true,registered_repository:true,unassigned:true}}],
    deferred_scope:[],
    rationale:[{repository:configuration.repository,version:"2.2.0",change_class:"minor",
      reasons:[{rule:"backward_compatible_feature",scope_ids:[`${configuration.repository}#10`]}]}],
    interrupts:null,created_at:"2026-09-03T08:00:00.000Z",updated_at:"2026-09-03T08:00:00.000Z",
  };
  const ordinaryIntent=createOperationIntent({
    intent_id:"INTENT-20260901-0002",created_at:"2026-09-01T08:00:00.000Z",
    command:"repo.add",policy_revision:"POLICY-0001",
    source:{repository:bootstrap.organization.control_repository,revision:configured.commit_sha,sha256:"b".repeat(64)},
    authority:null,operations:[{resource:"repository",action:"update",
      repository:configuration.repository,expected_revision:"repository-1",payload:{kind:"ordinary"}}],
  });
  const ordinaryIntentCommit=await store.commitIntent({
    expectedHead:configured.commit_sha,intent:ordinaryIntent,
  });
  const ordinaryReceipt=receiptForIntent(ordinaryIntent,{number:"0002"});
  const ordinaryReceiptCommit=await store.commitReceipt({
    expectedHead:ordinaryIntentCommit.commit_sha,receipt:ordinaryReceipt,
  });
  const planned=createOperationIntent({
    intent_id:"INTENT-20260903-0001",created_at:"2026-09-03T08:00:00.000Z",
    command:"release.plan",policy_revision:"POLICY-0001",
    source:{repository:bootstrap.organization.control_repository,revision:ordinaryReceiptCommit.commit_sha,sha256:"a".repeat(64)},
    authority:null,
    operations:[{resource:"repository",action:"commit",repository:bootstrap.organization.control_repository,
      expected_revision:null,payload:{kind:"release-program-manifest",expected_program_revision:null,program}}],
  });
  const intentCommit=await store.commitIntent({expectedHead:ordinaryReceiptCommit.commit_sha,intent:planned});
  const observation=await store.inspectReleaseProgramOperation(planned.operations[0]);
  assert.deepEqual(observation,{operation_id:"OP-0001",repository:bootstrap.organization.control_repository,revision:null});
  const recorded=receiptForIntent(planned,{number:"0001",observed_revisions:[{
    operation_id:"OP-0001",repository:bootstrap.organization.control_repository,revision:"REV-0001",
  }]});
  for (const existing of [bootstrap.receipt,ordinaryReceipt]) {
    const colliding={...recorded,receipt_id:existing.receipt_id,created_at:existing.created_at};
    await assert.rejects(store.commitReleaseProgramReceipt({
      expectedHead:intentCommit.commit_sha,operation:planned.operations[0],receipt:colliding,
    }),error => error?.code==="CONTROL_LEDGER_CONFLICT");
    assert.equal(await store.head(),intentCommit.commit_sha);
  }
  assert.deepEqual((await store.loadBootstrapState()).receipt,bootstrap.receipt);
  await store.commitReleaseProgramReceipt({
    expectedHead:intentCommit.commit_sha,operation:planned.operations[0],receipt:recorded,
  });

  const state=await store.loadReleasePlanningState();
  assert.equal(state.programs[0].program_id,"TOSS-OS-R0001");
  assert.equal(state.programs[0].revision,"REV-0001");
  assert.equal(state.receipts.some(value => value.receipt_id===recorded.receipt_id),true);
  assert.equal(programPath(program.program_id),"programs/TOSS-OS-R0001/manifest.yaml");
  assertDeeplyFrozen(state);
});

test("release program finalization records an exact unchanged manifest as a receipt-only commit",async t => {
  const {root,store,bootstrap,head}=await createBootstrappedStore(t);
  const configuration=repositoryConfig();
  const configured=await store.commitConfiguration({
    expectedHead:head,
    files:{
      [CONTROL_PATHS.organization]:{...bootstrap.organization,repositories:[configuration.repository]},
      [repositoryPath(configuration.repository)]:configuration,
    },
  });
  const releaseId="REL-TOSS-OS-R0001-cli";
  const program={
    schema_version:"release-program.v1",program_id:"TOSS-OS-R0001",phase:"DRAFT",
    revision:"REV-0001",
    repository_releases:[{
      schema_version:"repository-release.v1",release_id:releaseId,
      program_id:"TOSS-OS-R0001",repository:configuration.repository,phase:"DRAFT",
      revision:"REV-0001",version:null,milestone:null,branch:null,release_pr_intent:null,
      scope:[`${configuration.repository}#10`],publication_evidence:null,transitions:[],
    }],
    dependency_stages:[{stage:1,repository_release_ids:[releaseId]}],
    selected_scope:[{epic_id:`${configuration.repository}#10`,outcome:"release-store",
      eligibility:{approved:true,unversioned:true,decomposed:true,registered_repository:true,
        unassigned:true}}],
    deferred_scope:[],
    rationale:[{repository:configuration.repository,version:"2.2.0",change_class:"minor",
      reasons:[{rule:"backward_compatible_feature",scope_ids:[`${configuration.repository}#10`]}]}],
    interrupts:null,created_at:"2026-09-03T08:00:00.000Z",updated_at:"2026-09-03T08:00:00.000Z",
  };
  const manifestIntent=({number,sourceRevision,expectedRevision,nextProgram}) =>
    createOperationIntent({
      intent_id:`INTENT-20260903-${number}`,
      created_at:"2026-09-03T08:00:00.000Z",
      command:"release.plan",policy_revision:"POLICY-0001",
      source:{repository:bootstrap.organization.control_repository,
        revision:sourceRevision,sha256:"a".repeat(64)},
      authority:null,planned_receipt_id:`RECEIPT-20260903-${number}`,
      operations:[{resource:"repository",action:"commit",
        repository:bootstrap.organization.control_repository,
        expected_revision:expectedRevision,
        payload:{kind:"release-program-manifest",
          expected_program_revision:expectedRevision,program:nextProgram}}],
    });
  const github={
    async snapshot() { throw new Error("manifest-only execution must not snapshot GitHub"); },
    async inspect() { throw new Error("manifest-only execution must not inspect GitHub"); },
    async apply() { throw new Error("manifest-only execution must not mutate GitHub"); },
  };
  const runner=createOperationRunner({
    control:store,github,authorityRegistry:{keys:[]},
    clock:() => "2026-09-03T08:00:00.000Z",
    idGenerator:() => "RECEIPT-20260903-9999",
    policyRevision:() => "POLICY-0001",
  });

  const initial=manifestIntent({number:"0100",sourceRevision:configured.commit_sha,
    expectedRevision:null,nextProgram:program});
  const initialReceipt=await runner.apply(initial);
  assert.equal(initialReceipt.status,"completed");

  const beforeUnchanged=await store.head();
  const unchanged=manifestIntent({number:"0101",sourceRevision:beforeUnchanged,
    expectedRevision:"REV-0001",nextProgram:program});
  const unchangedReceipt=await runner.apply(unchanged);
  const afterUnchanged=await store.head();

  assert.equal(unchangedReceipt.status,"completed");
  assert.notEqual(afterUnchanged,beforeUnchanged);
  assert.deepEqual((await store.loadReleasePlanningState()).programs,[program]);
  assert.equal(canonicalJson(await store.findReceipt(unchanged)),canonicalJson(unchangedReceipt));
  assert.equal((await git(root,["diff-tree","--no-commit-id","--name-only","-r",afterUnchanged])).stdout,
    `${receiptPath(unchangedReceipt)}\n`);

  const drifted={...program,updated_at:"2026-09-03T08:01:00.000Z"};
  const drift=manifestIntent({number:"0102",sourceRevision:afterUnchanged,
    expectedRevision:"REV-0001",nextProgram:drifted});
  await assert.rejects(store.inspectReleaseProgramOperation(drift.operations[0]),error =>
    error?.code==="CONTROL_LEDGER_CONFLICT");
  assert.equal(await store.head(),afterUnchanged);

  const advanced={...program,revision:"REV-0002",updated_at:"2026-09-03T08:01:00.000Z"};
  const next=manifestIntent({number:"0103",sourceRevision:afterUnchanged,
    expectedRevision:"REV-0001",nextProgram:advanced});
  const nextReceipt=await runner.apply(next);
  const finalState=await store.loadReleasePlanningState();
  assert.equal(nextReceipt.status,"completed");
  assert.equal(finalState.programs[0].revision,"REV-0002");
  assert.equal(finalState.receipts.some(value => value.receipt_id===nextReceipt.receipt_id),true);
});
