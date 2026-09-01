import assert from "node:assert/strict";
import test from "node:test";

import {validateDocument} from "../src/contracts/validator.js";

const SOURCE={
  repository:"TOSS-Soft/toss-console",
  revision:"refs/heads/main@9f4d1a7",
  sha256:"a".repeat(64),
};

const AUTHORITY={
  schema_version:"authority-record.v1",
  document_type:"authority-record",
  record_id:"AUTH-20260901-0001",
  actor:"octavia",
  command:"repo.add",
  targets:["TOSS-Soft/toss-console"],
  expected_revisions:[{
    repository:"TOSS-Soft/toss-console",
    revision:null,
  }],
  policy_revision:"POLICY-0001",
  issued_at:"2026-09-01T08:00:00.000Z",
  expires_at:"2026-09-02T08:00:00.000Z",
  signature:{
    algorithm:"ed25519",
    key_id:"KEY-0001",
    value:"c2lnbmF0dXJl",
  },
};

const INTENT={
  schema_version:"operation-intent.v1",
  document_type:"operation-intent",
  intent_id:"INTENT-20260901-0001",
  command:"repo.add",
  created_at:"2026-09-01T08:00:00.000Z",
  policy_revision:"POLICY-0001",
  source:SOURCE,
  authority:null,
  operations:[{
    operation_id:"OP-0001",
    resource:"repository",
    action:"register",
    repository:"TOSS-Soft/toss-console",
    expected_revision:null,
    payload:{default_branch:"main"},
  }],
};

const RECEIPT={
  schema_version:"operation-receipt.v1",
  document_type:"operation-receipt",
  receipt_id:"RECEIPT-20260901-0001",
  intent_id:"INTENT-20260901-0001",
  intent_sha256:"b".repeat(64),
  created_at:"2026-09-01T08:01:00.000Z",
  status:"completed",
  observed_revisions:[{
    operation_id:"OP-0001",
    repository:"TOSS-Soft/toss-console",
    revision:"repository-node:123",
  }],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("core foundation schemas accept one closed valid document each",() => {
  const organization={
    schema_version:"organization-config.v1",
    organization:"TOSS-Soft",
    project:{node_id:"PVT_kwDO123",number:1},
    control_repository:"TOSS-Soft/toss-os-control",
    policy_revision:"POLICY-0001",
    repositories:["TOSS-Soft/toss-console"],
  };
  const repository={
    schema_version:"repository-config.v1",
    repository:"TOSS-Soft/toss-console",
    repository_node_id:"R_kgDO123",
    default_branch:"main",
    active_release:null,
    project_item_id:"PVTITEM_123",
    project_fields:{status:"PVTSSF_STATUS",gate:"PVTSSF_GATE"},
    registered_at:"2026-09-01T08:00:00.000Z",
  };

  for (const [schemaId,value] of [
    ["authority-record.v1",AUTHORITY],
    ["operation-intent.v1",INTENT],
    ["operation-receipt.v1",RECEIPT],
    ["organization-config.v1",organization],
    ["repository-config.v1",repository],
  ]) {
    assert.equal(validateDocument(value,schemaId).valid,true,schemaId);
  }
});

test("organization configuration rejects unknown fields and duplicate repositories",() => {
  const organization={
    schema_version:"organization-config.v1",
    organization:"TOSS-Soft",
    project:{node_id:"PVT_kwDO123",number:1},
    control_repository:"TOSS-Soft/toss-os-control",
    policy_revision:"POLICY-0001",
    repositories:["TOSS-Soft/toss-console"],
  };
  assert.equal(validateDocument({...organization,unexpected:true},"organization-config.v1").valid,false);
  assert.equal(validateDocument({
    ...organization,
    repositories:["TOSS-Soft/toss-console","TOSS-Soft/toss-console"],
  },"organization-config.v1").valid,false);
});

test("authority records reject malformed expiry timestamps",() => {
  assert.equal(validateDocument({
    ...AUTHORITY,
    expires_at:"2026-99-01T08:00:00.000Z",
  },"authority-record.v1").valid,false);
});

test("operation receipts require lowercase SHA-256 intent hashes",() => {
  assert.equal(validateDocument({
    ...RECEIPT,
    intent_sha256:"A".repeat(64),
  },"operation-receipt.v1").valid,false);
});

test("core operation intent is closed and operation IDs are unique",async () => {
  assert.equal(validateDocument(INTENT,"operation-intent.v1").valid,true);
  assert.equal(validateDocument({...INTENT,unexpected:true},"operation-intent.v1").valid,false);

  const duplicate=clone(INTENT);
  duplicate.operations.push({...duplicate.operations[0],action:"update"});
  const {CoreValidationError,validateCoreDocument}=await import("../src/core/contracts.js");
  assert.throws(
    () => validateCoreDocument(duplicate,"operation-intent.v1"),
    error => error instanceof CoreValidationError &&
      error.code==="CORE_CONTRACT_INVALID" && /duplicate operation_id/i.test(error.message),
  );
});

test("core operation intents require operation IDs in strict ascending ASCII order",async () => {
  const unordered=clone(INTENT);
  unordered.operations=[
    {...unordered.operations[0],operation_id:"OP-0002"},
    {...unordered.operations[0],operation_id:"OP-0001",action:"update"},
  ];
  assert.equal(validateDocument(unordered,"operation-intent.v1").valid,true);

  const {CoreValidationError,validateCoreDocument}=await import("../src/core/contracts.js");
  assert.throws(
    () => validateCoreDocument(unordered,"operation-intent.v1"),
    error => error instanceof CoreValidationError &&
      error.code==="CORE_CONTRACT_INVALID" && /strict ascending ASCII order/i.test(error.message),
  );
});

test("core validation rejects transparent root and nested proxies",async () => {
  const {CoreValidationError,validateCoreDocument}=await import("../src/core/contracts.js");
  const inputs=[
    new Proxy(clone(INTENT),{}),
    {...clone(INTENT),source:new Proxy(clone(SOURCE),{})},
  ];
  for (const input of inputs) {
    assert.throws(
      () => validateCoreDocument(input,"operation-intent.v1"),
      error => error instanceof CoreValidationError &&
        error.code==="CORE_CONTRACT_INVALID" && /proxy/i.test(error.message),
    );
  }
});
