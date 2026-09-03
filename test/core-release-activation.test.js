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
  releaseReconciliationEvidence,
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

function releasePlanBody(revision,{approved=true}={}) {
  return {
    kind:"release-plan",control_revision:revision,
    project:{id:"PVT_TOSS_OS_2",revision:"project-plan-1"},
    candidates:[{
      id:`${REPOSITORY}#10`,repository:REPOSITORY,approved,version:null,
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
      work_items:[{id:`${REPOSITORY}#10`,kind:"epic",revision:"issue-10-1",
        branch_revision:null,work:epicWork()}],
    }],
  };
}

function statusBody(state,kind,programs) {
  return {
    kind,control_revision:state.revision,
    program_revisions:(state.programs ?? programs).map(program => ({program_id:program.program_id,
      revision:program.revision})),
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
    work_items:[{id:`${repository}#${number}`,kind:"epic",revision:`issue-${number}-1`,branch_revision:null,
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
      if (intent.planned_receipt_id!==undefined && (
        receipts.some(value => value.receipt_id===intent.planned_receipt_id) ||
        intents.some(value => value.planned_receipt_id===intent.planned_receipt_id)
      )) throw new CoreConflictError("planned receipt identity is already reserved");
      intents.push(structuredClone(intent));
      events.push({kind:"intent",value:structuredClone(intent)});
      revision=`control-${++revisionNumber}`;
      return {commit_sha:revision};
    },
    async commitReceipt({expectedHead,receipt}) {
      assert.equal(expectedHead,revision);
      const owner=intents.find(value => value.intent_id===receipt.intent_id);
      if (owner?.planned_receipt_id!==undefined && owner.planned_receipt_id!==receipt.receipt_id) {
        throw new CoreConflictError("receipt does not use its planned identity");
      }
      if (receipts.some(value => value.receipt_id===receipt.receipt_id)) {
        throw new CoreConflictError("receipt identity is already immutable");
      }
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
      const owner=intents.find(value => value.intent_id===receipt.intent_id);
      if (owner?.planned_receipt_id!==receipt.receipt_id ||
          receipts.some(value => value.receipt_id===receipt.receipt_id)) {
        throw new CoreConflictError("program receipt identity is not uniquely reserved");
      }
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
  let planApproved=true;
  let activationOverride=null;
  const activationRevision=operation => {
    if (operation.payload.kind==="release-activation-precondition") {
      const query=operation.payload.query;
      if (query===undefined) throw new CoreConflictError("activation query descriptor is absent");
      const current=activationOverride ?? activationBody({revision:query.control_revision},query.program);
      if (operation.payload.project_id!==current.project.id ||
          operation.payload.snapshot_sha256!==sha256Canonical(current)) {
        throw new CoreConflictError("activation aggregate evidence changed after snapshot");
      }
      return current.project.revision;
    }
    const current=activationOverride ?? activationBody({revision:"durable-remote"},{
      program_id:"TOSS-OS-R0001",revision:"REV-0001",
    });
    const repository=current.repositories.find(value => value.repository===operation.repository);
    if (!repository) throw new CoreConflictError("activation repository evidence is absent");
    const item=repository.work_items.find(value => value.id===operation.payload.work_item_id);
    switch (operation.payload.kind) {
      case "release-repository-precondition":
        if (operation.payload.snapshot_sha256!==sha256Canonical(repository)) {
          throw new CoreConflictError("repository aggregate evidence changed after snapshot");
        }
        return repository.repository_revision;
      case "release-default-branch-precondition":
        if (operation.payload.name!==repository.default_branch.name ||
            operation.payload.head_sha!==repository.default_branch.head_sha) {
          throw new CoreConflictError("default branch evidence changed after snapshot");
        }
        return repository.default_branch.revision;
      case "release-milestone-precondition":
        if (!repository.milestone || operation.payload.title!==repository.milestone.title ||
            operation.payload.state!==repository.milestone.state) {
          throw new CoreConflictError("milestone evidence changed after snapshot");
        }
        return repository.milestone.revision;
      case "release-branch-precondition":
        if (!repository.release_branch || operation.payload.name!==repository.release_branch.name ||
            operation.payload.base_branch!==repository.release_branch.base_branch ||
            operation.payload.head_sha!==repository.release_branch.head_sha) {
          throw new CoreConflictError("release branch evidence changed after snapshot");
        }
        return repository.release_branch.revision;
      case "release-pull-request-precondition":
        if (!repository.release_pull_request ||
            operation.payload.number!==repository.release_pull_request.number ||
            operation.payload.base_branch!==repository.release_pull_request.base_branch ||
            operation.payload.head_branch!==repository.release_pull_request.head_branch ||
            operation.payload.head_sha!==repository.release_pull_request.head_sha ||
            operation.payload.draft!==repository.release_pull_request.draft) {
          throw new CoreConflictError("release pull request evidence changed after snapshot");
        }
        return repository.release_pull_request.revision;
      case "release-assignment-precondition":
        if (!item || operation.payload.work_sha256!==sha256Canonical(item.work)) {
          throw new CoreConflictError("release assignment evidence changed after snapshot");
        }
        return item.revision;
      case "release-epic-branch-precondition":
        if (!item?.work.physical_branch.exists || operation.payload.name!==item.work.item.branch ||
            operation.payload.base_branch!==repository.release_branch?.name ||
            operation.payload.head_sha!==item.work.physical_branch.head_sha) {
          throw new CoreConflictError("epic branch evidence changed after snapshot");
        }
        return item.branch_revision;
      case "release-project-item-precondition":
        if (!item || operation.payload.project_id!==item.work.project.project_id ||
            operation.payload.item_id!==item.work.project.item_id ||
            operation.payload.fields_sha256!==sha256Canonical(item.work.project.fields)) {
          throw new CoreConflictError("Project item evidence changed after snapshot");
        }
        return item.work.project.revision;
      case "release-milestone":
        if (repository.milestone!==null) throw new CoreConflictError("milestone already exists");
        return repository.repository_revision;
      case "release-branch":
        if (repository.release_branch!==null ||
            operation.payload.base_branch!==repository.default_branch.name ||
            operation.payload.head_sha!==repository.default_branch.head_sha) {
          throw new CoreConflictError("release branch create base is stale");
        }
        return repository.default_branch.revision;
      case "release-pull-request":
        if (repository.release_pull_request!==null ||
            operation.payload.base!==repository.default_branch.name ||
            operation.payload.expected_head_revision!==repository.comparison.head_sha) {
          throw new CoreConflictError("release pull request create evidence is stale");
        }
        return repository.repository_revision;
      case "release-assignment":
        if (!item || item.work.release.assigned) throw new CoreConflictError("release assignment is stale");
        return item.revision;
      case "release-epic-branch": {
        if (!item || item.work.physical_branch.exists) throw new CoreConflictError("epic branch already exists");
        const expectedBaseRevision=repository.release_branch?.revision ?? repository.default_branch.revision;
        const expectedHead=repository.release_branch?.head_sha ?? repository.default_branch.head_sha;
        if (operation.payload.base_revision!==expectedBaseRevision ||
            operation.payload.head_sha!==expectedHead) {
          throw new CoreConflictError("epic branch create base evidence is stale");
        }
        return repository.repository_revision;
      }
      case "release-project-state":
        if (!item || operation.payload.project_id!==item.work.project.project_id ||
            operation.payload.item_id!==item.work.project.item_id) {
          throw new CoreConflictError("Project update target is stale");
        }
        return item.work.project.revision;
      default:
        throw new CoreConflictError(`unexpected release fake operation: ${operation.payload.kind}`);
    }
  };
  const github=Object.freeze({
    async snapshot(query) {
      calls.push({method:"snapshot",query:structuredClone(query)});
      const selectedPrograms=query.kind==="program-status" ? query.selected_programs :
        query.program===null || query.program===undefined ? [] : [query.program];
      const planning={revision:query.control_revision,programs:query.programs};
      const body=query.kind==="release-plan" ? releasePlanBody(query.control_revision,{approved:planApproved}) :
        query.kind==="release-activation"
          ? structuredClone(activationOverride ?? activationBody(planning,query.program))
          : statusBody(planning,query.kind,selectedPrograms);
      if (failureMode==="source-race") control.advance();
      return body;
    },
    async inspect(operations) {
      calls.push({method:"inspect",operations:structuredClone(operations)});
      return operations.map(operation => {
        if (operation.payload.kind==="release-plan-precondition") {
          const query=operation.payload.query;
          if (query===undefined) throw new CoreConflictError("release plan query descriptor is absent");
          const current=releasePlanBody(query.control_revision,{approved:planApproved});
          if (operation.payload.project_id!==current.project.id ||
              operation.payload.snapshot_sha256!==sha256Canonical(current)) {
            throw new CoreConflictError("release plan evidence changed after snapshot");
          }
          return {operation_id:operation.operation_id,repository:null,
            revision:current.project.revision};
        }
        if (operation.payload.kind.startsWith("release-")) {
          const revision=failureMode==="stale" && operation.payload.kind==="release-branch"
            ? "stale-revision"
            : activationRevision(operation);
          return {operation_id:operation.operation_id,repository:operation.repository,revision};
        }
        return {operation_id:operation.operation_id,
          repository:operation.repository,revision:failureMode==="stale" &&
            operation.payload.kind==="release-branch"
            ? "stale-revision" : operation.expected_revision};
      });
    },
    async apply(operations) {
      calls.push({method:"apply",operations:structuredClone(operations)});
      const ranks=new Map([["release-milestone",10],["release-branch",20],
        ["release-pull-request",40],["release-assignment",50],
        ["release-epic-branch",60],["release-project-state",70]]);
      let previous=-Infinity;
      for (const operation of operations) {
        if (operation.action==="verify") throw new CoreConflictError("verify operation reached mutation apply");
        const rank=ranks.get(operation.payload.kind);
        if (rank===undefined || rank<previous) throw new CoreConflictError("release mutation order is invalid");
        previous=rank;
        if (activationRevision(operation)!==operation.expected_revision) {
          throw new CoreConflictError("release mutation expected revision is stale");
        }
      }
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
  return {
    calls,control,services,
    setFailureMode(value) { failureMode=value; },
    mutatePlanApproval() { planApproved=false; },
    setActivationObservation(value) { activationOverride=structuredClone(value); },
    mutateActivationDefaultBranch() {
      activationOverride.repositories[0].default_branch.revision="main-after-confirmation";
    },
  };
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
    "release-plan-precondition","release-program-manifest",
  ]);
  const manifest=preview.result.data.operations.find(value =>
    value.payload.kind==="release-program-manifest");
  assert.equal(manifest.payload.program.program_id,"TOSS-OS-R0001");
  assert.equal(manifest.payload.program.phase,"DRAFT");
  assert.equal(manifest.payload.program.rationale[0].version,"2.2.0");
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
  assert.deepEqual(calls.map(value => value.method),["snapshot","snapshot","inspect"]);
});

test("release plan revalidates approval evidence after interactive confirmation",async () => {
  const harness=releaseHarness();
  const result=await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply"]),{
    services:harness.services,
    confirm:async () => {
      harness.mutatePlanApproval();
      return true;
    },
  });
  assert.equal(result.exitCode,6,JSON.stringify(result.result.error));
  assert.deepEqual(harness.control.view().programs,[]);
  assert.equal(harness.calls.filter(value => value.method==="apply").length,0);
});

test("persisted aggregate preconditions restart from their closed query descriptors",async () => {
  const base=memoryReleaseControl().view();
  const planQuery={kind:"release-plan",control_revision:base.revision,
    organization:base.organization,repositories:base.repositories,programs:base.programs};
  const planBody=releasePlanBody(base.revision);
  const planDecision=releasePlanOperations({planningState:base,snapshot:{...planBody,source:{
    repository:CONTROL_REPOSITORY,revision:base.revision,
    sha256:sha256Canonical({control:base,github:planBody}),
  }},clock:() => NOW});
  const persisted=JSON.parse(JSON.stringify(createOperationIntent({
    intent_id:"INTENT-20260903-9001",created_at:NOW,command:"release.plan",
    policy_revision:"POLICY-0001",source:planDecision.source,authority:null,
    planned_receipt_id:"RECEIPT-20260903-9001",operations:planDecision.operations,
  })));
  const aggregate=persisted.operations.find(operation =>
    operation.payload.kind==="release-plan-precondition");
  const durable={approved:true};
  let remoteApplyCount=0;
  const restartedControl=() => ({
    async head() { return "restart-control-1"; },
    async findIntent() { return JSON.parse(JSON.stringify(persisted)); },
    async findReceipt() { return null; },
    async commitIntent() { throw new Error("persisted restart intent must not be replaced"); },
    async inspectReleaseProgramOperation(operation) {
      return {operation_id:operation.operation_id,repository:CONTROL_REPOSITORY,revision:null};
    },
    async commitReleaseProgramReceipt({receipt}) { return {commit_sha:receipt.receipt_id}; },
    async commitReceipt({receipt}) { return {commit_sha:receipt.receipt_id}; },
  });
  const restartedGithub=() => {
    const snapshot=async query => {
      assert.equal(JSON.stringify(query),JSON.stringify(planQuery));
      return releasePlanBody(query.control_revision,{approved:durable.approved});
    };
    return {
    snapshot,
    async inspect(operations) {
      return Promise.all(operations.map(async operation => {
        if (operation.payload.kind!=="release-plan-precondition" ||
            operation.payload.query===undefined) {
          throw new CoreConflictError("stored aggregate query descriptor is absent");
        }
        const current=await snapshot(operation.payload.query);
        if (operation.payload.snapshot_sha256!==sha256Canonical(current)) {
          throw new CoreConflictError("stored aggregate evidence changed after restart");
        }
        return {operation_id:operation.operation_id,repository:null,
          revision:current.project.revision};
      }));
    },
    async apply() {
      remoteApplyCount+=1;
      throw new Error("plan verification has no remote mutation");
    },
  }; };
  const restart=() => createOperationRunner({
    control:restartedControl(),github:restartedGithub(),authorityRegistry:null,
    clock:() => NOW,idGenerator:() => "RECEIPT-20260903-9999",
    policyRevision:() => "POLICY-0001",
  });

  const completed=await restart().apply(persisted,{authority:null});
  assert.equal(completed.status,"completed");
  assert.equal(JSON.stringify(aggregate.payload.query),JSON.stringify(planQuery));
  assert.equal(remoteApplyCount,0);

  const activationState={...base,revision:"control-plan",programs:[planDecision.program]};
  const activationQuery={kind:"release-activation",control_revision:activationState.revision,
    program:planDecision.program,repository:REPOSITORY,
    repository_configurations:activationState.repositories,project:activationState.organization.project};
  const activationSnapshot=activationBody(activationState,planDecision.program);
  const activationDecision=activationOperations({planningState:activationState,
    programId:planDecision.program.program_id,repository:REPOSITORY,snapshot:{
      ...activationSnapshot,source:{repository:CONTROL_REPOSITORY,
        revision:activationState.revision,
        sha256:sha256Canonical({control:activationState,github:activationSnapshot})},
    },receiptId:"RECEIPT-20260903-9002",clock:() => NOW});
  assert.equal(JSON.stringify(activationDecision.operations.find(operation =>
    operation.payload.kind==="release-activation-precondition").payload.query),
  JSON.stringify(activationQuery));

  durable.approved=false;
  await assert.rejects(restart().apply(persisted,{authority:null}),error =>
    error instanceof CoreConflictError && /changed after restart/u.test(error.message));
  assert.equal(remoteApplyCount,0);
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
  const emptyBody={kind:"release-plan",control_revision:base.revision,
    project:{id:"PVT_TOSS_OS_2",revision:"project-plan-1"},candidates:[],completed:[],
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
  assert.equal(promoted.operations.find(value => value.payload.kind==="release-program-manifest")
    .expected_revision,"REV-0001");
});

test("release activate materializes exact identities and Work projections in dependency order",async () => {
  const {calls,control,services}=releaseHarness();
  const planned=await dispatchCoreCommand(
    parseCoreCommand(["release","plan","--apply","--non-interactive"]),{services},
  );
  assert.equal(planned.exitCode,0);
  const beforePreviewEvents=control.events.length;
  const beforePreviewRemote=calls.filter(value => ["inspect","apply"].includes(value.method)).length;

  const preview=await dispatchCoreCommand(
    parseCoreCommand(["release","activate","TOSS-OS-R0001",REPOSITORY]),{services},
  );
  assert.equal(preview.exitCode,0,JSON.stringify(preview.result.error));
  assert.equal(preview.result.data.schema_version,"operation-preview.v1");
  assert.deepEqual(preview.result.data.operations.map(value => value.payload.kind),[
    "release-activation-precondition","release-repository-precondition",
    "release-default-branch-precondition","release-milestone","release-branch","release-program-manifest",
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
  assert.equal(calls.filter(value => ["inspect","apply"].includes(value.method)).length,
    beforePreviewRemote);

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

test("release activation revalidates matching remote evidence after confirmation",async () => {
  const harness=releaseHarness();
  await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply","--non-interactive"]),{
    services:harness.services,
  });
  const state=harness.control.view();
  const body=activationBody(state,state.programs[0]);
  body.repositories[0].release_branch={
    name:"release/v2.2.0",base_branch:"main",head_sha:"a".repeat(40),revision:"branch-1",
  };
  harness.setActivationObservation(body);
  const applyBefore=harness.calls.filter(value => value.method==="apply").length;
  const result=await dispatchCoreCommand(parseCoreCommand([
    "release","activate","TOSS-OS-R0001",REPOSITORY,"--apply",
  ]),{
    services:harness.services,
    confirm:async () => {
      harness.mutateActivationDefaultBranch();
      return true;
    },
  });
  assert.equal(result.exitCode,6,JSON.stringify(result.result.error));
  assert.equal(harness.calls.filter(value => value.method==="apply").length,applyBefore);
  assert.equal(harness.control.view().programs[0].phase,"DRAFT");
});

test("activation retains verify-only preconditions for every matching remote observation",async () => {
  const harness=releaseHarness();
  await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply","--non-interactive"]),{
    services:harness.services,
  });
  const state=harness.control.view();
  const program=state.programs[0];
  const body=activationBody(state,program);
  const repository=body.repositories[0];
  repository.milestone={title:"v2.2.0",state:"OPEN",revision:"milestone-1"};
  repository.release_branch={name:"release/v2.2.0",base_branch:"main",
    head_sha:"b".repeat(40),revision:"branch-1"};
  repository.comparison={base_sha:"a".repeat(40),head_sha:"b".repeat(40),material_difference:true};
  repository.release_pull_request={number:42,base_branch:"main",head_branch:"release/v2.2.0",
    head_sha:"b".repeat(40),draft:true,revision:"pull-1"};
  const item=repository.work_items[0];
  item.branch_revision="epic-branch-1";
  item.work.release={assigned:true,active:true,id:`${REPOSITORY}@release/v2.2.0`,
    repository:REPOSITORY,branch:"release/v2.2.0",milestone:"v2.2.0",revision:"REV-0002"};
  Object.assign(item.work.item,{milestone:"v2.2.0",base_branch:"release/v2.2.0",
    status:"Blocked",gate:"DEPENDENCY_REQUIRED"});
  item.work.physical_branch={exists:true,head_sha:"b".repeat(40)};
  Object.assign(item.work.project.fields,{Status:"Blocked",Gate:"DEPENDENCY_REQUIRED",
    milestone:"v2.2.0",base_branch:"release/v2.2.0",last_reconciled_at:NOW});
  const snapshot={...body,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
    sha256:sha256Canonical({control:state,github:body})}};
  const decision=activationOperations({planningState:state,programId:program.program_id,
    repository:REPOSITORY,snapshot,receiptId:"RECEIPT-20260903-2000",clock:() => NOW});
  assert.deepEqual(decision.operations.map(operation => [operation.action,operation.payload.kind]),[
    ["verify","release-activation-precondition"],
    ["verify","release-repository-precondition"],
    ["verify","release-default-branch-precondition"],
    ["verify","release-milestone-precondition"],
    ["verify","release-branch-precondition"],
    ["verify","release-pull-request-precondition"],
    ["verify","release-assignment-precondition"],
    ["verify","release-epic-branch-precondition"],
    ["verify","release-project-item-precondition"],
    ["commit","release-program-manifest"],
  ]);
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

test("release and program status expose failed release evidence as reconciliation",async () => {
  const harness=releaseHarness();
  await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply","--non-interactive"]),{
    services:harness.services,
  });
  harness.setFailureMode("partial");
  const partial=await dispatchCoreCommand(parseCoreCommand([
    "release","activate","TOSS-OS-R0001",REPOSITORY,"--apply","--non-interactive",
  ]),{services:harness.services});
  assert.equal(partial.exitCode,70);
  harness.setFailureMode(null);
  const failed=harness.control.view().receipts.find(value => value.status==="failed");

  const release=await dispatchCoreCommand(parseCoreCommand(["release","status",REPOSITORY]),{
    services:harness.services,
  });
  assert.equal(release.exitCode,0,JSON.stringify(release.result.error));
  assert.equal(release.result.data.gate,"RECONCILE_REQUIRED");
  assert.equal(release.result.data.next_command,`toss-core sync ${REPOSITORY}`);
  assert.equal(release.result.data.reconciliation.required,true);
  assert.equal(release.result.data.reconciliation.evidence[0].intent.intent_id,failed.intent_id);
  assert.equal(release.result.data.reconciliation.evidence[0].receipt.receipt_id,failed.receipt_id);

  const program=await dispatchCoreCommand(parseCoreCommand(["program","status","TOSS-OS-R0001"]),{
    services:harness.services,
  });
  assert.equal(program.exitCode,0,JSON.stringify(program.result.error));
  const track=program.result.data.programs[0].tracks[0];
  assert.equal(track.gate,"RECONCILE_REQUIRED");
  assert.equal(track.next_command,`toss-core sync ${REPOSITORY}`);
  assert.equal(track.reconciliation.evidence[0].receipt.receipt_id,failed.receipt_id);
});

test("release reconciliation rejects a receipt that does not own its planned identity",() => {
  const base=memoryReleaseControl().view();
  const intent=createOperationIntent({
    intent_id:"INTENT-20260903-9100",created_at:NOW,command:"release.activate",
    policy_revision:"POLICY-0001",
    source:{repository:CONTROL_REPOSITORY,revision:base.revision,sha256:"d".repeat(64)},
    authority:null,planned_receipt_id:"RECEIPT-20260903-9100",
    operations:[{resource:"milestone",action:"create",repository:REPOSITORY,
      expected_revision:"repository-1",payload:{kind:"release-milestone",
        program_id:"TOSS-OS-R0001",release_id:"REL-TOSS-OS-R0001-cli",
        title:"v2.2.0",state:"OPEN"}}],
  });
  const receipt={
    schema_version:"operation-receipt.v1",document_type:"operation-receipt",
    receipt_id:"RECEIPT-20260903-9101",intent_id:intent.intent_id,
    intent_sha256:sha256Canonical(intent),created_at:NOW,status:"completed",
    observed_revisions:[{operation_id:"OP-0001",repository:REPOSITORY,
      revision:"milestone-1"}],
  };
  assert.throws(() => releaseReconciliationEvidence({
    planningState:{...base,intents:[intent],receipts:[receipt]},
    programId:null,repository:null,
  }),error => error instanceof CoreConflictError &&
    /planned|reservation|identity/u.test(error.message));
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
  staleAssignment.repositories[0].work_items[0].branch_revision="epic-branch-1";
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

test("epic branch creation binds the observed physical base revision",async () => {
  const harness=releaseHarness();
  await dispatchCoreCommand(parseCoreCommand(["release","plan","--apply","--non-interactive"]),{
    services:harness.services,
  });
  const state=harness.control.view();
  const program=state.programs[0];
  const decisionFor=body => activationOperations({planningState:state,programId:program.program_id,
    repository:REPOSITORY,snapshot:{...body,source:{repository:CONTROL_REPOSITORY,
      revision:state.revision,sha256:sha256Canonical({control:state,github:body})}},
    receiptId:"RECEIPT-20260903-9006",clock:() => NOW});

  const existing=activationBody(state,program);
  existing.repositories[0].release_branch={name:"release/v2.2.0",base_branch:"main",
    head_sha:"a".repeat(40),revision:"branch-physical-1"};
  const existingEpic=decisionFor(existing).operations.find(value =>
    value.payload.kind==="release-epic-branch");
  assert.equal(existingEpic.payload.base_revision,"branch-physical-1");

  const created=activationBody(state,program);
  const createdEpic=decisionFor(created).operations.find(value =>
    value.payload.kind==="release-epic-branch");
  assert.equal(createdEpic.payload.base_revision,"main-1");
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
    "release-activation-precondition","release-repository-precondition",
    "release-default-branch-precondition","release-branch-precondition",
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
    id:`${REPOSITORY}#11`,kind:"issue",revision:"issue-11-1",branch_revision:null,work:childWork(),
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
  assert.equal(failedReceipt.observed_revisions.length,4);
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
  assert.equal(raceReceipt.observed_revisions.length,8);
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
    project:{id:"PVT_TOSS_OS_2",revision:"project-plan-1"},
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
  assert.throws(() => createOperationIntent({
    intent_id:"INTENT-20260903-9200",created_at:NOW,command:"release.activate",
    policy_revision:"POLICY-0001",source:all.source,authority:null,
    planned_receipt_id:"RECEIPT-20260903-9200",
    operations:all.operations.map(operation => operation.payload.kind===
      "release-activation-precondition" ? {...operation,payload:{...operation.payload,
        query:{...operation.payload.query,
          repository_configurations:operation.payload.query.repository_configurations.slice(0,1)}}} : operation),
  }),error => error?.code==="CORE_CONTRACT_INVALID" && error?.exitCode===5);

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
  const body={kind:"release-plan",control_revision:"control-wrapper",
    project:{id:"PVT_TOSS_OS_2",revision:"project-plan-1"},candidates:[],completed:[],
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
