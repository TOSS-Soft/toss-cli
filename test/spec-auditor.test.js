import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const specAuditorModule=await import("../src/pipeline/spec-auditor.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});

test("spec auditor exposes the pure specification audit contract",() => {
  assert.equal(typeof specAuditorModule.auditSpecification,"function");
  assert.equal(typeof specAuditorModule.SpecAuditInputError,"function");
});

if (typeof specAuditorModule.auditSpecification==="function") {
  const {auditSpecification}=specAuditorModule;
  const {sha256Canonical}=await import("../src/contracts/acp.js");
  const {validateDocument}=await import("../src/contracts/validator.js");
  const {buildArchitecture}=await import("../src/pipeline/architecture.js");
  const {buildIssuePlan}=await import("../src/pipeline/issue-plan.js");

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

  function artifactReference(artifact) {
    return {
      document_type:artifact.document_type,
      artifact_id:artifact.artifact_id,
      revision:artifact.revision,
      content_sha256:artifact.content_sha256,
    };
  }

  function buildAdr(pmAnalysis,architecture,{second=false}={}) {
    const content=fixture("./fixtures/architecture/valid/adr-content.json");
    if (second) {
      content.id="ADR-002";
      content.meaning="Keep read status projections isolated from request intake.";
      content.decision="Use an independently revisioned read-status projection.";
      content.rationale="The quality attribute can evolve without changing request intake.";
      content.affected_requirements=["NFR-001"];
    }
    return rehash({
      schema_version:"acp.v1",
      document_type:"adr",
      artifact_id:second ? "ADR-ARTIFACT-002" : "ADR-ARTIFACT-001",
      revision:1,
      run_id:"run-architecture-001",
      producer:{role:"architect",identity:"toss-architect"},
      runtime_identity:{kind:"deterministic",name:"toss-cli",version:"2.1.0"},
      created_at:"2026-08-17T13:00:00.000Z",
      provenance:clone(architecture.provenance),
      parents:[],
      inputs:[artifactReference(pmAnalysis),artifactReference(architecture)],
      content_sha256:"0".repeat(64),
      content,
    });
  }

  function requirementReferences(ids) {
    return ids.map(id => ({kind:"requirement",id}));
  }

  function completeGraph(casePath="./fixtures/spec-audit/pass/complete.json",{
    secondAdr=false,
  }={}) {
    const auditCase=fixture(casePath);
    const pmAnalysis=fixture("./fixtures/pm-analysis/valid/complete-artifact.json");
    pmAnalysis.content.open_questions[0].severity="P3";
    rehash(pmAnalysis);
    const architectureArtifact=buildArchitecture({
      pmAnalysis,
      decisions:fixture("./fixtures/architecture/valid/decisions.json"),
      artifactContext:fixture("./fixtures/architecture/valid/artifact-context.json"),
    });
    const adrs=[buildAdr(pmAnalysis,architectureArtifact)];
    if (secondAdr) adrs.push(buildAdr(pmAnalysis,architectureArtifact,{second:true}));
    const finalization=fixture("./fixtures/issue-plan/valid/finalization-input.json");
    const sourceReferences=requirementReferences(auditCase.source_requirement_ids);
    const acceptanceReferences=requirementReferences(
      auditCase.acceptance_requirement_ids,
    );
    finalization.plan.epics[0].source_requirements=clone(sourceReferences);
    finalization.plan.issues[0].source_requirements=clone(sourceReferences);
    finalization.plan.acceptance_criteria[0].verifies=acceptanceReferences;
    const issuePlan=buildIssuePlan({
      pmAnalysis,
      architecture:architectureArtifact,
      adrs,
      plan:finalization.plan,
      artifactContext:finalization.artifact_context,
    });
    return clone({
      pmAnalysis,
      architecture:{artifact:architectureArtifact,adrs},
      issuePlan,
    });
  }

  function assertDeepFrozen(value) {
    if (!value || typeof value!=="object") return;
    assert.equal(Object.isFrozen(value),true);
    for (const child of Object.values(value)) assertDeepFrozen(child);
  }

  test("a complete specification produces a deterministic frozen PASS artifact with every ADR input",() => {
    const graph=completeGraph();
    const before=clone(graph);

    const first=auditSpecification(graph);
    const second=auditSpecification(graph);

    assert.deepEqual(first,second);
    assert.deepEqual(graph,before);
    assert.equal(first.status,"PASS");
    assert.equal(first.ready_for_github,true);
    assert.deepEqual(first.findings,[]);
    assert.deepEqual(first.artifact.inputs.map(reference => reference.document_type),[
      "pm-analysis",
      "architecture",
      "adr",
      "issue-plan",
    ]);
    assert.equal(validateDocument(first.artifact,"spec-audit.v1").valid,true);
    assert.equal(first.artifact.content_sha256,
      sha256Canonical(first.artifact.content));
    assert.deepEqual(first.artifact,
      fixture("./fixtures/spec-audit/pass/complete-artifact.json"));
    assertDeepFrozen(first);
  });

  test("a requirement mentioned by an issue but not verified by AC fails closed",() => {
    const auditCase=fixture(
      "./fixtures/spec-audit/fail/requirement-mentioned-without-ac.json",
    );
    const graph=completeGraph();
    graph.issuePlan.content.acceptance_criteria[0].verifies=
      requirementReferences(auditCase.acceptance_requirement_ids);
    rehash(graph.issuePlan);

    const result=auditSpecification(graph);

    assert.equal(result.status,"FAIL");
    assert.equal(result.ready_for_github,false);
    assert.ok(result.findings.some(finding =>
      finding.type==="AC_COVERAGE" &&
      finding.affected_entities.includes(auditCase.expected_requirement_id),
    ));
  });

  test("a non-blocking orphan quality requirement yields WARN with owner-routed evidence",() => {
    const auditCase=fixture("./fixtures/spec-audit/warn/orphan-requirement.json");
    const graph=completeGraph(
      "./fixtures/spec-audit/warn/orphan-requirement.json",
    );

    const result=auditSpecification(graph);

    assert.equal(result.status,"WARN");
    assert.equal(result.ready_for_github,true);
    const finding=result.findings.find(item =>
      item.type==="ORPHAN_REQUIREMENT" &&
      item.affected_entities.includes(auditCase.expected_requirement_id),
    );
    assert.ok(finding);
    assert.equal(finding.owner,"PM");
    assert.equal(finding.severity,"P3");
    assert.match(finding.path,/^\//);
    assert.ok(finding.evidence.length>0);
    assert.equal(validateDocument(finding,"finding.v1").valid,true);
  });

  test("exact immutable PM, architecture, ADR, and issue-plan relationships fail closed",() => {
    const stale=completeGraph();
    stale.architecture.artifact.content.components[0].responsibility=
      "A silently changed architecture responsibility.";
    rehash(stale.architecture.artifact);

    const staleResult=auditSpecification(stale);

    assert.equal(staleResult.status,"FAIL");
    assert.ok(staleResult.findings.some(finding =>
      /IMMUTABLE|STALE|MISMATCHED/.test(finding.type),
    ));

    const missingAdr=completeGraph();
    missingAdr.architecture.adrs=[];
    const missingResult=auditSpecification(missingAdr);
    assert.equal(missingResult.status,"FAIL");
    assert.ok(missingResult.findings.some(finding => /ADR/.test(finding.type)));
  });

  test("ADR consistency and orphan ADRs are reported without changing architecture",() => {
    const graph=completeGraph(
      "./fixtures/spec-audit/warn/orphan-requirement.json",
      {secondAdr:true},
    );
    const before=clone(graph.architecture);

    const result=auditSpecification(graph);

    assert.deepEqual(graph.architecture,before);
    assert.equal(result.status,"WARN");
    assert.ok(result.findings.some(finding =>
      finding.type==="ORPHAN_ADR" && finding.affected_entities.includes("ADR-002"),
    ));
  });

  test("ADR aggregate order cannot change the deterministic audit artifact",() => {
    const graph=completeGraph(
      "./fixtures/spec-audit/warn/orphan-requirement.json",
      {secondAdr:true},
    );
    const reversed=clone(graph);
    reversed.architecture.adrs.reverse();

    assert.deepEqual(auditSpecification(reversed),auditSpecification(graph));
  });

  test("finding and ADR ordering never depends on ambient locale behavior",() => {
    const graph=completeGraph(
      "./fixtures/spec-audit/warn/orphan-requirement.json",
      {secondAdr:true},
    );
    const original=String.prototype.localeCompare;
    String.prototype.localeCompare=function localeDependentOrdering() {
      throw new Error("ambient locale ordering was used");
    };
    try {
      assert.doesNotThrow(() => auditSpecification(graph));
    } finally {
      String.prototype.localeCompare=original;
    }
  });

  test("finding order and both published schemas are closed and deterministic",() => {
    const graph=completeGraph(
      "./fixtures/spec-audit/warn/orphan-requirement.json",
      {secondAdr:true},
    );
    const result=auditSpecification(graph);

    assert.deepEqual(result.findings.map(finding => finding.type),[
      "ORPHAN_ADR",
      "ORPHAN_REQUIREMENT",
    ]);
    assert.ok(result.findings.every(finding =>
      validateDocument(finding,"finding.v1").valid,
    ));

    const openFinding=clone(result.findings[0]);
    openFinding.unexpected=true;
    assert.equal(validateDocument(openFinding,"finding.v1").valid,false);

    const openAudit=clone(result.artifact);
    openAudit.content.unexpected=true;
    assert.equal(validateDocument(openAudit,"spec-audit.v1").valid,false);
  });

  test("duplicate identities and material meanings are detected deterministically",() => {
    const graph=completeGraph();
    const duplicate=clone(graph.issuePlan.content.issues[0]);
    duplicate.id=fixture(
      "./fixtures/spec-audit/mutation/invalid-links.json",
    ).duplicate_issue_id;
    graph.issuePlan.content.issues.push(duplicate);
    rehash(graph.issuePlan);

    const first=auditSpecification(graph);
    const second=auditSpecification(graph);

    assert.deepEqual(first.findings,second.findings);
    assert.equal(first.status,"FAIL");
    assert.ok(first.findings.some(finding => finding.type==="DUPLICATE_ENTITY_ID"));
    assert.ok(first.findings.some(finding =>
      finding.type==="DUPLICATE_ENTITY_MEANING",
    ));
    assert.deepEqual(first.findings.map(finding => finding.id),
      [...first.findings].map(finding => finding.id));
  });

  test("valid graph defects stay semantic while schema-invalid orphan issues short-circuit",() => {
    const mutation=fixture("./fixtures/spec-audit/mutation/invalid-links.json");

    const dangling=completeGraph();
    dangling.issuePlan.content.issues[0].dependencies=[{
      kind:"issue",
      id:mutation.dangling_dependency_id,
    }];
    rehash(dangling.issuePlan);
    assert.ok(auditSpecification(dangling).findings.some(finding =>
      finding.type==="DANGLING_REFERENCE",
    ));

    const cycle=completeGraph();
    cycle.issuePlan.content.issues[0].dependencies=[{
      kind:"issue",
      id:"ISSUE-001",
    }];
    rehash(cycle.issuePlan);
    assert.ok(auditSpecification(cycle).findings.some(finding =>
      finding.type==="DEPENDENCY_CYCLE",
    ));

    const orphan=completeGraph();
    delete orphan.issuePlan.content.issues[0].epic;
    rehash(orphan.issuePlan);
    const orphanResult=auditSpecification(orphan);
    assert.ok(orphanResult.findings.some(finding =>
      finding.type==="SCHEMA_VALIDATION" && finding.owner==="PM_FINALIZATION",
    ));
    assert.equal(orphanResult.findings.some(finding => finding.type==="ORPHAN_ISSUE"),false);
  });

  test("schema-invalid issue completeness short-circuits with an owner-routed finding",() => {
    const graph=completeGraph();
    graph.issuePlan.content.issues[0].adr_refs=[];
    rehash(graph.issuePlan);

    const result=auditSpecification(graph);

    assert.equal(result.status,"FAIL");
    assert.ok(result.findings.some(finding =>
      finding.type==="SCHEMA_VALIDATION" &&
      finding.owner==="PM_FINALIZATION" &&
      finding.path==="/content/issues/0/adr_refs",
    ));
    assert.equal(result.findings.some(finding => finding.type==="ISSUE_INCOMPLETE"),false);
  });

  test("programmatic non-JSON inputs are rejected and valid inputs remain unchanged",() => {
    const graph=completeGraph();
    const before=clone(graph);
    const withPrototype=Object.create({inherited:true});
    Object.assign(withPrototype,graph.architecture);

    assert.throws(
      () => auditSpecification({...graph,architecture:withPrototype}),
      /canonical JSON|plain JSON|non-JSON/i,
    );
    assert.deepEqual(graph,before);

    Object.defineProperty(graph.issuePlan.content.issues[0],"hidden",{
      enumerable:false,
      value:true,
    });
    assert.throws(() => auditSpecification(graph),/canonical JSON|non-enumerable/i);
  });

  test("AC coverage is computed per owning issue instead of across the whole plan",() => {
    const graph=completeGraph();
    const firstIssue=graph.issuePlan.content.issues[0];
    const firstCriterion=graph.issuePlan.content.acceptance_criteria[0];
    firstIssue.source_requirements=requirementReferences(["REQ-001"]);
    firstCriterion.verifies=requirementReferences(["NFR-001"]);

    const secondIssue=clone(firstIssue);
    secondIssue.id="ISSUE-002";
    secondIssue.meaning="Expose customer support request status.";
    secondIssue.atomic_scope="Expose only the current status of a customer request.";
    secondIssue.source_requirements=requirementReferences(["NFR-001","NFR-002"]);
    secondIssue.acceptance_criteria=[{kind:"acceptance-criterion",id:"AC-002"}];
    const secondCriterion=clone(firstCriterion);
    secondCriterion.id="AC-002";
    secondCriterion.meaning="A customer can view the current request status.";
    secondCriterion.issue={kind:"issue",id:"ISSUE-002"};
    secondCriterion.verifies=requirementReferences(["REQ-001","NFR-002"]);
    graph.issuePlan.content.issues.push(secondIssue);
    graph.issuePlan.content.acceptance_criteria.push(secondCriterion);
    rehash(graph.issuePlan);

    const result=auditSpecification(graph);
    const coverage=result.findings.filter(finding => finding.type==="AC_COVERAGE");

    assert.equal(result.status,"FAIL");
    assert.ok(coverage.some(finding =>
      finding.affected_entities.includes("ISSUE-001") &&
      finding.affected_entities.includes("REQ-001"),
    ));
    assert.ok(coverage.some(finding =>
      finding.affected_entities.includes("ISSUE-002") &&
      finding.affected_entities.includes("NFR-001"),
    ));
  });

  test("an authoritative epic with no issue reverse-use is a blocking orphan",() => {
    const graph=completeGraph();
    const orphan=clone(graph.issuePlan.content.epics[0]);
    orphan.id="EPIC-002";
    orphan.meaning="Customer support request status.";
    orphan.source_requirements=requirementReferences(["NFR-001"]);
    graph.issuePlan.content.epics.push(orphan);
    rehash(graph.issuePlan);

    const result=auditSpecification(graph);
    const finding=result.findings.find(item => item.type==="ORPHAN_EPIC");

    assert.equal(result.status,"FAIL");
    assert.ok(finding);
    assert.equal(finding.owner,"PM_FINALIZATION");
    assert.equal(finding.path,"/content/epics/1");
    assert.deepEqual(finding.affected_entities,["EPIC-002"]);
  });

  test("duplicate IDs and meanings span every collection in one owner domain",() => {
    const graph=completeGraph();
    const duplicate=clone(graph.pmAnalysis.content.non_functional_requirements[0]);
    duplicate.intent_type="business-constraint";
    graph.pmAnalysis.content.constraints.push(duplicate);
    rehash(graph.pmAnalysis);

    const result=auditSpecification(graph);

    assert.ok(result.findings.some(finding =>
      finding.type==="DUPLICATE_ENTITY_ID" &&
      finding.path==="/content/constraints/1/id" &&
      finding.affected_entities.includes("NFR-001"),
    ));
    assert.ok(result.findings.some(finding =>
      finding.type==="DUPLICATE_ENTITY_MEANING" &&
      finding.path==="/content/constraints/1/meaning" &&
      finding.affected_entities.includes("NFR-001"),
    ));
  });

  test("raw options are validated without invoking accessors and require exact own keys",() => {
    const graph=completeGraph();
    function assertInputError(operation) {
      assert.throws(operation,error => {
        assert.equal(error?.name,"SpecAuditInputError");
        assert.equal(error?.code,"SPEC_AUDIT_INPUT_INVALID");
        return true;
      });
    }

    assertInputError(() => auditSpecification());
    assertInputError(() => auditSpecification(null));
    assertInputError(() => auditSpecification([]));

    let getterReads=0;
    const accessor={architecture:graph.architecture,issuePlan:graph.issuePlan};
    Object.defineProperty(accessor,"pmAnalysis",{
      enumerable:true,
      get() {
        getterReads+=1;
        return graph.pmAnalysis;
      },
    });
    assertInputError(() => auditSpecification(accessor));
    assert.equal(getterReads,0);

    assertInputError(() => auditSpecification(Object.assign(
      Object.create({inherited:true}),
      graph,
    )));
    assertInputError(() => auditSpecification({...graph,extra:true}));
    assertInputError(() => auditSpecification({
      ...graph,
      architecture:{...graph.architecture,extra:true},
    }));
    const missing=clone(graph);
    delete missing.pmAnalysis;
    assertInputError(() => auditSpecification(missing));

    const symbol=clone(graph);
    symbol[Symbol("hidden")]=true;
    assertInputError(() => auditSpecification(symbol));
    const nonEnumerable=clone(graph);
    Object.defineProperty(nonEnumerable,"hidden",{value:true,enumerable:false});
    assertInputError(() => auditSpecification(nonEnumerable));

    const sparse=clone(graph);
    sparse.pmAnalysis.content.functional_requirements.length=2;
    assertInputError(() => auditSpecification(sparse));
    const cyclic=clone(graph);
    cyclic.pmAnalysis.loop=cyclic.pmAnalysis;
    assertInputError(() => auditSpecification(cyclic));
  });

  test("a dangling issue ADR reference is routed to PM Finalization",() => {
    const graph=completeGraph();
    graph.issuePlan.content.issues[0].adr_refs=[{kind:"adr",id:"ADR-MISSING"}];
    rehash(graph.issuePlan);

    const result=auditSpecification(graph);
    const finding=result.findings.find(item =>
      item.type==="DANGLING_REFERENCE" &&
      item.path==="/content/issues/0/adr_refs/0",
    );

    assert.ok(finding);
    assert.equal(finding.owner,"PM_FINALIZATION");
  });

  test("minimum envelope identity errors are typed while invalid content emits schema findings",() => {
    const missingIdentity=completeGraph();
    delete missingIdentity.issuePlan.artifact_id;

    assert.throws(() => auditSpecification(missingIdentity),error => {
      assert.equal(error?.name,"SpecAuditInputError");
      assert.equal(error?.code,"SPEC_AUDIT_INPUT_INVALID");
      assert.equal(error?.path,"/issuePlan/artifact_id");
      return true;
    });

    const missingAdrIdentity=completeGraph(
      "./fixtures/spec-audit/warn/orphan-requirement.json",
      {secondAdr:true},
    );
    delete missingAdrIdentity.architecture.adrs[1].artifact_id;
    assert.throws(() => auditSpecification(missingAdrIdentity),error => {
      assert.equal(error?.name,"SpecAuditInputError");
      assert.equal(error?.code,"SPEC_AUDIT_INPUT_INVALID");
      assert.match(error?.path,/^\/architecture\/adrs\/\d+\/artifact_id$/);
      return true;
    });

    const invalidContent=completeGraph();
    delete invalidContent.issuePlan.content.summary;
    rehash(invalidContent.issuePlan);
    const before=clone(invalidContent);

    const result=auditSpecification(invalidContent);

    assert.deepEqual(invalidContent,before);
    assert.equal(result.status,"FAIL");
    assert.equal(result.ready_for_github,false);
    assert.ok(result.findings.some(finding =>
      finding.type==="SCHEMA_VALIDATION" &&
      finding.owner==="PM_FINALIZATION",
    ));
    assert.equal(validateDocument(result.artifact,"spec-audit.v1").valid,true);
    assert.equal(result.artifact.content.status,result.status);
    assert.equal(result.artifact.content.ready_for_github,result.ready_for_github);
  });

  test("a non-array issue collection short-circuits semantic traversal",() => {
    const graph=completeGraph();
    graph.issuePlan.content.issues="bad";
    rehash(graph.issuePlan);
    const before=clone(graph);

    const first=auditSpecification(graph);
    const second=auditSpecification(graph);

    assert.deepEqual(graph,before);
    assert.deepEqual(first,second);
    assert.equal(first.status,"FAIL");
    assert.equal(first.ready_for_github,false);
    assert.ok(first.findings.some(finding =>
      finding.type==="SCHEMA_VALIDATION" &&
      finding.owner==="PM_FINALIZATION" &&
      finding.path==="/content/issues" &&
      finding.evidence[0].artifact_id===graph.issuePlan.artifact_id,
    ));
    assert.equal(validateDocument(first.artifact,"spec-audit.v1").valid,true);
    assertDeepFrozen(first);
  });

  test("non-array issue acceptance criteria short-circuit semantic traversal",() => {
    const graph=completeGraph();
    graph.issuePlan.content.issues[0].acceptance_criteria={};
    rehash(graph.issuePlan);
    const before=clone(graph);

    const first=auditSpecification(graph);
    const second=auditSpecification(graph);

    assert.deepEqual(graph,before);
    assert.deepEqual(first,second);
    assert.equal(first.status,"FAIL");
    assert.equal(first.ready_for_github,false);
    assert.ok(first.findings.some(finding =>
      finding.type==="SCHEMA_VALIDATION" &&
      finding.owner==="PM_FINALIZATION" &&
      finding.path==="/content/issues/0/acceptance_criteria" &&
      finding.evidence[0].artifact_id===graph.issuePlan.artifact_id,
    ));
    assert.equal(validateDocument(first.artifact,"spec-audit.v1").valid,true);
    assertDeepFrozen(first);
  });

  test("non-array issue source requirements short-circuit semantic traversal",() => {
    const graph=completeGraph();
    graph.issuePlan.content.issues[0].source_requirements={};
    rehash(graph.issuePlan);
    const before=clone(graph);

    const first=auditSpecification(graph);
    const second=auditSpecification(graph);

    assert.deepEqual(graph,before);
    assert.deepEqual(first,second);
    assert.equal(first.status,"FAIL");
    assert.equal(first.ready_for_github,false);
    assert.ok(first.findings.some(finding =>
      finding.type==="SCHEMA_VALIDATION" &&
      finding.owner==="PM_FINALIZATION" &&
      finding.path==="/content/issues/0/source_requirements" &&
      finding.evidence[0].artifact_id===graph.issuePlan.artifact_id,
    ));
    assert.equal(validateDocument(first.artifact,"spec-audit.v1").valid,true);
    assertDeepFrozen(first);
  });
}
