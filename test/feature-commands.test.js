import assert from "node:assert/strict";
import test from "node:test";

import {
  createLifecycleRuntimeProvider,
  lifecycleRuntimeServices,
} from "../src/cli-lifecycle.js";
import {dispatchCommand} from "../src/commands/router.js";
import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {artifactReference,clone,rehash} from "./support/trace-fixture.js";
import {
  authorityRegistry,
  classificationInput,
  designCommandInput,
  graphForLevel,
  signedStageApproval,
} from "./support/design-command-fixture.js";
import {
  commandServices,
  commandStore,
  countedCommandStore,
  featureCommandInput,
  memoryCommandStore,
  parsedCommand,
  projectCommandInput,
} from "./support/command-fixture.js";

const featureModule=await import("../src/commands/feature.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const projectModule=await import("../src/commands/project.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const runFeatureCommand=featureModule.runFeatureCommand;
const runProjectCommand=projectModule.runProjectCommand;
const designModule=await import("../src/commands/design.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const runDesignCommand=designModule.runDesignCommand;
const commandsAvailable=typeof runFeatureCommand==="function" &&
  typeof runProjectCommand==="function";

test("feature orchestration exposes one closed command handler",() => {
  assert.equal(typeof runFeatureCommand,"function");
});

async function readyProject(t,{real=false}={}) {
  const store=real ? await commandStore(t) : memoryCommandStore();
  const project=projectCommandInput();
  const prepared=await runProjectCommand(
    parsedCommand("project.prepare",{from:"project.json"}),
    commandServices(store,project),
  );
  assert.equal(prepared.state,"READY_FOR_ISSUES");
  return {store,project,prepared};
}

function featureServices(store,input,options) {
  return commandServices(store,input,options);
}

function assertStateInputProjection(state) {
  assert.deepEqual(state.inputs,[
    ...state.content.source_artifact_refs,
    ...state.content.artifact_refs,
  ]);
}

function rewrittenStateInputStore(delegate,rewrite) {
  const project=row => {
    const result=clone(row);
    if (result.document_type==="design-orchestration-state") {
      result.inputs=rewrite(result);
    }
    return result;
  };
  return {
    append:delegate.append,
    get:async reference => project(await delegate.get(reference)),
    list:async filter => (await delegate.list(filter)).map(project),
    verify:async reference => project(await delegate.verify(reference)),
  };
}

function downgradedFeatureGraph(input) {
  const graph=graphForLevel("LITE");
  const prepared=[];
  const byType=new Map();
  for (const source of graph) {
    const artifact=clone(source);
    artifact.run_id=input.run_id;
    artifact.runtime_identity=clone(input.runtime_identity);
    artifact.created_at=input.created_at;
    artifact.provenance=clone(input.provenance);
    const remap=reference => artifactReference(byType.get(reference.document_type));
    artifact.parents=artifact.parents.map(remap);
    artifact.inputs=artifact.inputs.map(remap);
    if (artifact.document_type==="design-brief") {
      artifact.content.design_id="DESIGN-FEATURE-001";
      artifact.content.source=input.design_impact.source;
      artifact.content.purpose=input.design_impact.purpose;
      artifact.content.success_criteria=clone(input.design_impact.success_criteria);
      artifact.content.approval_owner=clone(input.design_impact.approval_owner);
    }
    if (artifact.document_type==="design-approval") {
      artifact.content.authority=clone(input.design_impact.approval_owner);
      artifact.content.graph_manifest=prepared.map(artifactReference).sort((left,right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)));
      artifact.content.graph_root_sha256=sha256Canonical(
        artifact.content.graph_manifest,
      );
    }
    artifact.content_sha256=sha256Canonical(artifact.content);
    prepared.push(artifact);
    byType.set(artifact.document_type,artifact);
  }
  return prepared;
}

test("feature add/analyze/prepare creates immutable delta revisions over one exact base",{
  skip:!commandsAvailable,
},async t => {
  const {store,prepared}=await readyProject(t);
  const input=featureCommandInput();
  const projectBefore=await store.list();

  const added=await runFeatureCommand(
    parsedCommand("feature.add",{from:"feature.yaml"}),
    featureServices(store,input),
  );
  const analyzed=await runFeatureCommand(
    parsedCommand("feature.analyze",{continue:true}),
    featureServices(store,input),
  );
  const result=await runFeatureCommand(
    parsedCommand("feature.prepare",{continue:true}),
    featureServices(store,input),
  );

  assert.equal(added.stage,"ADDED");
  assert.equal(analyzed.stage,"ANALYZED");
  assert.equal(result.stage,"PREPARED");
  assert.equal(result.ready,true);
  assert.equal(result.artifact.document_type,"feature-delta");
  assert.equal(result.artifact.content.kind,"feature-delta");
  assert.deepEqual(result.artifact.content.base_project.artifacts,prepared.artifact_revisions);
  assert.equal(result.artifact.content.base_project.authority,"reference-only");

  const featureOwnedTypes=new Set([
    "feature-delta","design-brief","design-orchestration-state",
  ]);
  const projectAfter=(await store.list()).filter(entry =>
    !featureOwnedTypes.has(entry.document_type));
  assert.deepEqual(projectAfter,projectBefore);
  assert.deepEqual(result.artifact.inputs,prepared.artifact_revisions.filter(
    reference => reference.document_type==="transition-event",
  ));

  const status=await runFeatureCommand(
    parsedCommand("feature.status"),
    featureServices(store,input),
  );
  assert.equal(status.stage,"PREPARED");
  assert.equal(status.next_command,"issues preview");
  assert.equal(status.blocking_owner,null);
});

test("feature prepare is idempotent and reports reused immutable revisions",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput();
  const services=featureServices(store,input);
  const first=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),
    services,
  );
  const before=await store.list({document_type:"feature-delta"});
  const second=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),
    services,
  );
  const after=await store.list({document_type:"feature-delta"});

  assert.deepEqual(after,before);
  assert.equal(first.artifact.content_sha256,second.artifact.content_sha256);
  assert.ok(second.reused_revisions.length>=1);
});

test("UI feature prepare starts a provenance-bound design state without pre-gate artifacts",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput({designImpact:{
    delivery_targets:["WEB"],
    affected_surfaces:["SCREEN","FLOW","INFORMATION_ARCHITECTURE"],
    risk_signals:["MULTI_SCREEN"],
    requested_level:"AUTO",
    source:"company_system",
    purpose:"Add a requester-visible resolution notification screen and flow.",
    success_criteria:["The requester can understand the resolved state."],
    approval_owner:{role:"USER",identity:"verified-user"},
  }});
  const first=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),featureServices(store,input),
  );
  assert.equal(first.design.level,"STANDARD");
  assert.equal(first.design.state,"INITIALIZED");
  assert.equal(first.design.artifact_revisions.length,0);
  assert.equal((await store.list({document_type:"design-brief"})).length,0);
  const states=await store.list({document_type:"design-orchestration-state"});
  assert.equal(states.length,1);
  assertStateInputProjection(states[0]);
  assert.equal(states[0].content.source_artifact_refs[0].document_type,"feature-delta");
  assert.deepEqual(first.design.state_revision,artifactReference(states[0]));
  assert.equal(states[0].provenance.source_revision,input.provenance.source_revision);

  const second=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),featureServices(store,input),
  );
  assert.deepEqual(second.design.state_revision,first.design.state_revision);
  assert.equal((await store.list({document_type:"design-orchestration-state"})).length,1);
});

test("Critical feature downgrade starts from one valid pending bootstrap state",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput({designImpact:{
    delivery_targets:["WEB"],
    affected_surfaces:["SCREEN"],
    risk_signals:["SECURITY_PRIVACY"],
    requested_level:"LITE",
    source:"company_system",
    purpose:"Protect a user-visible sensitive-data workflow.",
    success_criteria:["The sensitive flow is usable without weakening privacy."],
    approval_owner:{role:"CEO",identity:"verified-ceo"},
  }});
  const result=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),
    featureServices(store,input),
  );
  assert.equal(result.design.level,"CRITICAL");
  assert.equal(result.design.state,"DOWNGRADE_PENDING");
  assert.equal(result.design.gate,"CRITICAL_DOWNGRADE_APPROVAL");
  assert.equal(result.design.blocked,true);
  assert.equal(result.design.command_exit_code,4);
  const states=await store.list({document_type:"design-orchestration-state"});
  assert.equal(states.length,1);
  assertStateInputProjection(states[0]);
  const status=await runFeatureCommand(
    parsedCommand("feature.status"),featureServices(store,input),
  );
  assert.equal(status.design.state,"DOWNGRADE_PENDING");

  const graph=downgradedFeatureGraph(input);
  const classification=classificationInput({
    scope:{kind:"feature",id:"FEATURE-001"},
    delivery_targets:input.design_impact.delivery_targets,
    affected_surfaces:input.design_impact.affected_surfaces,
    risk_signals:input.design_impact.risk_signals,
    requested_level:"LITE",
    source:input.design_impact.source,
    purpose:input.design_impact.purpose,
    success_criteria:input.design_impact.success_criteria,
    approval_owner:input.design_impact.approval_owner,
  });
  const downgrade=signedStageApproval("CRITICAL_DOWNGRADE",graph,{
    design_id:"DESIGN-FEATURE-001",
    level:"LITE",
    recommended_level:"CRITICAL",
    effective_level:"LITE",
    from_level:"CRITICAL",
    to_level:"LITE",
    source_revision:input.provenance.source_revision,
    source_sha256:input.provenance.source_sha256,
  });
  const replay=designCommandInput({
    artifacts:graph,approvalRecords:[downgrade],classification,
  });
  replay.design_id="DESIGN-FEATURE-001";
  replay.created_at=input.created_at;
  replay.run_id=input.run_id;
  replay.runtime_identity=clone(input.runtime_identity);
  replay.provenance=clone(input.provenance);
  const authorityCapability=lifecycleRuntimeServices(createLifecycleRuntimeProvider({
    authorityRegistry:authorityRegistry(),prompt:async () => null,
  })).authorityCapability;
  const advanced=await runDesignCommand(
    parsedCommand("design.approve",{from:"design.json"}),{
      artifactStore:store,
      readInput:async () => JSON.stringify(replay),
      authorityCapability,
    },
  );
  assert.equal(advanced.level,"LITE");
  assert.equal(advanced.state,"DIRECTION_PENDING");
  assert.equal((await store.list({document_type:"design-orchestration-state"})).length,2);
  const continuedStatus=await runFeatureCommand(
    parsedCommand("feature.status"),{
      ...featureServices(store,input),authorityCapability,
    },
  );
  assert.equal(continuedStatus.design.level,"LITE");
  assert.equal(continuedStatus.design.state,"DIRECTION_PENDING");
});

test("feature status follows a valid descendant design state instead of comparing it to bootstrap",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput({designImpact:{
    delivery_targets:["WEB"],
    affected_surfaces:["SCREEN","FLOW","INFORMATION_ARCHITECTURE"],
    risk_signals:["MULTI_SCREEN"],
    requested_level:"AUTO",
    source:"company_system",
    purpose:"Add a requester-visible resolution notification screen and flow.",
    success_criteria:["The requester can understand the resolved state."],
    approval_owner:{role:"USER",identity:"verified-user"},
  }});
  await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),featureServices(store,input),
  );
  const initial=(await store.list({document_type:"design-orchestration-state"})).at(-1);
  const stages={
    "design-brief":"BRIEF",
    "ux-analysis":"ANALYSIS",
    "user-flow":"FLOWS",
    "information-architecture":"INFORMATION_ARCHITECTURE",
    "wireframe-plan":"WIREFRAMES",
    "visual-direction":"DIRECTION",
    "design-system":"DESIGN_SYSTEM",
    "screen-spec":"SCREENS",
    "prototype-manifest":"PROTOTYPE",
    "design-audit":"AUDIT",
    "design-approval":"FINAL_APPROVAL",
  };
  const descendant=clone(initial);
  descendant.revision=2;
  descendant.parents=[artifactReference(initial)];
  descendant.inputs=[...initial.content.source_artifact_refs];
  descendant.content.state="DIRECTION_PENDING";
  descendant.content.gate="DIRECTION_APPROVAL";
  descendant.content.payload_commitments=descendant.content.required_artifact_types.map(
    (documentType,index) => ({
      stage:stages[documentType],
      expected_document_type:documentType,
      expected_artifact_ref:documentType==="design-brief" ?
        initial.content.payload_commitments[0].expected_artifact_ref : {
          document_type:documentType,
          artifact_id:`${documentType}:DESIGN-FEATURE-001`,
          revision:1,
          content_sha256:"abcdef12345"[index].repeat(64),
        },
      payload_sha256:documentType==="design-brief" ?
        initial.content.payload_commitments[0].payload_sha256 :
        "123456789ab"[index].repeat(64),
      status:"COLLECTED",
      artifact_ref:null,
    }),
  );
  descendant.content.next_action={
    command:"toss design approve",
    owner:"USER",
    reason:"Visual direction approval is required.",
  };
  rehash(descendant);
  await store.append(descendant);

  const status=await runFeatureCommand(
    parsedCommand("feature.status"),featureServices(store,input),
  );
  assert.equal(status.design.state,"DIRECTION_PENDING");
  assert.deepEqual(status.design.state_revision,artifactReference(descendant));
});

test("backend-only feature prepare persists exactly a reasoned N/A brief and state",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput();
  const result=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),featureServices(store,input),
  );
  assert.equal(result.design.level,"NOT_APPLICABLE");
  assert.equal(result.design.state,"NOT_APPLICABLE");
  assert.equal((await store.list({document_type:"design-brief"})).length,1);
  assert.equal((await store.list({document_type:"design-orchestration-state"})).length,1);
  const state=(await store.list({document_type:"design-orchestration-state"}))[0];
  assertStateInputProjection(state);
  assert.deepEqual(result.artifact.content.design_impact,input.design_impact);
  assert.equal(result.design.artifact_revisions[0].document_type,"design-brief");
  const beforeRerun=await store.list();
  const rerun=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),featureServices(store,input),
  );
  assert.deepEqual(await store.list(),beforeRerun);
  assert.deepEqual(rerun.design.state_revision,result.design.state_revision);
});

test("feature design status rejects cleared source, cleared artifact, extra, duplicate, and reordered state inputs",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput();
  await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),featureServices(store,input),
  );
  const state=(await store.list({document_type:"design-orchestration-state"}))[0];
  assert.deepEqual(state.inputs.map(row => row.document_type),[
    "feature-delta","design-brief",
  ]);
  const inputKeys=new Set(state.inputs.map(row => canonicalJson(row)));
  const unexpected=artifactReference((await store.list()).find(row =>
    row.document_type!=="design-orchestration-state" &&
    !inputKeys.has(canonicalJson(artifactReference(row)))));
  const variants={
    "cleared source":row => row.inputs.slice(1),
    "cleared artifact":row => row.inputs.slice(0,1),
    extra:row => [...row.inputs,unexpected],
    duplicate:row => [...row.inputs,row.inputs[0]],
    reordered:row => [...row.inputs].reverse(),
  };
  for (const [name,rewrite] of Object.entries(variants)) {
    await t.test(name,async () => {
      await assert.rejects(runFeatureCommand(
        parsedCommand("feature.status"),
        featureServices(rewrittenStateInputStore(store,rewrite),input),
      ),error => new Set(["DESIGN_STATE_INVALID","INPUT_STALE"]).has(error?.code));
    });
  }
});

test("feature prepare detects a stale exact base and never rewrites project artifacts",{
  skip:!commandsAvailable,
},async t => {
  const {store,project}=await readyProject(t);
  const input=featureCommandInput();
  await runFeatureCommand(
    parsedCommand("feature.add",{from:"feature.json"}),
    featureServices(store,input),
  );

  const current=project.artifacts.pm_analysis;
  const next=clone(current);
  next.revision=current.revision+1;
  next.parents=[artifactReference(current)];
  next.created_at="2026-08-18T10:00:00.000Z";
  next.content.summary=`${next.content.summary} Updated.`;
  rehash(next);
  await store.append(next);

  await assert.rejects(
    runFeatureCommand(
      parsedCommand("feature.prepare",{continue:true}),
      featureServices(store,input),
    ),
    error => error?.code==="STALE_FEATURE_BASE" && error?.exitCode===6,
  );
  const pmRows=await store.list({document_type:"pm-analysis"});
  assert.equal(pmRows.length,2);
});

test("feature prepare persists an auditable blocked delta and automation exits nonzero",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput({findings:[{
    id:"FEATURE-FINDING-001",
    severity:"P2",
    owner:"ARCHITECT",
    message:"A new externally visible delivery guarantee needs an ADR.",
  }]});
  const interactive=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),
    featureServices(store,input),
  );
  assert.equal(interactive.ready,false);
  assert.equal(interactive.blocking_owner,"ARCHITECT");
  assert.equal(interactive.artifact.content.audit.status,"FAIL");

  const automation=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json",nonInteractive:true}),
    featureServices(store,input),
  );
  assert.equal(automation.blocked,true);
  assert.equal(automation.command_exit_code,4);
  assert.deepEqual(automation.findings,interactive.artifact.content.readiness.failures);
});

test("feature prepare recovers from interruption without ambiguous revision forks",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput();
  await runFeatureCommand(
    parsedCommand("feature.add",{from:"feature.json"}),
    featureServices(store,input),
  );
  let appends=0;
  const interrupted={
    list:store.list,
    get:store.get,
    verify:store.verify,
    append:async artifact => {
      appends+=1;
      if (appends===1) throw new Error("feature append interrupted");
      return store.append(artifact);
    },
  };
  await assert.rejects(
    runFeatureCommand(
      parsedCommand("feature.prepare",{from:"feature.json"}),
      featureServices(interrupted,input),
    ),
    /feature append interrupted/,
  );
  const resumed=await runFeatureCommand(
    parsedCommand("feature.prepare",{continue:true}),
    featureServices(store,input),
  );
  assert.equal(resumed.stage,"PREPARED");
  assert.ok(resumed.reused_revisions.length>0);
});

test("a prepared feature delta is durable and verifiable in the real artifact store",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t,{real:true});
  const result=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),
    featureServices(store,featureCommandInput()),
  );
  const verified=await store.verify(artifactReference(result.artifact));
  assert.equal(verified.document_type,"feature-delta");
  assert.equal(verified.content.stage,"PREPARED");
  assert.equal(verified.content.base_project.authority,"reference-only");
});

test("feature input and service boundaries reject stale source and accessors without calls",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput();
  let getterReads=0;
  const services={artifactStore:store};
  Object.defineProperty(services,"readInput",{
    enumerable:true,
    get() {
      getterReads+=1;
      return async () => JSON.stringify(input);
    },
  });
  await assert.rejects(
    runFeatureCommand(
      parsedCommand("feature.add",{from:"feature.json"}),
      services,
    ),
    /accessor|canonical|service/i,
  );
  assert.equal(getterReads,0);

  const stale=clone(input);
  stale.provenance.source_sha256="c".repeat(64);
  await runFeatureCommand(
    parsedCommand("feature.add",{from:"feature.json"}),
    featureServices(store,input),
  );
  await assert.rejects(
    runFeatureCommand(
      parsedCommand("feature.analyze",{from:"feature.json"}),
      featureServices(store,stale),
    ),
    error => error?.code==="STALE_FEATURE_SOURCE" && error?.exitCode===6,
  );
});

test("feature source content cannot drift under one immutable source identity",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput();
  await runFeatureCommand(
    parsedCommand("feature.add",{from:"feature.json"}),featureServices(store,input),
  );
  const drifted=clone(input);
  drifted.request.summary="Materially different request under the same source hash.";
  const before=await store.list({document_type:"feature-delta"});
  await assert.rejects(
    runFeatureCommand(
      parsedCommand("feature.analyze",{from:"feature.json"}),
      featureServices(store,drifted),
    ),
    error => error?.code==="STALE_FEATURE_SOURCE" && error?.exitCode===6,
  );
  assert.deepEqual(await store.list({document_type:"feature-delta"}),before);
});

test("requires_adr independently blocks and noninteractive JSON retains findings",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput();
  input.architecture_impact.requires_adr=true;
  const interactive=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),featureServices(store,input),
  );
  assert.equal(interactive.ready,false);
  assert.equal(interactive.blocking_owner,"ARCHITECT");
  assert.equal(interactive.artifact.content.readiness.failures[0].id,"FEATURE-ADR-REQUIRED");

  const dispatched=await dispatchCommand(
    parsedCommand("feature.prepare",{from:"feature.json",nonInteractive:true}),
    {services:featureServices(store,input)},
  );
  assert.equal(dispatched.exitCode,4);
  assert.equal(dispatched.result.ok,true);
  assert.equal(dispatched.result.data.blocked,true);
  assert.deepEqual(
    dispatched.result.data.findings,
    interactive.artifact.content.readiness.failures,
  );
});

test("noninteractive feature blocking is exit 4 command-result data with findings",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput({findings:[{
    id:"FEATURE-FINDING-STRUCTURED",
    severity:"P2",
    owner:"ARCHITECT",
    message:"Architecture approval is required.",
  }]});
  const dispatched=await dispatchCommand(
    parsedCommand("feature.prepare",{from:"feature.json",nonInteractive:true}),
    {services:featureServices(store,input)},
  );
  assert.equal(dispatched.exitCode,4);
  assert.equal(dispatched.result.schema_version,"command-result.v1");
  assert.equal(dispatched.result.ok,true);
  assert.equal(dispatched.result.data.blocked,true);
  assert.deepEqual(dispatched.result.data.findings,input.findings);
});

test("feature status rejects rehashed derived readiness that contradicts its source",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const prepared=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),
    featureServices(store,featureCommandInput()),
  );
  const forged=clone(prepared.artifact);
  forged.content.architecture_impact.requires_adr=true;
  rehash(forged);
  const forgedReference=artifactReference(forged);
  const isForged=reference =>
    reference.document_type===forgedReference.document_type &&
    reference.artifact_id===forgedReference.artifact_id &&
    reference.revision===forgedReference.revision &&
    reference.content_sha256===forgedReference.content_sha256;
  const hostile={
    append:store.append,
    list:async filter => (await store.list(filter)).map(row =>
      row.document_type==="feature-delta" ? clone(forged) : row),
    get:async reference => isForged(reference) ? clone(forged) : store.get(reference),
    verify:async reference => isForged(reference) ? clone(forged) : store.verify(reference),
  };
  await assert.rejects(
    runFeatureCommand(
      parsedCommand("feature.status"),featureServices(hostile,featureCommandInput()),
    ),
    error => error?.code==="AMBIGUOUS_FEATURE_HISTORY" ||
      error?.code==="FEATURE_BLOCKED",
  );
});

test("feature status fails closed for missing, duplicate, and ambiguous identities",{
  skip:!commandsAvailable,
},async t => {
  const missing=await readyProject(t);
  await assert.rejects(
    runFeatureCommand(
      parsedCommand("feature.status"),featureServices(missing.store,featureCommandInput()),
    ),
    error => error?.code==="FEATURE_INPUT_REQUIRED",
  );

  const ambiguous=await readyProject(t);
  await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature-1.json"}),
    featureServices(ambiguous.store,featureCommandInput()),
  );
  const second=featureCommandInput();
  second.feature_id="FEATURE-002";
  await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature-2.json"}),
    featureServices(ambiguous.store,second),
  );
  await assert.rejects(
    runFeatureCommand(
      parsedCommand("feature.status"),featureServices(ambiguous.store,second),
    ),
    error => error?.code==="AMBIGUOUS_FEATURE_HISTORY",
  );

  const rows=await ambiguous.store.list();
  const duplicate={
    append:ambiguous.store.append,
    get:ambiguous.store.get,
    verify:ambiguous.store.verify,
    list:async filter => {
      const listed=await ambiguous.store.list(filter);
      const delta=listed.find(row => row.document_type==="feature-delta");
      return delta ? [...listed,clone(delta)] : listed;
    },
  };
  assert.ok(rows.some(row => row.document_type==="feature-delta"));
  await assert.rejects(
    runFeatureCommand(parsedCommand("feature.status"),featureServices(duplicate,second)),
    error => error?.code==="DUPLICATE_REVISION_IDENTITY",
  );
});

test("feature prepare uses bounded command-scoped store verification",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const counted=countedCommandStore(store);
  const result=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),
    featureServices(counted.store,featureCommandInput()),
  );
  assert.equal(result.stage,"PREPARED");
  assert.ok(
    counted.calls.list<=3 && counted.calls.get<=15 && counted.calls.verify<=15,
    `feature prepare store amplification: ${JSON.stringify(counted.calls)}`,
  );
  assert.equal(counted.calls.append,3);
});

test("feature status verifies two bounded base catalog generations",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),
    featureServices(store,featureCommandInput()),
  );
  const counted=countedCommandStore(store);
  const result=await runFeatureCommand(
    parsedCommand("feature.status"),featureServices(counted.store,featureCommandInput()),
  );
  assert.equal(result.stage,"PREPARED");
  assert.equal(counted.calls.list,2);
  assert.ok(
    counted.calls.get<=15 && counted.calls.verify<=15,
    `feature status store amplification: ${JSON.stringify(counted.calls)}`,
  );
  assert.equal(counted.calls.append,0);
});
