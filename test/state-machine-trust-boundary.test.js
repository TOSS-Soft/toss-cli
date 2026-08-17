import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {createArtifactStore} from "../src/artifacts/store.js";
import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {validateDocument} from "../src/contracts/validator.js";
import {buildArchitecture} from "../src/pipeline/architecture.js";
import {buildDecisionPackageFromPmAnalysis} from "../src/pipeline/decisions.js";
import {buildIssuePlan} from "../src/pipeline/issue-plan.js";
import {resumeAnalysis,runNextStage} from "../src/pipeline/orchestrator.js";
import {auditSpecification} from "../src/pipeline/spec-auditor.js";
import {transition} from "../src/pipeline/state-machine.js";

async function fixture(path) {
  return JSON.parse(await readFile(new URL(`./fixtures/${path}`,import.meta.url),"utf8"));
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

function recordedProvenance({revision="project-brief-r1",sha256="a".repeat(64)}={}) {
  return {
    source_revision:revision,
    source_sha256:sha256,
    locations:["PROJECT_BRIEF.md"],
  };
}

function replaceProvenance(value,provenance) {
  if (Array.isArray(value)) return value.map(child => replaceProvenance(child,provenance));
  if (!value || typeof value!=="object") return value;
  const result={};
  for (const [key,child] of Object.entries(value)) {
    result[key]=key==="provenance" ? clone(provenance) :
      replaceProvenance(child,provenance);
  }
  return result;
}

async function validPm({
  severity="P3",
  sourceRevision="project-brief-r1",
  sourceSha256="a".repeat(64),
}={}) {
  const source=await fixture("pm-analysis/valid/complete-artifact.json");
  const provenance=recordedProvenance({revision:sourceRevision,sha256:sourceSha256});
  const pm=replaceProvenance(source,provenance);
  pm.provenance=clone(provenance);
  pm.content.open_questions[0].severity=severity;
  rehash(pm);
  assert.equal(validateDocument(pm,"pm-analysis.v1").valid,true);
  return pm;
}

async function architectureGraph({pending=false}={}) {
  const pmAnalysis=await validPm();
  const architecture=buildArchitecture({
    pmAnalysis,
    decisions:await fixture("architecture/valid/decisions.json"),
    artifactContext:await fixture("architecture/valid/artifact-context.json"),
  });
  const content=await fixture("architecture/valid/adr-content.json");
  if (pending) {
    content.status="proposed";
    content.approval.state="pending";
  }
  const adr=rehash({
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
    inputs:[reference(pmAnalysis),reference(architecture)],
    content_sha256:"0".repeat(64),
    content,
  });
  return {pm_analysis:pmAnalysis,architecture,adrs:[adr]};
}

async function completeGraph() {
  const graph=await architectureGraph();
  const finalization=await fixture("issue-plan/valid/finalization-input.json");
  const issuePlan=buildIssuePlan({
    pmAnalysis:graph.pm_analysis,
    architecture:graph.architecture,
    adrs:graph.adrs,
    plan:finalization.plan,
    artifactContext:finalization.artifact_context,
  });
  const audit=auditSpecification({
    pmAnalysis:graph.pm_analysis,
    architecture:{artifact:graph.architecture,adrs:graph.adrs},
    issuePlan,
  });
  return {...graph,issue_plan:issuePlan,spec_audit:audit.artifact};
}

function blockingPackage(pm) {
  return buildDecisionPackageFromPmAnalysis(pm,[{
    id:pm.content.open_questions[0].id,
    context:"The response target needs verified product authority.",
    impact:"Delivery remains blocked until the target is approved.",
  }]);
}

function transitionMetadata(source,{analysisId="project-analysis-trust-001"}={}) {
  return {
    analysis_id:analysisId,
    source_revision:source.provenance.source_revision,
    source_sha256:source.provenance.source_sha256,
    run_id:"run-analysis-trust-001",
    producer:{role:"orchestrator",identity:"toss-analysis-orchestrator"},
    runtime_identity:{kind:"deterministic",name:"toss-cli",version:"2.1.0"},
    created_at:"2026-08-17T14:00:00.000Z",
    provenance:clone(source.provenance),
  };
}

function fakeStore(initial=[]) {
  const values=[...initial];
  const appends=[];
  return {
    appends,
    async list(filter={}) {
      return values.filter(value => Object.entries(filter).every(([key,want]) =>
        value[key]===want));
    },
    async verify(want) {
      const found=values.find(value =>
        value.document_type===want.document_type &&
        value.artifact_id===want.artifact_id &&
        value.revision===want.revision &&
        value.content_sha256===want.content_sha256);
      if (!found) throw new Error("missing verified fixture artifact");
      return found;
    },
    async append(draft) {
      appends.push(draft);
      values.push(draft);
      return draft;
    },
  };
}

function eventArtifact({
  source,
  revision=1,
  previous_state="ANALYZING",
  event="ANALYSIS_COMPLETED",
  state="ARCHITECTURE_PENDING",
  inputs=[],
  parents=[],
  extraContent={},
  analysisId="project-analysis-trust-001",
}={}) {
  const provenance=clone(source.provenance);
  const inputReferences=inputs.map(reference).sort((left,right) =>
    left.document_type.localeCompare(right.document_type) ||
    left.artifact_id.localeCompare(right.artifact_id) ||
    left.revision-right.revision ||
    left.content_sha256.localeCompare(right.content_sha256));
  const content={
    previous_state,
    event,
    state,
    source_revision:provenance.source_revision,
    source_sha256:provenance.source_sha256,
    input_artifacts:inputReferences,
    ...clone(extraContent),
  };
  return {
    schema_version:"acp.v1",
    document_type:"transition-event",
    artifact_id:analysisId,
    revision,
    run_id:`run-transition-${revision}`,
    producer:{role:"orchestrator",identity:"fixture"},
    runtime_identity:{kind:"deterministic",name:"toss-cli",version:"2.1.0"},
    created_at:"2026-08-17T14:00:00.000Z",
    provenance,
    parents:parents.map(reference),
    inputs:inputReferences,
    content_sha256:sha256Canonical(content),
    content,
  };
}

test("explicit transitions reject missing, wrong-type, stale-hash, and wrong-source PM evidence before append",async () => {
  const pm=await validPm();
  const wrongType=(await architectureGraph()).architecture;
  const staleHash={...clone(pm),content_sha256:"0".repeat(64)};
  const cases=[
    ["bogus",{bogus:true},{}],
    ["wrong document type",wrongType,{}],
    ["stale content hash",staleHash,{}],
    ["source mismatch",pm,{
      source_revision:"project-brief-r2",
      source_sha256:"b".repeat(64),
      provenance:recordedProvenance({revision:"project-brief-r2",sha256:"b".repeat(64)}),
    }],
  ];
  for (const [name,evidence,overrides] of cases) {
    const store=fakeStore();
    await assert.rejects(runNextStage({
      ...transitionMetadata(pm),
      ...overrides,
      state:"ANALYZING",
      event:"ANALYSIS_COMPLETED",
      artifacts:{pm_analysis:evidence},
      store,
    }),undefined,name);
    assert.equal(store.appends.length,0,name);
  }
});

test("automatic SPEC_AUDIT cannot trust a forged ready boolean",async () => {
  const graph=await completeGraph();
  const store=fakeStore();
  await assert.rejects(runNextStage({
    ...transitionMetadata(graph.pm_analysis),
    state:"SPEC_AUDIT",
    artifacts:{...graph,spec_audit:{content:{ready_for_github:true}}},
    store,
  }));
  assert.equal(store.appends.length,0);
});

test("contract-valid exact-source recorded-provenance PM evidence persists",async (t) => {
  const root=await mkdtemp(join(tmpdir(),"toss-analysis-trust-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const store=createArtifactStore({
    root,
    now:() => new Date("2026-08-17T14:00:00.000Z"),
    randomId:() => "trust-boundary-test",
  });
  const pm=await validPm();
  const persisted=await store.append(pm);
  const event=await runNextStage({
    ...transitionMetadata(persisted),
    state:"ANALYZING",
    event:"ANALYSIS_COMPLETED",
    artifacts:{pm_analysis:persisted},
    store,
  });
  assert.equal(event.content.state,"ARCHITECTURE_PENDING");
  assert.deepEqual(event.inputs,[reference(persisted)]);
});

test("resume rejects a schema-valid illegal event tuple",async () => {
  const pm=await validPm();
  const impossible=eventArtifact({
    source:pm,
    previous_state:"ANALYZING",
    event:"AUDIT_PASSED",
    state:"READY_FOR_ISSUES",
  });
  assert.equal(validateDocument(impossible,"transition-event.v1").valid,true);
  await assert.rejects(resumeAnalysis(fakeStore([impossible]),{
    ...transitionMetadata(pm),
  }),/illegal|transition|state/i);
});

test("resume rejects broken revision and parent chains before choosing latest",async () => {
  const pm=await validPm();
  const first=eventArtifact({source:pm,inputs:[pm]});
  const skipped=eventArtifact({
    source:pm,
    revision:3,
    previous_state:"ARCHITECTURE_PENDING",
    event:"FAIL_RETRYABLE",
    state:"FAILED_RETRYABLE",
    parents:[first],
    extraContent:{
      failure:{code:"TEMPORARY",message:"Retry later"},
      resume_state:"ARCHITECTURE_PENDING",
    },
  });
  const wrongParent=eventArtifact({
    source:pm,
    revision:2,
    previous_state:"ARCHITECTURE_PENDING",
    event:"FAIL_RETRYABLE",
    state:"FAILED_RETRYABLE",
    parents:[],
    extraContent:{
      failure:{code:"TEMPORARY",message:"Retry later"},
      resume_state:"ARCHITECTURE_PENDING",
    },
  });
  for (const events of [[first,skipped],[first,wrongParent]]) {
    await assert.rejects(resumeAnalysis(fakeStore([pm,...events]),{
      ...transitionMetadata(pm),
    }),/revision|parent|chain/i);
  }
});

test("resume rejects content/envelope source, input, and predecessor-state contradictions",async () => {
  const pm=await validPm();
  const first=eventArtifact({source:pm,inputs:[pm]});
  const badSource=clone(first);
  badSource.content.source_revision="project-brief-r2";
  rehash(badSource);
  const badInputs=clone(first);
  badInputs.content.input_artifacts=[];
  rehash(badInputs);
  const contradictory=eventArtifact({
    source:pm,
    revision:2,
    previous_state:"ANALYZING",
    event:"ANALYSIS_COMPLETED",
    state:"ARCHITECTURE_PENDING",
    inputs:[pm],
    parents:[first],
  });
  for (const values of [[pm,badSource],[pm,badInputs],[pm,first,contradictory]]) {
    await assert.rejects(resumeAnalysis(fakeStore(values),{
      ...transitionMetadata(pm),
    }),/source|input|predecessor|continuity|transition/i);
  }
});

test("append requires predecessor state and source continuity before writing",async () => {
  const pm=await validPm();
  const graph=await architectureGraph();
  const previous=eventArtifact({
    source:pm,
    previous_state:"ARCHITECTURE_PENDING",
    event:"ARCHITECTURE_COMPLETED",
    state:"PM_FINALIZATION",
    inputs:[graph.pm_analysis,graph.architecture,...graph.adrs],
  });
  const wrongStateStore=fakeStore([graph.pm_analysis,graph.architecture,...graph.adrs,previous]);
  await assert.rejects(runNextStage({
    ...transitionMetadata(pm),
    state:"ANALYZING",
    event:"ANALYSIS_COMPLETED",
    artifacts:{pm_analysis:pm},
    store:wrongStateStore,
  }),/state|continuity|predecessor/i);
  assert.equal(wrongStateStore.appends.length,0);

  const wrongSourceStore=fakeStore([graph.pm_analysis,graph.architecture,...graph.adrs,previous]);
  await assert.rejects(runNextStage({
    ...transitionMetadata(pm),
    source_revision:"project-brief-r2",
    source_sha256:"b".repeat(64),
    provenance:recordedProvenance({revision:"project-brief-r2",sha256:"b".repeat(64)}),
    state:"PM_FINALIZATION",
    event:"FAIL_RETRYABLE",
    failure:{code:"TEMPORARY",message:"Retry later"},
    artifacts:{},
    store:wrongSourceStore,
  }),/source|continuity|predecessor/i);
  assert.equal(wrongSourceStore.appends.length,0);
});

test("pending decision packages cannot be replaced between transition revisions",async () => {
  const pm=await validPm({severity:"P2"});
  const firstPackage=blockingPackage(pm);
  const secondPackage=buildDecisionPackageFromPmAnalysis(pm,[{
    id:pm.content.open_questions[0].id,
    context:"A replacement context that was not in the pending event.",
    impact:"Replacing pending evidence would rewrite the decision boundary.",
  }]);
  const pendingContent=transition("ANALYZING","QUESTIONS_FOUND",{
    ...transitionMetadata(pm),
    artifacts:{pm_analysis:pm,decision_package:firstPackage},
  });
  const pending=eventArtifact({
    source:pm,
    state:pendingContent.state,
    event:pendingContent.event,
    previous_state:pendingContent.previous_state,
    inputs:[pm],
    extraContent:{
      next_action:pendingContent.next_action,
      decision_package:firstPackage,
    },
  });
  const store=fakeStore([pm,pending]);
  await assert.rejects(runNextStage({
    ...transitionMetadata(pm),
    state:"QUESTIONS_PENDING",
    event:"DECISION_STARTED",
    artifacts:{pm_analysis:pm,decision_package:secondPackage},
    store,
  }),/decision package|continuity|pending/i);
  assert.equal(store.appends.length,0);
});

test("SPEC_AUDIT preserves PM_FINALIZATION remediation ownership",async () => {
  const graph=await completeGraph();
  const issuePlan=clone(graph.issue_plan);
  issuePlan.content.issues[0].adr_refs=[{kind:"adr",id:"ADR-MISSING"}];
  rehash(issuePlan);
  const audit=auditSpecification({
    pmAnalysis:graph.pm_analysis,
    architecture:{artifact:graph.architecture,adrs:graph.adrs},
    issuePlan,
  });
  assert.ok(audit.findings.some(finding => finding.owner==="PM_FINALIZATION"));
  assert.throws(() => transition("SPEC_AUDIT","AUDIT_BLOCKED",{
    ...transitionMetadata(graph.pm_analysis),
    artifacts:{...graph,issue_plan:issuePlan,spec_audit:audit.artifact},
    next_action:{action:"RESOLVE_BLOCKING_FINDINGS",owner:"PM"},
  }),/owner|finding|next.action/i);
  const store=fakeStore();
  const result=await runNextStage({
    ...transitionMetadata(graph.pm_analysis),
    state:"SPEC_AUDIT",
    artifacts:{...graph,issue_plan:issuePlan,spec_audit:audit.artifact},
    store,
  });
  assert.equal(
    result.content.next_action.owner,
    "PM_FINALIZATION",
    JSON.stringify(audit.findings.map(finding => ({
      severity:finding.severity,
      type:finding.type,
      owner:finding.owner,
      path:finding.path,
    }))),
  );
});

test("public ADR approval packages are closed across extra and non-plain JSON fields",async () => {
  const graph=await architectureGraph({pending:true});
  const base={
    schema_version:"adr-approval-package.v1",
    document_type:"adr-approval-package",
    owner:"USER",
    adr_references:graph.adrs.map(reference),
  };
  const cases=[];
  cases.push({...clone(base),forged:true});
  const prototype=Object.create({forged:true});
  Object.assign(prototype,clone(base));
  cases.push(prototype);
  const accessor=clone(base);
  Object.defineProperty(accessor,"forged",{enumerable:true,get:() => true});
  cases.push(accessor);
  const symbol=clone(base);
  symbol[Symbol("forged")]=true;
  cases.push(symbol);
  const nonEnumerable=clone(base);
  Object.defineProperty(nonEnumerable,"forged",{value:true,enumerable:false});
  cases.push(nonEnumerable);

  for (const decisionPackage of cases) {
    assert.throws(() => transition(
      "ARCHITECTURE_PENDING",
      "ADR_APPROVAL_REQUIRED",
      {
        ...transitionMetadata(graph.pm_analysis),
        artifacts:{...graph,decision_package:decisionPackage},
      },
    ),/canonical|approval package|unsupported|invalid/i);
  }
});

test("resume rejects replaced or missing pending packages in question and ADR histories",async () => {
  const pm=await validPm({severity:"P2"});
  const firstPackage=blockingPackage(pm);
  const replacementPackage=buildDecisionPackageFromPmAnalysis(pm,[{
    id:pm.content.open_questions[0].id,
    context:"A replay-time replacement that was never the pending decision.",
    impact:"Immutable decision history would be rewritten.",
  }]);
  const pendingContent=transition("ANALYZING","QUESTIONS_FOUND",{
    ...transitionMetadata(pm),
    artifacts:{pm_analysis:pm,decision_package:firstPackage},
  });
  const pending=eventArtifact({
    source:pm,
    previous_state:"ANALYZING",
    event:"QUESTIONS_FOUND",
    state:"QUESTIONS_PENDING",
    inputs:[pm],
    extraContent:{
      next_action:pendingContent.next_action,
      decision_package:firstPackage,
    },
  });
  const startedContent=transition("QUESTIONS_PENDING","DECISION_STARTED",{
    ...transitionMetadata(pm),
    artifacts:{pm_analysis:pm,decision_package:replacementPackage},
  });
  const started=eventArtifact({
    source:pm,
    revision:2,
    previous_state:"QUESTIONS_PENDING",
    event:"DECISION_STARTED",
    state:"USER_DECISION",
    inputs:[pm],
    parents:[pending],
    extraContent:{
      next_action:startedContent.next_action,
      decision_package:replacementPackage,
    },
  });
  await assert.rejects(resumeAnalysis(fakeStore([pm,pending,started]),{
    ...transitionMetadata(pm),
  }),/decision package|pending|continuity/i);

  const pendingGraph=await architectureGraph({pending:true});
  const approvalPackage={
    schema_version:"adr-approval-package.v1",
    document_type:"adr-approval-package",
    owner:"USER",
    adr_references:pendingGraph.adrs.map(reference),
  };
  const approvalContent=transition("ARCHITECTURE_PENDING","ADR_APPROVAL_REQUIRED",{
    ...transitionMetadata(pendingGraph.pm_analysis),
    artifacts:{...pendingGraph,decision_package:approvalPackage},
  });
  const approvalPending=eventArtifact({
    source:pendingGraph.pm_analysis,
    previous_state:"ARCHITECTURE_PENDING",
    event:"ADR_APPROVAL_REQUIRED",
    state:"ADR_PENDING_APPROVAL",
    inputs:[pendingGraph.pm_analysis,pendingGraph.architecture,...pendingGraph.adrs],
    extraContent:{
      next_action:approvalContent.next_action,
      decision_package:approvalPackage,
    },
  });
  const approvedGraph=await architectureGraph();
  approvedGraph.adrs[0]=rehash({
    ...clone(approvedGraph.adrs[0]),
    revision:2,
    parents:[reference(pendingGraph.adrs[0])],
  });
  const replacementApprovalPackage={
    ...approvalPackage,
    adr_references:approvedGraph.adrs.map(reference),
  };
  const approvedContent=transition("ADR_PENDING_APPROVAL","ADR_APPROVED",{
    ...transitionMetadata(approvedGraph.pm_analysis),
    artifacts:{...approvedGraph,decision_package:replacementApprovalPackage},
  });
  const approved=eventArtifact({
    source:approvedGraph.pm_analysis,
    revision:2,
    previous_state:"ADR_PENDING_APPROVAL",
    event:"ADR_APPROVED",
    state:"PM_FINALIZATION",
    inputs:[approvedGraph.pm_analysis,approvedGraph.architecture,...approvedGraph.adrs],
    parents:[approvalPending],
    extraContent:approvedContent,
  });
  await assert.rejects(resumeAnalysis(fakeStore([
    pendingGraph.pm_analysis,
    pendingGraph.architecture,
    ...pendingGraph.adrs,
    ...approvedGraph.adrs,
    approvalPending,
    approved,
  ]),{
    ...transitionMetadata(pendingGraph.pm_analysis),
  }),/decision package|pending|continuity/i);
});

test("a changed source restarts the same analysis stream as an explicit generation",async () => {
  const oldPm=await validPm();
  const firstContent=transition("ANALYZING","ANALYSIS_COMPLETED",{
    ...transitionMetadata(oldPm),
    artifacts:{pm_analysis:oldPm},
  });
  const first=eventArtifact({source:oldPm,inputs:[oldPm],extraContent:firstContent});
  const store=fakeStore([oldPm,first]);
  const newSource={
    sourceRevision:"project-brief-r2",
    sourceSha256:"b".repeat(64),
  };
  const resumedOld=await resumeAnalysis(store,{
    analysis_id:first.artifact_id,
    source_revision:newSource.sourceRevision,
    source_sha256:newSource.sourceSha256,
  });
  assert.equal(resumedOld.state,"ANALYZING");
  assert.deepEqual(resumedOld.stale_artifacts.map(item => item.artifact_id),[oldPm.artifact_id]);

  const boundary=await runNextStage({
    ...transitionMetadata(oldPm),
    source_revision:newSource.sourceRevision,
    source_sha256:newSource.sourceSha256,
    provenance:recordedProvenance({
      revision:newSource.sourceRevision,
      sha256:newSource.sourceSha256,
    }),
    state:"ANALYZING",
    artifacts:{},
    store,
  });
  assert.equal(boundary.revision,2);
  assert.equal(boundary.content.event,"SOURCE_RESTARTED");
  assert.equal(boundary.content.state,"ANALYZING");
  assert.deepEqual(boundary.parents,[reference(first)]);
  assert.deepEqual(boundary.content.source_boundary.stale_artifacts,[{
    ...reference(oldPm),
  }]);
  assert.deepEqual(boundary.inputs,boundary.content.source_boundary.stale_artifacts);

  const resumedNew=await resumeAnalysis(store,{
    analysis_id:first.artifact_id,
    source_revision:newSource.sourceRevision,
    source_sha256:newSource.sourceSha256,
  });
  assert.equal(resumedNew.state,"ANALYZING");
  assert.equal(resumedNew.revision,2);
  assert.deepEqual(
    resumedNew.stale_artifacts.map(({source_revision,source_sha256,...item}) => item),
    boundary.content.source_boundary.stale_artifacts,
  );
});

test("tampered or caller-injected source generation boundaries fail closed",async () => {
  const oldPm=await validPm();
  const firstContent=transition("ANALYZING","ANALYSIS_COMPLETED",{
    ...transitionMetadata(oldPm),
    artifacts:{pm_analysis:oldPm},
  });
  const first=eventArtifact({source:oldPm,inputs:[oldPm],extraContent:firstContent});
  const sourceRevision="project-brief-r2";
  const sourceSha256="b".repeat(64);
  const metadata={
    ...transitionMetadata(oldPm),
    source_revision:sourceRevision,
    source_sha256:sourceSha256,
    provenance:recordedProvenance({revision:sourceRevision,sha256:sourceSha256}),
    state:"ANALYZING",
    artifacts:{},
  };
  const generatingStore=fakeStore([oldPm,first]);
  const boundary=await runNextStage({...metadata,store:generatingStore});

  const wrongTuple=clone(boundary);
  wrongTuple.content.event="ANALYSIS_COMPLETED";
  wrongTuple.content.state="ARCHITECTURE_PENDING";
  rehash(wrongTuple);
  const missingStale=clone(boundary);
  missingStale.inputs=[];
  missingStale.content.input_artifacts=[];
  missingStale.content.source_boundary.stale_artifacts=[];
  rehash(missingStale);
  const wrongParent=clone(boundary);
  wrongParent.parents=[];
  const skippedRevision=clone(boundary);
  skippedRevision.revision=3;

  for (const tampered of [wrongTuple,missingStale,wrongParent,skippedRevision]) {
    await assert.rejects(resumeAnalysis(fakeStore([oldPm,first,tampered]),{
      analysis_id:first.artifact_id,
      source_revision:sourceRevision,
      source_sha256:sourceSha256,
    }),/source|generation|stale|parent|revision|chain/i);
  }

  const injectedStore=fakeStore([oldPm,first]);
  await assert.rejects(runNextStage({
    ...metadata,
    event:"SOURCE_RESTARTED",
    source_boundary:boundary.content.source_boundary,
    store:injectedStore,
  }),/auto.derive|generation|source/i);
  assert.equal(injectedStore.appends.length,0);

  const midStreamStore=fakeStore([oldPm,first]);
  await assert.rejects(runNextStage({
    ...metadata,
    state:"ARCHITECTURE_PENDING",
    event:"FAIL_RETRYABLE",
    failure:{code:"FORGED_SWITCH",message:"Do not cross a source mid-stream"},
    store:midStreamStore,
  }),/auto.derive|generation|source/i);
  assert.equal(midStreamStore.appends.length,0);
});

test("review fixtures remain canonical and independently derived",async () => {
  const graph=await completeGraph();
  assert.doesNotThrow(() => canonicalJson(graph));
  for (const [artifact,schema] of [
    [graph.pm_analysis,"pm-analysis.v1"],
    [graph.architecture,"architecture.v1"],
    [graph.adrs[0],"adr.v1"],
    [graph.issue_plan,"issue-plan.v1"],
    [graph.spec_audit,"spec-audit.v1"],
  ]) assert.equal(validateDocument(artifact,schema).valid,true);
});
