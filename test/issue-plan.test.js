import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const issuePlanModule=await import("../src/pipeline/issue-plan.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});

test("issue-plan pipeline exposes deterministic construction and validation contracts",() => {
  assert.equal(typeof issuePlanModule.buildIssuePlan,"function");
  assert.equal(typeof issuePlanModule.validateIssuePlan,"function");
});

if (typeof issuePlanModule.buildIssuePlan==="function" &&
    typeof issuePlanModule.validateIssuePlan==="function") {
  const {buildIssuePlan,validateIssuePlan,MUST_REQUIREMENT_POLICY}=issuePlanModule;
  const {buildArchitecture}=await import("../src/pipeline/architecture.js");
  const {sha256Canonical}=await import("../src/contracts/acp.js");
  const {validateDocument}=await import("../src/contracts/validator.js");

  function fixture(path) {
    return JSON.parse(fs.readFileSync(new URL(path,import.meta.url),"utf8"));
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function rehash(artifact) {
    artifact.content_sha256=sha256Canonical(artifact.content);
    return artifact;
  }

  function reference(artifact) {
    return {
      document_type:artifact.document_type,
      artifact_id:artifact.artifact_id,
      revision:artifact.revision,
      content_sha256:artifact.content_sha256,
    };
  }

  function pmAnalysis() {
    const analysis=fixture("./fixtures/pm-analysis/valid/complete-artifact.json");
    analysis.content.open_questions[0].severity="P3";
    return rehash(analysis);
  }

  function architectureFor(analysis) {
    return buildArchitecture({
      pmAnalysis:analysis,
      decisions:fixture("./fixtures/architecture/valid/decisions.json"),
      artifactContext:fixture("./fixtures/architecture/valid/artifact-context.json"),
    });
  }

  function adrFor(analysis,architecture) {
    const content=fixture("./fixtures/architecture/valid/adr-content.json");
    return rehash({
      schema_version:"acp.v1",
      document_type:"adr",
      artifact_id:"ADR-ARTIFACT-001",
      revision:1,
      run_id:"run-architecture-001",
      producer:{role:"architect",identity:"toss-architect"},
      runtime_identity:{kind:"deterministic",name:"toss-cli",version:"2.1.0"},
      created_at:"2026-08-17T13:00:00.000Z",
      provenance:clone(architecture.provenance),
      parents:[],
      inputs:[reference(analysis),reference(architecture)],
      content_sha256:"0".repeat(64),
      content,
    });
  }

  function additionalAdrFor(analysis,architecture,{
    artifactId,
    id,
    meaning,
    affectedRequirements,
  }) {
    const adr=adrFor(analysis,architecture);
    adr.artifact_id=artifactId;
    adr.content.id=id;
    adr.content.meaning=meaning;
    adr.content.affected_requirements=affectedRequirements;
    return rehash(adr);
  }

  function synchronizeIssuePlanInputs(graph) {
    graph.issuePlan.inputs=[
      reference(graph.pmAnalysis),
      reference(graph.architecture),
      ...graph.adrs.map(reference),
    ];
    graph.issuePlan.content.input_snapshots={
      pm_analysis:reference(graph.pmAnalysis),
      architecture:reference(graph.architecture),
      adrs:graph.adrs.map(reference),
    };
    return rehash(graph.issuePlan);
  }

  function upstream() {
    const analysis=pmAnalysis();
    const architecture=architectureFor(analysis);
    return {pmAnalysis:analysis,architecture,adrs:[adrFor(analysis,architecture)]};
  }

  function finalization() {
    return fixture("./fixtures/issue-plan/valid/finalization-input.json");
  }

  function completeGraph() {
    const graph=upstream();
    const input=finalization();
    graph.issuePlan=buildIssuePlan({
      ...graph,
      plan:input.plan,
      artifactContext:input.artifact_context,
    });
    return clone(graph);
  }

  test("buildIssuePlan creates a frozen, authoritative PM-finalization artifact without mutating inputs",() => {
    const graph=upstream();
    const input=finalization();
    const before=clone({graph,input});

    const first=buildIssuePlan({
      ...graph,
      plan:input.plan,
      artifactContext:input.artifact_context,
    });
    const second=buildIssuePlan({
      ...graph,
      plan:input.plan,
      artifactContext:input.artifact_context,
    });

    assert.deepEqual(first,second);
    assert.deepEqual({graph,input},before);
    assert.equal(Object.isFrozen(first),true);
    assert.equal(first.document_type,"issue-plan");
    assert.equal(first.producer.role,"pm-finalization");
    assert.equal(first.content.epics[0].finalization_status,"authoritative");
    assert.equal(first.content.coverage.must_requirement_policy,
      MUST_REQUIREMENT_POLICY);
    assert.equal(validateDocument(first,"issue-plan.v1").valid,true);
  });

  test("the checked-in example artifact is hash-valid and reproducible from its exact inputs",() => {
    const graph=completeGraph();
    const example=fixture("./fixtures/issue-plan/valid/complete-artifact.json");

    assert.equal(validateDocument(example,"issue-plan.v1").valid,true);
    assert.equal(example.content_sha256,sha256Canonical(example.content));
    assert.deepEqual(example,graph.issuePlan);
    assert.equal(validateIssuePlan({...graph,issuePlan:example}).valid,true);
  });

  test("a complete issue plan computes functional PM requirements as v1 must coverage",() => {
    const graph=completeGraph();
    const result=validateIssuePlan(graph);

    assert.equal(MUST_REQUIREMENT_POLICY,
      "pm-analysis.v1-functional-requirements-are-must");
    assert.equal(result.valid,true);
    assert.equal(result.complete,true);
    assert.equal(result.ready_for_issues,true);
    assert.deepEqual(result.coverage,{
      must_requirement_policy:"pm-analysis.v1-functional-requirements-are-must",
      must_requirements:1,
      covered_must_requirements:1,
      uncovered_must_requirement_ids:[],
      ready:true,
    });
    assert.deepEqual(result.findings,[]);
  });

  test("PM epic candidates become authoritative only without changing their identity meaning",() => {
    const graph=completeGraph();
    graph.issuePlan.content.epics[0].meaning="A different delivery grouping.";
    rehash(graph.issuePlan);

    const result=validateIssuePlan(graph);

    assert.equal(result.valid,false);
    assert.ok(result.findings.some(finding =>
      finding.type==="EPIC_CANDIDATE_MEANING_CONFLICT",
    ));
  });

  test("a dependency cycle is rejected instead of producing a partial issue plan",() => {
    const graph=completeGraph();
    const patch=fixture("./fixtures/issue-plan/invalid/cycle.json");
    const second=clone(graph.issuePlan.content.issues[0]);
    second.id=patch.second_issue_id;
    second.meaning="Persist the support request status.";
    second.atomic_scope="Persist only the status transition for an existing support request.";
    second.dependencies=[{kind:"issue",id:patch.first_issue_id}];
    graph.issuePlan.content.issues[0].dependencies=[{kind:"issue",id:patch.second_issue_id}];
    graph.issuePlan.content.issues.push(second);
    rehash(graph.issuePlan);

    assert.throws(() => validateIssuePlan(graph),/dependency cycle/i);
  });

  test("a dangling requirement link is rejected instead of guessed",() => {
    const graph=completeGraph();
    const patch=fixture("./fixtures/issue-plan/invalid/dangling-reference.json");
    graph.issuePlan.content.acceptance_criteria[0].verifies=[patch.verifies];
    rehash(graph.issuePlan);

    assert.throws(() => validateIssuePlan(graph),/dangling/i);
  });

  test("uncovered must requirements invalidate readiness and coverage is recomputed, never trusted",() => {
    const graph=completeGraph();
    const patch=fixture("./fixtures/issue-plan/invalid/uncovered.json");
    // Keep a well-formed, resolvable verification link while deliberately
    // leaving the sole v1 must requirement (REQ-001) uncovered.
    graph.issuePlan.content.acceptance_criteria[0].verifies=[
      {kind:"requirement",id:"NFR-001"},
    ];
    graph.issuePlan.content.coverage={
      must_requirement_policy:patch.claimed_policy,
      must_requirements:patch.claimed_must_requirements,
      covered_must_requirements:patch.claimed_covered_must_requirements,
      uncovered_must_requirement_ids:patch.claimed_uncovered_must_requirement_ids,
      ready:patch.claimed_ready,
    };
    graph.issuePlan.content.status="ready-for-issues";
    rehash(graph.issuePlan);

    const result=validateIssuePlan(graph);

    assert.equal(result.valid,false);
    assert.equal(result.complete,false);
    assert.equal(result.ready_for_issues,false);
    assert.equal(result.coverage.must_requirements,1);
    assert.deepEqual(result.coverage.uncovered_must_requirement_ids,["REQ-001"]);
    assert.ok(result.findings.some(finding => finding.type==="MUST_REQUIREMENT_UNCOVERED"));
    assert.ok(result.findings.some(finding => finding.type==="COVERAGE_SUMMARY_MISMATCH"));
    assert.ok(result.findings.some(finding => finding.type==="STATUS_READINESS_MISMATCH"));
  });

  test("a forged coverage summary invalidates an otherwise-ready status",() => {
    const forgedSummaries=[
      {
        name:"understated",
        coverage:{
          must_requirement_policy:MUST_REQUIREMENT_POLICY,
          must_requirements:1,
          covered_must_requirements:0,
          uncovered_must_requirement_ids:["REQ-001"],
          ready:false,
        },
      },
      {
        name:"inverse",
        coverage:{
          must_requirement_policy:MUST_REQUIREMENT_POLICY,
          must_requirements:0,
          covered_must_requirements:0,
          uncovered_must_requirement_ids:[],
          ready:true,
        },
      },
    ];
    for (const forged of forgedSummaries) {
      const graph=completeGraph();
      graph.issuePlan.content.coverage=forged.coverage;
      graph.issuePlan.content.status="ready-for-issues";
      rehash(graph.issuePlan);

      const result=validateIssuePlan(graph);

      assert.equal(result.valid,false,forged.name);
      assert.equal(result.ready_for_issues,false,forged.name);
      assert.ok(result.findings.some(finding =>
        finding.type==="COVERAGE_SUMMARY_MISMATCH" && finding.path==="/content/coverage",
      ),forged.name);
      assert.ok(result.findings.some(finding =>
        finding.type==="STATUS_READINESS_MISMATCH" && finding.path==="/content/status",
      ),forged.name);
    }
  });

  test("PM finalization rejects an immutable architecture input whose content no longer matches the plan snapshot",() => {
    const graph=completeGraph();
    const patch=fixture("./fixtures/issue-plan/invalid/mutated-architecture.json");
    graph.architecture.content.components[patch.component_index].responsibility=
      patch.changed_responsibility;
    rehash(graph.architecture);

    assert.throws(
      () => validateIssuePlan(graph),
      /immutable architecture input/i,
    );
  });

  test("an issue cannot bypass a relevant approved ADR with requires_adr false",() => {
    const graph=completeGraph();
    graph.issuePlan.content.issues[0].requires_adr=false;
    graph.issuePlan.content.issues[0].adr_refs=[];
    rehash(graph.issuePlan);

    const result=validateIssuePlan(graph);

    assert.equal(result.valid,false);
    assert.ok(result.findings.some(finding =>
      finding.type==="ISSUE_ADR_REQUIRED" &&
      finding.path==="/content/issues/0/requires_adr",
    ));
    assert.ok(result.findings.some(finding =>
      finding.type==="ISSUE_ADR_MISSING_RELEVANT" &&
      finding.path==="/content/issues/0/adr_refs",
    ));

  });

  test("an issue cannot replace a relevant approved ADR with an unrelated one",() => {
    const graph=completeGraph();
    graph.adrs.push(additionalAdrFor(graph.pmAnalysis,graph.architecture,{
      artifactId:"ADR-ARTIFACT-002",
      id:"ADR-002",
      meaning:"Keep support-request read telemetry separate from the request record.",
      affectedRequirements:["NFR-001"],
    }));
    synchronizeIssuePlanInputs(graph);
    graph.issuePlan.content.issues[0].adr_refs=[{kind:"adr",id:"ADR-002"}];
    rehash(graph.issuePlan);

    const result=validateIssuePlan(graph);

    assert.equal(result.valid,false);
    assert.ok(result.findings.some(finding =>
      finding.type==="ISSUE_ADR_MISSING_RELEVANT" &&
      finding.path==="/content/issues/0/adr_refs",
    ));
    assert.ok(result.findings.some(finding =>
      finding.type==="ISSUE_ADR_UNRELATED" &&
      finding.path==="/content/issues/0/adr_refs/0",
    ));
  });

  test("an issue with no approved ADR intersection cannot claim an ADR",() => {
    const graph=completeGraph();
    graph.issuePlan.content.issues[0].source_requirements=[
      {kind:"requirement",id:"NFR-001"},
    ];
    rehash(graph.issuePlan);

    const result=validateIssuePlan(graph);

    assert.equal(result.valid,false);
    assert.ok(result.findings.some(finding =>
      finding.type==="ISSUE_ADR_NOT_REQUIRED" &&
      finding.path==="/content/issues/0/requires_adr",
    ));
    assert.ok(result.findings.some(finding =>
      finding.type==="ISSUE_ADR_UNRELATED" &&
      finding.path==="/content/issues/0/adr_refs/0",
    ));
  });

  test("every approved ADR relevant to an issue source requirement must be linked",() => {
    const graph=completeGraph();
    graph.adrs.push(additionalAdrFor(graph.pmAnalysis,graph.architecture,{
      artifactId:"ADR-ARTIFACT-002",
      id:"ADR-002",
      meaning:"Store customer support request updates as append-only revisions.",
      affectedRequirements:["REQ-001"],
    }));
    synchronizeIssuePlanInputs(graph);

    const result=validateIssuePlan(graph);

    assert.equal(result.valid,false);
    assert.ok(result.findings.some(finding =>
      finding.type==="ISSUE_ADR_MISSING_RELEVANT" &&
      finding.path==="/content/issues/0/adr_refs",
    ));

    graph.issuePlan.content.issues[0].adr_refs.push({kind:"adr",id:"ADR-002"});
    rehash(graph.issuePlan);
    const completeResult=validateIssuePlan(graph);
    assert.equal(completeResult.valid,true);
    assert.equal(completeResult.ready_for_issues,true);
  });

  test("issue-plan inputs accept only the exact PM, architecture, and ADR revisions",() => {
    const selfInput=completeGraph();
    selfInput.issuePlan.inputs.push(reference(selfInput.issuePlan));
    let result=validateIssuePlan(selfInput);
    assert.equal(result.valid,false);
    assert.ok(result.findings.some(finding => finding.type==="SELF_ARTIFACT_INPUT"));

    const extraInput=completeGraph();
    extraInput.issuePlan.inputs.push({
      document_type:"pm-analysis",
      artifact_id:"UNRELATED-001",
      revision:1,
      content_sha256:"f".repeat(64),
    });
    result=validateIssuePlan(extraInput);
    assert.equal(result.valid,false);
    assert.ok(result.findings.some(finding => finding.type==="EXTRA_ARTIFACT_INPUT"));

    const duplicateInput=completeGraph();
    duplicateInput.issuePlan.inputs.push(clone(duplicateInput.issuePlan.inputs[0]));
    result=validateIssuePlan(duplicateInput);
    assert.equal(result.valid,false);
    assert.ok(result.findings.some(finding => finding.type==="DUPLICATE_ARTIFACT_INPUT"));

    const missingDocumentType=completeGraph();
    delete missingDocumentType.issuePlan.inputs[0].document_type;
    result=validateIssuePlan(missingDocumentType);
    assert.equal(result.valid,false);
    assert.ok(result.findings.some(finding => finding.type==="MISSING_PM_INPUT"));
  });

  test("issues require exactly one epic or an explicit standalone rationale",() => {
    const standalone=completeGraph();
    const issue=standalone.issuePlan.content.issues[0];
    delete issue.epic;
    issue.standalone={
      status:"standalone",
      rationale:"The delivery work is operational and has no coherent epic grouping.",
    };
    standalone.issuePlan.content.epics=[];
    rehash(standalone.issuePlan);
    assert.equal(validateIssuePlan(standalone).valid,true);

    issue.epic={kind:"epic",id:"EPIC-001"};
    rehash(standalone.issuePlan);
    assert.equal(validateIssuePlan(standalone).valid,false);

    const noRationale=completeGraph();
    delete noRationale.issuePlan.content.issues[0].source_requirements;
    delete noRationale.issuePlan.content.issues[0].governance_rationale;
    rehash(noRationale.issuePlan);
    assert.equal(validateIssuePlan(noRationale).valid,false);
  });

  test("atomic scope, acceptance criteria, and Definition of Done are material delivery obligations",() => {
    const graph=completeGraph();
    const issue=graph.issuePlan.content.issues[0];
    issue.atomic_scope=" \n\t ";
    issue.definition_of_done=[];
    issue.acceptance_criteria=[];
    rehash(graph.issuePlan);

    const result=validateIssuePlan(graph);

    assert.equal(result.valid,false);
    assert.ok(result.findings.some(finding => finding.type==="SCHEMA_VALIDATION"));
  });

  test("acceptance criteria and all typed references resolve uniquely and exactly",() => {
    const duplicate=completeGraph();
    duplicate.issuePlan.content.acceptance_criteria.push(clone(
      duplicate.issuePlan.content.acceptance_criteria[0],
    ));
    rehash(duplicate.issuePlan);
    let result=validateIssuePlan(duplicate);
    assert.equal(result.valid,false);
    assert.ok(result.findings.some(finding => finding.type==="DUPLICATE_AC_ID"));

    const wrongKind=completeGraph();
    wrongKind.issuePlan.content.acceptance_criteria[0].issue.kind="epic";
    rehash(wrongKind.issuePlan);
    result=validateIssuePlan(wrongKind);
    assert.equal(result.valid,false);

    const selfDependency=completeGraph();
    selfDependency.issuePlan.content.issues[0].dependencies=[
      {kind:"issue",id:"ISSUE-001"},
    ];
    rehash(selfDependency.issuePlan);
    assert.throws(() => validateIssuePlan(selfDependency),/self dependency/i);
  });

  test("an issue that requires an ADR only accepts an existing accepted and approved ADR",() => {
    const graph=completeGraph();
    graph.adrs[0].content.status="proposed";
    graph.adrs[0].content.approval.state="pending";
    rehash(graph.adrs[0]);
    graph.issuePlan.inputs[2]=reference(graph.adrs[0]);
    graph.issuePlan.content.input_snapshots.adrs[0]=reference(graph.adrs[0]);
    rehash(graph.issuePlan);

    const result=validateIssuePlan(graph);

    assert.equal(result.valid,false);
    assert.equal(result.ready_for_issues,false);
    assert.ok(result.findings.some(finding => finding.type==="ISSUE_ADR_NOT_APPROVED"));
  });

  test("wrong producer, stale exact inputs, and noncanonical programmatic data fail closed",() => {
    const wrongProducer=completeGraph();
    wrongProducer.issuePlan.producer.role="pm";
    assert.equal(validateIssuePlan(wrongProducer).valid,false);

    const staleInput=completeGraph();
    staleInput.issuePlan.inputs[0].content_sha256="0".repeat(64);
    assert.equal(validateIssuePlan(staleInput).valid,false);

    const malformed=completeGraph();
    malformed.issuePlan.content.acceptance_criteria={};
    rehash(malformed.issuePlan);
    assert.equal(validateIssuePlan(malformed).valid,false);

    const nonCanonical=completeGraph();
    Object.defineProperty(nonCanonical.issuePlan.content.issues[0],"hidden",{
      enumerable:false,
      value:true,
    });
    const result=validateIssuePlan(nonCanonical);
    assert.equal(result.valid,false);
    assert.equal(result.findings[0].type,"CANONICAL_JSON");
  });
}
