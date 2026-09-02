import assert from "node:assert/strict";
import test from "node:test";

import {sha256Canonical} from "../src/contracts/acp.js";
import {dispatchCoreCommand,parseCoreCommand} from "../src/core/commands/router.js";
import {CoreConflictError} from "../src/core/errors.js";
import {createOperationIntent} from "../src/core/operations/plan.js";
import {createOperationRunner} from "../src/core/operations/runner.js";
import {
  activationOperations,
  releasePlanOperations,
  releaseStatusResult,
} from "../src/core/release/operations.js";

const CONTROL_REPOSITORY="TOSS-Soft/toss-os-control";
const REPOSITORY="TOSS-Soft/toss-cli";
const CONSOLE="TOSS-Soft/toss-console";
const NOW="2026-09-03T08:00:00.000Z";

function organization() {
  return {
    schema_version:"organization-config.v1",organization:"TOSS-Soft",
    project:{node_id:"PVT_TOSS_OS_2",number:2},control_repository:CONTROL_REPOSITORY,
    policy_revision:"POLICY-0001",repositories:[REPOSITORY],
  };
}

function repositoryConfiguration() {
  return {
    schema_version:"repository-config.v1",repository:REPOSITORY,
    repository_node_id:"R_toss_cli",default_branch:"main",active_release:null,
    project_item_id:"PVTI_toss_cli",project_fields:{status:"Status",gate:"Gate"},
    registered_at:"2026-09-01T08:00:00.000Z",
  };
}

function configuredRepository(repository,number) {
  return {...repositoryConfiguration(),repository,repository_node_id:`R_${number}`,
    project_item_id:`PVTI_${number}`};
}

function releasePlanBody(revision) {
  return {
    kind:"release-plan",control_revision:revision,
    candidates:[{
      id:`${REPOSITORY}#10`,repository:REPOSITORY,approved:true,version:null,
      decomposed:true,priority:10,risk:"medium",outcome:"organizational-lifecycle",
      change_class:"backward_compatible_feature",dependencies:[],
    }],
    completed:[],
    repositories:[{repository:REPOSITORY,latest_published_version:"2.1.2"}],
  };
}

function epicWork() {
  return {
    schema_version:"work-state-snapshot.v1",
    item:{
      schema_version:"work-item.v1",id:`${REPOSITORY}#10`,repository:REPOSITORY,
      issue_number:10,kind:"epic",parent_id:null,branch:"epic/10-organizational-lifecycle",
      base_branch:null,milestone:null,status:"Backlog",gate:"RELEASE_PLANNING",
    },
    issue_state:"OPEN",drifted:false,epic_required:false,prepared:true,
    scope_approved:true,parent:null,
    release:{assigned:false,active:false,id:null,repository:null,branch:null,milestone:null,revision:null},
    blocking_dependencies:[],children_complete:false,
    physical_branch:{exists:false,head_sha:null},pull_request:null,review:null,checks:null,
    authority:{epic_acceptance_required:false,release_approval_required:false},
    project:{
      project_id:"PVT_TOSS_OS_2",item_id:"PVTI_epic_10",revision:"project-1",
      fields:{Status:"Backlog",Gate:"RELEASE_PLANNING",repository:REPOSITORY,
        parent:null,milestone:null,branch:"epic/10-organizational-lifecycle",base_branch:null,
        last_reconciled_at:"2026-09-01T08:00:00.000Z"},
    },
  };
}

function childWork({blocking=[]}={}) {
  return {
    schema_version:"work-state-snapshot.v1",
    item:{
      schema_version:"work-item.v1",id:`${REPOSITORY}#11`,repository:REPOSITORY,
      issue_number:11,kind:"issue",parent_id:`${REPOSITORY}#10`,
      acceptance_criteria:["The child remains governed by its epic."],
      branch:"issue/11-governed-child",base_branch:"epic/10-organizational-lifecycle",
      milestone:null,status:"Backlog",gate:"RELEASE_PLANNING",
    },
    issue_state:"OPEN",drifted:false,epic_required:false,prepared:null,
    scope_approved:null,parent:{id:`${REPOSITORY}#10`,branch:"epic/10-organizational-lifecycle",revision:"issue-10-1"},
    release:{assigned:false,active:false,id:null,repository:null,branch:null,milestone:null,revision:null},
    blocking_dependencies:blocking,children_complete:null,
    physical_branch:{exists:false,head_sha:null},pull_request:null,review:null,checks:null,
    authority:{epic_acceptance_required:false,release_approval_required:false},
    project:{
      project_id:"PVT_TOSS_OS_2",item_id:"PVTI_issue_11",revision:"project-1",
      fields:{Status:"Backlog",Gate:"RELEASE_PLANNING",repository:REPOSITORY,
        parent:`${REPOSITORY}#10`,milestone:null,branch:"issue/11-governed-child",
        base_branch:"epic/10-organizational-lifecycle",last_reconciled_at:"2026-09-01T08:00:00.000Z"},
    },
  };
}

function activationBody(state,program) {
  return {
    kind:"release-activation",control_revision:state.revision,
    program_id:program.program_id,program_revision:program.revision,
    project:{id:"PVT_TOSS_OS_2",revision:"project-1"},
    repositories:[{
      repository:REPOSITORY,repository_revision:"repository-1",
      default_branch:{name:"main",revision:"main-1",head_sha:"a".repeat(40)},
      milestone:null,release_branch:null,release_pull_request:null,
      comparison:{base_sha:"a".repeat(40),head_sha:"a".repeat(40),material_difference:false},
      governed_children:[{epic_id:`${REPOSITORY}#10`,epic_revision:"issue-10-1",child_ids:[]}],
      work_items:[{id:`${REPOSITORY}#10`,kind:"epic",revision:"issue-10-1",work:epicWork()}],
    }],
  };
}

function statusBody(state,kind,programs) {
  return {
    kind,control_revision:state.revision,
    program_revisions:programs.map(program => ({program_id:program.program_id,revision:program.revision})),
    project:{id:"PVT_TOSS_OS_2",revision:"project-2"},
    repositories:programs.flatMap(program => program.repository_releases.map(release => ({
      program_id:program.program_id,repository:release.repository,
      repository_revision:"repository-2",release_id:release.release_id,
      release_revision:release.revision,
      milestone:release.milestone===null ? null : {title:release.milestone,state:"OPEN",revision:"milestone-1"},
      branch:release.branch===null ? null : {name:release.branch,base_branch:"main",head_sha:"a".repeat(40),revision:"branch-1"},
      release_pull_request:null,
      scope:program.selected_scope.filter(value => release.scope.includes(value.epic_id)),
      gates:[{name:"release-approval",status:"BLOCKED"}],checks:[],patch_link:null,
    }))),
  };
}

function epicFor(repository,number) {
  const value=epicWork();
  value.item.id=`${repository}#${number}`;
  value.item.repository=repository;
  value.item.issue_number=number;
  value.item.branch=`epic/${number}-release-track`;
  value.project.item_id=`PVTI_epic_${number}`;
  value.project.fields.repository=repository;
  value.project.fields.branch=value.item.branch;
  return value;
}

function activationRepository(repository,number,sha) {
  return {
    repository,repository_revision:`repository-${number}`,
    default_branch:{name:"main",revision:`main-${number}`,head_sha:sha},
    milestone:null,release_branch:null,release_pull_request:null,
    comparison:{base_sha:sha,head_sha:sha,material_difference:false},
    governed_children:[{epic_id:`${repository}#${number}`,
      epic_revision:`issue-${number}-1`,child_ids:[]}],
    work_items:[{id:`${repository}#${number}`,kind:"epic",revision:`issue-${number}-1`,
      work:epicFor(repository,number)}],
  };
}

function signedActivation(state,program,repositories) {
  const body={kind:"release-activation",control_revision:state.revision,
    program_id:program.program_id,program_revision:program.revision,
    project:{id:"PVT_TOSS_OS_2",revision:"project-stage"},repositories};
  return {...body,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
    sha256:sha256Canonical({control:state,github:body})}};
}

function memoryReleaseControl() {
  let revisionNumber=1;
  let revision=`control-${revisionNumber}`;
  let programs=[];
  const intents=[];
  const receipts=[];
  const events=[];
  const state=() => ({
    revision,organization:organization(),repositories:[repositoryConfiguration()],
    programs:structuredClone(programs),intents:structuredClone(intents),
    receipts:structuredClone(receipts),
  });
  return Object.freeze({
    events,
    async head() { return revision; },
    async loadReleasePlanningState() { return state(); },
    async findIntent(intent) {
      return intents.find(value => value.intent_id===intent.intent_id) ?? null;
    },
    async findReceipt(intent) {
      return receipts.find(value => value.intent_id===intent.intent_id) ?? null;
    },
    async commitIntent({expectedHead,intent}) {
      assert.equal(expectedHead,revision);
      intents.push(structuredClone(intent));
      events.push({kind:"intent",value:structuredClone(intent)});
      revision=`control-${++revisionNumber}`;
      return {commit_sha:revision};
    },
    async commitReceipt({expectedHead,receipt}) {
      assert.equal(expectedHead,revision);
      receipts.push(structuredClone(receipt));
      events.push({kind:"receipt",value:structuredClone(receipt)});
      revision=`control-${++revisionNumber}`;
      return {commit_sha:revision};
    },
    async inspectReleaseProgramOperation(operation) {
      const current=programs.find(value => value.program_id===operation.payload.program.program_id);
      return {operation_id:operation.operation_id,repository:CONTROL_REPOSITORY,
        revision:current?.revision ?? null};
    },
    async commitReleaseProgramReceipt({expectedHead,operation,receipt}) {
      assert.equal(expectedHead,revision);
      assert.equal(operation.payload.kind,"release-program-manifest");
      programs=programs.filter(value => value.program_id!==operation.payload.program.program_id);
      programs.push(structuredClone(operation.payload.program));
      receipts.push(structuredClone(receipt));
      events.push({kind:"program-receipt",value:{operation:structuredClone(operation),receipt:structuredClone(receipt)}});
      revision=`control-${++revisionNumber}`;
      return {commit_sha:revision};
    },
    view() { return structuredClone(state()); },
    advance() {
      revision=`control-${++revisionNumber}`;
      events.push({kind:"external-advance"});
    },
    failLastReleaseReceipt() {
      assert.ok(receipts.length>0);
      receipts[receipts.length-1]={...receipts.at(-1),status:"failed"};
    },
  });
}

function releaseHarness() {
  const control=memoryReleaseControl();
  const calls=[];
  let failureMode=null;
  const github=Object.freeze({
    async snapshot(query) {
      calls.push({method:"snapshot",query:structuredClone(query)});
      const selectedPrograms=query.kind==="program-status" ? query.programs :
        query.program===null || query.program===undefined ? [] : [query.program];
      const planning={revision:query.control_revision};
      const body=query.kind==="release-plan" ? releasePlanBody(query.control_revision) :
        query.kind==="release-activation"
          ? activationBody(planning,query.program)
          : statusBody(planning,query.kind,selectedPrograms);
      if (failureMode==="source-race") control.advance();
      return body;
    },
    async inspect(operations) {
      calls.push({method:"inspect",operations:structuredClone(operations)});
      return operations.map(operation => ({operation_id:operation.operation_id,
        repository:operation.repository,revision:failureMode==="stale" &&
          operation.payload.kind==="release-branch"
          ? "stale-revision" : operation.expected_revision}));
    },
    async apply(operations) {
      calls.push({method:"apply",operations:structuredClone(operations)});
      if (failureMode==="partial") return {status:"failed",observed_revisions:operations.slice(0,1).map(operation => ({
        operation_id:operation.operation_id,repository:operation.repository,revision:`applied-${operation.operation_id}`,
      }))};
      if (failureMode==="control-race") control.advance();
      return {status:"completed",observed_revisions:operations.map(operation => ({
        operation_id:operation.operation_id,repository:operation.repository,
        revision:`applied-${operation.operation_id}`,
      }))};
    },
  });
  let sequence=0;
  const runner=createOperationRunner({
    control,github,authorityRegistry:{keys:[]},clock:() => NOW,
    idGenerator:kind => {
      sequence+=1;
      const prefix=kind==="intent" ? "INTENT" : "RECEIPT";
      return `${prefix}-20260903-${String(sequence).padStart(4,"0")}`;
    },
    policyRevision:() => "POLICY-0001",
  });
  const services=Object.freeze({control,github,operations:runner,clock:() => NOW});
  return {calls,control,services,setFailureMode(value) { failureMode=value; }};
}

test("Release Program commands are routed to built-in handlers",async () => {
  const commands=[
    ["release","plan"],
    ["release","activate","TOSS-OS-R0001"],
    ["release","status","TOSS-Soft/toss-cli"],
    ["program","status"],
  ];

  for (const argv of commands) {
    const result=await dispatchCoreCommand(parseCoreCommand(argv),{services:{}});
    assert.notEqual(
      result.result.error?.code,
      "COMMAND_NOT_IMPLEMENTED",
      `${argv.join(" ")} has no built-in route`,
    );
  }
});

test("release plan previews and atomically persists an exact Task 3 Draft through the real runner",async () => {
  const {calls,control,services}=releaseHarness();

  const preview=await dispatchCoreCommand(parseCoreCommand(["release","plan"]),{services});
  assert.equal(preview.exitCode,0,JSON.stringify(preview.result.error));
  assert.equal(preview.result.data.schema_version,"operation-preview.v1");
  assert.deepEqual(preview.result.data.operations.map(value => value.payload.kind),[
    "release-program-manifest",
  ]);
  assert.equal(preview.result.data.operations[0].payload.program.program_id,"TOSS-OS-R0001");
  assert.equal(preview.result.data.operations[0].payload.program.phase,"DRAFT");
  assert.equal(preview.result.data.operations[0].payload.program.rationale[0].version,"2.2.0");
  assert.equal(control.events.length,0);
  assert.deepEqual(calls.map(value => value.method),["snapshot"]);
  assert.equal(calls[0].query.organization.control_repository,CONTROL_REPOSITORY);
  assert.deepEqual(calls[0].query.repositories.map(value => value.repository),[REPOSITORY]);
  assert.deepEqual(calls[0].query.programs,[]);

  const applied=await dispatchCoreCommand(
    parseCoreCommand(["release","plan","--apply","--non-interactive"]),
    {services},
  );
  assert.equal(applied.exitCode,0);
  assert.equal(applied.result.data.status,"completed");
  assert.equal(control.view().programs[0].program_id,"TOSS-OS-R0001");
  assert.equal(control.view().programs[0].revision,"REV-0001");
  assert.deepEqual(control.events.map(value => value.kind),["intent","program-receipt"]);
  assert.deepEqual(calls.map(value => value.method),["snapshot","snapshot"]);
});

test("repeated planning reuses the current record and promotes Waiting without allocating an id",async () => {
  const repeated=releaseHarness();
  await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply","--non-interactive"]),{
    services:repeated.services,
  });
  const beforeEvents=repeated.control.events.length;
  const replay=await dispatchCoreCommand(parseCoreCommand([
    "release","plan","--apply","--non-interactive",
  ]),{services:repeated.services});
  assert.equal(replay.exitCode,0,JSON.stringify(replay.result.error));
  assert.equal(replay.result.data.status,"already-reconciled");
  assert.equal(repeated.control.events.length,beforeEvents);
  assert.equal(repeated.control.view().programs.length,1);

  const base={revision:"control-waiting",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[],intents:[],receipts:[]};
  const emptyBody={kind:"release-plan",control_revision:base.revision,candidates:[],completed:[],
    repositories:[{repository:REPOSITORY,latest_published_version:"2.1.2"}]};
  const waiting=releasePlanOperations({planningState:base,snapshot:{...emptyBody,source:{
    repository:CONTROL_REPOSITORY,revision:base.revision,
    sha256:sha256Canonical({control:base,github:emptyBody})}},clock:() => NOW}).program;
  assert.equal(waiting.phase,"WAITING_FOR_EPIC");
  const nextState={...base,revision:"control-waiting-2",programs:[waiting]};
  const eligibleBody=releasePlanBody(nextState.revision);
  const promoted=releasePlanOperations({planningState:nextState,snapshot:{...eligibleBody,source:{
    repository:CONTROL_REPOSITORY,revision:nextState.revision,
    sha256:sha256Canonical({control:nextState,github:eligibleBody})}},clock:() => NOW});
  assert.equal(promoted.program.program_id,waiting.program_id);
  assert.equal(promoted.program.revision,"REV-0002");
  assert.equal(promoted.program.phase,"DRAFT");
  assert.equal(promoted.operations[0].expected_revision,"REV-0001");
});

test("release activate materializes exact identities and Work projections in dependency order",async () => {
  const {calls,control,services}=releaseHarness();
  const planned=await dispatchCoreCommand(
    parseCoreCommand(["release","plan","--apply","--non-interactive"]),{services},
  );
  assert.equal(planned.exitCode,0);
  const beforePreviewEvents=control.events.length;

  const preview=await dispatchCoreCommand(
    parseCoreCommand(["release","activate","TOSS-OS-R0001",REPOSITORY]),{services},
  );
  assert.equal(preview.exitCode,0,JSON.stringify(preview.result.error));
  assert.equal(preview.result.data.schema_version,"operation-preview.v1");
  assert.deepEqual(preview.result.data.operations.map(value => value.payload.kind),[
    "release-milestone","release-branch","release-program-manifest",
    "release-assignment","release-epic-branch","release-project-state",
  ]);
  const previewProgram=preview.result.data.operations
    .find(value => value.payload.kind==="release-program-manifest").payload.program;
  assert.equal(previewProgram.phase,"ACTIVE");
  assert.equal(previewProgram.revision,"REV-0002");
  assert.equal(previewProgram.repository_releases[0].version,"2.2.0");
  assert.equal(previewProgram.repository_releases[0].milestone,"v2.2.0");
  assert.equal(previewProgram.repository_releases[0].branch,"release/v2.2.0");
  const activationQuery=calls.find(value => value.method==="snapshot" &&
    value.query.kind==="release-activation").query;
  assert.equal(activationQuery.program.revision,"REV-0001");
  assert.equal(activationQuery.repository_configurations[0].repository,REPOSITORY);
  assert.equal(activationQuery.project.node_id,"PVT_TOSS_OS_2");
  assert.equal(control.events.length,beforePreviewEvents);
  assert.equal(calls.filter(value => ["inspect","apply"].includes(value.method)).length,0);

  const applied=await dispatchCoreCommand(
    parseCoreCommand(["release","activate","TOSS-OS-R0001",REPOSITORY,"--apply","--non-interactive"]),
    {services},
  );
  assert.equal(applied.exitCode,0);
  assert.equal(applied.result.data.status,"completed");
  const stored=control.view().programs[0];
  assert.equal(stored.phase,"ACTIVE");
  assert.equal(stored.repository_releases[0].phase,"ACTIVE");
  assert.equal(stored.repository_releases[0].transitions[0].source_receipt,
    applied.result.data.receipt_id);
  const remoteApply=calls.findLast(value => value.method==="apply");
  assert.deepEqual(remoteApply.operations.map(value => value.payload.kind),[
    "release-milestone","release-branch","release-assignment",
    "release-epic-branch","release-project-state",
  ]);
  assert.equal(remoteApply.operations.some(value => value.payload.kind==="release-pull-request"),false);
  const project=remoteApply.operations.find(value => value.payload.kind==="release-project-state");
  assert.equal(project.payload.fields.Status,"Blocked");
  assert.equal(project.payload.fields.Gate,"DEPENDENCY_REQUIRED");
});

test("release and program status return frozen aggregate projections without runner writes",async () => {
  const {calls,control,services}=releaseHarness();
  await dispatchCoreCommand(
    parseCoreCommand(["release","plan","--apply","--non-interactive"]),{services},
  );
  await dispatchCoreCommand(
    parseCoreCommand(["release","activate","TOSS-OS-R0001",REPOSITORY,"--apply","--non-interactive"]),
    {services},
  );
  const beforeEvents=control.events.length;
  const beforeMutations=calls.filter(value => ["inspect","apply"].includes(value.method)).length;

  const release=await dispatchCoreCommand(
    parseCoreCommand(["release","status",REPOSITORY]),{services},
  );
  assert.equal(release.exitCode,0,JSON.stringify(release.result.error));
  assert.equal(release.result.data.kind,"release-status");
  assert.equal(release.result.data.program.id,"TOSS-OS-R0001");
  assert.equal(release.result.data.track.version,"2.2.0");
  assert.equal(release.result.data.track.branch,"release/v2.2.0");
  assert.equal(release.result.data.scope[0].epic_id,`${REPOSITORY}#10`);
  assert.equal(release.result.data.gates[0].status,"BLOCKED");
  assert.equal(release.result.data.patch_link,null);
  assert.equal(release.result.data.next_command,`toss-core epic status ${REPOSITORY}#10`);
  const releaseQuery=calls.find(value => value.method==="snapshot" &&
    value.query.kind==="release-status").query;
  assert.equal(releaseQuery.program.program_id,"TOSS-OS-R0001");
  assert.equal(releaseQuery.release.repository,REPOSITORY);
  assert.equal(releaseQuery.repository_configuration.repository,REPOSITORY);
  assert.equal(releaseQuery.project.node_id,"PVT_TOSS_OS_2");

  const program=await dispatchCoreCommand(
    parseCoreCommand(["program","status","TOSS-OS-R0001"]),{services},
  );
  assert.equal(program.exitCode,0,JSON.stringify(program.result.error));
  assert.equal(program.result.data.kind,"program-status");
  assert.equal(program.result.data.programs.length,1);
  assert.equal(program.result.data.programs[0].tracks[0].repository,REPOSITORY);
  assert.deepEqual(program.result.data.programs[0].dependency_stages,[{
    stage:1,repository_release_ids:[control.view().programs[0].repository_releases[0].release_id],
  }]);
  const programQuery=calls.find(value => value.method==="snapshot" &&
    value.query.kind==="program-status").query;
  assert.equal(programQuery.programs[0].program_id,"TOSS-OS-R0001");
  assert.equal(programQuery.repository_configurations[0].repository,REPOSITORY);
  assert.equal(control.events.length,beforeEvents);
  assert.equal(calls.filter(value => ["inspect","apply"].includes(value.method)).length,beforeMutations);
  assert.equal(Object.isFrozen(release),true);
  assert.equal(Object.isFrozen(program),true);
});

test("release planning increments arbitrary-width program identities without numeric truncation",() => {
  const existingId="TOSS-OS-R900719925474099312345";
  const initial=twoRepositoryDraft();
  const activated=activationOperations({planningState:initial.state,
    programId:initial.program.program_id,repository:REPOSITORY,
    snapshot:signedActivation(initial.state,initial.program,[
      activationRepository(REPOSITORY,10,"a".repeat(40)),
    ]),receiptId:"RECEIPT-20260903-7000",clock:() => NOW}).program;
  const idMap=new Map();
  const releases=activated.repository_releases.map(release => {
    const releaseId=release.release_id.replace(activated.program_id,existingId);
    idMap.set(release.release_id,releaseId);
    return {...release,program_id:existingId,release_id:releaseId};
  });
  const existing={...activated,program_id:existingId,repository_releases:releases,
    dependency_stages:activated.dependency_stages.map(stage => ({...stage,
      repository_release_ids:stage.repository_release_ids.map(id => idMap.get(id))}))};
  const state={
    revision:"control-big",organization:{...organization(),repositories:[REPOSITORY,CONSOLE]},
    repositories:[configuredRepository(REPOSITORY,10),configuredRepository(CONSOLE,20)],
    programs:[existing],
    intents:[],receipts:[],
  };
  const body={...releasePlanBody(state.revision),repositories:[
    {repository:REPOSITORY,latest_published_version:"2.1.2"},
    {repository:CONSOLE,latest_published_version:"1.3.2"},
  ]};
  const snapshot={...body,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
    sha256:sha256Canonical({control:state,github:body})}};

  const decision=releasePlanOperations({planningState:state,snapshot,clock:() => NOW});
  assert.equal(decision.program.program_id,"TOSS-OS-R900719925474099312346");
});

test("an unresolved failed release receipt blocks a new identity before another snapshot",async () => {
  const {calls,control,services}=releaseHarness();
  const planned=await dispatchCoreCommand(
    parseCoreCommand(["release","plan","--apply","--non-interactive"]),{services},
  );
  assert.equal(planned.exitCode,0);
  control.failLastReleaseReceipt();
  const before=calls.length;

  const blocked=await dispatchCoreCommand(parseCoreCommand(["release","plan"]),{services});
  assert.equal(blocked.exitCode,4);
  assert.equal(blocked.result.error.code,"CORE_BLOCKED");
  assert.equal(calls.length,before);
});

test("activation ignores failed evidence that affects neither its program nor repository",async () => {
  const initial=twoRepositoryDraft();
  const intent=createOperationIntent({
    intent_id:"INTENT-20260903-8000",created_at:NOW,command:"release.activate",
    policy_revision:"POLICY-0001",
    source:{repository:CONTROL_REPOSITORY,revision:initial.state.revision,sha256:"c".repeat(64)},
    authority:null,
    operations:[{resource:"pull_request",action:"create",repository:"TOSS-Soft/unrelated",
      expected_revision:"unrelated-1",payload:{kind:"release-pull-request",
        program_id:"TOSS-OS-R9999",release_id:"REL-TOSS-OS-R9999-unrelated"}}],
  });
  const receipt={
    schema_version:"operation-receipt.v1",document_type:"operation-receipt",
    receipt_id:"RECEIPT-20260903-8000",intent_id:intent.intent_id,
    intent_sha256:sha256Canonical(intent),created_at:NOW,status:"failed",observed_revisions:[],
  };
  const state={...initial.state,intents:[intent],receipts:[receipt]};
  const snapshot=signedActivation(state,initial.program,[
    activationRepository(REPOSITORY,10,"a".repeat(40)),
  ]);
  const {source:_source,...githubSnapshot}=snapshot;
  const result=await dispatchCoreCommand(parseCoreCommand([
    "release","activate",initial.program.program_id,REPOSITORY,
  ]),{services:{
    control:{async loadReleasePlanningState() { return state; }},
    github:{async snapshot() { return githubSnapshot; }},
    operations:{reserveReceiptId() { return "RECEIPT-20260903-8001"; },
      async execute(request) { return request.operations; }},
    clock:() => NOW,
  }});
  assert.equal(result.exitCode,0,JSON.stringify(result.result.error));
});

test("release dry-run and interactive confirmation preserve shared runner safety",async () => {
  const dry=releaseHarness();
  const dryRun=await dispatchCoreCommand(parseCoreCommand(["release","plan","--dry-run"]),{
    services:dry.services,
  });
  assert.equal(dryRun.exitCode,0);
  assert.equal(dryRun.result.data.schema_version,"operation-preview.v1");
  assert.equal(dry.control.events.length,0);
  assert.equal(dry.calls.some(value => ["inspect","apply"].includes(value.method)),false);

  const interactive=releaseHarness();
  const prompts=[];
  const applied=await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply"]),{
    services:interactive.services,
    confirm:async preview => { prompts.push(preview); return true; },
  });
  assert.equal(applied.exitCode,0,JSON.stringify(applied.result.error));
  assert.equal(prompts.length,1);
  assert.equal(prompts[0].command,"release.plan");
  assert.deepEqual(interactive.control.events.map(value => value.kind),[
    "intent","program-receipt",
  ]);
});

test("matching release resources are idempotent, while same-version milestone drift conflicts",async () => {
  const {control,services}=releaseHarness();
  await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply","--non-interactive"]),{services});
  const state=control.view();
  const program=state.programs[0];
  const matching=activationBody(state,program);
  matching.repositories[0].release_branch={
    name:"release/v2.2.0",base_branch:"main",head_sha:"a".repeat(40),revision:"branch-1",
  };
  const matchingSnapshot={...matching,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
    sha256:sha256Canonical({control:state,github:matching})}};
  const decision=activationOperations({planningState:state,programId:program.program_id,
    repository:REPOSITORY,snapshot:matchingSnapshot,receiptId:"RECEIPT-20260903-9001",clock:() => NOW});
  assert.equal(decision.operations.some(value => value.payload.kind==="release-branch"),false);
  const epicBranch=decision.operations.find(value => value.payload.kind==="release-epic-branch");
  assert.equal(epicBranch.payload.base_branch,"release/v2.2.0");
  assert.equal(epicBranch.payload.head_sha,"a".repeat(40));

  const createsBranch=activationBody(state,program);
  const createsBranchSnapshot={...createsBranch,source:{repository:CONTROL_REPOSITORY,
    revision:state.revision,sha256:sha256Canonical({control:state,github:createsBranch})}};
  const branchDecision=activationOperations({planningState:state,programId:program.program_id,
    repository:REPOSITORY,snapshot:createsBranchSnapshot,
    receiptId:"RECEIPT-20260903-9002",clock:() => NOW});
  assert.equal(branchDecision.operations.find(value => value.payload.kind==="release-branch")
    .expected_revision,"main-1");

  const staleAssignment=activationBody(state,program);
  staleAssignment.repositories[0].work_items[0].work.release={
    assigned:true,active:true,id:`${REPOSITORY}@release/v2.2.0`,repository:REPOSITORY,
    branch:"release/v2.2.0",milestone:"v2.2.0",revision:"REV-0001",
  };
  staleAssignment.repositories[0].work_items[0].work.item.milestone="v2.2.0";
  staleAssignment.repositories[0].work_items[0].work.item.base_branch="release/v2.2.0";
  staleAssignment.repositories[0].work_items[0].work.physical_branch={
    exists:true,head_sha:"a".repeat(40),
  };
  const staleAssignmentSnapshot={...staleAssignment,source:{repository:CONTROL_REPOSITORY,
    revision:state.revision,sha256:sha256Canonical({control:state,github:staleAssignment})}};
  assert.throws(() => activationOperations({planningState:state,programId:program.program_id,
    repository:REPOSITORY,snapshot:staleAssignmentSnapshot,
    receiptId:"RECEIPT-20260903-9003",clock:() => NOW}),CoreConflictError);

  const drifted=activationBody(state,program);
  drifted.repositories[0].milestone={title:"v2.2.0",state:"CLOSED",revision:"milestone-1"};
  const driftedSnapshot={...drifted,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
    sha256:sha256Canonical({control:state,github:drifted})}};
  assert.throws(() => activationOperations({planningState:state,programId:program.program_id,
    repository:REPOSITORY,snapshot:driftedSnapshot,receiptId:"RECEIPT-20260903-9004",clock:() => NOW}),
  CoreConflictError);
});

test("material comparison emits one Draft release PR after its persisted intent operation",async () => {
  const {control,services}=releaseHarness();
  await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply","--non-interactive"]),{services});
  const state=control.view();
  const program=state.programs[0];
  const impossible=activationBody(state,program);
  impossible.repositories[0].comparison={
    base_sha:"a".repeat(40),head_sha:"b".repeat(40),material_difference:true,
  };
  const impossibleSnapshot={...impossible,source:{repository:CONTROL_REPOSITORY,
    revision:state.revision,sha256:sha256Canonical({control:state,github:impossible})}};
  assert.throws(() => activationOperations({planningState:state,programId:program.program_id,
    repository:REPOSITORY,snapshot:impossibleSnapshot,
    receiptId:"RECEIPT-20260903-9005",clock:() => NOW}),CoreConflictError);

  const body=activationBody(state,program);
  body.repositories[0].release_branch={
    name:"release/v2.2.0",base_branch:"main",head_sha:"b".repeat(40),revision:"branch-2",
  };
  body.repositories[0].comparison={
    base_sha:"a".repeat(40),head_sha:"b".repeat(40),material_difference:true,
  };
  const snapshot={...body,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
    sha256:sha256Canonical({control:state,github:body})}};
  const decision=activationOperations({planningState:state,programId:program.program_id,
    repository:REPOSITORY,snapshot,receiptId:"RECEIPT-20260903-9005",clock:() => NOW});
  const intent=createOperationIntent({
    intent_id:"INTENT-20260903-9005",created_at:NOW,command:"release.activate",
    policy_revision:"POLICY-0001",source:decision.source,authority:null,
    operations:decision.operations,
  });
  assert.deepEqual(intent.operations.map(value => value.payload.kind),[
    "release-milestone","release-program-manifest",
    "release-pull-request","release-assignment","release-epic-branch","release-project-state",
  ]);
  const pullRequest=intent.operations.find(value => value.payload.kind==="release-pull-request");
  assert.equal(pullRequest.payload.draft,true);
  assert.equal(pullRequest.payload.head,"release/v2.2.0");
  assert.equal(pullRequest.payload.base,"main");
  assert.equal(pullRequest.payload.expected_head_revision,"b".repeat(40));
});

test("activation assigns governed children but creates only the epic physical branch",async () => {
  const {control,services}=releaseHarness();
  await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply","--non-interactive"]),{services});
  const state=control.view();
  const program=state.programs[0];
  const body=activationBody(state,program);
  body.repositories[0].work_items.push({
    id:`${REPOSITORY}#11`,kind:"issue",revision:"issue-11-1",work:childWork(),
  });
  body.repositories[0].governed_children[0].child_ids=[`${REPOSITORY}#11`];
  const snapshot={...body,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
    sha256:sha256Canonical({control:state,github:body})}};
  const decision=activationOperations({planningState:state,programId:program.program_id,
    repository:REPOSITORY,snapshot,receiptId:"RECEIPT-20260903-9003",clock:() => NOW});
  assert.deepEqual(decision.operations.filter(value => value.payload.kind==="release-assignment")
    .map(value => value.payload.work_item_id),[`${REPOSITORY}#10`,`${REPOSITORY}#11`]);
  assert.deepEqual(decision.operations.filter(value => value.payload.kind==="release-epic-branch")
    .map(value => value.payload.work_item_id),[`${REPOSITORY}#10`]);
  const childProject=decision.operations.find(value => value.payload.kind==="release-project-state" &&
    value.payload.work_item_id===`${REPOSITORY}#11`);
  assert.equal(childProject.payload.fields.Status,"Ready");
  assert.equal(childProject.payload.fields.Gate,"NONE");
});

test("activation binds Project ownership and exact unique governed-child closure",async () => {
  const {control,services}=releaseHarness();
  await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply","--non-interactive"]),{services});
  const state=control.view();
  const program=state.programs[0];
  const request=body => ({planningState:state,programId:program.program_id,
    repository:REPOSITORY,snapshot:{...body,source:{repository:CONTROL_REPOSITORY,
      revision:state.revision,sha256:sha256Canonical({control:state,github:body})}},
    receiptId:"RECEIPT-20260903-9050",clock:() => NOW});

  const outerProject=activationBody(state,program);
  outerProject.project.id="PVT_OTHER";
  assert.throws(() => activationOperations(request(outerProject)),CoreConflictError);

  const itemProject=activationBody(state,program);
  itemProject.repositories[0].work_items[0].work.project.project_id="PVT_OTHER";
  assert.throws(() => activationOperations(request(itemProject)),CoreConflictError);

  const omitted=activationBody(state,program);
  omitted.repositories[0].governed_children[0].child_ids=[`${REPOSITORY}#11`];
  assert.throws(() => activationOperations(request(omitted)),CoreConflictError);

  const duplicate=activationBody(state,program);
  duplicate.repositories[0].work_items.push(structuredClone(duplicate.repositories[0].work_items[0]));
  assert.throws(() => activationOperations(request(duplicate)),CoreConflictError);
});

test("stale activation preflight performs zero remote writes and partial evidence blocks retry",async () => {
  const sourceRace=releaseHarness();
  await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply","--non-interactive"]),{
    services:sourceRace.services,
  });
  const beforeSourceRace=sourceRace.calls.filter(value => ["inspect","apply"].includes(value.method)).length;
  sourceRace.setFailureMode("source-race");
  const racedSource=await dispatchCoreCommand(parseCoreCommand([
    "release","activate","TOSS-OS-R0001",REPOSITORY,"--apply","--non-interactive",
  ]),{services:sourceRace.services});
  assert.equal(racedSource.exitCode,6);
  assert.equal(sourceRace.calls.filter(value => ["inspect","apply"].includes(value.method)).length,
    beforeSourceRace);
  assert.equal(sourceRace.control.view().programs[0].phase,"DRAFT");

  const stale=releaseHarness();
  await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply","--non-interactive"]),{
    services:stale.services,
  });
  stale.setFailureMode("stale");
  const staleResult=await dispatchCoreCommand(parseCoreCommand([
    "release","activate","TOSS-OS-R0001",REPOSITORY,"--apply","--non-interactive",
  ]),{services:stale.services});
  assert.equal(staleResult.exitCode,6);
  assert.equal(stale.calls.filter(value => value.method==="apply").length,0);
  assert.equal(stale.control.view().programs[0].phase,"DRAFT");

  const partial=releaseHarness();
  await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply","--non-interactive"]),{
    services:partial.services,
  });
  partial.setFailureMode("partial");
  const failed=await dispatchCoreCommand(parseCoreCommand([
    "release","activate","TOSS-OS-R0001",REPOSITORY,"--apply","--non-interactive",
  ]),{services:partial.services});
  assert.equal(failed.exitCode,70);
  assert.equal(partial.control.view().programs[0].phase,"DRAFT");
  const failedReceipt=partial.control.view().receipts.find(value => value.status==="failed");
  assert.equal(failedReceipt.observed_revisions.length,1);
  const before=partial.calls.length;
  const retry=await dispatchCoreCommand(parseCoreCommand([
    "release","activate","TOSS-OS-R0001",REPOSITORY,
  ]),{services:partial.services});
  assert.equal(retry.exitCode,4);
  assert.equal(partial.calls.length,before);

  const raced=releaseHarness();
  await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply","--non-interactive"]),{
    services:raced.services,
  });
  raced.setFailureMode("control-race");
  const controlRace=await dispatchCoreCommand(parseCoreCommand([
    "release","activate","TOSS-OS-R0001",REPOSITORY,"--apply","--non-interactive",
  ]),{services:raced.services});
  assert.equal(controlRace.exitCode,70);
  assert.equal(raced.control.view().programs[0].phase,"DRAFT");
  const raceReceipt=raced.control.view().receipts.find(value => value.status==="failed");
  assert.equal(raceReceipt.observed_revisions.length,5);
});

function twoRepositoryDraft() {
  const state={
    revision:"control-stage-1",
    organization:{...organization(),repositories:[REPOSITORY,CONSOLE]},
    repositories:[configuredRepository(REPOSITORY,10),configuredRepository(CONSOLE,20)],
    programs:[],intents:[],receipts:[],
  };
  const body={
    kind:"release-plan",control_revision:state.revision,
    candidates:[
      {id:`${REPOSITORY}#10`,repository:REPOSITORY,approved:true,version:null,decomposed:true,
        priority:10,risk:"medium",outcome:"joint",change_class:"backward_compatible_feature",dependencies:[]},
      {id:`${CONSOLE}#20`,repository:CONSOLE,approved:true,version:null,decomposed:true,
        priority:9,risk:"low",outcome:"joint",change_class:"backward_compatible_feature",dependencies:[]},
    ],
    completed:[],
    repositories:[
      {repository:REPOSITORY,latest_published_version:"2.1.2"},
      {repository:CONSOLE,latest_published_version:"1.3.2"},
    ],
  };
  const snapshot={...body,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
    sha256:sha256Canonical({control:state,github:body})}};
  const program=releasePlanOperations({planningState:state,snapshot,clock:() => NOW}).program;
  return {state:{...state,programs:[program]},program};
}

test("same-stage repositories activate together when omitted and independently when explicit",() => {
  const initial=twoRepositoryDraft();
  const repositories=[
    activationRepository(REPOSITORY,10,"a".repeat(40)),
    activationRepository(CONSOLE,20,"b".repeat(40)),
  ];
  const all=activationOperations({planningState:initial.state,programId:initial.program.program_id,
    repository:null,snapshot:signedActivation(initial.state,initial.program,repositories),
    receiptId:"RECEIPT-20260903-9100",clock:() => NOW});
  assert.deepEqual(all.program.repository_releases.map(value => value.phase),["ACTIVE","ACTIVE"]);
  assert.equal(all.program.revision,"REV-0002");

  const cliOnly=activationOperations({planningState:initial.state,programId:initial.program.program_id,
    repository:REPOSITORY,snapshot:signedActivation(initial.state,initial.program,[repositories[0]]),
    receiptId:"RECEIPT-20260903-9101",clock:() => NOW});
  assert.deepEqual(cliOnly.program.repository_releases.map(value => [value.repository,value.phase]),[
    [REPOSITORY,"ACTIVE"],[CONSOLE,"DRAFT"],
  ]);
  const nextState={...initial.state,revision:"control-stage-2",programs:[cliOnly.program]};
  const consoleOnly=activationOperations({planningState:nextState,programId:cliOnly.program.program_id,
    repository:CONSOLE,snapshot:signedActivation(nextState,cliOnly.program,[repositories[1]]),
    receiptId:"RECEIPT-20260903-9102",clock:() => NOW});
  assert.deepEqual(consoleOnly.program.repository_releases.map(value => value.phase),["ACTIVE","ACTIVE"]);
  assert.equal(consoleOnly.program.revision,"REV-0003");
});

test("repository status requires only the selected track from a multi-repository program",() => {
  const {state,program}=twoRepositoryDraft();
  const body=statusBody(state,"release-status",[program]);
  body.repositories=body.repositories.filter(value => value.repository===REPOSITORY);
  const snapshot={...body,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
    sha256:sha256Canonical({control:state,github:body})}};
  const result=releaseStatusResult({planningState:state,repository:REPOSITORY,snapshot});
  assert.equal(result.track.repository,REPOSITORY);
  assert.equal(result.program.id,program.program_id);
});

test("release status chooses the numerically highest arbitrary-width program id",async () => {
  const initial=twoRepositoryDraft();
  const reidentify=(source,programId) => {
    const replacements=new Map();
    const repositoryReleases=source.repository_releases.map(release => {
      const suffix=release.repository.split("/").at(-1).replace(/^toss-/u,"");
      const releaseId=`REL-${programId}-${suffix}`;
      replacements.set(release.release_id,releaseId);
      return {...release,program_id:programId,release_id:releaseId};
    });
    return {...source,program_id:programId,repository_releases:repositoryReleases,
      dependency_stages:source.dependency_stages.map(stage => ({...stage,
        repository_release_ids:stage.repository_release_ids.map(id => replacements.get(id))}))};
  };
  const lower=reidentify(initial.program,"TOSS-OS-R9999");
  const higher=reidentify(initial.program,"TOSS-OS-R10000");
  const state={...initial.state,programs:[lower,higher]};
  const body=statusBody(state,"release-status",[higher]);
  body.repositories=body.repositories.filter(value => value.repository===REPOSITORY);
  const snapshot={...body,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
    sha256:sha256Canonical({control:state,github:body})}};
  const {source:_source,...githubSnapshot}=snapshot;
  const result=await dispatchCoreCommand(parseCoreCommand(["release","status",REPOSITORY]),{
    services:{
      control:{async loadReleasePlanningState() { return state; }},
      github:{async snapshot(query) {
        assert.equal(query.program.program_id,higher.program_id);
        return githubSnapshot;
      }},
    },
  });
  assert.equal(result.exitCode,0,JSON.stringify(result.result.error));
  assert.equal(result.result.data.program.id,higher.program_id);
});

test("activation rechecks one-active-release concurrency against every persisted program",() => {
  const initial=twoRepositoryDraft();
  const active=activationOperations({planningState:initial.state,programId:initial.program.program_id,
    repository:REPOSITORY,
    snapshot:signedActivation(initial.state,initial.program,[activationRepository(REPOSITORY,10,"a".repeat(40))]),
    receiptId:"RECEIPT-20260903-9200",clock:() => NOW}).program;
  const original=initial.program;
  const originalTrack=original.repository_releases.find(value => value.repository===REPOSITORY);
  const secondId="TOSS-OS-R0002";
  const secondRelease={...originalTrack,program_id:secondId,release_id:"REL-TOSS-OS-R0002-cli"};
  const second={...original,program_id:secondId,repository_releases:[secondRelease],
    dependency_stages:[{stage:1,repository_release_ids:[secondRelease.release_id]}],
    selected_scope:original.selected_scope.filter(value => value.epic_id===`${REPOSITORY}#10`),
    rationale:original.rationale.filter(value => value.repository===REPOSITORY)};
  const state={...initial.state,revision:"control-concurrency",programs:[active,second]};
  const snapshot=signedActivation(state,second,[activationRepository(REPOSITORY,10,"a".repeat(40))]);
  assert.throws(() => activationOperations({planningState:state,programId:secondId,
    repository:REPOSITORY,snapshot,receiptId:"RECEIPT-20260903-9201",clock:() => NOW}),
  CoreConflictError);
});

test("release operation boundaries reject proxy and accessor wrappers without invoking traps",() => {
  const initial=twoRepositoryDraft();
  const body={kind:"release-plan",control_revision:"control-wrapper",candidates:[],completed:[],
    repositories:[{repository:REPOSITORY,latest_published_version:"2.1.2"},
      {repository:CONSOLE,latest_published_version:"1.3.2"}]};
  const state={...initial.state,revision:"control-wrapper",programs:[]};
  const snapshot={...body,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
    sha256:sha256Canonical({control:state,github:body})}};
  const valid={planningState:state,snapshot,clock:() => NOW};
  let traps=0;
  const proxy=new Proxy(valid,{
    ownKeys() { traps+=1; throw new Error("must not enumerate proxy"); },
    get() { traps+=1; throw new Error("must not read proxy"); },
  });
  const accessor={snapshot,clock:() => NOW};
  Object.defineProperty(accessor,"planningState",{enumerable:true,get() {
    traps+=1;
    return state;
  }});
  for (const input of [proxy,accessor]) {
    assert.throws(() => releasePlanOperations(input),error => error.exitCode===5);
  }
  assert.equal(traps,0);
});

test("public release commands reject malformed and deeply open control state before GitHub calls",async () => {
  const initial=twoRepositoryDraft().state;
  let nested={leaf:true};
  for (let index=0;index<200;index+=1) nested={next:nested};
  const states=[
    {...initial,receipts:null},
    {...initial,organization:{...initial.organization,unexpected:nested}},
  ];
  let githubCalls=0;
  for (const state of states) {
    for (const argv of [["release","plan"],["release","status",REPOSITORY],["program","status"]]) {
      const result=await dispatchCoreCommand(parseCoreCommand(argv),{services:{
        control:{async loadReleasePlanningState() { return state; }},
        github:{async snapshot() { githubCalls+=1; return {}; }},
        operations:{async execute() { throw new Error("must not execute"); }},
        clock:() => NOW,
      }});
      assert.equal(result.exitCode,5,JSON.stringify(result.result.error));
    }
  }
  assert.equal(githubCalls,0);
});

test("public release commands reject null independent GitHub snapshots as typed validation",async () => {
  const state=twoRepositoryDraft().state;
  for (const argv of [["release","plan"],["program","status"]]) {
    const result=await dispatchCoreCommand(parseCoreCommand(argv),{services:{
      control:{async loadReleasePlanningState() { return state; }},
      github:{async snapshot() { return null; }},
      operations:{async execute() { throw new Error("must not execute"); }},
      clock:() => NOW,
    }});
    assert.equal(result.exitCode,5,JSON.stringify(result.result.error));
  }
});
