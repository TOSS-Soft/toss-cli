import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  ACP_VERSION,
  ENTITY_ID_PATTERN,
  assertKnownDocumentType,
  assertStableEntityMeanings,
  canonicalJson,
  sha256Canonical,
} from "../src/contracts/acp.js";

test("canonical JSON sorts object keys recursively without reordering arrays",() => {
  assert.equal(canonicalJson({b:2,a:1}),'{"a":1,"b":2}');
  assert.equal(
    canonicalJson({z:[{b:2,a:1},"first"],a:{d:4,c:3}}),
    '{"a":{"c":3,"d":4},"z":[{"a":1,"b":2},"first"]}',
  );
});

test("canonical JSON rejects values outside the JSON data model",() => {
  for (const value of [undefined,NaN,Infinity,1n,() => {}]) {
    assert.throws(() => canonicalJson(value),/non-JSON value/i);
  }
  assert.throws(() => canonicalJson({missing:undefined}),/non-JSON value/i);
  assert.throws(() => canonicalJson([,1]),/non-JSON value/i);
  const hiddenFunction={};
  Object.defineProperty(hiddenFunction,"not-json",{value:() => {}});
  assert.throws(() => canonicalJson(hiddenFunction),/non-JSON value/i);
  const symbolProperty=[1];
  symbolProperty[Symbol("not-json")]=2;
  assert.throws(() => canonicalJson(symbolProperty),/non-JSON value/i);
  const cyclic={};
  cyclic.self=cyclic;
  assert.throws(() => canonicalJson(cyclic),/non-JSON value/i);
});

test("canonical JSON accepts only dense ordinary arrays without invoking their methods",() => {
  let methodCalls=0;
  const exotic=["safe"];
  Object.setPrototypeOf(exotic,{
    map() {
      methodCalls+=1;
      return ["forged"];
    },
  });
  const hidden=["safe"];
  Object.defineProperty(hidden,"0",{value:"safe",enumerable:false});
  const named=["safe"];
  Object.defineProperty(named,"extra",{value:true,enumerable:false});
  const accessor=["safe"];
  Object.defineProperty(accessor,"0",{
    enumerable:true,
    get() {
      methodCalls+=1;
      return "forged";
    },
  });

  for (const value of [exotic,hidden,named,accessor]) {
    assert.throws(() => canonicalJson(value),/non-JSON value/i);
  }
  assert.equal(methodCalls,0);
});

test("canonical hashes are lowercase SHA-256 digests of UTF-8 JSON",() => {
  assert.equal(
    sha256Canonical({b:2,a:1}),
    "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
  );
});

test("document registry accepts only declared type and schema-version pairs",() => {
  assert.equal(ACP_VERSION,"acp.v1");
  assert.doesNotThrow(() => assertKnownDocumentType("pm-analysis",ACP_VERSION));
  assert.throws(
    () => assertKnownDocumentType("pm-analysis","acp.v999"),
    /unknown schema version/i,
  );
  assert.throws(
    () => assertKnownDocumentType("unregistered",ACP_VERSION),
    /unknown document type/i,
  );
});

test("entity IDs use a protocol prefix and retain one stable meaning",() => {
  for (const prefix of [
    "REQ","NFR","BR","FLOW","ARCHQ","ADR",
    "EPIC","ISSUE","AC","RISK","ASM","Q",
  ]) {
    assert.match(`${prefix}-001`,ENTITY_ID_PATTERN);
  }
  assert.doesNotThrow(() => assertStableEntityMeanings([
    {id:"REQ-001",kind:"requirement",meaning:"A"},
    {id:"REQ-001",kind:"requirement",meaning:"A"},
  ]));
  assert.throws(() => assertStableEntityMeanings([
    {id:"REQ-001",kind:"requirement",meaning:"A"},
    {id:"REQ-001",kind:"requirement",meaning:"B"},
  ]),/reused with a different meaning/i);
  assert.throws(() => assertStableEntityMeanings([
    {id:"UNKNOWN-001",kind:"requirement",meaning:"A"},
  ]),/invalid entity id/i);
});

test("the registry declares role boundaries for every full-pipeline artifact",() => {
  const registry=JSON.parse(fs.readFileSync(
    new URL("../contracts/registry.json",import.meta.url),
    "utf8",
  ));
  assert.equal(registry.protocol_version,ACP_VERSION);
  assert.deepEqual(
    registry.documents.map(row => row.document_type),
    [
      "pm-analysis",
      "architecture",
      "adr",
      "issue-plan",
      "spec-audit",
      "transition-event",
      "project-input",
      "feature-delta",
      "github-publication-result",
    ],
  );
  for (const row of registry.documents) {
    assert.equal(row.schema_version,ACP_VERSION);
    assert.equal(typeof row.producer,"string");
    assert.ok(row.consumers.length > 0);
    assert.ok(row.allowed_mutations.length > 0);
    assert.ok(row.forbidden_actions.length > 0);
  }
});

test("the full-pipeline fixture is hash-valid and linked to exact revisions",() => {
  const fixture=JSON.parse(fs.readFileSync(
    new URL("./fixtures/acp/full-pipeline.json",import.meta.url),
    "utf8",
  ));
  const artifacts=new Map(
    fixture.artifacts.map(artifact => [artifact.artifact_id,artifact]),
  );
  assert.equal(artifacts.size,5);
  const identities=new Set(
    fixture.artifacts.map(artifact => `${artifact.artifact_id}\u0000${artifact.revision}`),
  );
  assert.equal(
    identities.size,
    fixture.artifacts.length,
    "fixture artifact identities must be unique by artifact_id and revision",
  );
  const registry=JSON.parse(fs.readFileSync(
    new URL("../contracts/registry.json",import.meta.url),
    "utf8",
  ));
  const registryByType=new Map(
    registry.documents.map(row => [row.document_type,row]),
  );
  const artifactsByType=new Map(
    fixture.artifacts.map(artifact => [artifact.document_type,artifact]),
  );
  const inputTypes=(artifact) => artifact.inputs.map(reference =>
    artifacts.get(reference.artifact_id).document_type,
  );
  const assertInputs=(artifact,typeNames) => {
    const actual=new Set(inputTypes(artifact));
    for (const typeName of typeNames) {
      assert.ok(
        actual.has(typeName),
        `${artifact.document_type} must consume ${typeName}`,
      );
    }
  };
  for (const artifact of fixture.artifacts) {
    assert.doesNotThrow(() => assertKnownDocumentType(
      artifact.document_type,
      artifact.schema_version,
    ));
    assert.equal(artifact.content_sha256,sha256Canonical(artifact.content));
    assert.equal(
      artifact.producer.role,
      registryByType.get(artifact.document_type)?.producer,
      `${artifact.document_type} producer role must match the registry`,
    );
    for (const reference of [...artifact.parents,...artifact.inputs]) {
      const target=artifacts.get(reference.artifact_id);
      assert.ok(target,`missing fixture artifact ${reference.artifact_id}`);
      assert.equal(reference.revision,target.revision);
      assert.equal(reference.content_sha256,target.content_sha256);
    }
  }
  const pmAnalysis=artifactsByType.get("pm-analysis");
  const architecture=artifactsByType.get("architecture");
  const adr=artifactsByType.get("adr");
  const issuePlan=artifactsByType.get("issue-plan");
  const specAudit=artifactsByType.get("spec-audit");
  assertInputs(architecture,["pm-analysis"]);
  assert.ok(
    architecture.content.entities.some(entity => entity.id==="ARCHQ-001"),
    "architecture must provide ARCHQ context for the ADR",
  );
  assertInputs(adr,["pm-analysis","architecture"]);
  assertInputs(issuePlan,["pm-analysis","architecture","adr"]);
  assertInputs(specAudit,["pm-analysis","architecture","adr","issue-plan"]);
  assert.ok(pmAnalysis && architecture && adr && issuePlan && specAudit);
  assert.doesNotThrow(() => assertStableEntityMeanings(
    fixture.artifacts.flatMap(artifact => artifact.content.entities ?? []),
  ));
});
