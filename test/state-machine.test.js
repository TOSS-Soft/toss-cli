import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {sha256Canonical} from "../src/contracts/acp.js";
import {createArtifactStore} from "../src/artifacts/store.js";
import {validateDocument} from "../src/contracts/validator.js";
import {buildArchitecture} from "../src/pipeline/architecture.js";
import {buildDecisionPackageFromPmAnalysis} from "../src/pipeline/decisions.js";

const stateMachine=await import("../src/pipeline/state-machine.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const orchestrator=await import("../src/pipeline/orchestrator.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});

test("analysis pipeline exposes its state-machine and resumable orchestration contracts",() => {
  assert.ok(Array.isArray(stateMachine.ANALYSIS_STATES));
  assert.equal(typeof stateMachine.transition,"function");
  assert.equal(typeof orchestrator.resumeAnalysis,"function");
  assert.equal(typeof orchestrator.runNextStage,"function");
});

const fixtureContext=JSON.parse(await readFile(new URL(
  "./fixtures/state/context.json",
  import.meta.url,
),"utf8"));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function replaceProvenance(value,provenance) {
  if (Array.isArray(value)) return value.map(child => replaceProvenance(child,provenance));
  if (!value || typeof value!=="object") return value;
  const result={};
  for (const [key,child] of Object.entries(value)) {
    result[key]=key==="provenance" ? clone(provenance) : replaceProvenance(child,provenance);
  }
  return result;
}

const recordedProvenance=clone(fixtureContext.provenance);
const rawPm=JSON.parse(await readFile(new URL(
  "./fixtures/pm-analysis/valid/complete-artifact.json",
  import.meta.url,
),"utf8"));
const validPmTemplate=replaceProvenance(rawPm,recordedProvenance);
validPmTemplate.provenance=clone(recordedProvenance);
validPmTemplate.content_sha256=sha256Canonical(validPmTemplate.content);

function validPmArtifact() {
  return clone(validPmTemplate);
}

const architectureDecisions=JSON.parse(await readFile(new URL(
  "./fixtures/architecture/valid/decisions.json",
  import.meta.url,
),"utf8"));
const rawArchitectureContext=JSON.parse(await readFile(new URL(
  "./fixtures/architecture/valid/artifact-context.json",
  import.meta.url,
),"utf8"));
const architectureContext=replaceProvenance(rawArchitectureContext,recordedProvenance);
architectureContext.provenance=clone(recordedProvenance);
const adrContentTemplate=JSON.parse(await readFile(new URL(
  "./fixtures/architecture/valid/adr-content.json",
  import.meta.url,
),"utf8"));

function architectureGraph({pending=false}={}) {
  const pm_analysis=validPmArtifact();
  const architecture=buildArchitecture({
    pmAnalysis:pm_analysis,
    decisions:architectureDecisions,
    artifactContext:architectureContext,
  });
  const content=clone(adrContentTemplate);
  if (pending) {
    content.status="proposed";
    content.approval.state="pending";
  }
  const adr={
    schema_version:"acp.v1",
    document_type:"adr",
    artifact_id:"ADR-ARTIFACT-001",
    revision:1,
    run_id:"run-architecture-001",
    producer:{role:"architect",identity:"toss-architect"},
    runtime_identity:{kind:"deterministic",name:"toss-cli",version:"2.1.0"},
    created_at:"2026-08-17T13:00:00.000Z",
    provenance:clone(recordedProvenance),
    parents:[],
    inputs:[reference(pm_analysis),reference(architecture)],
    content_sha256:sha256Canonical(content),
    content,
  };
  return {pm_analysis,architecture,adrs:[adr]};
}

function reference(artifact) {
  return {
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  };
}

function artifact(documentType,artifactId,revision,sourceRevision="source-r1") {
  const content={value:`${documentType}-${revision}`};
  return {
    schema_version:"acp.v1",
    document_type:documentType,
    artifact_id:artifactId,
    revision,
    run_id:`run-${artifactId}-${revision}`,
    producer:{role:documentType==="pm-analysis" ? "pm" : "architect",identity:"fixture"},
    runtime_identity:"fixture-runtime",
    created_at:"2026-08-17T14:00:00.000Z",
    provenance:{
      source_revision:sourceRevision,
      source_sha256:sourceRevision==="source-r1" ? "a".repeat(64) : "b".repeat(64),
      locations:["PROJECT_BRIEF.md"],
    },
    parents:[],
    inputs:[],
    content_sha256:sha256Canonical(content),
    content,
  };
}

function transitionArtifact(content,{revision=1,inputs=[],parents=[]}={}) {
  const value=artifact("transition-event","project-analysis-001",revision);
  value.producer={role:"orchestrator",identity:"fixture"};
  value.inputs=inputs.map(reference);
  value.parents=parents.map(reference);
  value.content=clone(content);
  value.content_sha256=sha256Canonical(value.content);
  return value;
}

function blockingDecisionPackage(pm=validPmArtifact()) {
  return buildDecisionPackageFromPmAnalysis(pm,[{
    id:pm.content.open_questions[0].id,
    context:"Launch needs an accountable approval authority.",
    impact:"Work cannot continue until the authority decides.",
  }]);
}

function transitionContext(overrides={}) {
  return {
    ...clone(fixtureContext),
    ...overrides,
    artifacts:{...overrides.artifacts},
  };
}

function assertDeepFrozen(value) {
  if (!value || typeof value!=="object") return;
  assert.equal(Object.isFrozen(value),true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("declared transitions are deterministic, deep-frozen, and illegal events fail closed",() => {
  let appendCalls=0;
  const pmAnalysis=validPmArtifact();
  const decisionPackage=blockingDecisionPackage(pmAnalysis);
  const context=transitionContext({
    artifacts:{pm_analysis:pmAnalysis,decision_package:decisionPackage},
    store:{append:() => { appendCalls+=1; }},
  });

  const result=stateMachine.transition("ANALYZING","QUESTIONS_FOUND",context);

  assert.equal(result.state,"QUESTIONS_PENDING");
  assert.equal(result.previous_state,"ANALYZING");
  assert.equal(result.event,"QUESTIONS_FOUND");
  assert.equal(result.next_action.owner,"USER");
  assert.deepEqual(result.next_action.decision_package,decisionPackage);
  assertDeepFrozen(result);
  assert.throws(
    () => stateMachine.transition("ANALYZING","PUBLISH",context),
    /illegal transition/i,
  );
  assert.equal(appendCalls,0);
});

test("ADR approval and interruption outcomes expose an owner, package, and recovery state",() => {
  const graph=architectureGraph({pending:true});
  const adrPackage={
    schema_version:"adr-approval-package.v1",
    document_type:"adr-approval-package",
    owner:"USER",
    adr_references:graph.adrs.map(reference),
  };
  const pending=stateMachine.transition(
    "ARCHITECTURE_PENDING",
    "ADR_APPROVAL_REQUIRED",
    transitionContext({artifacts:{...graph,decision_package:adrPackage}}),
  );
  assert.equal(pending.state,"ADR_PENDING_APPROVAL");
  assert.equal(pending.next_action.owner,"USER");
  assert.deepEqual(pending.next_action.decision_package,adrPackage);

  const blocked=stateMachine.transition("ANALYZING","BLOCK",transitionContext({
    next_action:{action:"PROVIDE_INPUT",owner:"USER",decision_package:adrPackage},
  }));
  assert.equal(blocked.state,"BLOCKED");
  assert.equal(blocked.next_action.owner,"USER");
  assert.equal(stateMachine.transition("BLOCKED","RESUME",transitionContext({
    resume_state:"PM_FINALIZATION",
  })).state,"PM_FINALIZATION");
  assert.equal(stateMachine.transition(
    "SPEC_AUDIT",
    "FAIL_RETRYABLE",
    transitionContext({failure:{code:"AUDITOR_UNAVAILABLE",message:"Retry later"}}),
  ).state,"FAILED_RETRYABLE");
  assert.equal(stateMachine.transition(
    "SPEC_AUDIT",
    "FAIL_TERMINAL",
    transitionContext({failure:{code:"INVALID_GRAPH",message:"Input graph is invalid"}}),
  ).state,"FAILED_TERMINAL");
});

test("ADR approval packages bind exactly the pending revisions",() => {
  const graph=architectureGraph({pending:true});
  const pendingAdr=graph.adrs[0];
  const decisionPackage={
    schema_version:"adr-approval-package.v1",
    document_type:"adr-approval-package",
    owner:"USER",
    adr_references:[reference(pendingAdr)],
  };

  const result=stateMachine.transition(
    "ARCHITECTURE_PENDING",
    "ADR_APPROVAL_REQUIRED",
    transitionContext({artifacts:{
      ...graph,
      decision_package:decisionPackage,
    }}),
  );

  assert.deepEqual(result.next_action.decision_package,decisionPackage);
});

test("transition inputs reject non-canonical JSON before producing a result",() => {
  assert.throws(() => stateMachine.transition(
    "ANALYZING",
    "ANALYSIS_COMPLETED",
    transitionContext({artifacts:{pm_analysis:new Date()}}),
  ),/canonical JSON/i);
});

test("pure transitions reject forged fields in otherwise recognizable decision packages",() => {
  const pmAnalysis=validPmArtifact();
  const forged={...blockingDecisionPackage(pmAnalysis),forged_gate:true};
  assert.throws(() => stateMachine.transition(
    "ANALYZING",
    "QUESTIONS_FOUND",
    transitionContext({artifacts:{
      pm_analysis:pmAnalysis,
      decision_package:forged,
    }}),
  ),/decision package.*invalid/i);
});

test("resume uses public store verification and returns the latest immutable event",async () => {
  const pm=validPmArtifact();
  const firstContent=stateMachine.transition("ANALYZING","ANALYSIS_COMPLETED",{
    ...fixtureContext,
    artifacts:{pm_analysis:pm},
  });
  const first=transitionArtifact(firstContent,{inputs:[pm]});
  const secondContent=stateMachine.transition("ARCHITECTURE_PENDING","FAIL_RETRYABLE",{
    ...fixtureContext,
    artifacts:{},
    failure:{code:"TEMPORARY",message:"Retry later"},
  });
  const second=transitionArtifact(secondContent,{revision:2,parents:[first]});
  const architecture=artifact("architecture","ARCHITECTURE-001",1);
  const verified=[];
  const store={
    async list() { return [architecture,pm,first,second]; },
    async verify(exactReference) {
      verified.push(exactReference);
      return [pm,first,second].find(value =>
        value.document_type===exactReference.document_type &&
        value.artifact_id===exactReference.artifact_id &&
        value.revision===exactReference.revision &&
        value.content_sha256===exactReference.content_sha256);
    },
  };

  const resumed=await orchestrator.resumeAnalysis(store,{
    source_revision:"source-r1",
    source_sha256:"a".repeat(64),
    analysis_id:"project-analysis-001",
  });

  assert.equal(resumed.revision,2);
  assert.equal(resumed.state,"FAILED_RETRYABLE");
  assert.deepEqual(resumed.stale_artifacts,[]);
  assert.ok(verified.some(item => item.revision===2));
  assertDeepFrozen(resumed);
});

test("resume deterministically marks downstream artifacts stale after a source change",async () => {
  const oldPm=validPmArtifact();
  const eventContent=stateMachine.transition("ANALYZING","ANALYSIS_COMPLETED",{
    ...fixtureContext,
    artifacts:{pm_analysis:oldPm},
  });
  const event=transitionArtifact(eventContent,{inputs:[oldPm]});
  const oldArchitecture=artifact("architecture","ARCHITECTURE-001",1);
  const store={
    async list() { return [oldArchitecture,event,oldPm]; },
    async verify(want) { return want.document_type==="transition-event" ? event : oldPm; },
  };

  const resumed=await orchestrator.resumeAnalysis(store,{
    source_revision:"source-r2",
    source_sha256:"b".repeat(64),
    analysis_id:"project-analysis-001",
  });

  assert.equal(resumed.state,"ANALYZING");
  assert.deepEqual(resumed.stale_artifacts.map(item => item.artifact_id),[
    "ARCHITECTURE-001",
    oldPm.artifact_id,
  ]);
});

test("resume fails closed when the newest verified envelope violates the event contract",async () => {
  const malformed=artifact("transition-event","project-analysis-001",1);
  malformed.producer={role:"orchestrator",identity:"fixture"};
  malformed.content={
    previous_state:"ANALYZING",
    event:"ANALYSIS_COMPLETED",
    state:"NOT_A_STATE",
    source_revision:"source-r1",
    source_sha256:"a".repeat(64),
    input_artifacts:[],
  };
  malformed.content_sha256=sha256Canonical(malformed.content);
  const store={
    async list() { return [malformed]; },
    async verify() { return malformed; },
  };

  await assert.rejects(orchestrator.resumeAnalysis(store,{
    source_revision:"source-r1",
    source_sha256:"a".repeat(64),
    analysis_id:"project-analysis-001",
  }),/transition event.*invalid/i);
});

test("resume exposes the recorded recovery state for retryable interruptions",async () => {
  const failed=artifact("transition-event","project-analysis-001",1);
  failed.producer={role:"orchestrator",identity:"fixture"};
  failed.content={
    previous_state:"SPEC_AUDIT",
    event:"FAIL_RETRYABLE",
    state:"FAILED_RETRYABLE",
    source_revision:"source-r1",
    source_sha256:"a".repeat(64),
    input_artifacts:[],
    failure:{code:"AUDITOR_UNAVAILABLE",message:"Retry later"},
    resume_state:"SPEC_AUDIT",
  };
  failed.content_sha256=sha256Canonical(failed.content);
  const store={
    async list() { return [failed]; },
    async verify() { return failed; },
  };

  const resumed=await orchestrator.resumeAnalysis(store,{
    source_revision:"source-r1",
    source_sha256:"a".repeat(64),
    analysis_id:"project-analysis-001",
  });

  assert.equal(resumed.state,"FAILED_RETRYABLE");
  assert.equal(resumed.recovery_state,"SPEC_AUDIT");
});

test("runNextStage validates a transition before appending its immutable event",async () => {
  let appendCalls=0;
  const store={
    async list() { return []; },
    async verify() { throw new Error("nothing to verify"); },
    async append(draft) {
      appendCalls+=1;
      return {...draft,revision:1,content_sha256:sha256Canonical(draft.content)};
    },
  };
  const pmAnalysis=validPmArtifact();
  const context={
    ...transitionContext({artifacts:{pm_analysis:pmAnalysis}}),
    state:"ANALYZING",
    store,
  };

  await assert.rejects(
    orchestrator.runNextStage({...context,event:"PUBLISH"}),
    /illegal transition/i,
  );
  assert.equal(appendCalls,0);

  const appended=await orchestrator.runNextStage({
    ...context,
    event:"ANALYSIS_COMPLETED",
  });
  assert.equal(appendCalls,1);
  assert.equal(appended.document_type,"transition-event");
  assert.equal(appended.content.state,"ARCHITECTURE_PENDING");
  assert.deepEqual(appended.inputs,[reference(pmAnalysis)]);
  let validation;
  assert.doesNotThrow(() => {
    validation=validateDocument(appended,"transition-event.v1");
  });
  assert.equal(validation.valid,true);
});

test("runNextStage derives the pending-question event from a validated analysis result",async () => {
  const appended=[];
  const store={
    async list() { return []; },
    async verify() { throw new Error("nothing to verify"); },
    async append(draft) {
      const value={...draft,revision:1,content_sha256:sha256Canonical(draft.content)};
      appended.push(value);
      return value;
    },
  };
  const pmAnalysis=validPmArtifact();
  const result=await orchestrator.runNextStage({
    ...transitionContext({artifacts:{
      pm_analysis:pmAnalysis,
      decision_package:blockingDecisionPackage(pmAnalysis),
    }}),
    state:"ANALYZING",
    store,
  });

  assert.equal(result.content.event,"QUESTIONS_FOUND");
  assert.equal(result.content.state,"QUESTIONS_PENDING");
  assert.equal(result.content.next_action.owner,"USER");
  assert.equal(appended.length,1);
});

test("real artifact-store persistence resumes the exact verified transition revision",async (t) => {
  const root=await mkdtemp(join(tmpdir(),"toss-analysis-state-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const store=createArtifactStore({
    root,
    now:() => new Date("2026-08-17T14:00:00.000Z"),
    randomId:() => "state-machine-test",
  });
  const pmAnalysis=validPmArtifact();
  const persistedPm=await store.append(pmAnalysis);
  const source={
    source_revision:persistedPm.provenance.source_revision,
    source_sha256:persistedPm.provenance.source_sha256,
    analysis_id:"project-analysis-real-001",
  };
  const event=await orchestrator.runNextStage({
    ...clone(fixtureContext),
    ...source,
    provenance:clone(persistedPm.provenance),
    state:"ANALYZING",
    event:"ANALYSIS_COMPLETED",
    artifacts:{pm_analysis:persistedPm},
    store,
  });
  const resumed=await orchestrator.resumeAnalysis(store,source);

  assert.equal(event.revision,1);
  assert.equal(resumed.revision,event.revision);
  assert.equal(resumed.state,"ARCHITECTURE_PENDING");
  assert.deepEqual(resumed.last_verified_revision,reference(event));
});
