import assert from "node:assert/strict";
import {execFile as childExecFile} from "node:child_process";
import {chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import test from "node:test";

import {sha256Canonical} from "../src/contracts/acp.js";
import {createOperationIntent} from "../src/core/operations/plan.js";
import {createGitControlRepository} from "../src/core/control/git-repository.js";
import {
  closeDocumentPaths,
  closeRootSnapshot,
  hasControlMaterial,
} from "../src/core/control/root-snapshot.js";
import {
  CONTROL_PATHS,
  createCoreControlStore,
  intentPath,
  receiptPath,
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
    files:{"config/organization.yaml":organization(),[path]:repositoryConfig()},
  });
  assert.deepEqual(await repositoryControl.readDocument(path),repositoryConfig());
  await assert.rejects(repositoryControl.readDocument("config/repositories/toss-soft%2ftoss-cli.yaml"),/unsafe relative path/i);
  await assert.rejects(repositoryControl.readDocument("config/repositories/toss-soft%20toss-cli.yaml"),/unsafe relative path/i);
  await assert.rejects(repositoryControl.readDocument("config/toss-soft%2Ftoss-cli.yaml"),/unsafe relative path/i);
  await assert.rejects(repositoryControl.readDocument("config/repositories/toss-soft%2Ftoss-cli.json"),/unsafe relative path|unsupported/i);
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
    listDocuments:async (_prefix,{at}) => {
      revisions.push(at);
      return [];
    },
    rootSnapshotAt:async ({at}) => ({revision:at,paths:[]}),
    commitFiles:async () => { throw new Error("not used"); },
  };
  const store=createCoreControlStore({repository});

  const state=await store.loadOrganizationState();

  assert.equal(state.organization.organization,"TOSS-Soft");
  assert.deepEqual(state.repositories,[repositoryConfig()]);
  assert.ok(revisions.length>=2);
  assert.deepEqual([...new Set(revisions)],[snapshot]);
});

test("organization state lists populated programs and receipts at its initially resolved revision",async t => {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const firstIntent=intent(); const secondIntent={...intent(),intent_id:"INTENT-20260901-0002"};
  const initial=await repositoryControl.commitFiles({
    expectedHead:null,
    message:"populated state",
    files:{
      "config/organization.yaml":organization(),
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
  ]);
  assert.deepEqual([...new Set(revisions)],[initial.commit_sha]);
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
  await repositoryControl.commitFiles({expectedHead:null,message:"aggregate valid",files:{[intentPath(planned)]:planned,[receiptPath(failed)]:failed}});
  const first=await store.loadOrganizationState(); const second=await store.loadOrganizationState();
  assert.deepEqual(first.receipts,[failed]); assert.deepEqual(second,first);
});

test("all receipt readers reject distinct receipt identities bound to one intent",async t => {
  const planned=intent();
  for (const receipts of [
    [receiptForIntent(planned),receiptForIntent(planned,{number:"0002"})],
    [receiptForIntent(planned),{...receiptForIntent(planned,{number:"0002"}),status:"failed",observed_revisions:[]}],
  ]) {
    const root=await createRepository(t); const repositoryControl=control(root); const store=createCoreControlStore({repository:repositoryControl});
    await repositoryControl.commitFiles({expectedHead:null,message:"duplicate receipt binding",files:{[intentPath(planned)]:planned,...Object.fromEntries(receipts.map(receipt => [receiptPath(receipt),receipt]))}});
    await assert.rejects(store.loadOrganizationState(),error => error?.code==="CONTROL_LEDGER_CONFLICT");
    await assert.rejects(store.findReceipt(planned),error => error?.code==="CONTROL_LEDGER_CONFLICT");
  }
});

test("aggregate state rejects init-like partial receipts without a complete bootstrap proof",async t => {
  const planned=createOperationIntent({intent_id:"INTENT-20260901-0001",created_at:"2026-09-01T08:00:00.000Z",command:"init",policy_revision:"POLICY-0001",source:{repository:"TOSS-Soft/toss-os-control",revision:"r1",sha256:"a".repeat(64)},authority:null,operations:[
    {resource:"repository",action:"commit",repository:"TOSS-Soft/toss-os-control",expected_revision:null,payload:{kind:"organization-config"}},
  ]});
  const receipt=receiptForIntent(planned,{observed_revisions:[]});
  const root=await createRepository(t); const repositoryControl=control(root); const store=createCoreControlStore({repository:repositoryControl});
  await repositoryControl.commitFiles({expectedHead:null,message:"init-like partial receipt",files:{[intentPath(planned)]:planned,[receiptPath(receipt)]:receipt}});
  await assert.rejects(store.loadOrganizationState(),error => error?.code==="CONTROL_LEDGER_CONFLICT");
  await assert.rejects(store.findReceipt(planned),error => error?.code==="CONTROL_LEDGER_CONFLICT");
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
  const root=await createRepository(t);
  const store=createCoreControlStore({repository:control(root)});
  const saved=await store.commitIntent({expectedHead:null,intent:intent()});

  assert.equal((await store.findIntent(intent())).intent_id,intent().intent_id);
  await assert.rejects(store.commitIntent({
    expectedHead:saved.commit_sha,
    intent:{...intent(),command:"repo.remove"},
  }),/immutable|different content|intent/i);
});

test("store exposes a revision-pinned head and exact receipt lookup for operation retries",async t => {
  const root=await createRepository(t);
  const store=createCoreControlStore({repository:control(root)});
  const planned=intent();
  const saved=await store.commitIntent({expectedHead:null,intent:planned});
  const recorded=receiptForIntent(planned);
  const receiptCommit=await store.commitReceipt({expectedHead:saved.commit_sha,receipt:recorded});

  assert.equal(await store.head(),receiptCommit.commit_sha);
  assert.deepEqual(await store.findReceipt(planned),recorded);
});

test("receipt lookup rejects a persisted incomplete completed receipt but permits failed partial evidence",async t => {
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
