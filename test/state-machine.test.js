import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {sha256Canonical} from "../src/contracts/acp.js";
import {createArtifactStore} from "../src/artifacts/store.js";
import {validateDocument} from "../src/contracts/validator.js";
import {buildDecisionPackage} from "../src/pipeline/decisions.js";

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

function blockingDecisionPackage() {
  return buildDecisionPackage([{
    id:"Q-BLOCKING",
    meaning:"Choose launch authority",
    question:"Who approves launch?",
    severity:"P0",
    context:"Launch needs an accountable approval authority.",
    impact:"Work cannot continue until the authority decides.",
    options:[{id:"USER",label:"Verified user approval"}],
    recommendation:"Ask the verified user.",
    rationale:"This choice changes protected project intent.",
    affected_entities:["REQ-001"],
    provenance:{
      source:{file:"PROJECT_BRIEF.md",section:"Launch",location:"line 1"},
      source_revision:"source-r1",
      source_sha256:"a".repeat(64),
      agent:{identity:"pm",model:"deterministic",run_id:"run-analysis-001"},
      timestamp:"2026-08-17T14:00:00.000Z",
      confidence:1,
    },
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
  const decisionPackage=blockingDecisionPackage();
  const pmAnalysis=artifact("pm-analysis","PM-ANALYSIS-001",1);
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
  const adrPackage={
    schema_version:"adr-approval-package.v1",
    document_type:"adr-approval-package",
    owner:"USER",
    adr_references:[{
      document_type:"adr",
      artifact_id:"ADR-ARTIFACT-001",
      revision:1,
      content_sha256:"c".repeat(64),
    }],
  };
  const pending=stateMachine.transition(
    "ARCHITECTURE_PENDING",
    "ADR_APPROVAL_REQUIRED",
    transitionContext({artifacts:{
      pm_analysis:artifact("pm-analysis","PM-ANALYSIS-001",1),
      architecture:artifact("architecture","ARCHITECTURE-001",1),
      adrs:[{
        document_type:"adr",
        artifact_id:"ADR-ARTIFACT-001",
        revision:1,
        content_sha256:"c".repeat(64),
      }],
      decision_package:adrPackage,
    }}),
  );
  assert.equal(pending.state,"ADR_PENDING_APPROVAL");
  assert.equal(pending.next_action.owner,"USER");
  assert.deepEqual(pending.next_action.decision_package,adrPackage);

  const blocked=stateMachine.transition("PM_FINALIZATION","BLOCK",transitionContext({
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

test("ADR approval packages bind exactly the pending revisions, excluding approved ADRs",() => {
  const pendingAdr={
    ...artifact("adr","ADR-PENDING-001",1),
    content:{approval:{state:"pending"}},
  };
  pendingAdr.content_sha256=sha256Canonical(pendingAdr.content);
  const approvedAdr={
    ...artifact("adr","ADR-APPROVED-001",1),
    content:{approval:{state:"approved"}},
  };
  approvedAdr.content_sha256=sha256Canonical(approvedAdr.content);
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
      pm_analysis:artifact("pm-analysis","PM-ANALYSIS-001",1),
      architecture:artifact("architecture","ARCHITECTURE-001",1),
      adrs:[approvedAdr,pendingAdr],
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
  const forged={...blockingDecisionPackage(),forged_gate:true};
  assert.throws(() => stateMachine.transition(
    "ANALYZING",
    "QUESTIONS_FOUND",
    transitionContext({artifacts:{
      pm_analysis:artifact("pm-analysis","PM-ANALYSIS-001",1),
      decision_package:forged,
    }}),
  ),/decision package.*invalid/i);
});

test("resume uses public store verification and returns the latest immutable event",async () => {
  const first=artifact("transition-event","project-analysis-001",1);
  first.producer={role:"orchestrator",identity:"fixture"};
  first.content={
    previous_state:"ANALYZING",
    event:"ANALYSIS_COMPLETED",
    state:"ARCHITECTURE_PENDING",
    source_revision:"source-r1",
    source_sha256:"a".repeat(64),
    input_artifacts:[],
  };
  first.content_sha256=sha256Canonical(first.content);
  const second=artifact("transition-event","project-analysis-001",2);
  second.producer={role:"orchestrator",identity:"fixture"};
  second.parents=[reference(first)];
  second.content={
    previous_state:"ARCHITECTURE_PENDING",
    event:"ARCHITECTURE_COMPLETED",
    state:"PM_FINALIZATION",
    source_revision:"source-r1",
    source_sha256:"a".repeat(64),
    input_artifacts:[],
  };
  second.content_sha256=sha256Canonical(second.content);
  const architecture=artifact("architecture","ARCHITECTURE-001",1);
  const verified=[];
  const store={
    async list() { return [architecture,first,second]; },
    async verify(exactReference) {
      verified.push(exactReference);
      return exactReference.revision===2 ? second : first;
    },
  };

  const resumed=await orchestrator.resumeAnalysis(store,{
    source_revision:"source-r1",
    source_sha256:"a".repeat(64),
    analysis_id:"project-analysis-001",
  });

  assert.equal(resumed.revision,2);
  assert.equal(resumed.state,"PM_FINALIZATION");
  assert.deepEqual(resumed.stale_artifacts,[]);
  assert.equal(verified[0].revision,2);
  assertDeepFrozen(resumed);
});

test("resume deterministically marks downstream artifacts stale after a source change",async () => {
  const event=artifact("transition-event","project-analysis-001",1);
  event.producer={role:"orchestrator",identity:"fixture"};
  event.content={
    previous_state:"ANALYZING",
    event:"ANALYSIS_COMPLETED",
    state:"ARCHITECTURE_PENDING",
    source_revision:"source-r1",
    source_sha256:"a".repeat(64),
    input_artifacts:[],
  };
  event.content_sha256=sha256Canonical(event.content);
  const oldPm=artifact("pm-analysis","PM-ANALYSIS-001",1);
  const oldArchitecture=artifact("architecture","ARCHITECTURE-001",1);
  const store={
    async list() { return [oldArchitecture,event,oldPm]; },
    async verify() { return event; },
  };

  const resumed=await orchestrator.resumeAnalysis(store,{
    source_revision:"source-r2",
    source_sha256:"b".repeat(64),
    analysis_id:"project-analysis-001",
  });

  assert.equal(resumed.state,"ANALYZING");
  assert.deepEqual(resumed.stale_artifacts.map(item => item.artifact_id),[
    "ARCHITECTURE-001",
    "PM-ANALYSIS-001",
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
  const pmAnalysis=artifact("pm-analysis","PM-ANALYSIS-001",1);
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
  const pmAnalysis=JSON.parse(await readFile(new URL(
    "./fixtures/pm-analysis/valid/complete-artifact.json",
    import.meta.url,
  ),"utf8"));
  const result=await orchestrator.runNextStage({
    ...transitionContext({artifacts:{
      pm_analysis:pmAnalysis,
      decision_package:blockingDecisionPackage(),
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
  const pmAnalysis=artifact("pm-analysis","PM-ANALYSIS-REAL-001",1);
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
