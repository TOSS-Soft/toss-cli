import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {sha256Canonical} from "../src/contracts/acp.js";
import {validateDocument} from "../src/contracts/validator.js";
import {buildDecisionPackageFromPmAnalysis} from "../src/pipeline/decisions.js";
import {auditSpecification} from "../src/pipeline/spec-auditor.js";
import {transition} from "../src/pipeline/state-machine.js";
import {buildTraceGraph} from "../src/pipeline/traceability.js";
import {
  artifactReference,
  clone,
  completeArtifacts,
  fixture,
  rehash,
} from "./support/trace-fixture.js";

const readinessModule=await import("../src/pipeline/readiness.js").catch(() => ({}));
const evaluateProjectReadiness=readinessModule.evaluateProjectReadiness ?? (() => {
  throw new Error("evaluateProjectReadiness is unavailable");
});

const gateCases=fixture("readiness/gate-cases.json");
const expectedPass=fixture("readiness/expected-pass.json");

function passAggregate() {
  const upstream=completeArtifacts();
  const specAudit=auditSpecification(upstream).artifact;
  const traceGraph=buildTraceGraph(upstream);
  const artifacts={
    pm_analysis:upstream.pmAnalysis,
    architecture:upstream.architecture.artifact,
    adrs:upstream.architecture.adrs,
    issue_plan:upstream.issuePlan,
    spec_audit:specAudit,
  };
  const stateContent=transition("SPEC_AUDIT","AUDIT_PASSED",{
    source_revision:upstream.pmAnalysis.provenance.source_revision,
    source_sha256:upstream.pmAnalysis.provenance.source_sha256,
    artifacts,
  });
  const analysisState={
    schema_version:"acp.v1",
    document_type:"transition-event",
    artifact_id:"project-analysis-readiness-001",
    revision:1,
    run_id:"run-project-readiness-001",
    producer:{role:"orchestrator",identity:"toss-analysis-orchestrator"},
    runtime_identity:clone(upstream.pmAnalysis.runtime_identity),
    created_at:"2026-08-17T14:00:00.000Z",
    provenance:clone(upstream.pmAnalysis.provenance),
    parents:[],
    inputs:clone(stateContent.input_artifacts),
    content_sha256:sha256Canonical(stateContent),
    content:clone(stateContent),
  };
  return clone({
    pmAnalysis:upstream.pmAnalysis,
    architecture:upstream.architecture,
    issuePlan:upstream.issuePlan,
    specAudits:[specAudit],
    traceGraph,
    analysisState,
  });
}

function failingOnly(mutation) {
  const aggregate=passAggregate();
  switch (mutation) {
    case "unknown-pm-version":
      aggregate.pmAnalysis.schema_version="acp.v2";
      break;
    case "missing-project-scope":
      aggregate.pmAnalysis.content.summary="";
      rehash(aggregate.pmAnalysis);
      break;
    case "missing-actors":
      aggregate.pmAnalysis.content.actors=[];
      rehash(aggregate.pmAnalysis);
      break;
    case "missing-integrations":
      aggregate.pmAnalysis.content.integrations=[];
      rehash(aggregate.pmAnalysis);
      break;
    case "unresolved-p2-question": {
      aggregate.pmAnalysis.content.open_questions[0].severity="P2";
      rehash(aggregate.pmAnalysis);
      aggregate.decisionPackage=buildDecisionPackageFromPmAnalysis(
        aggregate.pmAnalysis,
        [{
          id:"Q-001",
          context:"The source does not set a customer-visible response target.",
          impact:"Support outcomes cannot be evaluated consistently without the target.",
        }],
      );
      break;
    }
    case "pending-architecture-question":
      aggregate.architecture.artifact.content.architecture_questions[0].status="pending";
      rehash(aggregate.architecture.artifact);
      break;
    case "pending-adr":
      aggregate.architecture.adrs[0].content.status="proposed";
      aggregate.architecture.adrs[0].content.approval.state="pending";
      rehash(aggregate.architecture.adrs[0]);
      break;
    case "missing-risks":
      aggregate.pmAnalysis.content.risks=[];
      rehash(aggregate.pmAnalysis);
      break;
    case "missing-epic-map":
      aggregate.issuePlan.content.epics=[];
      rehash(aggregate.issuePlan);
      break;
    case "uncovered-requirement":
      aggregate.issuePlan.content.acceptance_criteria[0].verifies.pop();
      rehash(aggregate.issuePlan);
      break;
    case "non-pass-audit":
      aggregate.specAudits[0].content.status="WARN";
      aggregate.specAudits[0].content.ready_for_github=true;
      aggregate.specAudits[0].content.summary={total:1,blocking:0,warnings:1};
      rehash(aggregate.specAudits[0]);
      break;
    case "incompatible-analysis-state":
      aggregate.analysisState.content.state="SPEC_AUDIT";
      rehash(aggregate.analysisState);
      break;
    default:
      throw new Error(`Unknown readiness mutation ${mutation}`);
  }
  return aggregate;
}

function assertDeepFrozen(value) {
  if (!value || typeof value!=="object") return;
  assert.equal(Object.isFrozen(value),true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function p3DecisionEnrichment(overrides={}) {
  return {
    id:"Q-001",
    context:"The source does not set a customer-visible response target.",
    impact:"Support outcomes cannot be evaluated consistently without the target.",
    reversibility:"reversible",
    ...overrides,
  };
}

for (const {rule_id:ruleId,mutation} of gateCases) {
  test(`${ruleId} blocks with artifact/entity/path evidence`,() => {
    const result=evaluateProjectReadiness(failingOnly(mutation));

    assert.equal(result.ready_for_issue_generation,false,ruleId);
    const failure=result.failures.find(item => item.rule_id===ruleId);
    assert.ok(failure,ruleId);
    assert.ok(failure.evidence.length,ruleId);
    for (const evidence of failure.evidence) {
      assert.equal(typeof evidence.artifact,"string",ruleId);
      assert.ok(Object.hasOwn(evidence,"entity_id"),ruleId);
      assert.match(evidence.path,/^\//,ruleId);
    }
  });
}

test("an exact complete pipeline is ready while non-blocking assumptions remain warnings",() => {
  const input=passAggregate();
  const before=clone(input);
  const first=evaluateProjectReadiness(input);
  const second=evaluateProjectReadiness(clone(input));

  assert.deepEqual(first,second);
  assert.deepEqual(input,before);
  assert.equal(first.schema_version,expectedPass.schema_version);
  assert.equal(first.document_type,expectedPass.document_type);
  assert.equal(first.rules_version,expectedPass.rules_version);
  assert.equal(first.ready_for_issue_generation,expectedPass.ready_for_issue_generation);
  assert.deepEqual(first.failures.map(item => item.rule_id),expectedPass.failure_rule_ids);
  assert.deepEqual(first.warnings.map(item => item.rule_id),expectedPass.warning_rule_ids);
  assert.equal(first.coverage.requirement_ac,1);
  assert.equal(validateDocument(first,"pdor-result.v1").valid,true);
  assertDeepFrozen(first);
});

test("a supplied P3/P4 decision package is verified but cannot turn its warning into failure",() => {
  const aggregate=passAggregate();
  aggregate.decisionPackage=buildDecisionPackageFromPmAnalysis(
    aggregate.pmAnalysis,
    [{
      id:"Q-001",
      context:"The source does not set a customer-visible response target.",
      impact:"Support outcomes cannot be evaluated consistently without the target.",
      reversibility:"reversible",
    }],
  );

  const result=evaluateProjectReadiness(aggregate);

  assert.equal(result.ready_for_issue_generation,true);
  assert.deepEqual(result.failures,[]);
  assert.deepEqual(result.warnings.map(item => item.rule_id),[
    "PDOR-120-UNRESOLVED-ASSUMPTIONS",
  ]);
});

test("decision evidence must preserve the PM-owned question owner exactly",() => {
  const aggregate=passAggregate();
  aggregate.decisionPackage=clone(buildDecisionPackageFromPmAnalysis(
    aggregate.pmAnalysis,
    [{
      id:"Q-001",
      context:"The source does not set a customer-visible response target.",
      impact:"Support outcomes cannot be evaluated consistently without the target.",
      reversibility:"reversible",
    }],
  ));
  aggregate.decisionPackage.questions[0].evidence[0].owner="ATTACKER";

  const result=evaluateProjectReadiness(aggregate);

  assert.equal(result.ready_for_issue_generation,false);
  assert.ok(result.failures.some(item =>
    item.rule_id==="PDOR-040-BLOCKING-DECISIONS" &&
    item.evidence.some(item => item.path.endsWith("/owner"))));
});

test("missing retained owner reports stable exact decision evidence",() => {
  const aggregate=passAggregate();
  aggregate.decisionPackage=clone(buildDecisionPackageFromPmAnalysis(
    aggregate.pmAnalysis,
    [{
      id:"Q-001",
      context:"The source does not set a customer-visible response target.",
      impact:"Support outcomes cannot be evaluated consistently without the target.",
      reversibility:"reversible",
    }],
  ));
  delete aggregate.decisionPackage.questions[0].evidence[0].owner;

  const first=evaluateProjectReadiness(aggregate);
  const second=evaluateProjectReadiness(clone(aggregate));
  const failure=first.failures.find(item =>
    item.rule_id==="PDOR-040-BLOCKING-DECISIONS");

  assert.deepEqual(first,second);
  assert.ok(failure);
  assert.ok(failure.evidence.some(item =>
    item.path.endsWith("/owner") && item.entity_id==="Q-001"));
});

test("canonical but shape-invalid aggregates return a frozen schema-valid failure",() => {
  for (const aggregate of [null,[],42,"pipeline"]) {
    const result=evaluateProjectReadiness(aggregate);

    assert.equal(result.ready_for_issue_generation,false);
    assert.equal(validateDocument(result,"pdor-result.v1").valid,true);
    assertDeepFrozen(result);
  }
});

test("malformed nested canonical collections fail closed without raw traversal",() => {
  const malformedRequirements=passAggregate();
  malformedRequirements.pmAnalysis.content.functional_requirements=42;
  rehash(malformedRequirements.pmAnalysis);
  const malformedIssues=passAggregate();
  malformedIssues.issuePlan.content.issues=42;
  rehash(malformedIssues.issuePlan);

  for (const aggregate of [malformedRequirements,malformedIssues]) {
    const first=evaluateProjectReadiness(aggregate);
    const second=evaluateProjectReadiness(clone(aggregate));

    assert.deepEqual(first,second);
    assert.equal(first.ready_for_issue_generation,false);
    assert.equal(validateDocument(first,"pdor-result.v1").valid,true);
    assertDeepFrozen(first);
  }
});

test("a stale audit from a different source revision is never accepted",() => {
  const stale=passAggregate();
  stale.specAudits[0].provenance.source_revision="project-brief-r0";

  const result=evaluateProjectReadiness(stale);

  assert.equal(result.ready_for_issue_generation,false);
  assert.ok(result.failures.some(item =>
    item.rule_id==="PDOR-001-ARTIFACT-INTEGRITY" ||
    item.rule_id==="PDOR-100-LATEST-SPEC-AUDIT"));
});

test("derived summaries and inconsistent upstream references are independently rejected",() => {
  const forgedCoverage=passAggregate();
  forgedCoverage.issuePlan.content.coverage.ready=false;
  rehash(forgedCoverage.issuePlan);
  const wrongTrace=passAggregate();
  wrongTrace.traceGraph.input_snapshots.pm_analysis=artifactReference(
    wrongTrace.architecture.artifact,
  );

  assert.equal(evaluateProjectReadiness(forgedCoverage).ready_for_issue_generation,false);
  assert.equal(evaluateProjectReadiness(wrongTrace).ready_for_issue_generation,false);
});

test("unknown requirement references cannot inflate independently recomputed coverage",() => {
  const aggregate=passAggregate();
  aggregate.issuePlan.content.acceptance_criteria[0].verifies[0].id="REQ-404";
  rehash(aggregate.issuePlan);

  const result=evaluateProjectReadiness(aggregate);

  assert.equal(result.ready_for_issue_generation,false);
  assert.ok(result.failures.some(item =>
    item.rule_id==="PDOR-090-REQUIREMENT-AC-COVERAGE"));
  assert.ok(result.coverage.requirement_ac<1);
});

test("a failed authoritative trace rebuild cannot grant coordinated unknown IDs coverage",() => {
  const aggregate=passAggregate();
  const unknown=["REQ-404","NFR-404","NFR-405"].map(id => ({
    kind:"requirement",
    id,
  }));
  aggregate.issuePlan.content.issues[0].source_requirements=clone(unknown);
  aggregate.issuePlan.content.acceptance_criteria[0].verifies=clone(unknown);
  rehash(aggregate.issuePlan);

  const result=evaluateProjectReadiness(aggregate);

  assert.equal(result.ready_for_issue_generation,false);
  assert.equal(result.coverage.requirement_ac,0);
  assert.ok(result.failures.some(item =>
    item.rule_id==="PDOR-090-REQUIREMENT-AC-COVERAGE"));
});

test("duplicate artifact identities and unknown aggregate keys fail closed",() => {
  const duplicate=passAggregate();
  duplicate.architecture.adrs.push(clone(duplicate.architecture.adrs[0]));
  const unknownKey=passAggregate();
  unknownKey.callerSummary={ready:true};

  assert.equal(evaluateProjectReadiness(duplicate).ready_for_issue_generation,false);
  assert.equal(evaluateProjectReadiness(unknownKey).ready_for_issue_generation,false);
});

test("non-JSON and exotic values return a deterministic frozen failure result",() => {
  const exotic=passAggregate();
  exotic.analysisState.created_at=new Date("2026-08-17T14:00:00.000Z");
  const first=evaluateProjectReadiness(exotic);
  const second=evaluateProjectReadiness(exotic);

  assert.equal(first.ready_for_issue_generation,false);
  assert.deepEqual(first,second);
  assert.ok(first.failures[0].evidence.length);
  assertDeepFrozen(first);
});

test("malformed authoritative collections retain exact rule-specific evidence paths",() => {
  const cases=[
    {
      label:"PM questions",
      path:"/pmAnalysis/content/open_questions",
      rules:["PDOR-040-BLOCKING-DECISIONS"],
      mutate(aggregate) {
        aggregate.pmAnalysis.content.open_questions=42;
        rehash(aggregate.pmAnalysis);
      },
    },
    {
      label:"architecture questions",
      path:"/architecture/artifact/content/architecture_questions",
      rules:["PDOR-050-ARCHITECTURE-QUESTIONS"],
      mutate(aggregate) {
        aggregate.architecture.artifact.content.architecture_questions=42;
        rehash(aggregate.architecture.artifact);
      },
    },
    {
      label:"issue-plan issues",
      path:"/issuePlan/content/issues",
      rules:[
        "PDOR-070-DELIVERY-RECORDS",
        "PDOR-080-EPIC-MAP",
        "PDOR-090-REQUIREMENT-AC-COVERAGE",
      ],
      mutate(aggregate) {
        aggregate.issuePlan.content.issues=42;
        rehash(aggregate.issuePlan);
      },
    },
    {
      label:"audit inputs",
      path:"/specAudits/0/inputs",
      rules:["PDOR-100-LATEST-SPEC-AUDIT"],
      mutate(aggregate) {
        aggregate.specAudits[0].inputs=42;
      },
    },
  ];

  for (const testCase of cases) {
    const aggregate=passAggregate();
    testCase.mutate(aggregate);
    const first=evaluateProjectReadiness(aggregate);
    const second=evaluateProjectReadiness(clone(aggregate));

    assert.deepEqual(first,second,testCase.label);
    assert.equal(validateDocument(first,"pdor-result.v1").valid,true,testCase.label);
    assertDeepFrozen(first);
    for (const ruleId of testCase.rules) {
      const failure=first.failures.find(item => item.rule_id===ruleId);
      assert.ok(failure,`${testCase.label}: ${ruleId}`);
      assert.ok(failure.evidence.some(item => item.path===testCase.path),
        `${testCase.label}: ${ruleId} must identify ${testCase.path}`);
      assert.ok(failure.evidence.every(item =>
        !(item.artifact==="pipeline-input" && item.path==="/")),
      `${testCase.label}: ${ruleId} must not fall back to aggregate-root evidence`);
    }
  }
});

test("latest audit evidence retains its original index across input order permutations",() => {
  for (const latestFirst of [false,true]) {
    const aggregate=passAggregate();
    const latest=clone(aggregate.specAudits[0]);
    latest.revision=2;
    latest.content.status="WARN";
    latest.content.ready_for_github=true;
    latest.content.summary={total:1,blocking:0,warnings:1};
    rehash(latest);
    aggregate.specAudits=latestFirst ? [latest,aggregate.specAudits[0]] :
      [aggregate.specAudits[0],latest];
    const latestIndex=latestFirst ? 0 : 1;

    const result=evaluateProjectReadiness(aggregate);
    const failure=result.failures.find(item =>
      item.rule_id==="PDOR-100-LATEST-SPEC-AUDIT");
    const latestEvidence=failure.evidence.filter(item => item.artifact.includes("@2#"));

    assert.ok(latestEvidence.length>0);
    assert.ok(latestEvidence.every(item =>
      item.path.startsWith(`/specAudits/${latestIndex}`)));
    assert.ok(latestEvidence.some(item =>
      item.path===`/specAudits/${latestIndex}/content/status`));
  }
});

test("only an exact verified resolved P3 package can suppress its authoritative warning",() => {
  const absent=passAggregate();
  const valid=passAggregate();
  valid.decisionPackage=buildDecisionPackageFromPmAnalysis(
    valid.pmAnalysis,[p3DecisionEnrichment({status:"resolved"})],
  );
  const invalid=passAggregate();
  invalid.decisionPackage=clone(buildDecisionPackageFromPmAnalysis(
    invalid.pmAnalysis,[p3DecisionEnrichment({status:"resolved"})],
  ));
  invalid.decisionPackage.questions[0].meaning="Forged resolved question";
  invalid.decisionPackage.questions[0].evidence[0].meaning="Forged resolved question";

  const absentResult=evaluateProjectReadiness(absent);
  const validResult=evaluateProjectReadiness(valid);
  const invalidResult=evaluateProjectReadiness(invalid);

  assert.deepEqual(absentResult.warnings.map(item => item.rule_id),[
    "PDOR-120-UNRESOLVED-ASSUMPTIONS",
  ]);
  assert.deepEqual(validResult.failures,[]);
  assert.deepEqual(validResult.warnings,[]);
  assert.ok(invalidResult.failures.some(item =>
    item.rule_id==="PDOR-040-BLOCKING-DECISIONS"));
  assert.deepEqual(invalidResult.warnings.map(item => item.rule_id),[
    "PDOR-120-UNRESOLVED-ASSUMPTIONS",
  ]);
});

test("the versioned closed decision rule policy agrees with runtime package behavior",() => {
  const rules=JSON.parse(fs.readFileSync(new URL(
    "../contracts/pipeline/pdor-rules.v1.json",import.meta.url,
  ),"utf8"));
  const ruleIds=rules.rules.map(rule => rule.id);
  const decisionRule=rules.rules.find(rule =>
    rule.id==="PDOR-040-BLOCKING-DECISIONS");

  assert.deepEqual(Object.keys(rules).sort(),[
    "document_type","rules","schema_version",
  ]);
  assert.equal(rules.schema_version,"pdor-rules.v1");
  assert.equal(rules.document_type,"pdor-rules");
  assert.deepEqual(ruleIds,[...ruleIds].sort());
  assert.equal(new Set(ruleIds).size,ruleIds.length);
  for (const rule of rules.rules) {
    assert.deepEqual(Object.keys(rule).sort(),rule===decisionRule ?
      ["description","id","policy","severity"] :
      ["description","id","severity"]);
  }
  assert.deepEqual(decisionRule.policy,{
    blocking_severities:["P0","P1","P2"],
    warning_severities:["P3","P4"],
    package_required_when:"blocking-question-present",
    supplied_package_requires:[
      "external-authority-verification",
      "exact-cover-all-pm-questions",
      "exact-retained-pm-fields",
    ],
  });

  const optional=passAggregate();
  const optionalResult=evaluateProjectReadiness(optional);
  assert.equal(optionalResult.ready_for_issue_generation,true);
  assert.ok(optionalResult.warnings.some(item =>
    item.rule_id==="PDOR-120-UNRESOLVED-ASSUMPTIONS"));

  const suppliedInvalid=passAggregate();
  suppliedInvalid.decisionPackage={questions:[]};
  const suppliedInvalidResult=evaluateProjectReadiness(suppliedInvalid);
  assert.ok(suppliedInvalidResult.failures.some(item =>
    item.rule_id==="PDOR-040-BLOCKING-DECISIONS"));
  assert.ok(suppliedInvalidResult.warnings.some(item =>
    item.rule_id==="PDOR-120-UNRESOLVED-ASSUMPTIONS"));

  const blocking=passAggregate();
  blocking.pmAnalysis.content.open_questions[0].severity="P2";
  rehash(blocking.pmAnalysis);
  const blockingResult=evaluateProjectReadiness(blocking);
  assert.ok(blockingResult.failures.some(item =>
    item.rule_id==="PDOR-040-BLOCKING-DECISIONS"));
});
