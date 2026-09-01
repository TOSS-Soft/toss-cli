import assert from "node:assert/strict";
import {generateKeyPairSync,sign} from "node:crypto";
import test from "node:test";

import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {verifyAuthority} from "../src/core/authority.js";
import {CoreBlockedError,CoreConflictError} from "../src/core/errors.js";
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

test("a partial remote observation cannot be recorded as completed",async () => {
  const events=[];
  const runner=createOperationRunner({
    control:memoryControl(events), github:{
      async snapshot() { return {}; },
      async inspect() { return [{operation_id:"OP-0001",repository:"TOSS-Soft/toss-cli",revision:"rev-1"}]; },
      async apply() { return {status:"completed",observed_revisions:[]}; },
    }, authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "RECEIPT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  await assert.rejects(runner.apply(createOperationIntent(operationInput()),{authority:null}),error => error.code==="CORE_CONTRACT_INVALID" && error.exitCode===5);
  assert.deepEqual(events,["intent","receipt"]);
});

test("execute makes default and dry-run calls identical zero-write previews",async () => {
  const events=[];
  const runner=createOperationRunner({
    control:memoryControl(events), github:{
      async snapshot() { return {}; }, async inspect() { throw new Error("must not inspect"); }, async apply() { throw new Error("must not apply"); },
    }, authorityRegistry:null, clock:() => "2026-09-01T08:01:00.000Z",
    idGenerator:kind => kind==="intent" ? "INTENT-20260901-0001" : "RECEIPT-20260901-0001", policyRevision:() => "POLICY-0001",
  });
  const base={name:"repo.add",readOnly:true,interactive:true,options:{apply:false,dryRun:false,nonInteractive:false}};
  const preview=await runner.execute({command:base,source:operationInput().source,operations:operationInput().operations,authority:null});
  const dryRun=await runner.execute({command:{...base,options:{...base.options,dryRun:true}},source:operationInput().source,operations:operationInput().operations,authority:null});
  assert.equal(canonicalJson(preview),canonicalJson(dryRun));
  assert.deepEqual(events,[]);
});

test("execute requires an explicit interactive confirmation and rejects apply plus dry-run",async () => {
  const runner=createOperationRunner({
    control:memoryControl(), github:{async snapshot() { return {}; },async inspect() { return []; },async apply() { return {status:"completed",observed_revisions:[]}; }},
    authorityRegistry:null,clock:() => "2026-09-01T08:01:00.000Z",idGenerator:() => "INTENT-20260901-0001",policyRevision:() => "POLICY-0001",
  });
  const request={source:operationInput().source,operations:operationInput().operations,authority:null};
  await assert.rejects(runner.execute({command:{name:"repo.add",readOnly:false,interactive:true,options:{apply:true,dryRun:false,nonInteractive:false}},...request}),CoreBlockedError);
  await assert.rejects(runner.execute({command:{name:"repo.add",readOnly:false,interactive:false,options:{apply:true,dryRun:true,nonInteractive:true}},...request}),error => error.exitCode===5 && error.code==="CORE_CONTRACT_INVALID");
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
