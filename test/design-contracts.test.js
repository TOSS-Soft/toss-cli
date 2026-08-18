import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";

const fixture=JSON.parse(await readFile(new URL(
  "./fixtures/design-contracts/valid-graph.json",
  import.meta.url,
),"utf8"));
const invalidAssets=JSON.parse(await readFile(new URL(
  "./fixtures/design-contracts/invalid-assets.json",
  import.meta.url,
),"utf8"));

function canonicalCopy(value) {
  return JSON.parse(canonicalJson(value));
}

function artifactReference(artifact) {
  return {
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
    document_type:artifact.document_type,
  };
}

function replaceHashTokens(value,byType) {
  if (Array.isArray(value)) return value.map(item => replaceHashTokens(item,byType));
  if (!value || typeof value!=="object") return value;
  const copy={};
  for (const [key,item] of Object.entries(value)) {
    if (key==="content_sha256" && typeof item==="string" && item.startsWith("@")) {
      copy[key]=byType.get(item.slice(1)).content_sha256;
    } else {
      copy[key]=replaceHashTokens(item,byType);
    }
  }
  return copy;
}

function buildGraph() {
  const graph=[];
  const byType=new Map();
  for (const descriptor of fixture.artifacts) {
    const content=replaceHashTokens(descriptor.content,byType);
    const parents=(descriptor.parents ?? []).map(type =>
      artifactReference(byType.get(type)));
    const artifact={
      schema_version:"acp.v1",
      document_type:descriptor.document_type,
      artifact_id:`${descriptor.document_type}:DESIGN-CHECKOUT`,
      revision:1,
      run_id:"run:design-contracts:001",
      producer:{role:descriptor.producer_role,identity:`toss-${descriptor.producer_role}`},
      runtime_identity:{kind:"agent",name:"fixture-runtime",version:"1.0.0"},
      created_at:"2026-08-17T12:00:00Z",
      provenance:{source_revision:fixture.source_revision,source_sha256:fixture.source_sha256,locations:["project-brief.md#design"]},
      parents,
      inputs:parents,
      content_sha256:sha256Canonical(content),
      content,
    };
    graph.push(artifact);
    byType.set(artifact.document_type,artifact);
  }
  return canonicalCopy(graph);
}

function clone(value) {
  return canonicalCopy(value);
}

function replaceArtifact(graph,replacement) {
  return graph.map(artifact => artifact.document_type===replacement.document_type ?
    replacement : artifact);
}

function rehash(artifact) {
  artifact.content_sha256=sha256Canonical(artifact.content);
  return artifact;
}

function findingTypes(result) {
  return result.findings.map(item => item.type);
}

test("the public design validator accepts all twelve issue 29 artifact types",async () => {
  const {validateDesignArtifact}=await import(
    "../src/pipeline/design-contracts.js"
  );

  const graph=buildGraph();
  assert.equal(graph.length,12);
  for (const artifact of graph) {
    const result=validateDesignArtifact(artifact,graph);
    assert.equal(result.valid,true,`${artifact.document_type}: ${JSON.stringify(result.findings)}`);
  }
});

test("schema, version, and content integrity failures are typed and fail closed",async () => {
  const {validateDesignArtifact}=await import("../src/pipeline/design-contracts.js");
  const graph=buildGraph();
  const screen=graph.find(artifact => artifact.document_type==="screen-spec");

  const unknownVersion=clone(screen);
  unknownVersion.schema_version="acp.v999";
  assert.deepEqual(findingTypes(validateDesignArtifact(unknownVersion,graph)),[
    "UNKNOWN_SCHEMA_VERSION",
  ]);

  const unknownKey=clone(screen);
  unknownKey.content.forged_summary={valid:true};
  rehash(unknownKey);
  assert.ok(findingTypes(validateDesignArtifact(unknownKey,graph)).includes(
    "SCHEMA_VALIDATION",
  ));

  const malformed=clone(screen);
  malformed.content.states[0]=42;
  rehash(malformed);
  assert.ok(findingTypes(validateDesignArtifact(malformed,graph)).includes(
    "SCHEMA_VALIDATION",
  ));

  const corrupt=clone(screen);
  corrupt.content_sha256="f".repeat(64);
  assert.deepEqual(findingTypes(validateDesignArtifact(corrupt,graph)),[
    "CONTENT_SHA256_MISMATCH",
  ]);
});

test("artifact graphs reject duplicate, dangling, stale, and cross-source identity",async () => {
  const {validateDesignArtifact}=await import("../src/pipeline/design-contracts.js");
  const graph=buildGraph();
  const screen=graph.find(artifact => artifact.document_type==="screen-spec");

  const duplicateGraph=[...clone(graph),clone(graph[0])];
  assert.ok(findingTypes(validateDesignArtifact(graph[0],duplicateGraph)).includes(
    "DUPLICATE_ARTIFACT_IDENTITY",
  ));

  const dangling=clone(screen);
  dangling.content.flow_refs[0].artifact_id="user-flow:MISSING";
  rehash(dangling);
  assert.ok(findingTypes(validateDesignArtifact(
    dangling,replaceArtifact(graph,dangling),
  )).includes("DANGLING_ARTIFACT_REFERENCE"));

  const newerFlow=clone(graph.find(artifact => artifact.document_type==="user-flow"));
  newerFlow.revision=2;
  newerFlow.content.name="Complete checkout v2";
  rehash(newerFlow);
  assert.ok(findingTypes(validateDesignArtifact(screen,[...graph,newerFlow])).includes(
    "STALE_ARTIFACT_REFERENCE",
  ));

  const crossSource=clone(screen);
  crossSource.content.source="new_system";
  rehash(crossSource);
  assert.ok(findingTypes(validateDesignArtifact(
    crossSource,replaceArtifact(graph,crossSource),
  )).includes("SOURCE_MISMATCH"));
});

test("screen links reject missing entity identities",async () => {
  const {validateDesignArtifact}=await import("../src/pipeline/design-contracts.js");
  const graph=buildGraph();
  const screen=clone(graph.find(artifact => artifact.document_type==="screen-spec"));
  screen.content.flow_refs[0].entity_id="FLOW-MISSING";
  rehash(screen);
  assert.ok(findingTypes(validateDesignArtifact(
    screen,replaceArtifact(graph,screen),
  )).includes("DANGLING_ENTITY_REFERENCE"));
});

test("verified company binding rules cannot be bypassed or use an unapproved exception",async () => {
  const {validateDesignSystemRules}=await import("../src/pipeline/design-contracts.js");
  const graph=buildGraph();
  const screen=clone(graph.find(artifact => artifact.document_type==="screen-spec"));
  screen.content.rule_applications[0].value={token:"color.project.override"};
  rehash(screen);
  const violation=validateDesignSystemRules(replaceArtifact(graph,screen));
  assert.ok(findingTypes(violation).includes("BINDING_RULE_VIOLATION"));

  screen.content.rule_applications[0].exception_id="EXCEPTION-MISSING";
  rehash(screen);
  const misuse=validateDesignSystemRules(replaceArtifact(graph,screen));
  assert.ok(findingTypes(misuse).includes("APPROVED_EXCEPTION_INVALID"));
});

test("screen component and flow state linkage rejects dangling identities",async () => {
  const {validateDesignArtifact}=await import("../src/pipeline/design-contracts.js");
  const graph=buildGraph();
  const screen=clone(graph.find(artifact => artifact.document_type==="screen-spec"));
  screen.content.states[0].component_ids=["COMP-MISSING"];
  rehash(screen);
  assert.ok(findingTypes(validateDesignArtifact(
    screen,replaceArtifact(graph,screen),
  )).includes("DANGLING_ENTITY_REFERENCE"));
});

test("asset resolution validates identity, version, integrity, safe path, and safe URI",async () => {
  const {resolveDesignAsset}=await import("../src/pipeline/design-contracts.js");
  const graph=buildGraph();
  const prototype=graph.find(artifact => artifact.document_type==="prototype-manifest");
  const validAsset=clone(prototype.content.assets[0]);
  const before=canonicalJson(validAsset);
  const resolved=resolveDesignAsset(validAsset);
  assert.equal(resolved.valid,true,JSON.stringify(resolved.findings));
  assert.deepEqual(resolved.asset,validAsset);
  assert.equal(canonicalJson(validAsset),before);
  assert.equal(Object.isFrozen(resolved),true);
  assert.equal(Object.isFrozen(resolved.asset.location),true);

  for (const fixtureCase of invalidAssets) {
    const result=resolveDesignAsset(fixtureCase.entry);
    assert.equal(result.valid,false,fixtureCase.name);
    assert.ok(findingTypes(result).includes(fixtureCase.want_type),fixtureCase.name);
  }
});

test("canonical-invalid artifacts, graphs, assets, and hostile JavaScript objects return findings",async () => {
  const {resolveDesignAsset,validateDesignArtifact}=await import(
    "../src/pipeline/design-contracts.js"
  );
  const graph=buildGraph();
  const screen=graph.find(artifact => artifact.document_type==="screen-spec");

  const exotic=Object.create({inherited:true});
  exotic.schema_version="acp.v1";
  assert.doesNotThrow(() => validateDesignArtifact(exotic,graph));
  assert.deepEqual(findingTypes(validateDesignArtifact(exotic,graph)),["CANONICAL_JSON"]);

  const accessor={};
  Object.defineProperty(accessor,"asset_id",{enumerable:true,get() { throw new Error("getter ran"); }});
  assert.doesNotThrow(() => resolveDesignAsset(accessor));
  assert.deepEqual(findingTypes(resolveDesignAsset(accessor)),["CANONICAL_JSON"]);

  const proxy=new Proxy({}, {getPrototypeOf() { throw new Error("proxy trap"); }});
  assert.doesNotThrow(() => resolveDesignAsset(proxy));
  assert.deepEqual(findingTypes(resolveDesignAsset(proxy)),["CANONICAL_JSON"]);

  const malformedGraph=[...graph,42];
  assert.ok(findingTypes(validateDesignArtifact(screen,malformedGraph)).includes(
    "MALFORMED_GRAPH_MEMBER",
  ));
});

test("validation results are deterministic, deeply frozen, and leave inputs unchanged",async () => {
  const {validateDesignArtifact,validateDesignSystemRules}=await import(
    "../src/pipeline/design-contracts.js"
  );
  const graph=buildGraph();
  const screen=clone(graph.find(artifact => artifact.document_type==="screen-spec"));
  screen.content.source="new_system";
  screen.content.flow_refs[0].artifact_id="user-flow:MISSING";
  rehash(screen);
  const brokenGraph=replaceArtifact(graph,screen);
  const before=canonicalJson(brokenGraph);
  const first=validateDesignArtifact(screen,brokenGraph);
  const second=validateDesignArtifact(screen,brokenGraph);
  assert.deepEqual(first,second);
  assert.deepEqual(first.findings.map(item => `${item.type}:${item.path}`),
    [...first.findings].map(item => `${item.type}:${item.path}`).sort());
  assert.equal(Object.isFrozen(first),true);
  assert.equal(Object.isFrozen(first.findings),true);
  assert.equal(Object.isFrozen(first.findings[0]),true);
  assert.equal(canonicalJson(brokenGraph),before);
  const rules=validateDesignSystemRules(brokenGraph);
  assert.equal(Object.isFrozen(rules),true);
  assert.equal(Object.isFrozen(rules.findings),true);
});

test("the exact four design sources are accepted and every other source fails schema validation",async () => {
  const {validateDesignArtifact}=await import("../src/pipeline/design-contracts.js");
  const brief=buildGraph().find(artifact => artifact.document_type==="design-brief");
  for (const source of ["company_system","new_system","AUTO","NOT_APPLICABLE"]) {
    const candidate=clone(brief);
    candidate.content.source=source;
    rehash(candidate);
    assert.equal(validateDesignArtifact(candidate,[]).valid,true,source);
  }
  const unknown=clone(brief);
  unknown.content.source="COMPANY_SYSTEM";
  rehash(unknown);
  assert.ok(findingTypes(validateDesignArtifact(unknown,[])).includes("SCHEMA_VALIDATION"));
});

test("asset safety is enforced when an asset-bearing artifact is validated",async () => {
  const {validateDesignArtifact}=await import("../src/pipeline/design-contracts.js");
  const graph=buildGraph();
  const manifest=clone(graph.find(artifact => artifact.document_type==="prototype-manifest"));
  manifest.content.assets[0]=clone(invalidAssets.find(item =>
    item.want_type==="ASSET_PATH_UNSAFE").entry);
  rehash(manifest);
  const result=validateDesignArtifact(manifest,replaceArtifact(graph,manifest));
  assert.ok(findingTypes(result).includes("ASSET_PATH_UNSAFE"));
});

test("graph validation fails closed for unknown member versions and duplicate entities",async () => {
  const {validateDesignArtifact,validateDesignSystemRules}=await import(
    "../src/pipeline/design-contracts.js"
  );
  const graph=buildGraph();
  const unknown=clone(graph);
  unknown[1].schema_version="acp.v999";
  assert.ok(findingTypes(validateDesignSystemRules(unknown)).includes(
    "UNKNOWN_SCHEMA_VERSION",
  ));

  const screen=clone(graph.find(artifact => artifact.document_type==="screen-spec"));
  screen.content.states[0].state_id="COMP-BUTTON";
  rehash(screen);
  assert.ok(findingTypes(validateDesignArtifact(
    screen,replaceArtifact(graph,screen),
  )).includes("DUPLICATE_ENTITY_IDENTITY"));
});

test("approved exceptions are closed typed records rather than freeform bypasses",async () => {
  const {validateDesignArtifact}=await import("../src/pipeline/design-contracts.js");
  const graph=buildGraph();
  const system=clone(graph.find(artifact => artifact.document_type==="design-system"));
  system.content.exceptions=[{bypass:true,reason:"please"}];
  rehash(system);
  assert.ok(findingTypes(validateDesignArtifact(system,replaceArtifact(graph,system))).includes(
    "SCHEMA_VALIDATION",
  ));
});

test("approval references go stale and verified company rules cannot change across revisions",async () => {
  const {validateDesignArtifact,validateDesignSystemRules}=await import(
    "../src/pipeline/design-contracts.js"
  );
  const graph=buildGraph();
  const system=clone(graph.find(artifact => artifact.document_type==="design-system"));
  const newer=clone(system);
  newer.revision=2;
  newer.content.system_version="3.3.0";
  newer.content.rules[0].value={token:"color.brand.changed"};
  rehash(newer);
  const advanced=[...graph,newer];
  const approval=graph.find(artifact => artifact.document_type==="design-approval");
  assert.ok(findingTypes(validateDesignArtifact(approval,advanced)).includes(
    "STALE_ARTIFACT_REFERENCE",
  ));
  assert.ok(findingTypes(validateDesignSystemRules(advanced)).includes(
    "VERIFIED_RULE_MUTATION",
  ));
});

test("canonical but malformed graph containers and members never throw or pass open",async () => {
  const {validateDesignArtifact,validateDesignSystemRules}=await import(
    "../src/pipeline/design-contracts.js"
  );
  const graph=buildGraph();
  const screen=graph.find(artifact => artifact.document_type==="screen-spec");
  for (const malformedGraph of [{},null,"graph",42]) {
    assert.doesNotThrow(() => validateDesignArtifact(screen,malformedGraph));
    assert.equal(validateDesignArtifact(screen,malformedGraph).valid,false);
    assert.ok(findingTypes(validateDesignArtifact(screen,malformedGraph)).includes(
      "MALFORMED_GRAPH",
    ));
    assert.doesNotThrow(() => validateDesignSystemRules(malformedGraph));
    assert.equal(validateDesignSystemRules(malformedGraph).valid,false);
  }

  const malformedMembers=clone(graph);
  malformedMembers.find(artifact => artifact.document_type==="user-flow").content.steps=42;
  malformedMembers.find(artifact => artifact.document_type==="design-system").content.rules=42;
  malformedMembers.find(artifact => artifact.document_type==="usability-evidence").content.sessions=42;
  assert.doesNotThrow(() => validateDesignArtifact(screen,malformedMembers));
  assert.equal(validateDesignArtifact(screen,malformedMembers).valid,false);
  assert.doesNotThrow(() => validateDesignSystemRules(malformedMembers));
  assert.equal(validateDesignSystemRules(malformedMembers).valid,false);

  const nullSystem=clone(graph);
  nullSystem.find(artifact => artifact.document_type==="design-system").content=null;
  assert.doesNotThrow(() => validateDesignSystemRules(nullSystem));
  assert.equal(validateDesignSystemRules(nullSystem).valid,false);
});
