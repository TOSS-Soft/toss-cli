import assert from "node:assert/strict";
import test from "node:test";

import {canonicalJson} from "../src/contracts/acp.js";
import {
  deriveWorkItemState,
  projectReconciliationOperations,
} from "../src/core/domain/state.js";
import {CoreValidationError} from "../src/core/errors.js";
import {createOperationIntent} from "../src/core/operations/plan.js";

const REPOSITORY="TOSS-Soft/toss-cli";
const HEAD_A="a".repeat(40);
const HEAD_B="b".repeat(40);
const RECONCILED_AT="2026-09-01T12:00:00.000Z";
const NEXT_RECONCILED_AT="2026-09-01T12:05:00.000Z";

function deeplyFrozen(value,seen=new Set()) {
  if (value===null || typeof value!=="object" || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value).every(key => deeplyFrozen(value[key],seen));
}

function itemFor(kind) {
  const number={bug:52,epic:42,issue:43}[kind];
  const branch={
    bug:"bug/52-fix-production-receipt",
    epic:"epic/42-organizational-lifecycle",
    issue:"issue/43-derive-visible-state",
  }[kind];
  const baseBranch=kind==="issue"
    ? "epic/42-organizational-lifecycle"
    : "release/v2.2.0";
  return {
    schema_version:"work-item.v1",
    id:`${REPOSITORY}#${number}`,
    repository:REPOSITORY,
    issue_number:number,
    kind,
    parent_id:kind==="issue" ? `${REPOSITORY}#42` : null,
    ...(kind==="issue" ? {acceptance_criteria:["The visible lifecycle projection is exact."]} : {}),
    branch,
    base_branch:baseBranch,
    milestone:"v2.2.0",
    status:"Backlog",
    gate:"RELEASE_PLANNING",
  };
}

function snapshot(kind="issue") {
  const item=itemFor(kind);
  return {
    schema_version:"work-state-snapshot.v1",
    item,
    issue_state:"OPEN",
    drifted:false,
    epic_required:false,
    prepared:kind==="epic" ? true : null,
    scope_approved:kind==="epic" ? true : null,
    parent:kind==="issue" ? {
      id:`${REPOSITORY}#42`,
      branch:"epic/42-organizational-lifecycle",
      revision:"issue-42@8",
    } : null,
    release:{
      assigned:true,
      active:true,
      id:`${REPOSITORY}@release/v2.2.0`,
      repository:REPOSITORY,
      branch:"release/v2.2.0",
      milestone:"v2.2.0",
      revision:"release-v2.2.0@3",
    },
    blocking_dependencies:[],
    children_complete:kind==="epic" ? true : null,
    physical_branch:{exists:false,head_sha:null},
    pull_request:null,
    review:null,
    checks:null,
    authority:{
      epic_acceptance_required:false,
      release_approval_required:false,
    },
    project:{
      project_id:"PVT_TOSS_OS_2",
      item_id:`PVTI_${kind.toUpperCase()}_${item.issue_number}`,
      revision:`project-item-${item.issue_number}@7`,
      fields:{
        Status:"Backlog",
        Gate:"RELEASE_PLANNING",
        repository:item.repository,
        parent:item.parent_id,
        milestone:item.milestone,
        branch:item.branch,
        base_branch:item.base_branch,
        last_reconciled_at:RECONCILED_AT,
      },
    },
  };
}

function withPhysicalBranch(value,headSha=HEAD_A) {
  value.physical_branch={exists:true,head_sha:headSha};
  return value;
}

function withPullRequest(value,state="READY",headSha=HEAD_A) {
  withPhysicalBranch(value,headSha);
  value.pull_request={
    state,
    head_sha:headSha,
    merged_sha:state==="MERGED" ? headSha : null,
  };
  return value;
}

function withCurrentApproval(value) {
  value.review={verdict:"APPROVED",reviewed_revision:value.pull_request.head_sha};
  value.checks={state:"PASSED",revision:value.pull_request.head_sha};
  return value;
}

function stateCase(name,value,expected) {
  return {name,value,expected};
}

test("the ordered state table covers every approved status and gate",() => {
  const preparation=snapshot("epic");
  preparation.prepared=false;
  preparation.scope_approved=false;

  const approval=snapshot("epic");
  approval.scope_approved=false;

  const releasePlanning=snapshot();
  releasePlanning.release.active=false;

  const drift=snapshot();
  drift.drifted=true;

  const epicRequired=snapshot("bug");
  epicRequired.epic_required=true;

  const dependency=snapshot();
  dependency.blocking_dependencies=[`${REPOSITORY}#41`];

  const changesRequested=withPullRequest(snapshot());
  changesRequested.review={verdict:"CHANGES_REQUESTED",reviewed_revision:HEAD_A};
  changesRequested.checks={state:"PENDING",revision:HEAD_A};

  const blockedReview=withPullRequest(snapshot());
  blockedReview.review={verdict:"BLOCKED",reviewed_revision:HEAD_A};
  blockedReview.checks={state:"PASSED",revision:HEAD_A};

  const reviewRequired=withPullRequest(snapshot());
  reviewRequired.review={verdict:"APPROVED",reviewed_revision:HEAD_B};
  reviewRequired.checks={state:"PASSED",revision:HEAD_A};

  const epicAcceptance=withCurrentApproval(withPullRequest(snapshot("epic")));
  epicAcceptance.authority.epic_acceptance_required=true;

  const releaseApproval=withCurrentApproval(withPullRequest(snapshot("bug")));
  releaseApproval.authority.release_approval_required=true;

  const ready=snapshot();
  const inProgress=withPhysicalBranch(snapshot());
  const draft=withPullRequest(snapshot(),"DRAFT");
  const inReview=withPullRequest(snapshot());

  const done=withPullRequest(snapshot(),"MERGED");
  done.issue_state="CLOSED";
  done.review={verdict:"APPROVED",reviewed_revision:HEAD_B};
  done.checks={state:"FAILED",revision:HEAD_B};
  done.release.active=false;

  const cases=[
    stateCase("epic preparation",preparation,{
      status:"Backlog",gate:"EPIC_PREPARATION_REQUIRED",
      next_command:"toss-core epic prepare",
    }),
    stateCase("epic approval",approval,{
      status:"Backlog",gate:"EPIC_APPROVAL_REQUIRED",
      next_command:"toss-core epic approve",
    }),
    stateCase("release planning",releasePlanning,{
      status:"Backlog",gate:"RELEASE_PLANNING",
      next_command:"toss-core release plan",
    }),
    stateCase("reconciliation",drift,{
      status:"Blocked",gate:"RECONCILE_REQUIRED",
      next_command:"toss-core sync",
    }),
    stateCase("bug decomposition",epicRequired,{
      status:"Blocked",gate:"EPIC_REQUIRED",
      next_command:"toss-core feature add",
    }),
    stateCase("dependency",dependency,{
      status:"Blocked",gate:"DEPENDENCY_REQUIRED",
      next_command:"toss-core dependency check",
    }),
    stateCase("changes requested",changesRequested,{
      status:"Blocked",gate:"CHANGES_REQUESTED",
      next_command:"toss-core review status",
    }),
    stateCase("blocked review",blockedReview,{
      status:"Blocked",gate:"CHANGES_REQUESTED",
      next_command:"toss-core review status",
    }),
    stateCase("stale review",reviewRequired,{
      status:"In review",gate:"REVIEW_REQUIRED",
      next_command:"toss-core review record",
    }),
    stateCase("epic acceptance",epicAcceptance,{
      status:"In review",gate:"EPIC_ACCEPTANCE_REQUIRED",
      next_command:"toss-core epic accept",
    }),
    stateCase("release approval",releaseApproval,{
      status:"In review",gate:"RELEASE_APPROVAL_REQUIRED",
      next_command:"toss-core release approve",
    }),
    stateCase("reserved branch",ready,{
      status:"Ready",gate:"NONE",next_command:"toss-core issue start",
    }),
    stateCase("physical branch",inProgress,{
      status:"In progress",gate:"NONE",next_command:"toss-core issue submit",
    }),
    stateCase("draft pull request",draft,{
      status:"In progress",gate:"NONE",next_command:"toss-core issue submit",
    }),
    stateCase("ready pull request",inReview,{
      status:"In review",gate:"REVIEW_REQUIRED",
      next_command:"toss-core review record",
    }),
    stateCase("merged and closed",done,{
      status:"Done",gate:"NONE",next_command:null,
    }),
  ];

  const statuses=new Set();
  const gates=new Set();
  for (const candidate of cases) {
    const result=deriveWorkItemState(candidate.value);
    assert.equal(result.status,candidate.expected.status,candidate.name);
    assert.equal(result.gate,candidate.expected.gate,candidate.name);
    assert.equal(result.next_command,candidate.expected.next_command,candidate.name);
    assert.equal(typeof result.reason,"string",candidate.name);
    assert.ok(result.reason.trim().length>0,candidate.name);
    assert.ok(deeplyFrozen(result),candidate.name);
    statuses.add(result.status);
    gates.add(result.gate);
  }

  assert.deepEqual([...statuses].sort(),[
    "Backlog","Blocked","Done","In progress","In review","Ready",
  ]);
  assert.deepEqual([...gates].sort(),[
    "CHANGES_REQUESTED","DEPENDENCY_REQUIRED","EPIC_ACCEPTANCE_REQUIRED",
    "EPIC_APPROVAL_REQUIRED","EPIC_PREPARATION_REQUIRED","EPIC_REQUIRED","NONE",
    "RECONCILE_REQUIRED","RELEASE_APPROVAL_REQUIRED","RELEASE_PLANNING",
    "REVIEW_REQUIRED",
  ]);
});

test("first-match precedence follows lifecycle authority instead of incidental evidence",() => {
  const preparation=snapshot("epic");
  preparation.prepared=false;
  preparation.scope_approved=false;
  preparation.release.active=false;
  preparation.blocking_dependencies=[`${REPOSITORY}#41`];
  assert.equal(deriveWorkItemState(preparation).gate,"EPIC_PREPARATION_REQUIRED");

  const approval=snapshot("epic");
  approval.scope_approved=false;
  approval.release.active=false;
  approval.blocking_dependencies=[`${REPOSITORY}#41`];
  assert.equal(deriveWorkItemState(approval).gate,"EPIC_APPROVAL_REQUIRED");

  const inactive=snapshot();
  inactive.release.active=false;
  inactive.blocking_dependencies=[`${REPOSITORY}#41`];
  assert.equal(deriveWorkItemState(inactive).gate,"RELEASE_PLANNING");

  const dependency=withPhysicalBranch(snapshot());
  dependency.blocking_dependencies=[`${REPOSITORY}#41`];
  assert.equal(deriveWorkItemState(dependency).gate,"DEPENDENCY_REQUIRED");

  const changes=withPullRequest(snapshot());
  changes.review={verdict:"CHANGES_REQUESTED",reviewed_revision:HEAD_A};
  changes.checks={state:"FAILED",revision:HEAD_A};
  assert.equal(deriveWorkItemState(changes).gate,"CHANGES_REQUESTED");

  const staleChanges=withPullRequest(snapshot());
  staleChanges.review={verdict:"CHANGES_REQUESTED",reviewed_revision:HEAD_B};
  staleChanges.checks={state:"PASSED",revision:HEAD_A};
  assert.equal(deriveWorkItemState(staleChanges).gate,"REVIEW_REQUIRED");

  const drift=withPhysicalBranch(snapshot());
  drift.drifted=true;
  assert.equal(deriveWorkItemState(drift).gate,"RECONCILE_REQUIRED");
});

test("Ready requires exact governing branch and assigned release evidence",() => {
  const wrongParentBranch=snapshot();
  wrongParentBranch.item.base_branch="epic/99-wrong-parent";

  const missingChildBase=snapshot();
  missingChildBase.item.base_branch=null;

  const missingChildMilestone=snapshot();
  missingChildMilestone.item.milestone=null;

  const missingEpicBase=snapshot("epic");
  missingEpicBase.item.base_branch=null;

  const missingBugMilestone=snapshot("bug");
  missingBugMilestone.item.milestone=null;

  const wrongEpicVersion=snapshot("epic");
  wrongEpicVersion.item.milestone="v2.2.1";

  const wrongBugVersion=snapshot("bug");
  wrongBugVersion.item.base_branch="release/v2.1.3";

  for (const value of [
    wrongParentBranch,missingChildBase,missingChildMilestone,missingEpicBase,
    missingBugMilestone,wrongEpicVersion,wrongBugVersion,
  ]) {
    assert.throws(
      () => deriveWorkItemState(value),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }

  for (const kind of ["issue","epic","bug"]) {
    const backlog=snapshot(kind);
    backlog.release={
      assigned:false,active:false,id:null,repository:null,branch:null,milestone:null,revision:null,
    };
    if (kind!=="issue") backlog.item.base_branch=null;
    backlog.item.milestone=null;
    assert.equal(deriveWorkItemState(backlog).gate,"RELEASE_PLANNING",kind);
  }
});

test("a same-number branch that is not the reserved parent branch cannot become Ready",() => {
  const value=snapshot();
  value.item.base_branch="epic/42-not-the-reserved-parent-branch";

  assert.throws(
    () => deriveWorkItemState(value),
    error => error instanceof CoreValidationError && error.exitCode===5,
  );
});

test("governing parent and release evidence is exact and revision-bound",() => {
  assert.equal(deriveWorkItemState(snapshot()).status,"Ready");

  const wrongParentId=snapshot();
  wrongParentId.parent.id=`${REPOSITORY}#41`;

  const wrongParentBranch=snapshot();
  wrongParentBranch.parent.branch="epic/41-another-parent";

  const missingParentRevision=snapshot();
  missingParentRevision.parent.revision="";

  const missingParent=snapshot();
  missingParent.parent=null;

  const unexpectedParent=snapshot("epic");
  unexpectedParent.parent={
    id:`${REPOSITORY}#42`,branch:"epic/42-organizational-lifecycle",revision:"issue-42@8",
  };

  const unassignedWithRelease=snapshot("epic");
  unassignedWithRelease.release.assigned=false;
  unassignedWithRelease.release.active=false;

  const assignedWithoutBranch=snapshot("epic");
  assignedWithoutBranch.release.branch=null;

  const mismatchedReleaseMilestone=snapshot("epic");
  mismatchedReleaseMilestone.release.milestone="v2.2.1";

  const missingReleaseRevision=snapshot("bug");
  missingReleaseRevision.release.revision=null;

  const itemReleaseMismatch=snapshot("bug");
  itemReleaseMismatch.item.base_branch="release/v2.1.3";

  const childMilestoneMismatch=snapshot();
  childMilestoneMismatch.item.milestone="v2.2.1";

  for (const value of [
    wrongParentId,wrongParentBranch,missingParentRevision,missingParent,
    unexpectedParent,unassignedWithRelease,assignedWithoutBranch,
    mismatchedReleaseMilestone,missingReleaseRevision,itemReleaseMismatch,
    childMilestoneMismatch,
  ]) {
    assert.throws(
      () => deriveWorkItemState(value),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }
});

test("assigned release evidence must identify its repository before Ready",() => {
  assert.equal(deriveWorkItemState(snapshot("epic")).status,"Ready");
  assert.equal(deriveWorkItemState(snapshot("bug")).status,"Ready");

  const missingId=snapshot("epic");
  missingId.release.id=null;

  const missingRepository=snapshot("bug");
  missingRepository.release.repository=null;

  const crossRepository=snapshot("epic");
  crossRepository.release.id="TOSS-Soft/toss-console@release/v2.2.0";
  crossRepository.release.repository="TOSS-Soft/toss-console";

  const mismatchedRepositoryId=snapshot("bug");
  mismatchedRepositoryId.release.id="TOSS-Soft/toss-console@release/v2.2.0";

  const mismatchedBranchId=snapshot("epic");
  mismatchedBranchId.release.id=`${REPOSITORY}@release/v2.1.3`;

  for (const value of [
    missingId,missingRepository,crossRepository,mismatchedRepositoryId,mismatchedBranchId,
  ]) {
    assert.throws(
      () => deriveWorkItemState(value),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }
});

test("epic child completion controls submit and acceptance eligibility",() => {
  const incomplete=withPhysicalBranch(snapshot("epic"));
  incomplete.children_complete=false;
  assert.deepEqual(
    Object.fromEntries(Object.entries(deriveWorkItemState(incomplete)).filter(([key]) => key!=="reason")),
    {status:"Blocked",gate:"DEPENDENCY_REQUIRED",next_command:"toss-core dependency check"},
  );

  const complete=withPhysicalBranch(snapshot("epic"));
  assert.deepEqual(
    Object.fromEntries(Object.entries(deriveWorkItemState(complete)).filter(([key]) => key!=="reason")),
    {status:"In progress",gate:"NONE",next_command:"toss-core epic submit"},
  );

  const submitted=withCurrentApproval(withPullRequest(snapshot("epic")));
  submitted.authority.epic_acceptance_required=true;
  submitted.children_complete=false;
  assert.equal(deriveWorkItemState(submitted).gate,"DEPENDENCY_REQUIRED");
  submitted.children_complete=true;
  assert.equal(deriveWorkItemState(submitted).gate,"EPIC_ACCEPTANCE_REQUIRED");
});

test("a complete ready epic PR cannot suppress acceptance authority",() => {
  const suppressed=withCurrentApproval(withPullRequest(snapshot("epic")));
  assert.throws(
    () => deriveWorkItemState(suppressed),
    error => error instanceof CoreValidationError && error.exitCode===5,
  );

  const valid=withCurrentApproval(withPullRequest(snapshot("epic")));
  valid.authority.epic_acceptance_required=true;
  assert.deepEqual(
    Object.fromEntries(Object.entries(deriveWorkItemState(valid)).filter(([key]) => key!=="reason")),
    {
      status:"In review",
      gate:"EPIC_ACCEPTANCE_REQUIRED",
      next_command:"toss-core epic accept",
    },
  );

  valid.review.reviewed_revision=HEAD_B;
  assert.equal(deriveWorkItemState(valid).gate,"REVIEW_REQUIRED");
});

test("an explicit READY epic release projection retains the recorded release-approval gate",() => {
  const value=withCurrentApproval(withPullRequest(snapshot("epic")));
  value.authority.release_approval_required=true;

  const result=deriveWorkItemState(value);
  assert.equal(result.status,"In review");
  assert.equal(result.gate,"RELEASE_APPROVAL_REQUIRED");
  assert.equal(result.next_command,"toss-core release approve");

  value.review.reviewed_revision=HEAD_B;
  assert.equal(deriveWorkItemState(value).gate,"REVIEW_REQUIRED");
});

test("merged closed evidence wins over stale readiness review and release flags",() => {
  const value=withPullRequest(snapshot("epic"),"MERGED");
  value.issue_state="CLOSED";
  value.prepared=false;
  value.scope_approved=false;
  value.release.active=false;
  value.blocking_dependencies=[`${REPOSITORY}#41`];
  value.review={verdict:"CHANGES_REQUESTED",reviewed_revision:HEAD_B};
  value.checks={state:"FAILED",revision:HEAD_B};
  value.children_complete=false;

  const result=deriveWorkItemState(value);
  assert.equal(result.status,"Done");
  assert.equal(result.gate,"NONE");
  assert.equal(result.next_command,null);
});

test("impossible snapshots fail validation before any decision rule",() => {
  const mergedOpen=withPullRequest(snapshot(),"MERGED");
  mergedOpen.drifted=true;

  const mergedMismatch=withPullRequest(snapshot(),"MERGED");
  mergedMismatch.issue_state="CLOSED";
  mergedMismatch.pull_request.merged_sha=HEAD_B;

  const closedWithoutMerge=snapshot();
  closedWithoutMerge.issue_state="CLOSED";

  const prWithoutBranch=snapshot();
  prWithoutBranch.pull_request={state:"READY",head_sha:HEAD_A,merged_sha:null};

  const wrongHead=withPullRequest(snapshot());
  wrongHead.physical_branch.head_sha=HEAD_B;

  const reviewWithoutPr=snapshot();
  reviewWithoutPr.review={verdict:"APPROVED",reviewed_revision:HEAD_A};

  const checksWithoutPr=snapshot();
  checksWithoutPr.checks={state:"PASSED",revision:HEAD_A};

  const activeUnassigned=snapshot();
  activeUnassigned.release={
    assigned:false,active:true,id:null,repository:null,branch:null,milestone:null,revision:null,
  };

  const approvedUnprepared=snapshot("epic");
  approvedUnprepared.prepared=false;
  approvedUnprepared.scope_approved=true;

  const contradictoryAuthority=withPullRequest(snapshot("epic"));
  contradictoryAuthority.authority={
    epic_acceptance_required:true,
    release_approval_required:true,
  };

  const wrongEpicAuthority=withPullRequest(snapshot());
  wrongEpicAuthority.authority.epic_acceptance_required=true;

  for (const value of [
    mergedOpen,mergedMismatch,closedWithoutMerge,prWithoutBranch,wrongHead,
    reviewWithoutPr,checksWithoutPr,activeUnassigned,approvedUnprepared,
    contradictoryAuthority,wrongEpicAuthority,
  ]) {
    assert.throws(
      () => deriveWorkItemState(value),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }
});

test("state input is exact detached plain data and hostile values trigger no traps",() => {
  let traps=0;
  const hostile=new Proxy({}, {
    get() { traps+=1; throw new Error("get trap invoked"); },
    getOwnPropertyDescriptor() { traps+=1; throw new Error("descriptor trap invoked"); },
    getPrototypeOf() { traps+=1; throw new Error("prototype trap invoked"); },
    ownKeys() { traps+=1; throw new Error("ownKeys trap invoked"); },
  });
  assert.throws(() => deriveWorkItemState(hostile),CoreValidationError);
  assert.throws(() => deriveWorkItemState({...snapshot(),item:hostile}),CoreValidationError);
  assert.equal(traps,0);

  let getterCalls=0;
  const accessor=snapshot();
  Object.defineProperty(accessor,"drifted",{
    enumerable:true,
    get() { getterCalls+=1; return false; },
  });
  assert.throws(() => deriveWorkItemState(accessor),CoreValidationError);
  assert.equal(getterCalls,0);

  const sparse=snapshot();
  sparse.blocking_dependencies=new Array(2);
  sparse.blocking_dependencies[1]=`${REPOSITORY}#41`;
  assert.throws(() => deriveWorkItemState(sparse),CoreValidationError);

  assert.throws(() => deriveWorkItemState({...snapshot(),unexpected:true}),CoreValidationError);
  assert.throws(() => deriveWorkItemState(Object.assign(Object.create({}),snapshot())),CoreValidationError);

  const mutable=snapshot();
  const result=deriveWorkItemState(mutable);
  mutable.item.branch="issue/43-mutated";
  mutable.blocking_dependencies.push(`${REPOSITORY}#41`);
  assert.equal(result.status,"Ready");
  assert.ok(deeplyFrozen(result));
});

test("blocking reason is raw-order deterministic",() => {
  const first=snapshot();
  first.blocking_dependencies=[`${REPOSITORY}#99`,`${REPOSITORY}#41`];
  const second=snapshot();
  second.blocking_dependencies=[`${REPOSITORY}#41`,`${REPOSITORY}#99`];

  assert.equal(
    canonicalJson(deriveWorkItemState(first)),
    canonicalJson(deriveWorkItemState(second)),
  );
});

test("Project reconciliation emits only differing machine-owned fields",() => {
  const value=snapshot();
  const state=deriveWorkItemState(value);
  const operations=projectReconciliationOperations(value,state,NEXT_RECONCILED_AT);

  assert.deepEqual(operations,[{
    resource:"project",
    action:"update",
    repository:REPOSITORY,
    expected_revision:"project-item-43@7",
    payload:{
      project_id:"PVT_TOSS_OS_2",
      item_id:"PVTI_ISSUE_43",
      fields:{
        Status:"Ready",
        Gate:"NONE",
        last_reconciled_at:NEXT_RECONCILED_AT,
      },
    },
  }]);
  assert.ok(deeplyFrozen(operations));

  const intent=createOperationIntent({
    intent_id:"INTENT-20260901-0043",
    created_at:NEXT_RECONCILED_AT,
    command:"sync",
    policy_revision:"POLICY-0001",
    source:{repository:REPOSITORY,revision:"github-snapshot@43",sha256:"c".repeat(64)},
    authority:null,
    operations,
  });
  assert.equal(intent.operations[0].resource,"project");
});

test("Project reconciliation validates and corrects repository parent and milestone with all eight machine fields",() => {
  const value=snapshot();
  Object.assign(value.project.fields,{
    repository:"TOSS-Soft/wrong-repository",
    parent:null,
    milestone:"v9.9.9",
  });
  const state=deriveWorkItemState(value);

  const operations=projectReconciliationOperations(value,state,NEXT_RECONCILED_AT);

  assert.deepEqual(operations[0].payload.fields,{
    Status:"Ready",
    Gate:"NONE",
    repository:REPOSITORY,
    parent:`${REPOSITORY}#42`,
    milestone:"v2.2.0",
    last_reconciled_at:NEXT_RECONCILED_AT,
  });
});

test("Project reconciliation is a semantic no-op and treats time as an observed field",() => {
  const value=snapshot();
  const state=deriveWorkItemState(value);
  value.project.fields.Status=state.status;
  value.project.fields.Gate=state.gate;

  assert.deepEqual(projectReconciliationOperations(value,state,RECONCILED_AT),[]);
  assert.deepEqual(projectReconciliationOperations(value,state,NEXT_RECONCILED_AT),[{
    resource:"project",
    action:"update",
    repository:REPOSITORY,
    expected_revision:"project-item-43@7",
    payload:{
      project_id:"PVT_TOSS_OS_2",
      item_id:"PVTI_ISSUE_43",
      fields:{last_reconciled_at:NEXT_RECONCILED_AT},
    },
  }]);
});

test("Project reconciliation corrects branch fields in deterministic operation order",() => {
  const first=snapshot();
  first.project.fields={
    last_reconciled_at:RECONCILED_AT,
    base_branch:"epic/41-old-parent",
    branch:"issue/41-old-reservation",
    milestone:first.item.milestone,
    parent:first.item.parent_id,
    repository:first.item.repository,
    Gate:"NONE",
    Status:"Ready",
  };
  const second=structuredClone(first);
  second.project.fields={
    Status:"Ready",
    Gate:"NONE",
    repository:second.item.repository,
    parent:second.item.parent_id,
    milestone:second.item.milestone,
    branch:"issue/41-old-reservation",
    base_branch:"epic/41-old-parent",
    last_reconciled_at:RECONCILED_AT,
  };
  const state=deriveWorkItemState(first);

  const firstOperations=projectReconciliationOperations(first,state,RECONCILED_AT);
  const secondOperations=projectReconciliationOperations(second,state,RECONCILED_AT);
  assert.equal(canonicalJson(firstOperations),canonicalJson(secondOperations));
  assert.deepEqual(firstOperations[0].payload.fields,{
    branch:"issue/43-derive-visible-state",
    base_branch:"epic/42-organizational-lifecycle",
  });
});

test("Project reconciliation rejects forged state time and hostile evidence",() => {
  const value=snapshot();
  const state=deriveWorkItemState(value);
  const forged={...state,status:"Done"};
  assert.throws(
    () => projectReconciliationOperations(value,forged,NEXT_RECONCILED_AT),
    CoreValidationError,
  );
  for (const timestamp of ["2026-02-30T12:00:00.000Z","yesterday",null]) {
    assert.throws(
      () => projectReconciliationOperations(value,state,timestamp),
      CoreValidationError,
    );
  }

  let traps=0;
  const hostile=new Proxy({}, {
    get() { traps+=1; throw new Error("get trap invoked"); },
    getOwnPropertyDescriptor() { traps+=1; throw new Error("descriptor trap invoked"); },
    getPrototypeOf() { traps+=1; throw new Error("prototype trap invoked"); },
    ownKeys() { traps+=1; throw new Error("ownKeys trap invoked"); },
  });
  assert.throws(
    () => projectReconciliationOperations(value,hostile,NEXT_RECONCILED_AT),
    CoreValidationError,
  );
  assert.equal(traps,0);
});
