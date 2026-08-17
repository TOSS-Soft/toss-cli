import assert from "node:assert/strict";
import test from "node:test";

import {validateDocument} from "../src/contracts/validator.js";
import {
  clone,
  completeArtifacts,
  fixture,
  rehash,
} from "./support/trace-fixture.js";

const traceabilityModule=await import("../src/pipeline/traceability.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});

const unavailable=name => () => {
  throw new Error(`${name} is unavailable`);
};
const buildTraceGraph=traceabilityModule.buildTraceGraph ??
  unavailable("buildTraceGraph");
const traceEntity=traceabilityModule.traceEntity ?? unavailable("traceEntity");
const calculateRequirementCoverage=traceabilityModule.calculateRequirementCoverage ??
  unavailable("calculateRequirementCoverage");

function assertDeepFrozen(value) {
  if (!value || typeof value!=="object") return;
  assert.equal(Object.isFrozen(value),true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("traceability exposes deterministic graph, traversal, and coverage contracts",() => {
  assert.equal(typeof traceabilityModule.buildTraceGraph,"function");
  assert.equal(typeof traceabilityModule.traceEntity,"function");
  assert.equal(typeof traceabilityModule.calculateRequirementCoverage,"function");
});

test("a complete fixture builds a deterministic frozen typed graph without mutation",() => {
  const artifacts=completeArtifacts();
  const before=clone(artifacts);

  const first=buildTraceGraph(artifacts);
  const second=buildTraceGraph(clone(artifacts));

  assert.deepEqual(first,second);
  assert.deepEqual(artifacts,before);
  assert.equal(first.schema_version,"trace-graph.v1");
  assert.equal(validateDocument(first,"trace-graph.v1").valid,true);
  assertDeepFrozen(first);
  assert.deepEqual(first.nodes.map(node => node.id),[...first.nodes.map(
    node => node.id,
  )].sort());
});

test("trace traversal follows the normative stage order and returns a raw result contract",() => {
  const expected=fixture("traceability/valid/complete.json");
  const graph=buildTraceGraph(completeArtifacts());
  const result=traceEntity(graph,"REQ-001");

  assert.deepEqual(result.downstream.map(node => node.id),
    expected.downstream_from_req_001);
  assert.equal(result.schema_version,"trace-result.v1");
  assert.equal(result.document_type,"trace-result");
  assert.equal(validateDocument(result,"trace-result.v1").valid,true);
  assertDeepFrozen(result);
});

test("source provenance remains exact and BR stays visible as a v1 provenance root",() => {
  const expected=fixture("traceability/valid/complete.json").business_rule;
  const graph=buildTraceGraph(completeArtifacts());
  const businessRule=graph.nodes.find(node => node.id===expected.id);

  assert.equal(businessRule.type,expected.type);
  assert.deepEqual(businessRule.provenance.source,{
    file:expected.file,
    section:expected.section,
    location:expected.location,
  });
  assert.deepEqual(traceEntity(graph,expected.id).downstream,[]);

  const sourceRequirement=graph.edges.find(edge =>
    edge.type==="SOURCE_REQUIREMENT" && edge.from==="REQ-001",
  );
  assert.equal(sourceRequirement.source.path,
    "/content/issues/0/source_requirements/0");
});

test("requirement coverage is issue-owned and excludes BR until upstream refs support it",() => {
  const expected=fixture("traceability/valid/complete.json");
  const graph=buildTraceGraph(completeArtifacts());

  assert.equal(calculateRequirementCoverage(graph),expected.coverage);

  const crossIssue=clone(graph);
  const issue=crossIssue.nodes.find(node => node.id==="ISSUE-001");
  const criterion=crossIssue.nodes.find(node => node.id==="AC-001");
  crossIssue.nodes.push({...issue,id:"ISSUE-002",meaning:"Unrelated issue."});
  crossIssue.nodes.push({...criterion,id:"AC-002",meaning:"Unrelated criterion."});
  crossIssue.edges.push({
    ...crossIssue.edges.find(edge => edge.type==="CONTAINS"),
    to:"ISSUE-002",
  });
  crossIssue.edges.push({
    ...crossIssue.edges.find(edge => edge.type==="OWNS"),
    from:"ISSUE-002",
    to:"AC-002",
  });
  const verifies=crossIssue.edges.find(edge =>
    edge.from==="REQ-001" && edge.type==="VERIFIED_BY",
  );
  verifies.to="AC-002";

  assert.equal(calculateRequirementCoverage(crossIssue),2/3);
});

test("dangling, cycle, orphan, stale, and extra inputs fail closed",() => {
  const dangling=completeArtifacts();
  const danglingPatch=fixture("traceability/invalid/dangling.json");
  dangling.issuePlan.content.acceptance_criteria[0].verifies=[{
    kind:"requirement",
    id:danglingPatch.dangling_requirement_id,
  }];
  rehash(dangling.issuePlan);
  assert.throws(() => buildTraceGraph(dangling),/dangling/i);

  const cycle=completeArtifacts();
  const cyclePatch=fixture("traceability/invalid/cycle.json");
  cycle.issuePlan.content.issues[0].dependencies=[{
    kind:"issue",
    id:cyclePatch.dependency_id,
  }];
  rehash(cycle.issuePlan);
  assert.throws(() => buildTraceGraph(cycle),/cycle/i);

  const orphan=completeArtifacts({orphanAdr:true});
  const orphanPatch=fixture("traceability/invalid/orphan.json");
  assert.throws(() => buildTraceGraph(orphan),
    new RegExp(`orphan.*${orphanPatch.orphan_id}`,"i"));

  const stale=completeArtifacts();
  stale.architecture.artifact.content.components[0].meaning="Stale meaning.";
  rehash(stale.architecture.artifact);
  assert.throws(() => buildTraceGraph(stale),/stale|immutable|mismatch/i);

  assert.throws(() => buildTraceGraph({...completeArtifacts(),extra:true}),
    /unknown|extra|property/i);
});

test("unknown current graph types and missing entities are controlled failures",() => {
  const graph=buildTraceGraph(completeArtifacts());
  const unknown=clone(graph);
  unknown.nodes[0].type="FLOW";

  assert.throws(() => traceEntity(unknown,unknown.nodes[0].id),/type|schema/i);
  assert.throws(() => traceEntity(graph,"REQ-MISSING"),/not found/i);
});

test("raw graph sources remain bound to exact typed input snapshots",() => {
  const graph=buildTraceGraph(completeArtifacts());
  const foreignSource=clone(graph);
  foreignSource.nodes[0].source.artifact.artifact_id="FOREIGN-ARTIFACT";
  assert.throws(() => traceEntity(foreignSource,foreignSource.nodes[0].id),
    /source.*snapshot|stale|exact input/i);

  const wrongSlot=clone(graph);
  wrongSlot.input_snapshots.pm_analysis.document_type="adr";
  assert.throws(() => calculateRequirementCoverage(wrongSlot),
    /pm_analysis|document type|source.*snapshot/i);
});

test("programmatic non-JSON values fail before graph construction",() => {
  const invalidValues=[
    new Date(),
    undefined,
    Object.assign(Object.create({polluted:true}),completeArtifacts()),
    Object.defineProperty(completeArtifacts(),"hidden",{value:true}),
    {...completeArtifacts(),symbol:Symbol("invalid")},
    [...Array(2)],
  ];
  const accessor=completeArtifacts();
  Object.defineProperty(accessor,"pmAnalysis",{get() { return {}; }});
  invalidValues.push(accessor);
  const symbolic=completeArtifacts();
  symbolic[Symbol("invalid")]=true;
  invalidValues.push(symbolic);
  const cyclic=completeArtifacts();
  cyclic.self=cyclic;
  invalidValues.push(cyclic);

  for (const value of invalidValues) {
    assert.throws(() => buildTraceGraph(value),/JSON|object|unsupported|cyclic|property/i);
  }
});
