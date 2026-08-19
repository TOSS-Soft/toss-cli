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
    if (descriptor.document_type==="design-approval") {
      content.graph_manifest=graph.map(artifactReference).sort((left,right) =>
        canonicalJson(left)<canonicalJson(right) ? -1 :
          canonicalJson(left)>canonicalJson(right) ? 1 : 0);
      content.graph_root_sha256=sha256Canonical(content.graph_manifest);
    }
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

function entityReference(artifact,entityId) {
  return {...artifactReference(artifact),entity_id:entityId};
}

function replaceReferences(value,byArtifactId) {
  if (Array.isArray(value)) return value.map(item => replaceReferences(item,byArtifactId));
  if (!value || typeof value!=="object") return value;
  if (typeof value.artifact_id==="string" &&
      Number.isSafeInteger(value.revision) &&
      typeof value.content_sha256==="string") {
    const target=byArtifactId.get(value.artifact_id);
    return target ? {
      ...value,
      revision:target.revision,
      content_sha256:target.content_sha256,
      document_type:target.document_type,
    } : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [
    key,replaceReferences(item,byArtifactId),
  ]));
}

function latestManifest(graph) {
  const latestByType=new Map();
  for (const artifact of graph) {
    if (artifact.document_type==="design-approval") continue;
    const previous=latestByType.get(artifact.document_type);
    if (!previous || artifact.revision>previous.revision) {
      latestByType.set(artifact.document_type,artifact);
    }
  }
  return [...latestByType.values()].map(artifactReference).sort((left,right) =>
    canonicalJson(left)<canonicalJson(right) ? -1 :
      canonicalJson(left)>canonicalJson(right) ? 1 : 0);
}

function synchronizeApproval(graph) {
  const approval=graph.find(artifact => artifact.document_type==="design-approval");
  approval.content.graph_manifest=latestManifest(graph);
  approval.content.graph_root_sha256=sha256Canonical(approval.content.graph_manifest);
  rehash(approval);
  return graph;
}

function rebuildGraph(input) {
  const graph=[];
  const byArtifactId=new Map();
  for (const original of input) {
    const artifact=clone(original);
    artifact.parents=replaceReferences(artifact.parents,byArtifactId);
    artifact.inputs=replaceReferences(artifact.inputs,byArtifactId);
    artifact.content=replaceReferences(artifact.content,byArtifactId);
    if (artifact.document_type==="design-approval") {
      artifact.content.graph_manifest=latestManifest(graph);
      artifact.content.graph_root_sha256=sha256Canonical(artifact.content.graph_manifest);
    }
    rehash(artifact);
    graph.push(artifact);
    byArtifactId.set(artifact.artifact_id,artifact);
  }
  return graph;
}

const LEVEL_TYPES=Object.freeze({
  LITE:Object.freeze([
    "design-brief","user-flow","design-system","screen-spec","design-audit",
    "design-approval",
  ]),
  STANDARD:Object.freeze([
    "design-brief","ux-analysis","user-flow","information-architecture",
    "wireframe-plan","visual-direction","design-system","screen-spec",
    "prototype-manifest","design-audit","design-approval",
  ]),
  CRITICAL:Object.freeze([
    "design-brief","ux-analysis","user-flow","information-architecture",
    "wireframe-plan","visual-direction","design-system","screen-spec",
    "prototype-manifest","usability-evidence","design-audit","design-approval",
  ]),
});

function levelAwareGraph(level) {
  const graph=buildGraph();
  const brief=graph.find(artifact => artifact.document_type==="design-brief");
  brief.content.orchestration={
    level,
    basis:[`${level} is the exact PM-classified design depth for this source revision.`],
  };
  if (level==="NOT_APPLICABLE") {
    brief.content.source="NOT_APPLICABLE";
    brief.content.purpose="Record that the verified scope has no user-interface impact.";
    brief.content.success_criteria=["No UI design artifact is required for this source revision."];
    rehash(brief);
    return rebuildGraph([brief]);
  }
  rehash(brief);
  return rebuildGraph(graph.filter(artifact => LEVEL_TYPES[level].includes(
    artifact.document_type,
  )));
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
    assert.equal(validateDesignArtifact(candidate,[candidate]).valid,true,source);
  }
  const unknown=clone(brief);
  unknown.content.source="COMPANY_SYSTEM";
  rehash(unknown);
  assert.ok(findingTypes(validateDesignArtifact(unknown,[unknown])).includes("SCHEMA_VALIDATION"));
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

test("artifact validation requires one exact canonical candidate in every graph",async () => {
  const {validateDesignArtifact}=await import("../src/pipeline/design-contracts.js");
  const graph=buildGraph();
  const brief=graph[0];

  assert.ok(findingTypes(validateDesignArtifact(brief,[])).includes(
    "ARTIFACT_NOT_IN_GRAPH",
  ));

  const detached=clone(brief);
  detached.content.purpose="A detached but internally rehashed candidate.";
  rehash(detached);
  assert.ok(findingTypes(validateDesignArtifact(detached,graph)).includes(
    "ARTIFACT_GRAPH_MISMATCH",
  ));

  const replacement=clone(detached);
  replacement.content.purpose="A different rehashed graph replacement.";
  rehash(replacement);
  assert.ok(findingTypes(validateDesignArtifact(
    detached,replaceArtifact(graph,replacement),
  )).includes("ARTIFACT_GRAPH_MISMATCH"));

  assert.ok(findingTypes(validateDesignArtifact(brief,[...graph,clone(brief)])).includes(
    "DUPLICATE_ARTIFACT_IDENTITY",
  ));
});

function approvedExceptionGraph() {
  const graph=buildGraph();
  const system=graph.find(artifact => artifact.document_type==="design-system");
  const screen=graph.find(artifact => artifact.document_type==="screen-spec");
  const approval=graph.find(artifact => artifact.document_type==="design-approval");
  const scope={
    screen_ids:[screen.content.screen_id],
    state_ids:["STATE-DEFAULT"],
    component_ids:["COMP-BUTTON"],
  };
  system.content.exceptions=[{
    exception_id:"EXCEPTION-CHECKOUT-COLOR",
    exact_rule_id:"RULE-COLOR-PRIMARY",
    rationale:"The verified human authority approved this exact checkout treatment.",
    scope,
    valid_until:"2026-09-17T12:00:00Z",
    provenance:clone(system.provenance),
  }];
  screen.content.rule_applications[0]={
    rule_ref:entityReference(system,"RULE-COLOR-PRIMARY"),
    state_ids:["STATE-DEFAULT"],
    component_ids:["COMP-BUTTON"],
    value:{token:"color.checkout.primary"},
    exception_id:"EXCEPTION-CHECKOUT-COLOR",
  };
  delete approval.content.approved_artifacts;
  Object.assign(approval.content,{
    expires_at:"2026-09-17T12:00:00Z",
    graph_manifest:[],
    graph_root_sha256:"0".repeat(64),
    exception_grants:[{
      exception_id:"EXCEPTION-CHECKOUT-COLOR",
      rule_ref:entityReference(system,"RULE-COLOR-PRIMARY"),
      screen_ref:entityReference(screen,screen.content.screen_id),
      scope,
    }],
  });
  return rebuildGraph(graph);
}

function multiMemberApprovedExceptionGraph() {
  let graph=approvedExceptionGraph();
  const system=graph.find(artifact => artifact.document_type==="design-system");
  const screen=graph.find(artifact => artifact.document_type==="screen-spec");
  const approval=graph.find(artifact => artifact.document_type==="design-approval");
  system.content.components.push({
    component_id:"COMP-LINK",name:"Link",states:["default"],
    rule_ids:["RULE-COLOR-PRIMARY"],
  });
  screen.content.component_refs.push(entityReference(system,"COMP-LINK"));
  for (const state of screen.content.states) state.component_ids.push("COMP-LINK");
  const scope={
    screen_ids:["SCREEN-CHECKOUT"],
    state_ids:["STATE-DEFAULT","STATE-SUCCESS"],
    component_ids:["COMP-BUTTON","COMP-LINK"],
  };
  system.content.exceptions[0].scope=clone(scope);
  screen.content.rule_applications[0].state_ids=clone(scope.state_ids);
  screen.content.rule_applications[0].component_ids=clone(scope.component_ids);
  approval.content.exception_grants[0].scope=clone(scope);
  return rebuildGraph(graph);
}

test("only an exact approved unexpired human exception grant authorizes an override",async () => {
  const {validateDesignSystemRules}=await import("../src/pipeline/design-contracts.js");
  const graph=approvedExceptionGraph();
  assert.equal(validateDesignSystemRules(graph).valid,true,
    JSON.stringify(validateDesignSystemRules(graph).findings));
});

test("approved exception scope comparison is order-independent and duplicate-aware",async t => {
  const {validateDesignSystemRules}=await import("../src/pipeline/design-contracts.js");
  await t.test("differently ordered human grant is the same exact scope",() => {
    let graph=multiMemberApprovedExceptionGraph();
    const grant=graph.find(artifact =>
      artifact.document_type==="design-approval").content.exception_grants[0];
    grant.scope.screen_ids.reverse();
    grant.scope.state_ids.reverse();
    grant.scope.component_ids.reverse();
    graph=rebuildGraph(graph);
    const result=validateDesignSystemRules(graph);
    assert.equal(result.valid,true,JSON.stringify(result.findings));
  });

  const cases=[
    ["duplicate screen",scope => scope.screen_ids.push("SCREEN-CHECKOUT")],
    ["missing screen",scope => { scope.screen_ids=[]; }],
    ["extra screen",scope => scope.screen_ids.push("SCREEN-OTHER")],
    ["duplicate state",scope => scope.state_ids.push("STATE-DEFAULT")],
    ["missing state",scope => { scope.state_ids=["STATE-DEFAULT"]; }],
    ["extra state",scope => scope.state_ids.push("STATE-OTHER")],
    ["duplicate component",scope => scope.component_ids.push("COMP-BUTTON")],
    ["missing component",scope => { scope.component_ids=["COMP-BUTTON"]; }],
    ["extra component",scope => scope.component_ids.push("COMP-OTHER")],
  ];
  for (const [name,mutate] of cases) await t.test(name,() => {
    let graph=multiMemberApprovedExceptionGraph();
    const grant=graph.find(artifact =>
      artifact.document_type==="design-approval").content.exception_grants[0];
    mutate(grant.scope);
    graph=rebuildGraph(graph);
    const result=validateDesignSystemRules(graph);
    assert.equal(result.valid,false);
    assert.ok(findingTypes(result).includes("APPROVED_EXCEPTION_INVALID"));
  });
});

test("rejected, wrong-authority, expired, wrong-scope, wrong-revision and replayed grants fail",async t => {
  const {validateDesignSystemRules}=await import("../src/pipeline/design-contracts.js");
  const cases=[
    ["rejected",graph => { graph.at(-1).content.decision="REJECTED"; }],
    ["wrong authority",graph => { graph.at(-1).content.authority.identity="authority:attacker"; }],
    ["expired",graph => { graph.at(-1).content.expires_at="2026-08-16T12:00:00Z"; }],
    ["wrong scope",graph => {
      graph.at(-1).content.exception_grants[0].scope.screen_ids=["SCREEN-OTHER"];
    }],
    ["wrong revision",graph => {
      graph.at(-1).content.exception_grants[0].rule_ref.revision=999;
    }],
    ["replayed for another screen",graph => {
      const screen=graph.find(artifact => artifact.document_type==="screen-spec");
      screen.content.screen_id="SCREEN-OTHER";
    }],
  ];
  for (const [name,mutate] of cases) await t.test(name,() => {
    const graph=approvedExceptionGraph();
    mutate(graph);
    if (name==="replayed for another screen") {
      const rebuilt=rebuildGraph(graph);
      assert.ok(findingTypes(validateDesignSystemRules(rebuilt)).includes(
        "APPROVED_EXCEPTION_INVALID",
      ));
    } else {
      rehash(graph.at(-1));
      assert.ok(findingTypes(validateDesignSystemRules(graph)).includes(
        "APPROVED_EXCEPTION_INVALID",
      ));
    }
  });
});

function designSystemRevision(graph,revision) {
  const prior=graph.find(artifact => artifact.document_type==="design-system");
  const brief=graph.find(artifact => artifact.document_type==="design-brief");
  const next=clone(prior);
  next.revision=revision;
  next.parents=[artifactReference(prior)];
  next.inputs=[artifactReference(brief)];
  next.content.system_version=`3.2.${revision}`;
  return next;
}

test("verified design-system lineage rejects deletion, downgrade, missing prior, gaps and forks",async t => {
  const {validateDesignSystemRules}=await import("../src/pipeline/design-contracts.js");
  await t.test("protected deletion",() => {
    const graph=buildGraph();
    const next=designSystemRevision(graph,2);
    next.content.rules=[];
    rehash(next);
    assert.ok(findingTypes(validateDesignSystemRules([...graph,next])).includes(
      "VERIFIED_RULE_DELETION",
    ));
  });
  await t.test("protected metadata downgrade",() => {
    const graph=buildGraph();
    const next=designSystemRevision(graph,2);
    next.content.rules[0].binding=false;
    rehash(next);
    assert.ok(findingTypes(validateDesignSystemRules([...graph,next])).includes(
      "VERIFIED_RULE_MUTATION",
    ));
  });
  await t.test("verified system downgrade",() => {
    const graph=buildGraph();
    const next=designSystemRevision(graph,2);
    next.content.verified=false;
    rehash(next);
    assert.ok(findingTypes(validateDesignSystemRules([...graph,next])).includes(
      "VERIFIED_SYSTEM_DOWNGRADE",
    ));
  });
  await t.test("missing prior",() => {
    const graph=buildGraph();
    const next=designSystemRevision(graph,2);
    rehash(next);
    const withoutPrior=graph.filter(artifact => artifact.document_type!=="design-system");
    assert.ok(findingTypes(validateDesignSystemRules([...withoutPrior,next])).includes(
      "DESIGN_SYSTEM_LINEAGE_MISSING",
    ));
  });
  await t.test("noncontiguous revision",() => {
    const graph=buildGraph();
    const next=designSystemRevision(graph,3);
    rehash(next);
    assert.ok(findingTypes(validateDesignSystemRules([...graph,next])).includes(
      "DESIGN_SYSTEM_LINEAGE_NONCONTIGUOUS",
    ));
  });
  await t.test("forked revision",() => {
    const graph=buildGraph();
    const left=designSystemRevision(graph,2);
    const right=designSystemRevision(graph,2);
    left.content.system_version="3.2.left";
    right.content.system_version="3.2.right";
    rehash(left);
    rehash(right);
    assert.ok(findingTypes(validateDesignSystemRules([...graph,left,right])).includes(
      "DESIGN_SYSTEM_LINEAGE_FORK",
    ));
  });
});

test("schema-invalid nested binding tables return deterministic frozen findings",async () => {
  const {validateDesignSystemRules}=await import("../src/pipeline/design-contracts.js");
  const graph=buildGraph();
  const system=graph.find(artifact => artifact.document_type==="design-system");
  const screen=graph.find(artifact => artifact.document_type==="screen-spec");
  delete system.content.rules[0].value;
  delete screen.content.rule_applications[0].value;
  rehash(system);
  rehash(screen);
  assert.doesNotThrow(() => validateDesignSystemRules(graph));
  const first=validateDesignSystemRules(graph);
  const second=validateDesignSystemRules(graph);
  assert.equal(first.valid,false);
  assert.ok(findingTypes(first).includes("GRAPH_SCHEMA_VALIDATION"));
  assert.deepEqual(first,second);
  assert.equal(Object.isFrozen(first),true);
  assert.equal(Object.isFrozen(first.findings),true);
});

test("every design relation is local or bound to one exact artifact revision",async t => {
  const {validateDesignArtifact}=await import("../src/pipeline/design-contracts.js");
  await t.test("next step",() => {
    const graph=buildGraph();
    const flow=graph.find(artifact => artifact.document_type==="user-flow");
    flow.content.steps[0].next_step_ids=["STEP-MISSING"];
    rehash(flow);
    assert.ok(findingTypes(validateDesignArtifact(flow,graph)).includes(
      "DANGLING_NEXT_STEP_REFERENCE",
    ));
  });
  await t.test("IA parent",() => {
    const graph=buildGraph();
    const ia=graph.find(artifact => artifact.document_type==="information-architecture");
    ia.content.nodes[0].parent_id="IA-NODE-MISSING";
    rehash(ia);
    assert.ok(findingTypes(validateDesignArtifact(ia,graph)).includes(
      "DANGLING_IA_PARENT_REFERENCE",
    ));
  });
  await t.test("foreign component despite a graph-wide ID",() => {
    const graph=buildGraph();
    const system=clone(graph.find(artifact => artifact.document_type==="design-system"));
    system.artifact_id="design-system:FOREIGN";
    system.content.system_id="DS-FOREIGN";
    system.content.verified=false;
    system.content.rules=[];
    system.content.components=[{
      component_id:"COMP-FOREIGN",name:"Foreign",states:["default"],rule_ids:[],
    }];
    rehash(system);
    const screen=graph.find(artifact => artifact.document_type==="screen-spec");
    screen.content.states[0].component_ids=["COMP-FOREIGN"];
    rehash(screen);
    graph.push(system);
    assert.ok(findingTypes(validateDesignArtifact(screen,graph)).includes(
      "SCREEN_COMPONENT_NOT_DECLARED",
    ));
  });
  await t.test("wireframe state belongs to its exact screen",() => {
    const graph=buildGraph();
    const other=clone(graph.find(artifact => artifact.document_type==="screen-spec"));
    other.artifact_id="screen-spec:OTHER";
    other.content.screen_id="SCREEN-OTHER";
    other.content.states[0].state_id="STATE-FOREIGN";
    rehash(other);
    const wireframe=graph.find(artifact => artifact.document_type==="wireframe-plan");
    wireframe.content.wireframes[0].state_ids=["STATE-FOREIGN"];
    rehash(wireframe);
    graph.push(other);
    assert.ok(findingTypes(validateDesignArtifact(wireframe,graph)).includes(
      "CROSS_SCREEN_STATE_REFERENCE",
    ));
  });
  await t.test("rule application exact revision",() => {
    const graph=buildGraph();
    const screen=graph.find(artifact => artifact.document_type==="screen-spec");
    screen.content.rule_applications[0].rule_ref={
      ...screen.content.component_refs[0],entity_id:"RULE-MISSING",
    };
    delete screen.content.rule_applications[0].rule_id;
    rehash(screen);
    assert.ok(findingTypes(validateDesignArtifact(screen,graph)).includes(
      "DANGLING_ENTITY_REFERENCE",
    ));
  });
  await t.test("responsive and accessibility state links",() => {
    const graph=buildGraph();
    const screen=graph.find(artifact => artifact.document_type==="screen-spec");
    Object.assign(screen.content.states[0],{
      responsive_target_ids:["RESP-MISSING"],
      accessibility_criterion_ids:["A11Y-MISSING"],
    });
    rehash(screen);
    const types=findingTypes(validateDesignArtifact(screen,graph));
    assert.ok(types.includes("DANGLING_RESPONSIVE_REFERENCE"));
    assert.ok(types.includes("DANGLING_ACCESSIBILITY_REFERENCE"));
  });
});

test("asset locations reject encoded ambiguity, controls, fragments, credentials, and secrets",async () => {
  const {resolveDesignAsset}=await import("../src/pipeline/design-contracts.js");
  const base={
    asset_id:"ASSET-CHECKOUT",tool:"code_native",version:"1.0.0",
    integrity:{algorithm:"sha256",value:"c".repeat(64)},
    location:{kind:"path",path:"assets/checkout.html"},
  };
  for (const location of [
    {kind:"path",path:"assets/%2e%2e/secret"},
    {kind:"path",path:"assets/%2fsecret"},
    {kind:"path",path:"assets/%5csecret"},
    {kind:"path",path:"assets/%252e%252e/secret"},
    {kind:"path",path:"assets/control\u0001.txt"},
    {kind:"uri",uri:"https://example.com/file%2fsecret"},
    {kind:"uri",uri:"https://example.com/file#token=secret"},
    {kind:"uri",uri:"https://user:password@example.com/file"},
    {kind:"uri",uri:"https://example.com/file?access_token=secret"},
  ]) {
    assert.equal(resolveDesignAsset({...base,location}).valid,false,JSON.stringify(location));
  }
  for (const location of [
    {kind:"path",path:"assets/design/checkout.html"},
    {kind:"uri",uri:"https://www.figma.com/file/checkout-v42"},
  ]) assert.equal(resolveDesignAsset({...base,location}).valid,true,JSON.stringify(location));
});

function approvalGraph() {
  const graph=buildGraph();
  const approval=graph.at(-1);
  delete approval.content.approved_artifacts;
  Object.assign(approval.content,{
    expires_at:"2026-09-17T12:00:00Z",
    graph_manifest:[],
    graph_root_sha256:"0".repeat(64),
    exception_grants:[],
  });
  return rebuildGraph(graph);
}

test("design approval binds the complete exact latest graph manifest and root",async t => {
  const {validateDesignArtifact}=await import("../src/pipeline/design-contracts.js");
  const valid=approvalGraph();
  assert.equal(validateDesignArtifact(valid.at(-1),valid).valid,true,
    JSON.stringify(validateDesignArtifact(valid.at(-1),valid).findings));

  const cases=[
    ["omitted",graph => { graph.at(-1).content.graph_manifest.pop(); }],
    ["extra",graph => { graph.at(-1).content.graph_manifest.push({
      document_type:"screen-spec",artifact_id:"screen-spec:EXTRA",revision:1,
      content_sha256:"d".repeat(64),
    }); }],
    ["stale",graph => { graph.at(-1).content.graph_manifest[0].revision=999; }],
    ["duplicate",graph => {
      graph.at(-1).content.graph_manifest.push(clone(graph.at(-1).content.graph_manifest[0]));
    }],
    ["forged root",graph => { graph.at(-1).content.graph_root_sha256="f".repeat(64); }],
  ];
  for (const [name,mutate] of cases) await t.test(name,() => {
    const graph=approvalGraph();
    mutate(graph);
    rehash(graph.at(-1));
    assert.ok(findingTypes(validateDesignArtifact(graph.at(-1),graph)).some(type =>
      type.startsWith("APPROVAL_GRAPH_")),name);
  });

  await t.test("omitted actual graph member",() => {
    const graph=approvalGraph();
    const approval=graph.at(-1);
    graph.splice(graph.findIndex(artifact => artifact.document_type==="visual-direction"),1);
    assert.equal(validateDesignArtifact(approval,graph).valid,false);
  });
  await t.test("extra actual graph member",() => {
    const graph=approvalGraph();
    const approval=graph.at(-1);
    const extra=clone(graph.find(artifact => artifact.document_type==="visual-direction"));
    extra.artifact_id="visual-direction:EXTRA";
    extra.content.direction_id="VDIR-EXTRA";
    rehash(extra);
    graph.splice(-1,0,extra);
    assert.ok(findingTypes(validateDesignArtifact(approval,graph)).includes(
      "APPROVAL_GRAPH_INCOMPLETE",
    ));
  });
  await t.test("stale actual graph member",() => {
    const graph=approvalGraph();
    const approval=graph.at(-1);
    const newer=designSystemRevision(graph,2);
    rehash(newer);
    graph.splice(-1,0,newer);
    assert.ok(findingTypes(validateDesignArtifact(approval,graph)).includes(
      "APPROVAL_GRAPH_STALE",
    ));
  });
  await t.test("duplicate actual graph member",() => {
    const graph=approvalGraph();
    const approval=graph.at(-1);
    graph.splice(-1,0,clone(graph[0]));
    assert.ok(findingTypes(validateDesignArtifact(approval,graph)).includes(
      "DUPLICATE_ARTIFACT_IDENTITY",
    ));
  });
});

test("approved exception component and state scope is exact and rule-bearing",async t => {
  const {validateDesignSystemRules}=await import("../src/pipeline/design-contracts.js");
  const setScope=(graph,componentId,stateId="STATE-DEFAULT") => {
    const system=graph.find(artifact => artifact.document_type==="design-system");
    const screen=graph.find(artifact => artifact.document_type==="screen-spec");
    const approval=graph.find(artifact => artifact.document_type==="design-approval");
    const scope={
      screen_ids:[screen.content.screen_id],state_ids:[stateId],component_ids:[componentId],
    };
    system.content.exceptions[0].scope=clone(scope);
    screen.content.rule_applications[0].state_ids=[stateId];
    screen.content.rule_applications[0].component_ids=[componentId];
    approval.content.exception_grants[0].scope=clone(scope);
    return {system,screen};
  };

  await t.test("valid exact scope",() => {
    const graph=approvedExceptionGraph();
    assert.equal(validateDesignSystemRules(graph).valid,true,
      JSON.stringify(validateDesignSystemRules(graph).findings));
  });
  await t.test("unused component",() => {
    let graph=approvedExceptionGraph();
    const {system,screen}=setScope(graph,"COMP-UNUSED");
    system.content.components.push({
      component_id:"COMP-UNUSED",name:"Unused",states:["default"],
      rule_ids:["RULE-COLOR-PRIMARY"],
    });
    screen.content.component_refs.push(entityReference(system,"COMP-UNUSED"));
    graph=rebuildGraph(graph);
    assert.ok(findingTypes(validateDesignSystemRules(graph)).includes(
      "APPROVED_EXCEPTION_INVALID",
    ));
  });
  await t.test("component without protected rule",() => {
    let graph=approvedExceptionGraph();
    const {system,screen}=setScope(graph,"COMP-NO-RULE");
    system.content.components.push({
      component_id:"COMP-NO-RULE",name:"No rule",states:["default"],rule_ids:[],
    });
    screen.content.component_refs.push(entityReference(system,"COMP-NO-RULE"));
    screen.content.states[0].component_ids.push("COMP-NO-RULE");
    graph=rebuildGraph(graph);
    assert.ok(findingTypes(validateDesignSystemRules(graph)).includes(
      "APPROVED_EXCEPTION_INVALID",
    ));
  });
  await t.test("affected state does not use scoped component",() => {
    let graph=approvedExceptionGraph();
    const {system,screen}=setScope(graph,"COMP-BUTTON","STATE-SUCCESS");
    system.content.components.push({
      component_id:"COMP-LINK",name:"Link",states:["default"],
      rule_ids:["RULE-COLOR-PRIMARY"],
    });
    screen.content.component_refs.push(entityReference(system,"COMP-LINK"));
    screen.content.states.find(state => state.state_id==="STATE-SUCCESS").component_ids=[
      "COMP-LINK",
    ];
    graph=rebuildGraph(graph);
    assert.ok(findingTypes(validateDesignSystemRules(graph)).includes(
      "APPROVED_EXCEPTION_INVALID",
    ));
  });
  await t.test("component reference from wrong system revision",() => {
    let graph=approvedExceptionGraph();
    const prior=graph.find(artifact => artifact.document_type==="design-system");
    const next=designSystemRevision(graph,2);
    graph.splice(graph.indexOf(prior)+1,0,next);
    graph=rebuildGraph(graph);
    const screen=graph.find(artifact => artifact.document_type==="screen-spec");
    screen.content.component_refs[0]=entityReference(prior,"COMP-BUTTON");
    rehash(screen);
    synchronizeApproval(graph);
    assert.ok(findingTypes(validateDesignSystemRules(graph)).includes(
      "APPROVED_EXCEPTION_INVALID",
    ));
  });
});

function designSystemRevisionGraph(mutate=() => {}) {
  const graph=buildGraph();
  const prior=graph.find(artifact => artifact.document_type==="design-system");
  const next=designSystemRevision(graph,2);
  mutate(next,prior,graph);
  graph.splice(graph.indexOf(prior)+1,0,next);
  return rebuildGraph(graph);
}

function designSystemThreeRevisionGraph() {
  let graph=designSystemRevisionGraph();
  const prior=graph.find(artifact =>
    artifact.document_type==="design-system" && artifact.revision===2);
  const brief=graph.find(artifact => artifact.document_type==="design-brief");
  const next=clone(prior);
  next.revision=3;
  next.parents=[artifactReference(prior)];
  next.inputs=[artifactReference(brief)];
  next.content.system_version="3.2.3";
  graph.splice(graph.indexOf(prior)+1,0,next);
  return rebuildGraph(graph);
}

test("design-system history accepts one exact stable lineage and rejects impostors",async t => {
  const {validateDesignSystemRules}=await import("../src/pipeline/design-contracts.js");
  await t.test("valid unchanged revision two",() => {
    const graph=designSystemRevisionGraph();
    assert.equal(validateDesignSystemRules(graph).valid,true,
      JSON.stringify(validateDesignSystemRules(graph).findings));
  });
  await t.test("valid lineage is independent of graph member order",() => {
    const graph=designSystemThreeRevisionGraph();
    const systems=graph.filter(artifact => artifact.document_type==="design-system").reverse();
    const reordered=graph.filter(artifact => artifact.document_type!=="design-system");
    reordered.splice(graph.findIndex(artifact => artifact.document_type==="design-system"),
      0,...systems);
    assert.equal(validateDesignSystemRules(reordered).valid,true,
      JSON.stringify(validateDesignSystemRules(reordered).findings));
  });
  await t.test("deletion still fails",() => {
    const graph=designSystemRevisionGraph(next => { next.content.rules=[]; });
    assert.ok(findingTypes(validateDesignSystemRules(graph)).includes(
      "VERIFIED_RULE_DELETION",
    ));
  });
  await t.test("metadata downgrade still fails",() => {
    const graph=designSystemRevisionGraph(next => { next.content.rules[0].binding=false; });
    assert.ok(findingTypes(validateDesignSystemRules(graph)).includes(
      "VERIFIED_RULE_MUTATION",
    ));
  });
  await t.test("wrong parent fails",() => {
    const graph=designSystemRevisionGraph((next,prior,all) => {
      next.parents=[artifactReference(all[0])];
    });
    assert.ok(findingTypes(validateDesignSystemRules(graph)).includes(
      "DESIGN_SYSTEM_LINEAGE_PARENT_INVALID",
    ));
  });
  await t.test("cross-source revision fails",() => {
    const graph=designSystemRevisionGraph(next => { next.content.source="new_system"; });
    const types=findingTypes(validateDesignSystemRules(graph));
    assert.ok(types.includes("SOURCE_MISMATCH") || types.includes("CROSS_SOURCE_REFERENCE"));
  });
  await t.test("unrelated artifact cannot reuse stable entities",() => {
    const graph=buildGraph();
    const foreign=clone(graph.find(artifact => artifact.document_type==="design-system"));
    foreign.artifact_id="design-system:FOREIGN";
    foreign.content.system_version="foreign";
    rehash(foreign);
    graph.splice(-1,0,foreign);
    synchronizeApproval(graph);
    assert.ok(findingTypes(validateDesignSystemRules(graph)).includes(
      "DUPLICATE_ENTITY_IDENTITY",
    ));
  });
});

test("wireframe flow references must traverse the exact selected screen",async t => {
  const {validateDesignArtifact}=await import("../src/pipeline/design-contracts.js");
  await t.test("selected flow traverses another screen",() => {
    let graph=buildGraph();
    const flow=graph.find(artifact => artifact.document_type==="user-flow");
    for (const step of flow.content.steps) step.screen_id="SCREEN-OTHER";
    graph=rebuildGraph(graph);
    const wireframe=graph.find(artifact => artifact.document_type==="wireframe-plan");
    assert.ok(findingTypes(validateDesignArtifact(wireframe,graph)).includes(
      "WIREFRAME_FLOW_SCREEN_MISMATCH",
    ));
  });
  await t.test("colliding screen and state ids do not replace reverse linkage",() => {
    const graph=buildGraph();
    const flow=graph.find(artifact => artifact.document_type==="user-flow");
    const foreign=clone(flow);
    foreign.artifact_id="user-flow:FOREIGN";
    foreign.content.flow_id="FLOW-FOREIGN";
    rehash(foreign);
    graph.splice(-1,0,foreign);
    const wireframe=graph.find(artifact => artifact.document_type==="wireframe-plan");
    wireframe.content.wireframes[0].flow_refs=[entityReference(foreign,"FLOW-FOREIGN")];
    rehash(wireframe);
    const result=validateDesignArtifact(wireframe,graph);
    assert.ok(findingTypes(result).includes(
      "WIREFRAME_FLOW_SCREEN_MISMATCH",
    ),JSON.stringify(result.findings));
  });
});

test("remote asset URIs reject every query, fragment, and encoded credential ambiguity",async () => {
  const {resolveDesignAsset}=await import("../src/pipeline/design-contracts.js");
  const base={
    asset_id:"ASSET-REMOTE",tool:"figma",version:"1",
    integrity:{algorithm:"sha256",value:"c".repeat(64)},
  };
  for (const uri of [
    "https://example.com/file?node-id=1",
    "https://example.com/file?token=secret",
    "https://example.com/file?session=secret",
    "https://example.com/file?bearer=secret",
    "https://example.com/file?key=secret",
    "https://example.com/file?signature=secret",
    "https://example.com/file?auth=secret",
    "https://example.com/file%3ftoken%3dsecret",
    "https://example.com/file%253ftoken%253dsecret",
    "https://example.com/file#session",
  ]) assert.equal(resolveDesignAsset({
    ...base,location:{kind:"uri",uri},
  }).valid,false,uri);
  assert.equal(resolveDesignAsset({
    ...base,location:{kind:"uri",uri:"https://example.com/assets/file"},
  }).valid,true);
});

test("approval closure is independent of synchronized caller omissions and extras",async t => {
  const {validateDesignArtifact}=await import("../src/pipeline/design-contracts.js");
  await t.test("complete exact twelve-type graph",() => {
    const graph=approvalGraph();
    assert.equal(new Set(graph.map(artifact => artifact.document_type)).size,12);
    assert.equal(validateDesignArtifact(graph.at(-1),graph).valid,true);
  });
  await t.test("synchronized omission",() => {
    const graph=approvalGraph();
    graph.splice(graph.findIndex(artifact => artifact.document_type==="visual-direction"),1);
    synchronizeApproval(graph);
    const approval=graph.find(artifact => artifact.document_type==="design-approval");
    assert.ok(findingTypes(validateDesignArtifact(approval,graph)).includes(
      "APPROVAL_REQUIRED_TYPE_MISSING",
    ));
  });
  await t.test("synchronized extra member",() => {
    const graph=approvalGraph();
    const extra=clone(graph.find(artifact => artifact.document_type==="visual-direction"));
    extra.artifact_id="visual-direction:EXTRA";
    extra.content.direction_id="VDIR-EXTRA";
    rehash(extra);
    graph.splice(-1,0,extra);
    synchronizeApproval(graph);
    const approval=graph.find(artifact => artifact.document_type==="design-approval");
    assert.ok(findingTypes(validateDesignArtifact(approval,graph)).includes(
      "APPROVAL_TYPE_MULTIPLICITY",
    ));
  });
  await t.test("synchronized duplicate member",() => {
    const graph=approvalGraph();
    graph.splice(-1,0,clone(graph.find(
      artifact => artifact.document_type==="visual-direction",
    )));
    synchronizeApproval(graph);
    const approval=graph.find(artifact => artifact.document_type==="design-approval");
    const types=findingTypes(validateDesignArtifact(approval,graph));
    assert.ok(types.includes("APPROVAL_TYPE_MULTIPLICITY"));
    assert.ok(types.includes("DUPLICATE_ARTIFACT_IDENTITY"));
  });
  await t.test("synchronized forked latest lineage",() => {
    const graph=designSystemRevisionGraph();
    const latest=graph.find(artifact =>
      artifact.document_type==="design-system" && artifact.revision===2);
    const fork=clone(latest);
    fork.content.system_version="3.2.fork";
    rehash(fork);
    graph.splice(-1,0,fork);
    synchronizeApproval(graph);
    const approval=graph.find(artifact => artifact.document_type==="design-approval");
    const types=findingTypes(validateDesignArtifact(approval,graph));
    assert.ok(types.includes("DESIGN_SYSTEM_LINEAGE_FORK"));
    assert.ok(types.includes("APPROVAL_TYPE_MULTIPLICITY"));
  });
  await t.test("latest manifest cannot be synchronized to a stale predecessor",() => {
    const graph=designSystemRevisionGraph();
    const approval=graph.find(artifact => artifact.document_type==="design-approval");
    const stale=graph.find(artifact =>
      artifact.document_type==="design-system" && artifact.revision===1);
    approval.content.graph_manifest=approval.content.graph_manifest.map(reference =>
      reference.document_type==="design-system" ? artifactReference(stale) : reference);
    approval.content.graph_root_sha256=sha256Canonical(approval.content.graph_manifest);
    rehash(approval);
    assert.ok(findingTypes(validateDesignArtifact(approval,graph)).includes(
      "APPROVAL_GRAPH_STALE",
    ));
  });
  await t.test("historical predecessor is outside latest manifest",() => {
    const graph=designSystemRevisionGraph();
    const approval=graph.find(artifact => artifact.document_type==="design-approval");
    assert.equal(approval.content.graph_manifest.filter(reference =>
      reference.document_type==="design-system").length,1);
    assert.equal(approval.content.graph_manifest.find(reference =>
      reference.document_type==="design-system").revision,2);
    assert.equal(validateDesignArtifact(approval,graph).valid,true,
      JSON.stringify(validateDesignArtifact(approval,graph).findings));
  });
});

test("level-aware approval closure accepts exact Lite, Standard, Critical, and N/A graphs",async t => {
  const {validateDesignArtifact}=await import("../src/pipeline/design-contracts.js");
  for (const level of ["LITE","STANDARD","CRITICAL","NOT_APPLICABLE"]) {
    await t.test(level,() => {
      const graph=levelAwareGraph(level);
      const expectedCount=level==="NOT_APPLICABLE" ? 1 : LEVEL_TYPES[level].length;
      assert.equal(graph.length,expectedCount);
      for (const artifact of graph) {
        const result=validateDesignArtifact(artifact,graph);
        assert.equal(result.valid,true,`${level} ${artifact.document_type}: ${JSON.stringify(
          result.findings,
        )}`);
      }
    });
  }
});

test("Lite keeps its hidden design-system binding and N/A cannot fabricate approval",async () => {
  const {validateDesignArtifact}=await import("../src/pipeline/design-contracts.js");
  const lite=levelAwareGraph("LITE");
  const withoutSystem=rebuildGraph(lite.filter(artifact => artifact.document_type!=="design-system"));
  const liteApproval=withoutSystem.find(artifact => artifact.document_type==="design-approval");
  assert.ok(validateDesignArtifact(liteApproval,withoutSystem).findings.some(finding =>
    finding.type==="APPROVAL_REQUIRED_TYPE_MISSING" ||
    finding.type==="APPROVAL_GRAPH_INCOMPLETE"));

  const notApplicable=levelAwareGraph("NOT_APPLICABLE");
  const fabricated=clone(buildGraph().find(artifact => artifact.document_type==="design-approval"));
  fabricated.content.source="NOT_APPLICABLE";
  fabricated.parents=[];
  fabricated.inputs=[];
  fabricated.content.graph_manifest=[artifactReference(notApplicable[0])];
  fabricated.content.graph_root_sha256=sha256Canonical(fabricated.content.graph_manifest);
  rehash(fabricated);
  const forgedGraph=[...notApplicable,fabricated];
  assert.ok(validateDesignArtifact(fabricated,forgedGraph).findings.some(finding =>
    finding.type==="APPROVAL_NOT_ALLOWED"));
});
