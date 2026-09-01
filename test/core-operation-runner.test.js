import assert from "node:assert/strict";
import {generateKeyPairSync,sign} from "node:crypto";
import test from "node:test";

import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {authorityReference,verifyAuthority} from "../src/core/authority.js";
import {parseCoreCommand} from "../src/core/commands/router.js";
import {CoreBlockedError,CoreConflictError,CoreRemoteError} from "../src/core/errors.js";
import {createOperationIntent,operationPreview} from "../src/core/operations/plan.js";
import {createOperationRunner} from "../src/core/operations/runner.js";

test("operation intents canonicalize logical operation order before hashing",() => {
  const common={
    intent_id:"INTENT-20260901-0001",
    created_at:"2026-09-01T08:00:00.000Z",
    command:"repo.add",
    policy_revision:"POLICY-0001",
    source:{repository:"TOSS-Soft/toss-cli",revision:"abc",sha256:"a".repeat(64)},
    authority:null,
  };
  const first=createOperationIntent({...common,operations:[
    {resource:"issue",action:"update",repository:"TOSS-Soft/toss-cli",expected_revision:"two",payload:{number:2}},
    {resource:"issue",action:"update",repository:"TOSS-Soft/toss-cli",expected_revision:"one",payload:{number:1}},
  ]});
  const second=createOperationIntent({...common,operations:[
    {resource:"issue",action:"update",repository:"TOSS-Soft/toss-cli",expected_revision:"one",payload:{number:1}},
    {resource:"issue",action:"update",repository:"TOSS-Soft/toss-cli",expected_revision:"two",payload:{number:2}},
  ]});
  assert.deepEqual(first.operations.map(operation => operation.operation_id),["OP-0001","OP-0002"]);
  assert.equal(operationPreview(first).intent_sha256,operationPreview(second).intent_sha256);
});

test("an expected revision changes the deterministic operation intent hash",() => {
  const first=createOperationIntent(operationInput({expected_revision:"rev-1"}));
  const second=createOperationIntent(operationInput({expected_revision:"rev-2"}));
  assert.notEqual(operationPreview(first).intent_sha256,operationPreview(second).intent_sha256);
});

function operationInput({expected_revision="rev-1"}={}) {
  return {
    intent_id:"INTENT-20260901-0001",
    created_at:"2026-09-01T08:00:00.000Z",
    command:"repo.add",
    policy_revision:"POLICY-0001",
    source:{repository:"TOSS-Soft/toss-cli",revision:"abc",sha256:"a".repeat(64)},
    authority:null,
    operations:[{
      resource:"repository",action:"register",repository:"TOSS-Soft/toss-cli",
      expected_revision,payload:{default_branch:"main"},
    }],
  };
}

function memoryControl(events=[]) {
  let revision="head-0";
  const intents=[];
  const receipts=[];
  return Object.freeze({
    async head() { return revision; },
    async findIntent(intent) { return intents.find(value => sha256Canonical(value)===sha256Canonical(intent)) ?? null; },
    async findReceipt(intent) {
      const matches=receipts.filter(value => value.intent_id===intent.intent_id && value.intent_sha256===sha256Canonical(intent));
      return matches.length===0 ? null : matches.length===1 ? matches[0] : matches;
    },
    async commitIntent({expectedHead,intent}) {
      assert.equal(expectedHead,revision);
      events.push("intent"); intents.push(intent); revision="head-1"; return {commit_sha:revision};
    },
    async commitReceipt({expectedHead,receipt}) {
      assert.equal(expectedHead,revision);
      events.push("receipt"); receipts.push(receipt); revision="head-2"; return {commit_sha:revision};
    },
  });
}

test("apply persists the intent before its remote call and a bound receipt afterward",async () => {
  const events=[];
  const runner=createOperationRunner({
    control:memoryControl(events),
    github:{
      async snapshot() { return {}; },
      async inspect() { events.push("inspect"); return [{operation_id:"OP-0001",repository:"TOSS-Soft/toss-cli",revision:"rev-1"}]; },
      async apply() { events.push("apply"); return {status:"completed",observed_revisions:[{operation_id:"OP-0001",repository:"TOSS-Soft/toss-cli",revision:"rev-2"}]}; },
    },
    authorityRegistry:null,
    clock:() => "2026-09-01T08:01:00.000Z",
    idGenerator:() => "RECEIPT-20260901-0001",
    policyRevision:() => "POLICY-0001",
  });
  const receipt=await runner.apply(createOperationIntent(operationInput()),{authority:null});
  assert.equal(receipt.status,"completed");
  assert.deepEqual(events,["intent","inspect","apply","receipt"]);
});

test("a stale inspected revision is a conflict with no remote apply",async () => {
  const events=[];
  const runner=createOperationRunner({
    control:memoryControl(events),
    github:{
      async snapshot() { return {}; },
      async inspect() { return [{operation_id:"OP-0001",repository:"TOSS-Soft/toss-cli",revision:"changed"}]; },
      async apply() { events.push("apply"); return {status:"completed",observed_revisions:[{operation_id:"OP-0001",repository:"TOSS-Soft/toss-cli",revision:"rev-2"}]}; },
    }, authorityRegistry:null, clock:() => "2026-09-01T08:01:00.000Z",
    idGenerator:() => "RECEIPT-20260901-0001", policyRevision:() => "POLICY-0001",
  });
  await assert.rejects(runner.apply(createOperationIntent(operationInput()),{authority:null}),CoreConflictError);
  assert.deepEqual(events,["intent","receipt"]);
});

test("a matching retry returns its immutable receipt without a second remote apply",async () => {
  const events=[];
  const runner=createOperationRunner({
    control:memoryControl(events),
    github:{
      async snapshot() { return {}; },
      async inspect() { events.push("inspect"); return [{operation_id:"OP-0001",repository:"TOSS-Soft/toss-cli",revision:"rev-1"}]; },
      async apply() { events.push("apply"); return {status:"completed",observed_revisions:[{operation_id:"OP-0001",repository:"TOSS-Soft/toss-cli",revision:"rev-2"}]}; },
    }, authorityRegistry:null, clock:() => "2026-09-01T08:01:00.000Z",
    idGenerator:kind => kind==="receipt" ? "RECEIPT-20260901-0001" : "INTENT-20260901-0001",
    policyRevision:() => "POLICY-0001",
  });
  const intent=createOperationIntent(operationInput());
  const first=await runner.apply(intent,{authority:null});
  const second=await runner.apply(intent,{authority:null});
  assert.equal(canonicalJson(second),canonicalJson(first));
  assert.deepEqual(events,["intent","inspect","apply","receipt"]);
});

test("a tagged ambiguous receipt ledger lookup is a conflict before GitHub apply",async () => {
  const events=[];
  const control=memoryControl(events);
  const conflict=new Error("ambiguous immutable receipt");
  conflict.code="CONTROL_LEDGER_CONFLICT";
  const runner=createOperationRunner({
    control:{...control,async findReceipt() { throw conflict; }},
    github:{async snapshot() { return {}; },async inspect() { events.push("inspect"); return []; },async apply() { events.push("apply"); return {status:"completed",observed_revisions:[]}; }},
    authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "RECEIPT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  await assert.rejects(runner.apply(createOperationIntent(operationInput()),{authority:null}),error => error.code==="CORE_CONFLICT" && error.exitCode===6);
  assert.deepEqual(events,[]);
});

test("a tagged divergent intent ledger lookup is a conflict before GitHub apply",async () => {
  const events=[];
  const control=memoryControl(events);
  const conflict=new Error("divergent immutable intent");
  conflict.code="CONTROL_LEDGER_CONFLICT";
  const runner=createOperationRunner({
    control:{...control,async findIntent() { throw conflict; }},
    github:{async snapshot() { return {}; },async inspect() { events.push("inspect"); return []; },async apply() { events.push("apply"); return {status:"completed",observed_revisions:[]}; }},
    authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "RECEIPT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  await assert.rejects(runner.apply(createOperationIntent(operationInput()),{authority:null}),error => error.code==="CORE_CONFLICT" && error.exitCode===6);
  assert.deepEqual(events,[]);
});

test("a generic intent commit failure is internal and cannot reach GitHub",async () => {
  const events=[];
  const control=memoryControl(events);
  const runner=createOperationRunner({
    control:{...control,async commitIntent() { throw new Error("disk I/O unavailable"); }},
    github:{async snapshot() { return {}; },async inspect() { events.push("inspect"); return []; },async apply() { events.push("apply"); return {status:"completed",observed_revisions:[]}; }},
    authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "RECEIPT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  await assert.rejects(runner.apply(createOperationIntent(operationInput()),{authority:null}),error => error.code==="CORE_INTERNAL_FAILURE" && error.exitCode===70);
  assert.deepEqual(events,[]);
});

test("a tagged intent CAS conflict exits six before GitHub apply",async () => {
  const events=[];
  const control=memoryControl(events);
  const conflict=new Error("expected head changed");
  conflict.code="CORE_CONTROL_CONFLICT";
  const runner=createOperationRunner({
    control:{...control,async commitIntent() { throw conflict; }},
    github:{async snapshot() { return {}; },async inspect() { events.push("inspect"); return []; },async apply() { events.push("apply"); return {status:"completed",observed_revisions:[]}; }},
    authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "RECEIPT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  await assert.rejects(runner.apply(createOperationIntent(operationInput()),{authority:null}),error => error.code==="CORE_CONFLICT" && error.exitCode===6);
  assert.deepEqual(events,[]);
});

test("a corrupt stored receipt is a ledger conflict before GitHub apply",async () => {
  const events=[];
  const control=memoryControl(events);
  const runner=createOperationRunner({
    control:{...control,async findReceipt() { return {intent_id:"INTENT-20260901-0001"}; }},
    github:{async snapshot() { return {}; },async inspect() { events.push("inspect"); return []; },async apply() { events.push("apply"); return {status:"completed",observed_revisions:[]}; }},
    authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "RECEIPT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  await assert.rejects(runner.apply(createOperationIntent(operationInput()),{authority:null}),error => error.code==="CORE_CONFLICT" && error.exitCode===6);
  assert.deepEqual(events,[]);
});

test("a remote transport failure records a failed receipt before surfacing internal failure",async () => {
  const events=[];
  const runner=createOperationRunner({
    control:memoryControl(events),
    github:{
      async snapshot() { return {}; },
      async inspect() { events.push("inspect"); return [{operation_id:"OP-0001",repository:"TOSS-Soft/toss-cli",revision:"rev-1"}]; },
      async apply() { events.push("apply"); throw new Error("network unavailable"); },
    }, authorityRegistry:null, clock:() => "2026-09-01T08:01:00.000Z",
    idGenerator:() => "RECEIPT-20260901-0001", policyRevision:() => "POLICY-0001",
  });
  await assert.rejects(runner.apply(createOperationIntent(operationInput()),{authority:null}),error => error.code==="CORE_REMOTE_FAILURE" && error.exitCode===70);
  assert.deepEqual(events,["intent","inspect","apply","receipt"]);
});

test("a port-thrown remote error persists one failed receipt before exiting",async () => {
  const events=[];
  const runner=createOperationRunner({
    control:memoryControl(events), github:{
      async snapshot() { return {}; },
      async inspect() { events.push("inspect"); return [{operation_id:"OP-0001",repository:"TOSS-Soft/toss-cli",revision:"rev-1"}]; },
      async apply() { events.push("apply"); throw new CoreRemoteError("adapter outage"); },
    }, authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "RECEIPT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  await assert.rejects(runner.apply(createOperationIntent(operationInput()),{authority:null}),error => error.code==="CORE_REMOTE_FAILURE" && error.exitCode===70);
  assert.deepEqual(events,["intent","inspect","apply","receipt"]);
});

test("a partial remote observation cannot be recorded as completed",async () => {
  const events=[];
  const runner=createOperationRunner({
    control:memoryControl(events), github:{
      async snapshot() { return {}; },
      async inspect() { return [{operation_id:"OP-0001",repository:"TOSS-Soft/toss-cli",revision:"rev-1"}]; },
      async apply() { return {status:"completed",observed_revisions:[]}; },
    }, authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "RECEIPT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  const intent=createOperationIntent(operationInput());
  await assert.rejects(runner.apply(intent,{authority:null}),error => error.code==="CORE_REMOTE_FAILURE" && error.exitCode===70);
  await assert.rejects(runner.apply(intent,{authority:null}),error => error.code==="CORE_REMOTE_FAILURE" && error.exitCode===70);
  assert.deepEqual(events,["intent","receipt"]);
});

test("a remote-declared failed outcome persists its receipt but exits as remote failure",async () => {
  const events=[];
  const runner=createOperationRunner({
    control:memoryControl(events), github:{
      async snapshot() { return {}; },
      async inspect() { return [{operation_id:"OP-0001",repository:"TOSS-Soft/toss-cli",revision:"rev-1"}]; },
      async apply() { return {status:"failed",observed_revisions:[{operation_id:"OP-0001",repository:"TOSS-Soft/toss-cli",revision:"rev-1"}]}; },
    }, authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "RECEIPT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  await assert.rejects(runner.apply(createOperationIntent(operationInput()),{authority:null}),error => error.code==="CORE_REMOTE_FAILURE" && error.exitCode===70);
  assert.deepEqual(events,["intent","receipt"]);
});

test("failed receipt persistence remains a remote failure and never returns success",async () => {
  const events=[];
  const control=memoryControl(events);
  const runner=createOperationRunner({
    control:{...control,async commitReceipt() { events.push("receipt-attempt"); throw new Error("control unavailable"); }},
    github:{
      async snapshot() { return {}; },
      async inspect() { return [{operation_id:"OP-0001",repository:"TOSS-Soft/toss-cli",revision:"rev-1"}]; },
      async apply() { return {status:"failed",observed_revisions:[]}; },
    }, authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "RECEIPT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  await assert.rejects(runner.apply(createOperationIntent(operationInput()),{authority:null}),error => error.code==="CORE_REMOTE_FAILURE" && error.exitCode===70);
  assert.deepEqual(events,["intent","receipt-attempt","receipt-attempt"]);
});

test("execute makes default and dry-run calls identical zero-write previews",async () => {
  const events=[];
  const runner=createOperationRunner({
    control:memoryControl(events), github:{
      async snapshot() { return {}; }, async inspect() { throw new Error("must not inspect"); }, async apply() { throw new Error("must not apply"); },
    }, authorityRegistry:null, clock:() => "2026-09-01T08:01:00.000Z",
    idGenerator:kind => kind==="intent" ? "INTENT-20260901-0001" : "RECEIPT-20260901-0001", policyRevision:() => "POLICY-0001",
  });
  const base=parseCoreCommand(["repo","add","TOSS-Soft/toss-cli"]);
  const preview=await runner.execute({command:base,source:operationInput().source,operations:operationInput().operations,authority:null});
  const dryRun=await runner.execute({command:parseCoreCommand(["repo","add","TOSS-Soft/toss-cli","--dry-run"]),source:operationInput().source,operations:operationInput().operations,authority:null});
  assert.equal(canonicalJson(preview),canonicalJson(dryRun));
  assert.deepEqual(events,[]);
});

test("execute requires an explicit interactive confirmation and rejects apply plus dry-run",async () => {
  const runner=createOperationRunner({
    control:memoryControl(), github:{async snapshot() { return {}; },async inspect() { return []; },async apply() { return {status:"completed",observed_revisions:[]}; }},
    authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "INTENT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  const request={source:operationInput().source,operations:operationInput().operations,authority:null};
  const applyCommand=parseCoreCommand(["repo","add","TOSS-Soft/toss-cli","--apply"]);
  await assert.rejects(runner.execute({command:applyCommand,...request}),CoreBlockedError);
  await assert.rejects(runner.execute({command:{...applyCommand,options:{...applyCommand.options,dryRun:true}},...request}),error => error.exitCode===5 && error.code==="CORE_CONTRACT_INVALID");
});

test("execute rejects forged parsed commands before any ledger or GitHub activity",async () => {
  const events=[];
  const runner=createOperationRunner({
    control:memoryControl(events), github:{
      async snapshot() { events.push("snapshot"); return {}; }, async inspect() { events.push("inspect"); return []; }, async apply() { events.push("apply"); return {status:"completed",observed_revisions:[]}; },
    }, authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "INTENT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  const forged={name:"repo.add",options:{apply:false,dryRun:false,nonInteractive:false},readOnly:true,interactive:true};
  await assert.rejects(runner.execute({command:forged,source:operationInput().source,operations:operationInput().operations,authority:null}),error => error.code==="CORE_CONTRACT_INVALID" && error.exitCode===5);
  assert.deepEqual(events,[]);
});

test("execute closes command fields, normalized options, and safety metadata before writes",async () => {
  const events=[];
  const runner=createOperationRunner({
    control:memoryControl(events), github:{
      async snapshot() { events.push("snapshot"); return {}; }, async inspect() { events.push("inspect"); return []; }, async apply() { events.push("apply"); return {status:"completed",observed_revisions:[]}; },
    }, authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "INTENT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  const valid=parseCoreCommand(["repo","add","TOSS-Soft/toss-cli"]);
  const getter={...valid};
  Object.defineProperty(getter,"name",{enumerable:true,get() { throw new Error("must not read accessor"); }});
  const candidates=[
    {...valid,name:7},
    {...valid,args:[7]},
    {...valid,options:{...valid.options,apply:"true"}},
    {...valid,readOnly:false},
    {...valid,extra:true},
    getter,
    new Proxy(valid,{}),
  ];
  for (const command of candidates) {
    await assert.rejects(runner.execute({command,source:operationInput().source,operations:operationInput().operations,authority:null}),error => error.code==="CORE_CONTRACT_INVALID" && error.exitCode===5);
  }
  assert.deepEqual(events,[]);
});

test("runner rejects accessor-backed remote ports before they can be trusted",() => {
  const control=memoryControl();
  assert.throws(() => createOperationRunner({
    control,github:{get snapshot() { return async () => ({}); },inspect:async () => [],apply:async () => ({status:"completed",observed_revisions:[]})},
    authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "RECEIPT-20260901-0001",policyRevision:() => "POLICY-0001",
  }),error => error.exitCode===5 && error.code==="CORE_CONTRACT_INVALID");
});

test("authority verification rejects an expired signature even when its key is trusted",() => {
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  const unsigned={
    schema_version:"authority-record.v1",document_type:"authority-record",record_id:"AUTH-20260901-0001",
    actor:"independent-approver",command:"repo.add",targets:["TOSS-Soft/toss-cli"],
    expected_revisions:[{repository:"TOSS-Soft/toss-cli",revision:"rev-1"}],policy_revision:"POLICY-0001",
    issued_at:"2026-09-01T07:00:00.000Z",expires_at:"2026-09-01T07:30:00.000Z",
  };
  const record={...unsigned,signature:{algorithm:"ed25519",key_id:"approver",value:sign(null,Buffer.from(canonicalJson(unsigned)),privateKey).toString("base64")}};
  assert.throws(() => verifyAuthority(record,{
    command:"repo.add",targets:["TOSS-Soft/toss-cli"],expected_revisions:unsigned.expected_revisions,
    policy_revision:"POLICY-0001",now:"2026-09-01T08:00:00.000Z",implementation_actor:"worker",
  },{keys:[{key_id:"approver",actor:"independent-approver",public_key:publicKey.export({format:"pem",type:"spki"}).toString()}]}),CoreBlockedError);
});

test("authority signatures bind the exact command, revisions, and an independent actor",() => {
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  const unsigned={
    schema_version:"authority-record.v1",document_type:"authority-record",record_id:"AUTH-20260901-0001",
    actor:"independent-approver",command:"repo.add",targets:["TOSS-Soft/toss-cli"],
    expected_revisions:[{repository:"TOSS-Soft/toss-cli",revision:"rev-1"}],policy_revision:"POLICY-0001",
    issued_at:"2026-09-01T07:00:00.000Z",expires_at:"2026-09-01T09:00:00.000Z",
  };
  const record={...unsigned,signature:{algorithm:"ed25519",key_id:"approver",value:sign(null,Buffer.from(canonicalJson(unsigned)),privateKey).toString("base64")}};
  const binding={command:"repo.add",targets:["TOSS-Soft/toss-cli"],expected_revisions:unsigned.expected_revisions,policy_revision:"POLICY-0001",now:"2026-09-01T08:00:00.000Z",implementation_actor:"worker"};
  const registry={keys:[{key_id:"approver",actor:"independent-approver",public_key:publicKey.export({format:"pem",type:"spki"}).toString()}]};
  assert.equal(verifyAuthority(record,binding,registry).record_id,"AUTH-20260901-0001");
  assert.throws(() => verifyAuthority(record,{...binding,implementation_actor:"independent-approver"},registry),CoreBlockedError);
  assert.throws(() => verifyAuthority(record,{...binding,expected_revisions:[{repository:"TOSS-Soft/toss-cli",revision:"changed"}]},registry),CoreBlockedError);
});

test("authority expected revisions reject repeated repositories and reordered bindings",() => {
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  const registry={keys:[{key_id:"approver",actor:"independent-approver",public_key:publicKey.export({format:"pem",type:"spki"}).toString()}]};
  const makeRecord=expected_revisions => {
    const targets=[...new Set(expected_revisions.map(value => value.repository))].sort();
    const unsigned={
      schema_version:"authority-record.v1",document_type:"authority-record",record_id:"AUTH-20260901-0001",
      actor:"independent-approver",command:"repo.add",targets,expected_revisions,
      policy_revision:"POLICY-0001",issued_at:"2026-09-01T07:00:00.000Z",expires_at:"2026-09-01T09:00:00.000Z",
    };
    return {...unsigned,signature:{algorithm:"ed25519",key_id:"approver",value:sign(null,Buffer.from(canonicalJson(unsigned)),privateKey).toString("base64")}};
  };
  const unique=[{repository:"TOSS-Soft/toss-cli",revision:"one"},{repository:"TOSS-Soft/toss-console",revision:"two"}].sort((left,right) => canonicalJson(left)<canonicalJson(right) ? -1 : 1);
  const binding={command:"repo.add",targets:["TOSS-Soft/toss-cli","TOSS-Soft/toss-console"],expected_revisions:unique,policy_revision:"POLICY-0001",now:"2026-09-01T08:00:00.000Z",implementation_actor:"worker"};
  assert.equal(verifyAuthority(makeRecord(unique),binding,registry).record_id,"AUTH-20260901-0001");
  const duplicateSame=[{repository:"TOSS-Soft/toss-cli",revision:"one"},{repository:"TOSS-Soft/toss-cli",revision:"one"}];
  const duplicateDifferent=[{repository:"TOSS-Soft/toss-cli",revision:"one"},{repository:"TOSS-Soft/toss-cli",revision:"two"}].sort((left,right) => canonicalJson(left)<canonicalJson(right) ? -1 : 1);
  assert.throws(() => verifyAuthority(makeRecord(duplicateSame),{...binding,targets:["TOSS-Soft/toss-cli"],expected_revisions:duplicateSame},registry),CoreBlockedError);
  assert.throws(() => verifyAuthority(makeRecord(duplicateDifferent),{...binding,targets:["TOSS-Soft/toss-cli"],expected_revisions:duplicateDifferent},registry),CoreBlockedError);
  assert.throws(() => verifyAuthority(makeRecord([...unique].reverse()),binding,registry),CoreBlockedError);
});

test("runner authority binding uses raw canonical ordering for punctuation-bearing repositories",async () => {
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  const expected_revisions=[
    {repository:"TOSS-Soft/a--",revision:"one"},
    {repository:"TOSS-Soft/a__",revision:"two"},
  ];
  const unsigned={
    schema_version:"authority-record.v1",document_type:"authority-record",record_id:"AUTH-20260901-0001",
    actor:"independent-approver",command:"repo.add",targets:["TOSS-Soft/a--","TOSS-Soft/a__"],expected_revisions,
    policy_revision:"POLICY-0001",issued_at:"2026-09-01T07:00:00.000Z",expires_at:"2026-09-01T09:00:00.000Z",
  };
  const authority={...unsigned,signature:{algorithm:"ed25519",key_id:"approver",value:sign(null,Buffer.from(canonicalJson(unsigned)),privateKey).toString("base64")}};
  const intent=createOperationIntent({
    ...operationInput(),authority:authorityReference(authority),operations:[
      {resource:"repository",action:"register",repository:"TOSS-Soft/a__",expected_revision:"two",payload:{default_branch:"main"}},
      {resource:"repository",action:"register",repository:"TOSS-Soft/a--",expected_revision:"one",payload:{default_branch:"main"}},
    ],
  });
  const runner=createOperationRunner({
    control:memoryControl(),github:{
      async snapshot() { return {}; },
      async inspect() { return intent.operations.map(operation => ({operation_id:operation.operation_id,repository:operation.repository,revision:operation.expected_revision})); },
      async apply() { return {status:"completed",observed_revisions:intent.operations.map(operation => ({operation_id:operation.operation_id,repository:operation.repository,revision:"next"}))}; },
    },authorityRegistry:{keys:[{key_id:"approver",actor:"independent-approver",public_key:publicKey.export({format:"pem",type:"spki"}).toString()}]},clock:() => "2026-09-01T08:00:00.000Z",idGenerator:() => "RECEIPT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  assert.equal((await runner.apply(intent,{authority})).status,"completed");
});
