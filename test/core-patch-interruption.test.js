import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";

import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {authorityReference} from "../src/core/authority.js";
import {dispatchCoreCommand,parseCoreCommand} from "../src/core/commands/router.js";
import {runPatchInterruptionStep} from "../src/core/commands/release.js";
import {CoreConflictError,CoreValidationError} from "../src/core/errors.js";
import {createOperationIntent,validateOperationIntent} from "../src/core/operations/plan.js";
import {validatePersistedOperationIntent} from "../src/core/operations/intent-contract.js";
import {createOperationRunner} from "../src/core/operations/runner.js";
import {updateManagedReviewBlock} from "../src/core/review/body.js";
import {
  patchCompletionSource,projectPatchCompletionTransaction,
} from "../src/core/release/patch-completion-projector.js";
import {
  completePatchInterruption,patchVersionFor,planPatchInterruption,
} from "../src/core/release/patch.js";
import {programStatusResult,releaseStatusResult} from "../src/core/release/operations.js";
import {approvalOperations,publicationOperations,publicationSource,
  releasePublicationQuery} from "../src/core/release/verification.js";
import {transitionRepositoryRelease} from "../src/core/release/state.js";

const CONTROL_REPOSITORY="TOSS-Soft/toss-os-control";
const REPOSITORY="TOSS-Soft/toss-cli";
const OTHER_REPOSITORY="TOSS-Soft/toss-console";
const BUG=`${REPOSITORY}#55`;
const FEATURE=`${REPOSITORY}#10`;
const NOW="2026-09-03T10:00:00.000Z";
const MAIN_SHA="a".repeat(40);
const PATCH_SHA="f".repeat(40);
const MERGED_SHA="9".repeat(40);
const EPIC_HEAD="1".repeat(40);
const CHILD_HEAD="2".repeat(40);
const FEATURE_RELEASE_HEAD="3".repeat(40);
const LATER_MAIN_SHA="4".repeat(40);
const SECOND_MERGED_SHA="8".repeat(40);
const RECONCILED_AT="2026-09-03T10:10:00.000Z";
const REVIEW_GATE_AT="2026-09-03T10:20:00.000Z";
const REREVIEWED_AT="2026-09-03T10:30:00.000Z";
const PACKAGE_SRI=`sha512-${"A".repeat(86)}==`;

function releaseId(programId,repository=REPOSITORY) {
  return `REL-${programId}-${createHash("sha256").update(repository,"utf8").digest("hex")}`;
}

function releasePrIntent(version,programId="TOSS-OS-R0001",repository=REPOSITORY) {
  return {
    intent_id:`RELEASE-PR-INTENT-${BigInt(`0x${sha256Canonical(releaseId(programId,repository))}`).toString(10)}`,
    head:`release/v${version}`,base:"main",expected_head_revision:MAIN_SHA,recorded_at:NOW,
  };
}

function featureProgram({repository=REPOSITORY,programId="TOSS-OS-R0001",
  feature=`${repository}#10`}={}) {
  const release={
    schema_version:"repository-release.v1",release_id:releaseId(programId,repository),
    program_id:programId,repository,phase:"ACTIVE",revision:"REV-0002",
    version:"2.2.0",milestone:"v2.2.0",branch:"release/v2.2.0",
    release_pr_intent:releasePrIntent("2.2.0",programId,repository),scope:[feature],approval:null,
    publication_evidence:null,
    transitions:[{event:"ACTIVATE",source_phase:"DRAFT",target_phase:"ACTIVE",timestamp:NOW,
      source_receipt:"RECEIPT-20260903-0001"}],
  };
  return {
    schema_version:"release-program.v1",program_id:programId,phase:"ACTIVE",
    revision:"REV-0002",repository_releases:[release],
    dependency_stages:[{stage:1,repository_release_ids:[release.release_id]}],
    selected_scope:[{epic_id:feature,outcome:"feature-release",eligibility:{approved:true,
      unversioned:true,decomposed:true,registered_repository:true,unassigned:true}}],
    deferred_scope:[],rationale:[{repository,version:"2.2.0",change_class:"minor",
      reasons:[{rule:"backward_compatible_feature",scope_ids:[feature]}]}],interrupts:null,
    created_at:NOW,updated_at:NOW,
  };
}

function organization() {
  return {schema_version:"organization-config.v1",organization:"TOSS-Soft",
    project:{node_id:"PVT_TOSS_OS_2",number:2},control_repository:CONTROL_REPOSITORY,
    policy_revision:"POLICY-0001",repositories:[REPOSITORY]};
}

function repositoryConfiguration() {
  return {schema_version:"repository-config.v1",repository:REPOSITORY,
    repository_node_id:"R_toss_cli",default_branch:"main",active_release:null,
    project_item_id:"PVTI_toss_cli",project_fields:{status:"Status",gate:"Gate"},
    publication:{package_name:"@toss-software/cli",workflow:"publish.yml",required_assets:[]},
    registered_at:"2026-09-01T08:00:00.000Z"};
}

function otherRepositoryConfiguration() {
  return {...repositoryConfiguration(),repository:OTHER_REPOSITORY,
    repository_node_id:"R_toss_console",project_item_id:"PVTI_toss_console"};
}

function bugWork() {
  return {schema_version:"work-state-snapshot.v1",item:{schema_version:"work-item.v1",id:BUG,
    repository:REPOSITORY,issue_number:55,kind:"bug",parent_id:null,
    branch:"bug/55-production-receipt",base_branch:null,milestone:null,
    status:"Backlog",gate:"RELEASE_PLANNING"},issue_state:"OPEN",drifted:false,
  epic_required:false,prepared:null,scope_approved:null,parent:null,
  release:{assigned:false,active:false,id:null,repository:null,branch:null,milestone:null,revision:null},
  blocking_dependencies:[],children_complete:null,physical_branch:{exists:false,head_sha:null},
  pull_request:null,review:null,checks:null,
  authority:{epic_acceptance_required:false,release_approval_required:false},
  project:{project_id:"PVT_TOSS_OS_2",item_id:"PVTI_bug_55",revision:"project-bug-1",
    fields:{Status:"Backlog",Gate:"RELEASE_PLANNING",repository:REPOSITORY,parent:null,
      milestone:null,branch:"bug/55-production-receipt",base_branch:null,
      last_reconciled_at:"2026-09-03T09:00:00.000Z"}}};
}

function issueStartSnapshot(work=bugWork(),base=null,affected="2.1.2",patch="2.1.3") {
  return {kind:"issue-start",source:{repository:REPOSITORY,revision:"repository-1",
    sha256:"b".repeat(64)},repository_revision:"repository-1",work,branch:null,base:null,
  pull_request:null,bug_lineage:{classification:"patch",affected_version:affected,
    patch_version:patch},...(base===null ? {} : {base})};
}

function publicationEvidence() {
  const evidence={schema_version:"publication-evidence.v1",evidence_id:"PUB-20260903-0002",
    release_id:"REL-published-2.1.2",repository:REPOSITORY,version:"2.1.2",
    expected_revision:MAIN_SHA,tag:{name:"v2.1.2",target_revision:MAIN_SHA},
    package:{name:"@toss-software/cli",version:"2.1.2",integrity:PACKAGE_SRI},
    github_release:{release_id:"R_2_1_2",tag_name:"v2.1.2",target_revision:MAIN_SHA,
      draft:false,prerelease:false,assets:[{name:"toss-cli-2.1.2.tgz",sha256:"c".repeat(64)}]},
    source_receipt:"RECEIPT-20260903-0002",verified_at:NOW};
  return {...evidence,evidence_sha256:sha256Canonical(evidence)};
}

function patchApproval(release,manifestRevision) {
  const commits=[{revision:PATCH_SHA,author:"implementation-author",
    committer:"release-committer"}];
  const result={schema_version:"review-result.v1",review_id:"REVIEW-20260903-0055",
    repository:release.repository,pull_request_number:55,reviewed_revision:PATCH_SHA,
    reviewer:{identity:"release-reviewer",role:"independent-reviewer"},verdict:"APPROVED",
    freshness:"CURRENT",findings:[],unresolved:[],
    verification_evidence:["test:patch-release"],follow_up_issues:[],
    reviewed_at:NOW,recorded_at:NOW};
  return {schema_version:"release-approval.v1",source_receipt:"RECEIPT-20260903-0201",
    authority:{record_id:"AUTH-20260903-0001",sha256:"d".repeat(64)},
    program_id:release.program_id,release_id:release.release_id,
    manifest_revision:manifestRevision,manifest_sha256:"e".repeat(64),
    pull_request:{number:55,revision:"release-pr-55",head:release.branch,
      head_sha:PATCH_SHA,base:"main",base_sha:MAIN_SHA,base_revision:"base-main-55"},
    review:{revision:"release-review-revision-55",result,
      formal_review:{state:"APPROVED",review_id:result.review_id,
        reviewed_revision:PATCH_SHA,revision:"formal-release-review-55"},
      implementation_identity:{base_revision:MAIN_SHA,revision:PATCH_SHA,
        pull_request_author:"implementation-author",commit_count:commits.length,
        commits_sha256:sha256Canonical(commits),commits}},
    scope:[{id:release.scope[0],revision:"issue-55-1",project_item_id:"PVTI_55",
      project_revision:"project-item-55",status:"Done",gate:"RELEASE_APPROVAL_REQUIRED"}],
    required_checks:["build"],
    checks:[{name:"build",revision:"release-check-build-55",head_sha:PATCH_SHA,
      conclusion:"SUCCESS"}],
    rules_revision:"rules-55",policy_revision:"POLICY-0001",
    publication:{package_name:"@toss-software/cli",workflow:"publish.yml",
      required_assets:["toss-cli-2.1.3.tgz"]},merge_result_revision:PATCH_SHA,approved_at:NOW};
}

function patchSnapshotBody(state,program,work=bugWork(),affected="2.1.2") {
  const patches=state.programs.filter(value => value.interrupts!==null);
  const patchRelease=patches.at(-1)?.repository_releases[0] ?? null;
  return {kind:"patch-interruption",control_revision:state.revision,
    project:{id:"PVT_TOSS_OS_2",revision:"project-patch-1"},
    feature:{program_id:program.program_id,program_revision:program.revision,
      release_id:program.repository_releases[0].release_id,
      release_revision:program.repository_releases[0].revision},
    patch_program_revisions:patches.map(value => ({program_id:value.program_id,
      revision:value.revision,phase:value.phase,
      release_id:value.repository_releases[0].release_id,
      release_revision:value.repository_releases[0].revision,
      scope:value.repository_releases[0].scope})),
    bug:{id:BUG,revision:"issue-55-1",affected_version:affected,
      work_sha256:sha256Canonical(work)},latest_published:publicationEvidence(),
    repository:{repository:REPOSITORY,revision:"repository-1",
      default_branch:{name:"main",revision:"main-1",head_sha:MAIN_SHA},
      milestone:patchRelease===null ? null : {title:patchRelease.milestone,state:"OPEN",
        revision:"milestone-2.1.3"},
      release_branch:patchRelease===null ? null : {name:patchRelease.branch,
        base_branch:"main",head_sha:MAIN_SHA,revision:"branch-2.1.3"}}};
}

function pausedFeatureProgram(program=featureProgram()) {
  const release=transitionRepositoryRelease(program.repository_releases[0],{
    event:"PAUSE_FOR_PATCH",expected_revision:"REV-0002",timestamp:NOW,
    source_receipt:"RECEIPT-20260903-0100",activation:null});
  return {...program,phase:"PAUSED",revision:"REV-0003",repository_releases:[release],
    updated_at:NOW};
}

function activePatchProgram(paused,scope=BUG,{programId="TOSS-OS-R0002",
  repository=REPOSITORY}={}) {
  const identity=releaseId(programId,repository);
  const intentId=`RELEASE-PR-INTENT-${BigInt(`0x${sha256Canonical(identity)}`).toString(10)}`;
  const release={schema_version:"repository-release.v1",release_id:identity,
    program_id:programId,repository,phase:"ACTIVE",revision:"REV-0002",
    version:"2.1.3",milestone:"v2.1.3",branch:"release/v2.1.3",
    release_pr_intent:{intent_id:intentId,head:"release/v2.1.3",base:"main",
      expected_head_revision:MAIN_SHA,recorded_at:NOW},scope:[scope],approval:null,
    publication_evidence:null,
    transitions:[{event:"ACTIVATE",source_phase:"DRAFT",target_phase:"ACTIVE",
      timestamp:NOW,source_receipt:"RECEIPT-20260903-0101"}]};
  return {schema_version:"release-program.v1",program_id:programId,phase:"ACTIVE",
    revision:"REV-0001",repository_releases:[release],
    dependency_stages:[{stage:1,repository_release_ids:[identity]}],
    selected_scope:[{epic_id:scope,outcome:"production-patch",eligibility:{approved:true,
      unversioned:true,decomposed:true,registered_repository:true,unassigned:true}}],
    deferred_scope:[],rationale:[{repository,version:"2.1.3",change_class:"patch",
      reasons:[{rule:"published_product_fix",scope_ids:[scope]}]}],
    interrupts:{program_id:paused.program_id,
      repository_release_id:paused.repository_releases[0].release_id,
      paused_release_revision:paused.repository_releases[0].revision},created_at:NOW,updated_at:NOW};
}

function linkedStatusSnapshot(state,kind,program,patchLink) {
  const release=program.repository_releases[0];
  const body={kind,control_revision:state.revision,
    program_revisions:state.programs.map(value => ({program_id:value.program_id,
      revision:value.revision})),
    project:{id:"PVT_TOSS_OS_2",revision:"project-status-1"},
    repositories:[{program_id:program.program_id,repository:release.repository,
      repository_revision:"repository-status-1",release_id:release.release_id,
      release_revision:release.revision,
      milestone:{title:release.milestone,state:"OPEN",revision:"milestone-status-1"},
      branch:{name:release.branch,base_branch:"main",head_sha:MAIN_SHA,
        revision:"branch-status-1"},release_pull_request:null,
      scope:program.selected_scope.filter(value => release.scope.includes(value.epic_id)),
      gates:[],checks:[],patch_link:patchLink}]};
  return {...body,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
    sha256:sha256Canonical({control:state,github:body})}};
}

function statelessPublicStatusSnapshot(query) {
  const manifests=Array.isArray(query.programs) ? query.programs : [];
  const selected=query.kind==="release-status"
    ? (query.program===null ? [] : [query.program])
    : (Array.isArray(query.selected_programs) ? query.selected_programs : manifests);
  const patchLink=(program,release) => {
    if (program.interrupts!==null) return program.interrupts.program_id;
    if (release.phase!=="PAUSED") return null;
    const matches=manifests.filter(candidate => candidate.interrupts!==null &&
      candidate.interrupts.program_id===program.program_id &&
      candidate.interrupts.repository_release_id===release.release_id &&
      candidate.interrupts.paused_release_revision===release.revision);
    return matches.length===1 ? matches[0].program_id : null;
  };
  return {kind:query.kind,control_revision:query.control_revision,
    program_revisions:manifests.map(program => ({program_id:program.program_id,
      revision:program.revision})),
    project:{id:query.project.node_id,revision:"project-status-public"},
    repositories:selected.flatMap(program => program.repository_releases.map(release => ({
      program_id:program.program_id,repository:release.repository,
      repository_revision:"repository-status-public",release_id:release.release_id,
      release_revision:release.revision,
      milestone:release.milestone===null ? null : {title:release.milestone,state:"OPEN",
        revision:"milestone-status-public"},
      branch:release.branch===null ? null : {name:release.branch,base_branch:"main",
        head_sha:MAIN_SHA,revision:"branch-status-public"},release_pull_request:null,
      scope:program.selected_scope.filter(value => release.scope.includes(value.epic_id)),
      gates:[],checks:[],patch_link:patchLink(program,release),
    })))};
}

async function startIssueWithSnapshot(snapshot) {
  return dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services:{
    github:{async snapshot() { return snapshot; }},
    operations:{async execute() { throw new Error("must not execute"); }},
    clock:() => NOW,
  }});
}

function completedIntent(program,previewOperations,{receiptId="RECEIPT-20260903-0100",
  intentId="INTENT-20260903-0100",sourceRevision="control-1"}={}) {
  const operations=previewOperations.map(({operation_id:_operationId,...operation}) => operation);
  const intent=createOperationIntent({intent_id:intentId,created_at:NOW,
    command:"issue.start",policy_revision:"POLICY-0001",
    source:{repository:CONTROL_REPOSITORY,revision:sourceRevision,sha256:"e".repeat(64)},
    authority:null,planned_receipt_id:receiptId,operations});
  assert.equal(canonicalJson(intent.operations.find(operation =>
    operation.payload.kind==="release-program-manifest").payload.program),canonicalJson(program));
  const receipt={schema_version:"operation-receipt.v1",document_type:"operation-receipt",
    receipt_id:intent.planned_receipt_id,intent_id:intent.intent_id,
    intent_sha256:sha256Canonical(intent),created_at:NOW,status:"completed",
    observed_revisions:intent.operations.map(operation => ({operation_id:operation.operation_id,
      repository:operation.repository,revision:operation.payload.kind==="release-program-manifest"
        ? program.revision : operation.expected_revision}))};
  return {intent,receipt};
}

function assignedBugWork(patch) {
  const release=patch.repository_releases[0];
  const work=bugWork();
  return {...work,item:{...work.item,status:"Ready",gate:"NONE",
    base_branch:release.branch,milestone:release.milestone},
  release:{assigned:true,active:true,id:`${REPOSITORY}@${release.branch}`,
    repository:REPOSITORY,branch:release.branch,milestone:release.milestone,
    revision:release.revision},project:{...work.project,fields:{...work.project.fields,
      Status:"Ready",Gate:"NONE",base_branch:release.branch,milestone:release.milestone,
      last_reconciled_at:NOW}}};
}

function releasedPatchProgram(active) {
  let release=transitionRepositoryRelease(active.repository_releases[0],{
    event:"SCOPE_DONE",expected_revision:active.repository_releases[0].revision,
    timestamp:NOW,source_receipt:"RECEIPT-20260903-0200",activation:null});
  const ready={...active,phase:"ACTIVE",revision:"REV-0002",
    repository_releases:[release],updated_at:NOW};
  const pausedId=active.interrupts.program_id;
  const pausedReleaseId=active.interrupts.repository_release_id;
  const pausedRelease={...featureProgram().repository_releases[0],release_id:pausedReleaseId,
    revision:active.interrupts.paused_release_revision,phase:"PAUSED",
    transitions:[...featureProgram().repository_releases[0].transitions,
      {event:"PAUSE_FOR_PATCH",source_phase:"ACTIVE",target_phase:"PAUSED",timestamp:NOW,
        source_receipt:"RECEIPT-20260903-0100"}]};
  const paused={...featureProgram(),program_id:pausedId,phase:"PAUSED",revision:"REV-0003",
    repository_releases:[pausedRelease],updated_at:NOW};
  const suffix=Number(active.program_id.match(/([0-9]+)$/u)[1]);
  const approvalReceipt=`RECEIPT-20260903-${20000+suffix*10+1}`;
  const publicationReceipt=`RECEIPT-20260903-${20000+suffix*10+2}`;
  const authority={schema_version:"authority-record.v1",document_type:"authority-record",
    record_id:`AUTH-20260903-${20000+suffix*10+1}`,actor:"release-manager",
    command:"release.approve",targets:[REPOSITORY],
    expected_revisions:[{repository:REPOSITORY,revision:"repository-release-55"}],
    policy_revision:"POLICY-0001",issued_at:"2026-09-03T09:00:00.000Z",
    expires_at:"2026-09-03T11:00:00.000Z",
    signature:{algorithm:"ed25519",key_id:"release-key",value:`${"A".repeat(86)}==`}};
  const approvalState={revision:`control-approval-${suffix}`,organization:organization(),
    repositories:[repositoryConfiguration()],programs:[paused,ready],intents:[],receipts:[]};
  const review=patchApproval(release,ready.revision).review;
  const githubApproval={kind:"release-approval",control_revision:approvalState.revision,
    project:{id:"PVT_TOSS_OS_2",revision:"project-release-55"},
    repository:{repository:REPOSITORY,revision:"repository-release-55",
      rules_revision:"rules-55",required_checks:["build"],workflow_revision:"workflow-55"},
    pull_request:{number:55,revision:"release-pr-55",head:release.branch,head_sha:PATCH_SHA,
      base:"main",base_sha:MAIN_SHA,base_revision:"base-main-55",state:"OPEN",draft:false},
    scope:[{id:BUG,revision:"issue-55-release",project_item_id:"PVTI_bug_55",
      project_revision:"project-bug-release",status:"Done",gate:"RELEASE_APPROVAL_REQUIRED"}],
    review,checks:[{name:"build",revision:"release-check-build-55",head_sha:PATCH_SHA,
      conclusion:"SUCCESS"}]};
  const approvalSnapshot={...githubApproval,source:{repository:CONTROL_REPOSITORY,
    revision:approvalState.revision,
    sha256:sha256Canonical({control:approvalState,github:githubApproval})}};
  const approved=approvalOperations({planningState:approvalState,programId:ready.program_id,
    releaseId:release.release_id,snapshot:approvalSnapshot,receiptId:approvalReceipt,
    authority,clock:() => NOW});
  const approvalIntent=createOperationIntent({intent_id:`INTENT-20260903-${20000+suffix*10+1}`,
    created_at:NOW,command:"release.approve",policy_revision:"POLICY-0001",
    source:approved.source,authority:authorityReference(authority),
    planned_receipt_id:approvalReceipt,operations:approved.operations});
  const approvalTransaction={schema_version:"operation-receipt.v1",
    document_type:"operation-receipt",receipt_id:approvalReceipt,intent_id:approvalIntent.intent_id,
    intent_sha256:sha256Canonical(approvalIntent),created_at:NOW,status:"completed",
    observed_revisions:approvalIntent.operations.map(operation => ({
      operation_id:operation.operation_id,repository:operation.repository,
      revision:operation.payload.kind==="release-program-manifest" ? approved.program.revision
        : operation.payload.kind==="release-pull-request-merge" ? PATCH_SHA
          : operation.payload.kind==="release-publication-workflow" ? PATCH_SHA
            : operation.expected_revision}))};
  const publicationState={...approvalState,revision:`control-publication-${suffix}`,
    programs:[paused,approved.program],intents:[approvalIntent],receipts:[approvalTransaction]};
  const githubPublication={kind:"release-publication",
    control_revision:publicationState.revision,repository_revision:"repository-published-55",
    publication:{tag:{name:"v2.1.3",target_revision:PATCH_SHA},
      package:{name:"@toss-software/cli",version:"2.1.3",integrity:PACKAGE_SRI},
      github_release:{release_id:"R_2_1_3",tag_name:"v2.1.3",target_revision:PATCH_SHA,
        draft:false,prerelease:false,assets:[]}},
    planning:{candidates:[],completed:[BUG],repositories:[{
      repository:REPOSITORY,latest_published_version:"2.1.3"}]}};
  const publicationQuery=releasePublicationQuery(publicationState,ready.program_id,
    release.release_id);
  const publicationSnapshot={...githubPublication,
    source:publicationSource(publicationQuery,githubPublication)};
  const published=publicationOperations({planningState:publicationState,
    programId:ready.program_id,releaseId:release.release_id,snapshot:publicationSnapshot,
    receiptId:publicationReceipt,clock:() => NOW});
  const publicationIntent=createOperationIntent({
    intent_id:`INTENT-20260903-${20000+suffix*10+2}`,created_at:NOW,
    command:"release.approve",policy_revision:"POLICY-0001",source:published.source,
    authority:null,planned_receipt_id:publicationReceipt,operations:published.operations});
  const publicationTransaction={schema_version:"operation-receipt.v1",
    document_type:"operation-receipt",receipt_id:publicationReceipt,
    intent_id:publicationIntent.intent_id,intent_sha256:sha256Canonical(publicationIntent),
    created_at:NOW,status:"completed",observed_revisions:publicationIntent.operations.map(
      operation => ({operation_id:operation.operation_id,repository:operation.repository,
        revision:operation.payload.kind==="release-program-manifest-set"
          ? operation.payload.resulting_set_sha256 : operation.expected_revision}))};
  return {publication:published.evidence,program:published.program,nextProgram:published.nextProgram,
    intents:[approvalIntent,publicationIntent],receipts:[approvalTransaction,publicationTransaction]};
}

function completionReviewResult(freshness="CURRENT") {
  return {schema_version:"review-result.v1",review_id:"REVIEW-20260903-0300",
    repository:REPOSITORY,pull_request_number:10,reviewed_revision:MAIN_SHA,
    reviewer:{identity:"independent-reviewer",role:"independent-reviewer"},
    verdict:"APPROVED",freshness,findings:[],unresolved:[],
    verification_evidence:["node --test test/core-patch-interruption.test.js"],
    follow_up_issues:[],reviewed_at:NOW,recorded_at:NOW};
}

function completionReviewWork(featureHead,reviewResult) {
  return {schema_version:"work-state-snapshot.v1",item:{schema_version:"work-item.v1",
    id:FEATURE,repository:REPOSITORY,issue_number:10,kind:"epic",parent_id:null,
    branch:"epic/10-feature",base_branch:"release/v2.2.0",milestone:"v2.2.0",
    status:"In review",gate:reviewResult.freshness==="STALE" ? "REVIEW_REQUIRED" : "NONE"},
  issue_state:"OPEN",drifted:false,epic_required:false,prepared:true,scope_approved:true,
  parent:null,release:{assigned:true,active:true,id:`${REPOSITORY}@release/v2.2.0`,
    repository:REPOSITORY,branch:"release/v2.2.0",milestone:"v2.2.0",revision:"REV-0003"},
  blocking_dependencies:[],children_complete:true,
  physical_branch:{exists:true,head_sha:featureHead},
  pull_request:{state:"READY",head_sha:featureHead,merged_sha:null},
  review:{verdict:reviewResult.verdict,reviewed_revision:reviewResult.reviewed_revision},
  checks:{state:"PASSED",revision:reviewResult.reviewed_revision},
  authority:{epic_acceptance_required:true,release_approval_required:false},
  project:{project_id:"PVT_TOSS_OS_2",item_id:"PVTI_feature_10",
    revision:"project-feature-10",fields:{Status:"In review",
      Gate:reviewResult.freshness==="STALE" ? "REVIEW_REQUIRED" : "NONE",
      repository:REPOSITORY,parent:null,milestone:"v2.2.0",branch:"epic/10-feature",
      base_branch:"release/v2.2.0",last_reconciled_at:NOW}}};
}

function completionSnapshot({patch,paused,publication,ancestor=false,drifted=false,
  featureHead=MAIN_SHA,reviewFreshness="CURRENT",checksState="NOT_STARTED"}) {
  const feature=paused.repository_releases[0];
  const current=assignedWorkItem(feature,{number:10,head:featureHead,kind:"epic",
    reviewId:"REVIEW-20260903-0300",recordedAt:NOW});
  const items=[reviewFreshness==="STALE"
    ? assignedWorkItem(feature,{number:10,head:featureHead,kind:"epic",
      reviewId:"REVIEW-20260903-0300",recordedAt:NOW,freshness:"STALE"})
    : current];
  const reconciliation=ancestor ? completionPhaseEvidence({kind:"reconciliation",paused,patch,
    publication,featureHead,currentMain:PATCH_SHA,createdAt:RECONCILED_AT,
    intentId:"INTENT-20260903-0301",receiptId:"RECEIPT-20260903-0301"}) : null;
  const reviewGate=reviewFreshness==="STALE" ? completionPhaseEvidence({kind:"review_gate",
    paused,patch,publication,featureHead,currentMain:PATCH_SHA,items:[current],
    phaseEvidence:{reconciliation,review_gate:null},
    createdAt:REVIEW_GATE_AT,intentId:"INTENT-20260903-0302",
    receiptId:"RECEIPT-20260903-0302"}) : null;
  const snapshot=ruledCompletionSnapshot({patch,paused,publication,currentMain:PATCH_SHA,
    featureHead,reconciled:ancestor,items,
    phaseEvidence:{reconciliation,review_gate:reviewGate},checksState});
  snapshot.observation.repository.reconciliation.drifted=drifted;
  return rehashCompletionSnapshot(snapshot);
}

function completionFixture() {
  const paused=pausedFeatureProgram();
  const released=releasedPatchProgram(activePatchProgram(paused));
  return {paused,patch:released.program,publication:released.publication,
    next:released.nextProgram,intents:released.intents,receipts:released.receipts};
}

function rehashCompletionSnapshot(snapshot) {
  const sourceQuery=snapshot.observation.repository.reconciliation
    .current_default_is_ancestor_of_feature_release
    ? snapshot.query : {...snapshot.query,
      phase_evidence:{reconciliation:null,review_gate:null}};
  snapshot.source.sha256=sha256Canonical({control:sourceQuery,
    github:snapshot.observation});
  return snapshot;
}

function makeCompletionChildReview(snapshot,{parentId=FEATURE}={}) {
  const review=structuredClone(snapshot.observation.assigned_work.items[0]);
  const childId=`${REPOSITORY}#11`;
  const parentBranch=`epic/${parentId.slice(parentId.lastIndexOf("#")+1)}-feature`;
  review.pull_request.number=11;
  review.review={...review.review,pull_request_number:11,
    review_id:"REVIEW-20260903-0311"};
  review.pull_request.head_branch="issue/11-governed-child";
  review.pull_request.base_branch=parentBranch;
  review.pull_request.body=updateManagedReviewBlock("Human context.",review.review);
  review.pull_request.formal_review.review_id=review.review.review_id;
  review.work={...review.work,
    item:{...review.work.item,id:childId,issue_number:11,kind:"issue",parent_id:parentId,
      acceptance_criteria:["The governed child remains reviewable after patch reconciliation."],
      branch:"issue/11-governed-child",base_branch:parentBranch,milestone:"v2.2.0",gate:"NONE"},
    prepared:null,scope_approved:null,children_complete:null,
    parent:{id:parentId,branch:parentBranch,revision:"issue-10-1"},
    authority:{epic_acceptance_required:false,release_approval_required:false},
    project:{...review.work.project,item_id:"PVTI_issue_11",revision:"project-issue-11",
      fields:{...review.work.project.fields,Gate:"NONE",parent:parentId,
        branch:"issue/11-governed-child",base_branch:parentBranch}}};
  snapshot.observation.assigned_work.items.push(review);
  snapshot.observation.assigned_work.work_item_ids.push(childId);
  return review;
}

function governedReviewResult({number,head,reviewId,recordedAt=NOW,freshness="CURRENT"}) {
  return {schema_version:"review-result.v1",review_id:reviewId,
    repository:REPOSITORY,pull_request_number:number,reviewed_revision:head,
    reviewer:{identity:"independent-reviewer",role:"independent-reviewer"},
    verdict:"APPROVED",freshness,findings:[],unresolved:[],
    verification_evidence:["node --test test/core-patch-interruption.test.js"],
    follow_up_issues:[],reviewed_at:recordedAt,recorded_at:recordedAt};
}

function assignedFeatureWork(feature,{number,head,kind="issue",parentId=FEATURE,
  reviewResult=null,hasPullRequest=true}={}) {
  const id=`${REPOSITORY}#${number}`;
  const epic=kind==="epic";
  const branch=epic ? "epic/10-feature" : `issue/${number}-governed-child`;
  const baseBranch=epic ? feature.branch : "epic/10-feature";
  const status=hasPullRequest ? "In review" : "In progress";
  const gate=reviewResult?.freshness==="STALE" ? "REVIEW_REQUIRED" :
    hasPullRequest && epic ? "EPIC_ACCEPTANCE_REQUIRED" : "NONE";
  return {schema_version:"work-state-snapshot.v1",item:{schema_version:"work-item.v1",
    id,repository:REPOSITORY,issue_number:number,kind,parent_id:epic ? null : parentId,
    ...(epic ? {} : {acceptance_criteria:["The governed child remains complete after reconciliation."]}),
    branch,base_branch:baseBranch,milestone:feature.milestone,status,gate},
  issue_state:"OPEN",drifted:false,epic_required:false,
  prepared:epic ? true : null,scope_approved:epic ? true : null,
  parent:epic ? null : {id:parentId,branch:"epic/10-feature",revision:"issue-10-1"},
  release:{assigned:true,active:true,id:`${REPOSITORY}@${feature.branch}`,
    repository:REPOSITORY,branch:feature.branch,milestone:feature.milestone,
    revision:feature.revision},blocking_dependencies:[],children_complete:epic ? true : null,
  physical_branch:{exists:true,head_sha:head},
  pull_request:hasPullRequest ? {state:"READY",head_sha:head,merged_sha:null} : null,
  review:reviewResult?.freshness==="CURRENT"
    ? {verdict:reviewResult.verdict,reviewed_revision:reviewResult.reviewed_revision} : null,
  checks:hasPullRequest ? {state:"PASSED",revision:head} : null,
  authority:{epic_acceptance_required:epic,release_approval_required:false},
  project:{project_id:"PVT_TOSS_OS_2",item_id:`PVTI_${number}`,
    revision:`project-${number}-completion`,fields:{Status:status,Gate:gate,
      repository:REPOSITORY,parent:epic ? null : parentId,milestone:feature.milestone,
      branch,base_branch:baseBranch,last_reconciled_at:NOW}}};
}

function assignedWorkItem(feature,{number,head,kind="issue",parentId=FEATURE,
  reviewId=`REVIEW-20260903-${String(number).padStart(4,"0")}`,recordedAt=NOW,
  freshness="CURRENT",hasPullRequest=true}={}) {
  const review=hasPullRequest ? governedReviewResult({number,head,reviewId,recordedAt,freshness}) : null;
  const work=assignedFeatureWork(feature,{number,head,kind,parentId,reviewResult:review,hasPullRequest});
  return {work,pull_request:hasPullRequest ? {repository:REPOSITORY,number,
    revision:`pr-${number}-completion`,head_branch:work.item.branch,
    base_branch:work.item.base_branch,head_sha:head,
    body:updateManagedReviewBlock("Human context.",review),
    formal_review:{state:"APPROVED",review_id:review.review_id,
      reviewed_revision:review.reviewed_revision}} : null,review};
}

function completionPhaseEvidence({kind,paused,patch,publication,featureHead,currentMain,
  items=[],createdAt,intentId,receiptId,
  phaseEvidence={reconciliation:null,review_gate:null}}) {
  const feature=paused.repository_releases[0];
  const programs=[paused,patch].sort((left,right) => left.program_id<right.program_id ? -1 : 1);
  const query={kind:"patch-completion",control_revision:"control-completion",
    control_repository:CONTROL_REPOSITORY,organization:organization(),
    repositories:[repositoryConfiguration()],programs,ledger_sha256:"6".repeat(64),
    patch_program:patch,paused_program:paused,publication,
    repository_configuration:repositoryConfiguration(),project:organization().project,
    phase_evidence:phaseEvidence};
  const operations=[
    {resource:"project",action:"verify",repository:null,expected_revision:"project-completion",
      payload:{kind:"release-patch-completion-precondition",project_id:"PVT_TOSS_OS_2",
        query,snapshot_sha256:"8".repeat(64)}},
    {resource:"branch",action:"verify",repository:REPOSITORY,expected_revision:"main-completion",
      payload:{kind:"release-default-branch-precondition",name:"main",head_sha:currentMain}},
    {resource:"branch",action:"verify",repository:REPOSITORY,expected_revision:"feature-completion",
      payload:{kind:"release-branch-precondition",name:feature.branch,base_branch:"main",
        head_sha:featureHead}},
  ];
  if (kind==="reconciliation") {
    operations.push({resource:"branch",action:"merge",repository:REPOSITORY,
      expected_revision:"feature-completion",payload:{kind:"release-patch-reconcile",
        patch_program_id:patch.program_id,patch_release_id:patch.repository_releases[0].release_id,
        feature_program_id:paused.program_id,feature_release_id:feature.release_id,
        source_branch:"main",source_sha:currentMain,target_branch:feature.branch,
        target_sha:featureHead}});
  } else {
    for (const item of items.filter(value => value.review!==null)) {
      const stale={...item.review,freshness:"STALE"};
      operations.push({resource:"pull_request",action:"update",repository:REPOSITORY,
        expected_revision:item.pull_request.revision,payload:{kind:"release-patch-review-stale",
          patch_program_id:patch.program_id,feature_program_id:paused.program_id,
          work_item_id:item.work.item.id,pull_request_number:item.pull_request.number,
          head_sha:item.pull_request.head_sha,reviewed_revision:item.review.reviewed_revision,
          current_revision:item.pull_request.head_sha,freshness:"STALE",
          review_result:stale,body:updateManagedReviewBlock(item.pull_request.body,stale),
          work_review:null}});
      operations.push({resource:"project",action:"update",repository:REPOSITORY,
        expected_revision:item.work.project.revision,payload:{kind:"release-patch-review-stale",
          patch_program_id:patch.program_id,feature_program_id:paused.program_id,
          project_id:item.work.project.project_id,item_id:item.work.project.item_id,
          work_item_id:item.work.item.id,pull_request_number:item.pull_request.number,
          pull_request_revision:item.pull_request.revision,
          reviewed_revision:item.review.reviewed_revision,
          current_revision:item.pull_request.head_sha,freshness:"STALE",
          fields:{Status:"In review",Gate:"REVIEW_REQUIRED"}}});
    }
    operations.push({resource:"workflow",action:"create",repository:REPOSITORY,
      expected_revision:"repository-completion",payload:{kind:"release-check-request",
        patch_program_id:patch.program_id,feature_program_id:paused.program_id,
        branch:feature.branch,head_sha:featureHead,required:["ci"]}});
  }
  operations.push({resource:"repository",action:"commit",repository:CONTROL_REPOSITORY,
    expected_revision:paused.revision,payload:{kind:"release-program-manifest",
      expected_program_revision:paused.revision,program:paused}});
  const intent=createOperationIntent({intent_id:intentId,created_at:createdAt,
    command:"release.patch-complete",policy_revision:"POLICY-0001",
    source:{repository:CONTROL_REPOSITORY,revision:"control-completion",sha256:"7".repeat(64)},
    authority:null,planned_receipt_id:receiptId,operations});
  return {intent,receipt:{schema_version:"operation-receipt.v1",document_type:"operation-receipt",
    receipt_id:receiptId,intent_id:intent.intent_id,intent_sha256:sha256Canonical(intent),
    created_at:createdAt,status:"completed",observed_revisions:intent.operations.map(operation => ({
      operation_id:operation.operation_id,repository:operation.repository,
      revision:operation.payload.kind==="release-program-manifest"
        ? paused.revision : operation.expected_revision}))}};
}

function rewriteCompletedPhaseEvidence(evidence,rewrite) {
  const operations=evidence.intent.operations.map(({operation_id:_operationId,...operation}) =>
    structuredClone(operation));
  rewrite(operations);
  const intent=createOperationIntent({intent_id:evidence.intent.intent_id,
    created_at:evidence.intent.created_at,command:evidence.intent.command,
    policy_revision:evidence.intent.policy_revision,source:evidence.intent.source,
    authority:evidence.intent.authority,planned_receipt_id:evidence.intent.planned_receipt_id,
    operations});
  return {intent,receipt:{...evidence.receipt,intent_sha256:sha256Canonical(intent),
    observed_revisions:intent.operations.map(operation => ({
      operation_id:operation.operation_id,repository:operation.repository,
      revision:operation.payload.kind==="release-program-manifest"
        ? operation.payload.program.revision : operation.expected_revision}))}};
}

function completedPatchOperations(operations,{paused,createdAt,intentId,receiptId}) {
  const intent=createOperationIntent({intent_id:intentId,created_at:createdAt,
    command:"release.patch-complete",policy_revision:"POLICY-0001",
    source:{repository:CONTROL_REPOSITORY,revision:"control-completion",sha256:"7".repeat(64)},
    authority:null,planned_receipt_id:receiptId,operations});
  return {intent,receipt:{schema_version:"operation-receipt.v1",
    document_type:"operation-receipt",receipt_id:receiptId,intent_id:intent.intent_id,
    intent_sha256:sha256Canonical(intent),created_at:createdAt,status:"completed",
    observed_revisions:intent.operations.map(operation => ({
      operation_id:operation.operation_id,repository:operation.repository,
      revision:operation.payload.kind==="release-program-manifest"
        ? paused.revision : operation.expected_revision}))}};
}

function ruledCompletionSnapshot({patch,paused,publication,currentMain=LATER_MAIN_SHA,
  featureHead=FEATURE_RELEASE_HEAD,reconciled=false,items=null,phaseEvidence=null,
  checksState="PENDING"}={}) {
  const patchRelease=patch.repository_releases[0];
  const feature=paused.repository_releases[0];
  const assigned=items ?? [
    assignedWorkItem(feature,{number:10,head:EPIC_HEAD,kind:"epic",
      reviewId:"REVIEW-20260903-0310"}),
    assignedWorkItem(feature,{number:11,head:CHILD_HEAD,
      reviewId:"REVIEW-20260903-0311"}),
    assignedWorkItem(feature,{number:12,head:"5".repeat(40),hasPullRequest:false}),
  ];
  const programs=[paused,patch].sort((left,right) => left.program_id<right.program_id ? -1 : 1);
  const query={kind:"patch-completion",control_revision:"control-completion",
    control_repository:CONTROL_REPOSITORY,organization:organization(),
    repositories:[repositoryConfiguration()],programs,ledger_sha256:"6".repeat(64),
    patch_program:patch,paused_program:paused,publication,
    repository_configuration:repositoryConfiguration(),project:organization().project,
    phase_evidence:phaseEvidence ?? {reconciliation:null,review_gate:null}};
  const observation={kind:"patch-completion",control_revision:"control-completion",
    project:{id:"PVT_TOSS_OS_2",revision:"project-completion"},
    patch:{program_id:patch.program_id,program_revision:patch.revision,
      release_id:patchRelease.release_id,release_revision:patchRelease.revision},
    feature:{program_id:paused.program_id,program_revision:paused.revision,
      release_id:feature.release_id,release_revision:feature.revision},
    repository:{repository:REPOSITORY,revision:"repository-completion",
      default_branch:{name:"main",revision:"main-completion",head_sha:currentMain},
      feature_branch:{name:feature.branch,revision:"feature-completion",head_sha:featureHead},
      reconciliation:{publication_commit:publication.expected_revision,
        publication_is_ancestor_of_current_default:true,
        current_default_is_ancestor_of_feature_release:reconciled,drifted:false}},
    assigned_work:{release_id:feature.release_id,release_revision:feature.revision,
      project_id:"PVT_TOSS_OS_2",project_revision:"project-completion",
      work_item_ids:assigned.map(item => item.work.item.id),items:assigned},
    checks:{head_sha:checksState==="NOT_STARTED" ? null : featureHead,
      state:checksState,required:["ci"]}};
  const sourceQuery=reconciled ? query : {...query,
    phase_evidence:{reconciliation:null,review_gate:null}};
  return {source:{repository:CONTROL_REPOSITORY,revision:"control-completion",
    sha256:sha256Canonical({control:sourceQuery,github:observation})},query,observation,
  receipt_id:"RECEIPT-20260903-0399",timestamp:REREVIEWED_AT};
}

function completedReviewedReconciliationRound() {
  const {paused,patch,publication}=completionFixture();
  const feature=paused.repository_releases[0];
  const historical=assignedWorkItem(feature,{number:10,head:EPIC_HEAD,kind:"epic",
    reviewId:"REVIEW-20260903-0600",recordedAt:NOW});
  const initial=ruledCompletionSnapshot({patch,paused,publication,currentMain:PATCH_SHA,
    featureHead:FEATURE_RELEASE_HEAD,reconciled:false,items:[historical],
    phaseEvidence:{reconciliation:null,review_gate:null},checksState:"NOT_STARTED"});
  const reconciliationOperations=completePatchInterruption({patchProgram:patch,
    pausedProgram:paused,publication,snapshot:initial});
  const reconciliation=completedPatchOperations(reconciliationOperations,{paused,
    createdAt:RECONCILED_AT,intentId:"INTENT-20260903-0601",
    receiptId:"RECEIPT-20260903-0601"});
  const gated=ruledCompletionSnapshot({patch,paused,publication,currentMain:PATCH_SHA,
    featureHead:MERGED_SHA,reconciled:true,items:[historical],
    phaseEvidence:{reconciliation,review_gate:null},checksState:"NOT_STARTED"});
  const reviewGateOperations=completePatchInterruption({patchProgram:patch,
    pausedProgram:paused,publication,snapshot:gated});
  const reviewGate=completedPatchOperations(reviewGateOperations,{paused,
    createdAt:REVIEW_GATE_AT,intentId:"INTENT-20260903-0602",
    receiptId:"RECEIPT-20260903-0602"});
  const current=assignedWorkItem(feature,{number:10,head:EPIC_HEAD,kind:"epic",
    reviewId:"REVIEW-20260903-0603",recordedAt:"2026-09-03T10:25:00.000Z"});
  return {paused,patch,publication,reconciliation,reviewGate,reviewGateOperations,current};
}

async function pausedPreviewState() {
  const program=featureProgram();
  const initial={revision:"control-1",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[program],intents:[],receipts:[]};
  const services={control:{async loadReleasePlanningState() { return structuredClone(initial); }},
    github:{async snapshot(query) { return query.kind==="issue-start" ? issueStartSnapshot() :
      patchSnapshotBody(initial,program); }},operations:{reserveReceiptId() {
      return "RECEIPT-20260903-0100"; },async execute(input) {
      return {schema_version:"operation-preview.v1",operations:input.operations}; }},clock:() => NOW};
  const result=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services});
  assert.equal(result.exitCode,0,JSON.stringify(result.result.error));
  const paused=result.result.data.operations.find(operation =>
    operation.payload.kind==="release-program-manifest").payload.program;
  const evidence=completedIntent(paused,result.result.data.operations);
  return {paused,state:{...initial,revision:"control-2",programs:[paused],
    intents:[evidence.intent],receipts:[evidence.receipt]}};
}

function patchHarness() {
  let controlRevisionNumber=1;
  let controlRevision=`control-${controlRevisionNumber}`;
  let programs=[featureProgram()];
  const intents=[];
  const receipts=[];
  const controlEvents=[];
  const remoteEvents=[];
  let work=bugWork();
  let repositoryRevision="repository-1";
  let issueRevision="issue-55-1";
  let projectRevision="project-patch-1";
  let mainRevision="main-1";
  let mainHead=MAIN_SHA;
  let milestone=null;
  let patchBranch=null;
  let bugBranch=null;
  const state=() => ({revision:controlRevision,organization:organization(),
    repositories:[repositoryConfiguration()],programs:structuredClone(programs),
    intents:structuredClone(intents),receipts:structuredClone(receipts)});
  const advanceControl=() => { controlRevision=`control-${++controlRevisionNumber}`; };
  const control={
    async head() { return controlRevision; },
    async loadReleasePlanningState() { return state(); },
    async loadOperationState() { return {revision:controlRevision,
      intents:structuredClone(intents),receipts:structuredClone(receipts)}; },
    async findIntent(intent) { return intents.find(value => value.intent_id===intent.intent_id) ?? null; },
    async findReceipt(intent) { return receipts.find(value => value.intent_id===intent.intent_id) ?? null; },
    async commitIntent({expectedHead,intent}) {
      assert.equal(expectedHead,controlRevision);
      assert.equal(intents.some(value => value.planned_receipt_id===intent.planned_receipt_id),false);
      intents.push(structuredClone(intent)); controlEvents.push("intent"); advanceControl();
      return {commit_sha:controlRevision};
    },
    async commitReceipt({expectedHead,receipt}) {
      assert.equal(expectedHead,controlRevision);
      receipts.push(structuredClone(receipt)); controlEvents.push("receipt"); advanceControl();
      return {commit_sha:controlRevision};
    },
    async inspectReleaseProgramOperation(operation) {
      const current=programs.find(value => value.program_id===operation.payload.program.program_id);
      return {operation_id:operation.operation_id,repository:CONTROL_REPOSITORY,
        revision:current?.revision ?? null};
    },
    async commitReleaseProgramReceipt({expectedHead,operation,receipt}) {
      assert.equal(expectedHead,controlRevision);
      programs=programs.filter(value => value.program_id!==operation.payload.program.program_id);
      programs.push(structuredClone(operation.payload.program));
      programs.sort((left,right) => left.program_id<right.program_id ? -1 : 1);
      receipts.push(structuredClone(receipt)); controlEvents.push("program-receipt"); advanceControl();
      return {commit_sha:controlRevision};
    },
  };
  const issueSnapshot=() => {
    const release=work.release.assigned ? {repository:REPOSITORY,branch:work.release.branch,
      revision:work.release.revision,head_sha:patchBranch.head_sha} : null;
    return {kind:"issue-start",source:{repository:REPOSITORY,revision:repositoryRevision,
      sha256:sha256Canonical({repository:REPOSITORY,revision:repositoryRevision})},
    repository_revision:repositoryRevision,work:structuredClone(work),
    branch:bugBranch===null ? null : structuredClone(bugBranch),base:release,pull_request:null,
    bug_lineage:{classification:"patch",affected_version:"2.1.2",patch_version:"2.1.3"}};
  };
  const patchObservation=query => ({kind:"patch-interruption",
    control_revision:query.control_revision,project:{id:"PVT_TOSS_OS_2",revision:projectRevision},
    feature:{program_id:query.feature_program.program_id,
      program_revision:query.feature_program.revision,
      release_id:query.feature_program.repository_releases[0].release_id,
      release_revision:query.feature_program.repository_releases[0].revision},
    patch_program_revisions:query.patch_programs.map(program => ({program_id:program.program_id,
      revision:program.revision,phase:program.phase,release_id:program.repository_releases[0].release_id,
      release_revision:program.repository_releases[0].revision,
      scope:program.repository_releases[0].scope})),
    bug:{id:BUG,revision:issueRevision,affected_version:"2.1.2",
      work_sha256:sha256Canonical(work)},latest_published:publicationEvidence(),
    repository:{repository:REPOSITORY,revision:repositoryRevision,
      default_branch:{name:"main",revision:mainRevision,head_sha:mainHead},
      milestone:milestone===null ? null : structuredClone(milestone),
      release_branch:patchBranch===null ? null : structuredClone(patchBranch)}});
  const github={
    async snapshot(query) {
      remoteEvents.push({method:"snapshot",kind:query.kind});
      if (query.kind==="issue-start") return issueSnapshot();
      if (query.kind==="patch-interruption") return patchObservation(query);
      throw new Error(`unexpected patch harness snapshot ${query.kind}`);
    },
    async inspect(operations) {
      remoteEvents.push({method:"inspect",kinds:operations.map(value => value.payload.kind)});
      return Promise.all(operations.map(async operation => {
        let revision=operation.expected_revision;
        switch (operation.payload.kind) {
          case "release-patch-precondition": {
            const current=await github.snapshot(operation.payload.query);
            if (operation.payload.snapshot_sha256!==sha256Canonical(current)) {
              throw new CoreConflictError("patch aggregate evidence changed after confirmation");
            }
            revision=current.project.revision; break;
          }
          case "release-repository-precondition":
            assert.equal(operation.payload.snapshot_sha256,
              sha256Canonical(patchObservation(operation.payload.kind &&
                intents.at(-1).operations.find(value => value.payload.kind==="release-patch-precondition")
                  .payload.query).repository));
            revision=repositoryRevision; break;
          case "release-default-branch-precondition":
            if (operation.payload.head_sha!==mainHead) {
              throw new CoreConflictError("patch default branch changed after confirmation");
            }
            revision=mainRevision; break;
          case "release-milestone": revision=repositoryRevision; break;
          case "release-branch": revision=mainRevision; break;
          case "release-assignment": revision=issueRevision; break;
          case "release-project-state": revision=work.project.revision; break;
          case "work-branch": revision=repositoryRevision; break;
          case "work-state": revision=work.project.revision; break;
          default: throw new Error(`unexpected patch inspect ${operation.payload.kind}`);
        }
        return {operation_id:operation.operation_id,repository:operation.repository,revision};
      }));
    },
    async apply(operations) {
      remoteEvents.push({method:"apply",kinds:operations.map(value => value.payload.kind)});
      for (const operation of operations) {
        const payload=operation.payload;
        if (payload.kind==="release-milestone") {
          milestone={title:payload.title,state:payload.state,revision:"milestone-1"};
        } else if (payload.kind==="release-branch") {
          patchBranch={name:payload.name,base_branch:payload.base_branch,
            head_sha:payload.head_sha,revision:"patch-branch-1"};
        } else if (payload.kind==="release-assignment") {
          work={...work,item:{...work.item,...payload.item},release:payload.release};
          issueRevision="issue-55-2";
        } else if (payload.kind==="release-project-state") {
          work={...work,item:{...work.item,status:payload.fields.Status,gate:payload.fields.Gate},
            project:{...work.project,revision:"project-bug-2",fields:payload.fields}};
          projectRevision="project-patch-2";
        } else if (payload.kind==="work-branch") {
          bugBranch={name:payload.name,base_branch:payload.base_branch,
            head_sha:payload.source_sha,revision:"bug-branch-1"};
          work={...work,physical_branch:{exists:true,head_sha:payload.source_sha}};
          repositoryRevision="repository-2";
        } else if (payload.kind==="work-state") {
          work={...work,item:{...work.item,status:payload.fields.Status ?? work.item.status,
            gate:payload.fields.Gate ?? work.item.gate},
            project:{...work.project,revision:"project-bug-3",fields:{...work.project.fields,
              ...payload.fields}}};
          projectRevision="project-patch-3";
        } else throw new Error(`unexpected patch apply ${payload.kind}`);
      }
      return {status:"completed",observed_revisions:operations.map(operation => ({
        operation_id:operation.operation_id,repository:operation.repository,
        revision:`applied-${operation.operation_id}`}))};
    },
  };
  let sequence=0;
  const runner=createOperationRunner({control,github,authorityRegistry:{keys:[]},clock:() => NOW,
    idGenerator:kind => `${kind==="intent" ? "INTENT" : "RECEIPT"}-20260903-${String(++sequence).padStart(4,"0")}`,
    policyRevision:() => "POLICY-0001"});
  return {services:{control,github,operations:runner,clock:() => NOW},controlEvents,remoteEvents,
    view:() => ({state:state(),work:structuredClone(work),milestone:structuredClone(milestone),
      patchBranch:structuredClone(patchBranch),bugBranch:structuredClone(bugBranch)}),
    advanceMain() { mainRevision="main-2"; mainHead="8".repeat(40); },advanceControl};
}

test("patch version increments verified latest published history",() => {
  assert.deepEqual(patchVersionFor("2.1.2"),{
    version:"2.1.3",change_class:"patch",based_on:"2.1.2",
  });
});

test("public issue start rejects a proxy GitHub snapshot without invoking traps",async () => {
  let traps=0;
  const snapshot=new Proxy(issueStartSnapshot(),{
    get(_target,key) {
      if (key==="then") return undefined;
      traps+=1;
      throw new Error("must not read a hostile snapshot");
    },
    ownKeys() { traps+=1; throw new Error("must not enumerate a hostile snapshot"); },
  });

  const result=await startIssueWithSnapshot(snapshot);

  assert.equal(result.exitCode,5,JSON.stringify(result.result.error));
  assert.equal(traps,0);
});

test("public issue start rejects a snapshot accessor without invoking it",async () => {
  let traps=0;
  const accessor=issueStartSnapshot();
  Object.defineProperty(accessor,"work",{enumerable:true,get() {
    traps+=1;
    throw new Error("must not invoke a hostile snapshot accessor");
  }});

  const result=await startIssueWithSnapshot(accessor);

  assert.equal(result.exitCode,5,JSON.stringify(result.result.error));
  assert.equal(traps,0);
});

test("exported patch planners reject hostile request wrappers without invoking traps",() => {
  let traps=0;
  const proxy=new Proxy({}, {
    get() { traps+=1; throw new Error("must not read a hostile request"); },
    ownKeys() { traps+=1; throw new Error("must not enumerate a hostile request"); },
  });
  const accessor={};
  Object.defineProperty(accessor,"bug",{enumerable:true,get() {
    traps+=1;
    throw new Error("must not invoke a hostile request accessor");
  }});
  for (const operation of [planPatchInterruption,completePatchInterruption]) {
    for (const input of [proxy,accessor]) {
      assert.throws(() => operation(input),error => error?.exitCode===5);
    }
  }
  for (const input of [proxy,accessor]) {
    assert.throws(() => projectPatchCompletionTransaction(input,{}),
      error => error?.exitCode===5);
  }
  let deep={};
  for (let index=0;index<70;index+=1) deep={value:deep};
  assert.throws(() => projectPatchCompletionTransaction(deep,{}),
    error => error?.exitCode===5);
  assert.equal(traps,0);
});

test("exported patch command helper rejects hostile bug snapshots without invoking traps",async () => {
  let traps=0;
  const proxy=new Proxy({}, {
    get() { traps+=1; throw new Error("must not read a hostile patch command snapshot"); },
    ownKeys() { traps+=1; throw new Error("must not enumerate a hostile patch command snapshot"); },
  });
  const accessor={};
  Object.defineProperty(accessor,"work",{enumerable:true,get() {
    traps+=1;
    throw new Error("must not invoke a hostile patch command accessor");
  }});
  for (const snapshot of [proxy,accessor]) {
    await assert.rejects(() => runPatchInterruptionStep({},null,snapshot),
      error => error?.exitCode===5);
  }
  assert.equal(traps,0);
});

test("public status queries give a stateless adapter the complete pinned manifest set",async () => {
  const paused=pausedFeatureProgram();
  const published=releasedPatchProgram(activePatchProgram(paused));
  const released=published.program;
  const state={revision:"control-status-public",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[paused,released,published.nextProgram],
    intents:published.intents,receipts:published.receipts};
  const queries=[];
  const services={
    control:{async loadReleasePlanningState() { return structuredClone(state); }},
    github:{async snapshot(query) {
      queries.push(structuredClone(query));
      return statelessPublicStatusSnapshot(query);
    }},
  };

  const release=await dispatchCoreCommand(
    parseCoreCommand(["release","status",REPOSITORY]),{services},
  );
  assert.equal(release.exitCode,0,JSON.stringify(release.result.error));
  assert.equal(release.result.data.program.id,paused.program_id);
  assert.equal(release.result.data.patch_link,released.program_id);

  const program=await dispatchCoreCommand(
    parseCoreCommand(["program","status",paused.program_id]),{services},
  );
  assert.equal(program.exitCode,0,JSON.stringify(program.result.error));
  assert.deepEqual(program.result.data.programs.map(value => value.id),[paused.program_id]);
  assert.equal(program.result.data.programs[0].tracks[0].patch_link,released.program_id);

  const expectedIds=[paused.program_id,released.program_id,published.nextProgram.program_id];
  assert.equal(queries.length,2);
  for (const query of queries) {
    assert.deepEqual(query.programs.map(value => value.program_id),expectedIds);
  }
  assert.deepEqual(queries[1].selected_programs.map(value => value.program_id),[paused.program_id]);
});

test("release status derives the patch target and rejects a null adapter override",() => {
  const paused=pausedFeatureProgram();
  const patch=activePatchProgram(paused);
  const state={revision:"control-status-1",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[paused,patch],intents:[],receipts:[]};

  const canonical=releaseStatusResult({planningState:state,repository:REPOSITORY,
    snapshot:linkedStatusSnapshot(state,"release-status",patch,paused.program_id)});
  assert.equal(canonical.patch_link,paused.program_id);
  assert.throws(() => releaseStatusResult({planningState:state,repository:REPOSITORY,
    snapshot:linkedStatusSnapshot(state,"release-status",patch,null)}),CoreConflictError);
});

test("release status rejects an arbitrary adapter patch-link override",() => {
  const paused=pausedFeatureProgram();
  const patch=activePatchProgram(paused);
  const state={revision:"control-status-1",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[paused,patch],intents:[],receipts:[]};
  assert.throws(() => releaseStatusResult({planningState:state,repository:REPOSITORY,
    snapshot:linkedStatusSnapshot(state,"release-status",patch,"TOSS-OS-R9999")}),
  CoreConflictError);
});

test("program status derives a paused feature link and rejects a null override",() => {
  const paused=pausedFeatureProgram();
  const patch=activePatchProgram(paused);
  const base={revision:"control-status-2",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[paused,patch],intents:[],receipts:[]};
  const canonical=programStatusResult({planningState:base,programId:paused.program_id,
    snapshot:linkedStatusSnapshot(base,"program-status",paused,patch.program_id)});
  assert.equal(canonical.programs[0].tracks[0].patch_link,patch.program_id);
  assert.throws(() => programStatusResult({planningState:base,programId:paused.program_id,
    snapshot:linkedStatusSnapshot(base,"program-status",paused,null)}),CoreConflictError);
});

test("program status rejects multiple manifest-derived links for one paused feature",() => {
  const paused=pausedFeatureProgram();
  const patch=activePatchProgram(paused);
  const base={revision:"control-status-2",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[paused,patch],intents:[],receipts:[]};
  const published=releasedPatchProgram(activePatchProgram(paused,BUG,{programId:"TOSS-OS-R0003"}));
  const ambiguous={...base,revision:"control-status-3",programs:[paused,patch,published.program],
    intents:published.intents,receipts:published.receipts};
  assert.throws(() => programStatusResult({planningState:ambiguous,programId:paused.program_id,
    snapshot:linkedStatusSnapshot(ambiguous,"program-status",paused,patch.program_id)}),
  error => error instanceof CoreConflictError && /ambiguous/iu.test(error.message));
});

test("a patch status link requires its exact interrupted program release and repository",() => {
  const paused=pausedFeatureProgram();
  const released=releasedPatchProgram(activePatchProgram(paused)).program;
  for (const state of [
    {revision:"control-status-4",organization:organization(),
      repositories:[repositoryConfiguration()],programs:[released],intents:[],receipts:[]},
    {revision:"control-status-5",organization:organization(),
      repositories:[repositoryConfiguration()],programs:[paused,{...released,interrupts:{
        ...released.interrupts,repository_release_id:"REL-TOSS-OS-R0001-missing",
      }}],intents:[],receipts:[]},
  ]) {
    assert.throws(() => releaseStatusResult({planningState:state,repository:REPOSITORY,
      snapshot:linkedStatusSnapshot(state,"release-status",state.programs.at(-1),paused.program_id)}),
    CoreConflictError);
  }
});

test("a resumed patch link must retain the exact historical pause result revision",() => {
  const paused=pausedFeatureProgram();
  const resumedRelease=transitionRepositoryRelease(paused.repository_releases[0],{
    event:"RESUME_AFTER_PATCH",expected_revision:paused.repository_releases[0].revision,
    timestamp:REREVIEWED_AT,source_receipt:"RECEIPT-20260903-0990",activation:null,
  });
  const resumed={...paused,phase:"ACTIVE",revision:"REV-0004",
    repository_releases:[resumedRelease],updated_at:REREVIEWED_AT};
  const published=releasedPatchProgram(activePatchProgram(paused));
  const released=published.program;
  const valid={revision:"control-status-6",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[resumed,released],
    intents:published.intents,receipts:published.receipts};
  const status=programStatusResult({planningState:valid,programId:released.program_id,
    snapshot:linkedStatusSnapshot(valid,"program-status",released,resumed.program_id)});
  assert.equal(status.programs[0].tracks[0].patch_link,resumed.program_id);

  const forgedPatch={...released,interrupts:{...released.interrupts,
    paused_release_revision:"REV-9999"}};
  const forged={...valid,revision:"control-status-7",programs:[resumed,forgedPatch]};
  assert.throws(() => programStatusResult({planningState:forged,programId:forgedPatch.program_id,
    snapshot:linkedStatusSnapshot(forged,"program-status",forgedPatch,resumed.program_id)}),
  CoreConflictError);
});

test("a historical patch link rejects a release revision detached from its transition ordinal",() => {
  const paused=pausedFeatureProgram();
  const resumedRelease=transitionRepositoryRelease(paused.repository_releases[0],{
    event:"RESUME_AFTER_PATCH",expected_revision:paused.repository_releases[0].revision,
    timestamp:REREVIEWED_AT,source_receipt:"RECEIPT-20260903-0991",activation:null,
  });
  const forgedTarget={...paused,phase:"ACTIVE",revision:"REV-0004",
    repository_releases:[{...resumedRelease,revision:"REV-10000"}],updated_at:REREVIEWED_AT};
  const released=releasedPatchProgram(activePatchProgram(paused)).program;
  const forgedPatch={...released,interrupts:{...released.interrupts,
    paused_release_revision:"REV-9999"}};
  const state={revision:"control-status-8",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[forgedTarget,forgedPatch],
    intents:[],receipts:[]};

  assert.throws(() => programStatusResult({planningState:state,programId:forgedPatch.program_id,
    snapshot:linkedStatusSnapshot(state,"program-status",forgedPatch,forgedTarget.program_id)}),
  CoreConflictError);
});

test("public issue start first previews only the durable feature pause",async () => {
  const program=featureProgram();
  const state={revision:"control-1",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[program],intents:[],receipts:[]};
  const calls=[];
  const services={
    control:{async loadReleasePlanningState() { return structuredClone(state); }},
    github:{async snapshot(query) {
      calls.push(structuredClone(query));
      if (query.kind==="issue-start") return issueStartSnapshot();
      if (query.kind==="patch-interruption") return patchSnapshotBody(state,program);
      throw new Error(`unexpected snapshot ${query.kind}`);
    }},
    operations:{reserveReceiptId() { return "RECEIPT-20260903-0100"; },
      async execute(input) { return {schema_version:"operation-preview.v1",operations:input.operations}; }},
    clock:() => NOW,
  };

  const result=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services});

  assert.equal(result.exitCode,0,JSON.stringify(result.result.error));
  assert.deepEqual(result.result.data.operations.map(operation => operation.payload.kind),[
    "release-patch-precondition","release-program-manifest",
  ]);
  const paused=result.result.data.operations.at(-1).payload.program;
  assert.equal(paused.phase,"PAUSED");
  assert.equal(paused.repository_releases[0].phase,"PAUSED");
  assert.equal(paused.repository_releases[0].branch,"release/v2.2.0");
  assert.equal(result.result.data.next_command,`toss-core issue start ${BUG}`);
  assert.deepEqual(calls.map(call => call.kind),["issue-start","patch-interruption"]);
});

test("public issue start re-entry activates only linked 2.1.3 after the exact pause receipt",async () => {
  const initialProgram=featureProgram();
  const initialState={revision:"control-1",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[initialProgram],intents:[],receipts:[]};
  const firstServices={control:{async loadReleasePlanningState() { return structuredClone(initialState); }},
    github:{async snapshot(query) {
      if (query.kind==="issue-start") return issueStartSnapshot();
      if (query.kind==="patch-interruption") return patchSnapshotBody(initialState,initialProgram);
      throw new Error(`unexpected snapshot ${query.kind}`);
    }},operations:{reserveReceiptId() { return "RECEIPT-20260903-0100"; },
      async execute(input) { return {schema_version:"operation-preview.v1",operations:input.operations}; }},
    clock:() => NOW};
  const first=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services:firstServices});
  assert.equal(first.exitCode,0,JSON.stringify(first.result.error));
  const paused=first.result.data.operations.find(operation =>
    operation.payload.kind==="release-program-manifest").payload.program;
  const evidence=completedIntent(paused,first.result.data.operations);
  const state={...initialState,revision:"control-2",programs:[paused],
    intents:[evidence.intent],receipts:[evidence.receipt]};
  const services={control:{async loadReleasePlanningState() { return structuredClone(state); }},
    github:{async snapshot(query) {
      if (query.kind==="issue-start") return issueStartSnapshot();
      if (query.kind==="patch-interruption") return patchSnapshotBody(state,paused);
      throw new Error(`unexpected snapshot ${query.kind}`);
    }},operations:{reserveReceiptId() { return "RECEIPT-20260903-0101"; },
      async execute(input) { return {schema_version:"operation-preview.v1",operations:input.operations}; }},
    clock:() => NOW};

  const result=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services});

  assert.equal(result.exitCode,0,JSON.stringify(result.result.error));
  assert.deepEqual(result.result.data.operations.map(operation => operation.payload.kind),[
    "release-patch-precondition","release-repository-precondition",
    "release-default-branch-precondition","release-milestone","release-branch",
    "release-program-manifest","release-assignment","release-project-state",
  ]);
  const patch=result.result.data.operations.find(operation =>
    operation.payload.kind==="release-program-manifest").payload.program;
  assert.equal(patch.phase,"ACTIVE");
  assert.equal(patch.repository_releases[0].version,"2.1.3");
  assert.equal(patch.repository_releases[0].branch,"release/v2.1.3");
  assert.deepEqual(patch.interrupts,{program_id:paused.program_id,
    repository_release_id:paused.repository_releases[0].release_id,
    paused_release_revision:paused.repository_releases[0].revision});
  assert.equal(result.result.data.operations.some(operation =>
    operation.payload.kind==="work-branch"),false);
  assert.equal(result.result.data.next_command,`toss-core issue start ${BUG}`);
});

test("only a later issue start creates the bug branch from the receipt-backed patch release",async () => {
  const initialProgram=featureProgram();
  const initialState={revision:"control-1",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[initialProgram],intents:[],receipts:[]};
  const executePreview=() => async input =>
    ({schema_version:"operation-preview.v1",operations:input.operations});
  const firstServices={control:{async loadReleasePlanningState() { return structuredClone(initialState); }},
    github:{async snapshot(query) {
      return query.kind==="issue-start" ? issueStartSnapshot() : patchSnapshotBody(initialState,initialProgram);
    }},operations:{reserveReceiptId() { return "RECEIPT-20260903-0100"; },
      execute:executePreview()},clock:() => NOW};
  const first=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services:firstServices});
  const paused=first.result.data.operations.find(operation =>
    operation.payload.kind==="release-program-manifest").payload.program;
  const pauseEvidence=completedIntent(paused,first.result.data.operations);
  const pausedState={...initialState,revision:"control-2",programs:[paused],
    intents:[pauseEvidence.intent],receipts:[pauseEvidence.receipt]};
  const secondServices={control:{async loadReleasePlanningState() { return structuredClone(pausedState); }},
    github:{async snapshot(query) {
      return query.kind==="issue-start" ? issueStartSnapshot() : patchSnapshotBody(pausedState,paused);
    }},operations:{reserveReceiptId() { return "RECEIPT-20260903-0101"; },
      execute:executePreview()},clock:() => NOW};
  const second=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services:secondServices});
  const patch=second.result.data.operations.find(operation =>
    operation.payload.kind==="release-program-manifest").payload.program;
  const activationEvidence=completedIntent(patch,second.result.data.operations,{
    receiptId:"RECEIPT-20260903-0101",intentId:"INTENT-20260903-0101",
    sourceRevision:"control-2"});
  const state={...pausedState,revision:"control-3",programs:[paused,patch],
    intents:[pauseEvidence.intent,activationEvidence.intent],
    receipts:[pauseEvidence.receipt,activationEvidence.receipt]};
  const work=assignedBugWork(patch);
  const release=patch.repository_releases[0];
  const base={repository:REPOSITORY,branch:release.branch,revision:release.revision,
    head_sha:MAIN_SHA};
  const calls=[];
  const services={control:{async loadReleasePlanningState() { return structuredClone(state); }},
    github:{async snapshot(query) {
      calls.push(query.kind);
      return query.kind==="issue-start" ? issueStartSnapshot(work,base) :
        patchSnapshotBody(state,paused,work);
    }},operations:{reserveReceiptId() { return "RECEIPT-20260903-0102"; },
      execute:executePreview()},clock:() => NOW};

  const result=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services});

  assert.equal(result.exitCode,0,JSON.stringify(result.result.error));
  assert.equal(result.result.data.operations.some(operation =>
    operation.payload.kind==="release-program-manifest"),false);
  const branch=result.result.data.operations.find(operation => operation.payload.kind==="work-branch");
  assert.equal(branch.payload.base_branch,"release/v2.1.3");
  assert.equal(branch.payload.source_sha,MAIN_SHA);
  assert.equal(result.result.data.next_command,`toss-core issue start ${BUG}`);
  assert.deepEqual(calls,["issue-start","patch-interruption"]);
});

test("real runner persists three immutable receipts for pause, activation, and bug start",async () => {
  const harness=patchHarness();
  const command=parseCoreCommand(["issue","start",BUG,"--apply","--non-interactive"]);

  for (let stage=0;stage<3;stage+=1) {
    const result=await dispatchCoreCommand(command,{services:harness.services});
    assert.equal(result.exitCode,0,JSON.stringify(result.result.error));
    assert.equal(result.result.data.status,"completed");
  }

  const view=harness.view();
  assert.deepEqual(view.state.programs.map(program => [program.phase,
    program.repository_releases[0].version,program.repository_releases[0].branch]),[
    ["PAUSED","2.2.0","release/v2.2.0"],
    ["ACTIVE","2.1.3","release/v2.1.3"],
  ]);
  assert.equal(view.bugBranch.base_branch,"release/v2.1.3");
  assert.equal(view.bugBranch.head_sha,MAIN_SHA);
  assert.equal(view.state.intents.length,3);
  assert.equal(view.state.receipts.length,3);
  assert.equal(view.state.receipts.every(receipt => receipt.status==="completed"),true);
  assert.equal(view.state.intents.every(intent =>
    intent.planned_receipt_id===view.state.receipts.find(receipt =>
      receipt.intent_id===intent.intent_id)?.receipt_id),true);
  assert.deepEqual(harness.controlEvents,["intent","program-receipt",
    "intent","program-receipt","intent","receipt"]);

  const replay=await dispatchCoreCommand(command,{services:harness.services});
  assert.equal(replay.exitCode,0,JSON.stringify(replay.result.error));
  assert.equal(replay.result.data.status,"already-reconciled");
  assert.equal(harness.view().state.intents.length,3);
  assert.equal(harness.view().state.receipts.length,3);
});

test("preview and declined confirmation preserve patch and remote state",async () => {
  const harness=patchHarness();
  const before=canonicalJson(harness.view());
  const preview=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{
    services:harness.services});
  assert.equal(preview.exitCode,0);
  assert.equal(canonicalJson(harness.view()),before);
  const declined=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG,"--apply"]),{
    services:harness.services,confirm:async () => false});
  assert.equal(declined.exitCode,4);
  assert.equal(canonicalJson(harness.view()),before);
});

test("main advancing after confirmation records failure but performs no remote mutation",async () => {
  const harness=patchHarness();
  const result=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG,"--apply"]),{
    services:harness.services,confirm:async () => { harness.advanceMain(); return true; }});

  assert.equal(result.exitCode,6,JSON.stringify(result.result.error));
  const view=harness.view();
  assert.equal(view.state.programs[0].phase,"ACTIVE");
  assert.equal(view.state.programs.length,1);
  assert.equal(view.state.intents.length,1);
  assert.equal(view.state.receipts.length,1);
  assert.equal(view.state.receipts[0].status,"failed");
  assert.equal(harness.remoteEvents.some(event => event.method==="apply"),false);
});

test("unreleased-only and wrong affected versions cannot create a patch program",async () => {
  for (const [affected,patch] of [["2.2.0","2.2.1"],["2.1.1","2.1.2"]]) {
    const program=featureProgram();
    const state={revision:"control-1",organization:organization(),
      repositories:[repositoryConfiguration()],programs:[program],intents:[],receipts:[]};
    let executions=0;
    const services={control:{async loadReleasePlanningState() { return structuredClone(state); }},
      github:{async snapshot(query) {
        return query.kind==="issue-start" ? issueStartSnapshot(bugWork(),null,affected,patch) :
          patchSnapshotBody(state,program,bugWork(),affected);
      }},operations:{reserveReceiptId() { return "RECEIPT-20260903-0400"; },
        async execute() { executions+=1; throw new Error("must not execute"); }},clock:() => NOW};

    const result=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services});
    assert.equal(result.exitCode,6,`${affected}: ${JSON.stringify(result.result.error)}`);
    assert.equal(executions,0);
  }
});

test("an existing active patch for another bug rejects a second patch",async () => {
  const paused=pausedFeatureProgram();
  const existing=activePatchProgram(paused,`${REPOSITORY}#56`);
  const state={revision:"control-3",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[paused,existing],intents:[],receipts:[]};
  let executions=0;
  const services={control:{async loadReleasePlanningState() { return structuredClone(state); }},
    github:{async snapshot(query) {
      return query.kind==="issue-start" ? issueStartSnapshot() : patchSnapshotBody(state,paused);
    }},operations:{reserveReceiptId() { return "RECEIPT-20260903-0401"; },
      async execute() { executions+=1; throw new Error("must not execute"); }},clock:() => NOW};

  const result=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services});
  assert.equal(result.exitCode,6,JSON.stringify(result.result.error));
  assert.equal(executions,0);
});

test("failed pause evidence blocks patch activation before remote writes",async () => {
  const program=featureProgram();
  const initial={revision:"control-1",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[program],intents:[],receipts:[]};
  const firstServices={control:{async loadReleasePlanningState() { return structuredClone(initial); }},
    github:{async snapshot(query) { return query.kind==="issue-start" ? issueStartSnapshot() :
      patchSnapshotBody(initial,program); }},operations:{reserveReceiptId() {
      return "RECEIPT-20260903-0100"; },async execute(input) {
      return {schema_version:"operation-preview.v1",operations:input.operations}; }},clock:() => NOW};
  const first=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services:firstServices});
  const paused=first.result.data.operations.find(operation =>
    operation.payload.kind==="release-program-manifest").payload.program;
  const evidence=completedIntent(paused,first.result.data.operations);
  evidence.receipt.status="failed";
  evidence.receipt.observed_revisions=evidence.receipt.observed_revisions.slice(0,1);
  const state={...initial,revision:"control-2",programs:[paused],
    intents:[evidence.intent],receipts:[evidence.receipt]};
  let executions=0;
  const services={control:{async loadReleasePlanningState() { return structuredClone(state); }},
    github:{async snapshot(query) { return query.kind==="issue-start" ? issueStartSnapshot() :
      patchSnapshotBody(state,paused); }},operations:{reserveReceiptId() {
      return "RECEIPT-20260903-0402"; },async execute() {
      executions+=1; throw new Error("must not execute"); }},clock:() => NOW};

  const result=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services});
  assert.equal(result.exitCode,4,JSON.stringify(result.result.error));
  assert.equal(executions,0);
});

test("public patch activation rejects an existing release branch whose head is not verified main",async () => {
  const {paused,state}=await pausedPreviewState();
  let executions=0;
  const services={control:{async loadReleasePlanningState() { return structuredClone(state); }},
    github:{async snapshot(query) {
      if (query.kind==="issue-start") return issueStartSnapshot();
      const observed=patchSnapshotBody(state,paused);
      observed.repository.milestone={title:"v2.1.3",state:"OPEN",revision:"milestone-2.1.3"};
      observed.repository.release_branch={name:"release/v2.1.3",base_branch:"main",
        head_sha:"7".repeat(40),revision:"branch-2.1.3"};
      return observed;
    }},operations:{reserveReceiptId() { return "RECEIPT-20260903-0500"; },
      async execute() { executions+=1; return {schema_version:"operation-preview.v1",operations:[]}; }},
    clock:() => NOW};

  const result=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services});

  assert.equal(result.exitCode,6,JSON.stringify(result.result.error));
  assert.equal(executions,0);
});

test("patch completion projects authoritative In review and REVIEW_REQUIRED stale state",() => {
  const {paused,patch,publication}=completionFixture();
  const operations=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot:completionSnapshot({patch,paused,publication,ancestor:true,
      featureHead:MERGED_SHA})});
  const projected=operations.find(operation =>
    operation.payload.kind==="release-patch-review-stale" && operation.resource==="project");

  assert.equal(projected.payload.fields.Status,"In review");
  assert.equal(projected.payload.fields.Gate,"REVIEW_REQUIRED");
});

test("patch completion rejects foreign and duplicate review ownership before planning",() => {
  const {paused,patch,publication}=completionFixture();
  const cases=[
    ["repository",snapshot => {
      const review=snapshot.observation.assigned_work.items[0];
      snapshot.observation.assigned_work.work_item_ids[0]="Other/repo#10";
      review.review.repository="Other/repo";
      review.pull_request.repository="Other/repo";
      review.pull_request.body=updateManagedReviewBlock("Human context.",review.review);
      review.work.item.id="Other/repo#10";
      review.work.item.repository="Other/repo";
      review.work.release.repository="Other/repo";
      review.work.release.id=`Other/repo@${review.work.release.branch}`;
      review.work.project.fields.repository="Other/repo";
    }],
    ["Project",snapshot => {
      snapshot.observation.assigned_work.items[0].work.project.project_id="PVT_FOREIGN";
    }],
    ["duplicate",snapshot => {
      snapshot.observation.assigned_work.items.push(
        structuredClone(snapshot.observation.assigned_work.items[0]));
      snapshot.observation.assigned_work.work_item_ids.push(
        snapshot.observation.assigned_work.work_item_ids[0]);
    }],
  ];
  for (const [label,mutate] of cases) {
    const snapshot=completionSnapshot({patch,paused,publication,ancestor:true,
      featureHead:MERGED_SHA});
    mutate(snapshot); rehashCompletionSnapshot(snapshot);
    assert.throws(() => completePatchInterruption({patchProgram:patch,pausedProgram:paused,
      publication,snapshot}),CoreConflictError,label);
  }
});

test("patch completion invalidates only exact epic scope or a child governed by that scope",() => {
  const {paused,patch,publication}=completionFixture();
  const request=snapshot => ({patchProgram:patch,pausedProgram:paused,publication,
    snapshot:rehashCompletionSnapshot(snapshot)});

  const outsideEpic=completionSnapshot({patch,paused,publication,ancestor:true,
    featureHead:MERGED_SHA});
  const outsideEpicReview=outsideEpic.observation.assigned_work.items[0];
  outsideEpic.observation.assigned_work.work_item_ids[0]=`${REPOSITORY}#11`;
  outsideEpicReview.work.item={...outsideEpicReview.work.item,id:`${REPOSITORY}#11`,issue_number:11,
    branch:"epic/11-unrelated"};
  outsideEpicReview.work.project={...outsideEpicReview.work.project,item_id:"PVTI_epic_11",
    fields:{...outsideEpicReview.work.project.fields,branch:"epic/11-unrelated"}};
  assert.throws(() => completePatchInterruption(request(outsideEpic)),CoreConflictError,
    "direct epic outside paused release scope");

  const wrongAssignment=completionSnapshot({patch,paused,publication,ancestor:true,
    featureHead:MERGED_SHA});
  wrongAssignment.observation.assigned_work.items[0].work.release.revision="REV-9999";
  assert.throws(() => completePatchInterruption(request(wrongAssignment)),CoreConflictError,
    "direct epic assignment does not equal paused release");

  const governedChild=completionSnapshot({patch,paused,publication,ancestor:true,
    featureHead:MERGED_SHA});
  makeCompletionChildReview(governedChild);
  assert.doesNotThrow(() => completePatchInterruption(request(governedChild)),
    "child governed by an in-scope epic remains eligible");

  const outsideChild=completionSnapshot({patch,paused,publication,ancestor:true,
    featureHead:MERGED_SHA});
  makeCompletionChildReview(outsideChild,{parentId:`${REPOSITORY}#12`});
  assert.throws(() => completePatchInterruption(request(outsideChild)),CoreConflictError,
    "child governed by an out-of-scope epic");

  const bug=completionSnapshot({patch,paused,publication,ancestor:true,
    featureHead:MERGED_SHA});
  const bugWork=bug.observation.assigned_work.items[0].work;
  bugWork.item={...bugWork.item,kind:"bug",branch:"bug/10-feature"};
  bugWork.prepared=null;
  bugWork.scope_approved=null;
  bugWork.children_complete=null;
  bugWork.authority={epic_acceptance_required:false,release_approval_required:false};
  bugWork.project.fields.branch="bug/10-feature";
  assert.throws(() => completePatchInterruption(request(bug)),CoreConflictError,
    "bug reviews do not belong to paused feature scope");
});

test("patch completion cannot resume an inactive direct epic assignment",() => {
  const {paused,patch,publication}=completionFixture();
  const snapshot=completionSnapshot({patch,paused,publication,ancestor:true,
    checksState:"PENDING"});
  snapshot.observation.assigned_work.items[0].work.release.active=false;
  rehashCompletionSnapshot(snapshot);

  assert.throws(() => completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot}),CoreConflictError);
});

test("patch completion accepts only normalized unique canonically ordered required checks",() => {
  const {paused,patch,publication}=completionFixture();
  for (const required of [[null],[""],[" ci"],["ci","ci"],["z","a"]]) {
    const snapshot=completionSnapshot({patch,paused,publication,ancestor:true,
      checksState:"PENDING"});
    snapshot.observation.checks.required=required;
    rehashCompletionSnapshot(snapshot);
    assert.throws(() => completePatchInterruption({patchProgram:patch,pausedProgram:paused,
      publication,snapshot}),CoreValidationError,JSON.stringify(required));
  }
});

test("patch completion requires at least one required check",() => {
  const {paused,patch,publication}=completionFixture();
  const snapshot=completionSnapshot({patch,paused,publication,ancestor:true,
    checksState:"PENDING"});
  snapshot.observation.checks.required=[];
  rehashCompletionSnapshot(snapshot);
  assert.throws(() => completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot}),CoreValidationError);
});

test("patch completion orders non-BMP required checks with the shared canonical comparator",() => {
  const {paused,patch,publication}=completionFixture();
  const request=required => {
    const snapshot=completionSnapshot({patch,paused,publication,ancestor:true,
      checksState:"PENDING"});
    snapshot.observation.checks.required=required;
    rehashCompletionSnapshot(snapshot);
    return () => completePatchInterruption({patchProgram:patch,pausedProgram:paused,
      publication,snapshot});
  };
  assert.throws(request(["\uE000","\u{10000}"]),CoreValidationError);
  assert.doesNotThrow(request(["\u{10000}","\uE000"]));
});

test("public patch activation rejects a bug Project item outside the bound TOSS OS Project",async () => {
  const {paused,state}=await pausedPreviewState();
  const work=bugWork();
  work.project.project_id="PVT_FOREIGN";
  let executions=0;
  const services={control:{async loadReleasePlanningState() { return structuredClone(state); }},
    github:{async snapshot(query) { return query.kind==="issue-start" ? issueStartSnapshot(work) :
      patchSnapshotBody(state,paused,work); }},operations:{reserveReceiptId() {
      return "RECEIPT-20260903-0501"; },async execute() { executions+=1;
      return {schema_version:"operation-preview.v1",operations:[]}; }},clock:() => NOW};

  const result=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services});

  assert.equal(result.exitCode,6,JSON.stringify(result.result.error));
  assert.equal(executions,0);
});

test("patch planning binds Work and Project rows to the exact repository",async () => {
  const {paused,state}=await pausedPreviewState();
  const work=bugWork();
  work.project.fields.repository=OTHER_REPOSITORY;
  let executions=0;
  const services={control:{async loadReleasePlanningState() { return structuredClone(state); }},
    github:{async snapshot(query) { return query.kind==="issue-start" ? issueStartSnapshot(work) :
      patchSnapshotBody(state,paused,work); }},operations:{reserveReceiptId() {
      return "RECEIPT-20260903-0502"; },async execute() { executions+=1;
      return {schema_version:"operation-preview.v1",operations:[]}; }},clock:() => NOW};
  const stageB=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services});
  assert.equal(stageB.exitCode,6,JSON.stringify(stageB.result.error));
  assert.equal(executions,0);

  const {paused:completionPaused,patch,publication}=completionFixture();
  const completion=completionSnapshot({patch,paused:completionPaused,publication,ancestor:true,
    featureHead:MERGED_SHA});
  completion.observation.assigned_work.items[0].work.project.fields.repository=OTHER_REPOSITORY;
  rehashCompletionSnapshot(completion);
  assert.throws(() => completePatchInterruption({patchProgram:patch,
    pausedProgram:completionPaused,publication,snapshot:completion}),CoreConflictError);
});

test("patch planning retains unrelated repository patch history without claiming it",async () => {
  const targetFeature=featureProgram();
  const otherFeature=featureProgram({repository:OTHER_REPOSITORY,
    programId:"TOSS-OS-R0003",feature:`${OTHER_REPOSITORY}#10`});
  const otherPaused=pausedFeatureProgram(otherFeature);
  const otherPatch=activePatchProgram(otherPaused,`${OTHER_REPOSITORY}#55`,{
    programId:"TOSS-OS-R0004",repository:OTHER_REPOSITORY});
  const state={revision:"control-cross-repository",organization:{...organization(),
    repositories:[REPOSITORY,OTHER_REPOSITORY]},
  repositories:[repositoryConfiguration(),otherRepositoryConfiguration()],
  programs:[targetFeature,otherPaused,otherPatch],intents:[],receipts:[]};
  let input=null;
  const services={control:{async loadReleasePlanningState() { return structuredClone(state); }},
    github:{async snapshot(query) {
      if (query.kind==="issue-start") return issueStartSnapshot();
      const observed=patchSnapshotBody(state,targetFeature);
      observed.patch_program_revisions=[];
      observed.repository.milestone=null;
      observed.repository.release_branch=null;
      return observed;
    }},operations:{reserveReceiptId() { return "RECEIPT-20260903-0503"; },
      async execute(value) { input=value;
        return {schema_version:"operation-preview.v1",operations:value.operations}; }},clock:() => NOW};

  const result=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{services});

  assert.equal(result.exitCode,0,JSON.stringify(result.result.error));
  assert.ok(input);
  assert.deepEqual(input.operations.map(operation => operation.payload.kind),[
    "release-patch-precondition","release-program-manifest",
  ]);
  assert.equal(input.operations[0].payload.query.patch_programs.length,1,
    "aggregate proof retains the unrelated patch program");
  assert.equal(input.operations[0].payload.query.patch_programs[0].program_id,otherPatch.program_id);
});

test("public Stage C carries patch aggregate evidence and rejects post-confirmation control drift",async () => {
  const harness=patchHarness();
  const applied=parseCoreCommand(["issue","start",BUG,"--apply","--non-interactive"]);
  for (let stage=0;stage<2;stage+=1) {
    const result=await dispatchCoreCommand(applied,{services:harness.services});
    assert.equal(result.exitCode,0,JSON.stringify(result.result.error));
  }
  const preview=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG]),{
    services:harness.services});
  assert.equal(preview.exitCode,0,JSON.stringify(preview.result.error));
  assert.equal(preview.result.data.operations.some(operation =>
    operation.payload.kind==="release-patch-precondition"),true,
  JSON.stringify(preview.result.data.operations));

  const drifted=await dispatchCoreCommand(parseCoreCommand(["issue","start",BUG,"--apply"]),{
    services:harness.services,confirm:async () => { harness.advanceControl(); return true; }});

  assert.equal(drifted.exitCode,6,JSON.stringify(drifted.result.error));
  assert.equal(harness.view().bugBranch,null);
  assert.equal(harness.view().state.intents.length,2);
});

test("patch completion invalidates the canonical managed PR review and Project in one receipt",async () => {
  const {paused,patch,publication}=completionFixture();
  const snapshot=completionSnapshot({patch,paused,publication,ancestor:true,
    featureHead:MERGED_SHA});
  const operations=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot});
  const pull=operations.find(operation => operation.resource==="pull_request" &&
    operation.payload.kind==="release-patch-review-stale");
  const project=operations.find(operation => operation.resource==="project" &&
    operation.payload.kind==="release-patch-review-stale");

  assert.ok(pull,"managed PR review result must be invalidated");
  assert.equal(pull.expected_revision,"pr-10-completion");
  assert.equal(pull.payload.freshness,"STALE");
  assert.equal(pull.payload.review_result.freshness,"STALE");
  assert.equal(pull.payload.work_review,null);
  assert.equal(pull.payload.body.includes("Human context."),true);
  assert.equal(pull.payload.body.includes("- Freshness: STALE"),true);
  assert.ok(project,"the exact Project item must be projected in the same plan");
  assert.equal(project.expected_revision,"project-10-completion");

  let controlRevision=snapshot.source.revision;
  let storedIntent=null;
  let storedReceipt=null;
  let storedProgram=paused;
  let storedBody=snapshot.observation.assigned_work.items[0].pull_request.body;
  let storedResult=snapshot.observation.assigned_work.items[0].review;
  let storedWorkReview=snapshot.observation.assigned_work.items[0].work.review;
  let storedFields=snapshot.observation.assigned_work.items[0].work.project.fields;
  const control={async head() { return controlRevision; },async findIntent() { return storedIntent; },
    async findReceipt() { return storedReceipt; },async commitIntent({expectedHead,intent}) {
      assert.equal(expectedHead,controlRevision); storedIntent=intent; controlRevision="control-after-intent";
      return {commit_sha:controlRevision}; },async commitReceipt() {
      throw new Error("manifest receipt path required"); },async inspectReleaseProgramOperation(operation) {
      return {operation_id:operation.operation_id,repository:CONTROL_REPOSITORY,
        revision:storedProgram.revision}; },
    async commitReleaseProgramReceipt({expectedHead,operation,receipt}) {
      assert.equal(expectedHead,controlRevision); storedProgram=operation.payload.program;
      storedReceipt=receipt; controlRevision="control-after-receipt";
      return {commit_sha:controlRevision}; }};
  const github={async snapshot() { return structuredClone(snapshot.observation); },
    async inspect(values) { return values.map(operation => ({operation_id:operation.operation_id,
      repository:operation.repository,revision:operation.expected_revision})); },
    async apply(values) {
      for (const operation of values) {
        if (operation.resource==="pull_request") {
          storedBody=operation.payload.body; storedResult=operation.payload.review_result;
          storedWorkReview=operation.payload.work_review;
        } else if (operation.resource==="project") storedFields=operation.payload.fields;
      }
      return {status:"completed",observed_revisions:values.map(operation => ({
        operation_id:operation.operation_id,repository:operation.repository,
        revision:`applied-${operation.operation_id}`}))}; }};
  const runner=createOperationRunner({control,github,authorityRegistry:{keys:[]},clock:() => NOW,
    idGenerator:kind => `${kind.toUpperCase()}-20260903-0999`,policyRevision:() => "POLICY-0001"});
  const intent=createOperationIntent({intent_id:"INTENT-20260903-0998",created_at:NOW,
    command:"issue.start",policy_revision:"POLICY-0001",source:snapshot.source,authority:null,
    planned_receipt_id:snapshot.receipt_id,operations});

  const receipt=await runner.apply(intent);

  assert.equal(receipt.status,"completed");
  assert.equal(storedReceipt.receipt_id,snapshot.receipt_id);
  assert.equal(storedResult.freshness,"STALE");
  assert.equal(storedWorkReview,null);
  assert.equal(storedBody.includes("- Freshness: STALE"),true);
  assert.equal(storedFields.Status,"In review");
  assert.equal(storedFields.Gate,"REVIEW_REQUIRED");
  assert.equal(canonicalJson(storedProgram),canonicalJson(paused));
});

test("every patch completion phase binds control source and persists paused-program CAS",() => {
  const {paused,patch,publication}=completionFixture();
  const snapshots=[
    completionSnapshot({patch,paused,publication}),
    completionSnapshot({patch,paused,publication,ancestor:true,featureHead:MERGED_SHA}),
    completionSnapshot({patch,paused,publication,ancestor:true,featureHead:MERGED_SHA,
      reviewFreshness:"STALE",checksState:"PENDING"}),
  ];
  for (const snapshot of snapshots) {
    const operations=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
      publication,snapshot});
    const aggregate=operations.find(operation =>
      operation.payload.kind==="release-patch-completion-precondition");
    assert.equal(aggregate.payload.query.control_repository,CONTROL_REPOSITORY);
    const manifest=operations.find(operation => operation.payload.kind==="release-program-manifest");
    assert.ok(manifest,"every phase must publish one manifest CAS with its receipt");
    assert.equal(manifest.repository,CONTROL_REPOSITORY);
    assert.equal(manifest.payload.expected_program_revision,paused.revision);
  }
  const foreign=completionSnapshot({patch,paused,publication});
  foreign.source.repository="Other/control";
  assert.throws(() => completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot:foreign}),CoreConflictError);
});

test("R64 patch projector exactly binds reconciliation review-check and resume transactions",async () => {
  const {paused,patch,publication}=completionFixture();
  const cases=[
    {name:"reconciliation",snapshot:completionSnapshot({patch,paused,publication}),
      mutate(operations) {
        const operation=operations.find(value =>
          value.payload.kind==="release-patch-reconcile");
        operation.payload.source_sha=operation.payload.source_sha==="9".repeat(40)
          ? "8".repeat(40) : "9".repeat(40);
      }},
    {name:"review-stale",snapshot:completionSnapshot({patch,paused,publication,ancestor:true,
      featureHead:MERGED_SHA}),mutate(operations) {
      const operation=operations.find(value =>
        value.payload.kind==="release-patch-review-stale" &&
        value.resource==="pull_request");
      operation.payload.body=`${operation.payload.body}\nsubstituted`;
    }},
    {name:"review-check",snapshot:completionSnapshot({patch,paused,publication,ancestor:true,
      featureHead:MERGED_SHA}),mutate(operations) {
      const operation=operations.find(value => value.payload.kind==="release-check-request");
      operation.payload.head_sha=operation.payload.head_sha==="9".repeat(40)
        ? "8".repeat(40) : "9".repeat(40);
    }},
    {name:"resume",snapshot:completionSnapshot({patch,paused,publication,ancestor:true,
      featureHead:MERGED_SHA,reviewFreshness:"STALE",checksState:"PENDING"}),
    mutate(operations) {
      const program=operations.find(operation =>
        operation.payload.kind==="release-program-manifest").payload.program;
      program.updated_at=program.updated_at==="2026-09-03T10:59:59.000Z"
        ? "2026-09-03T10:59:58.000Z" : "2026-09-03T10:59:59.000Z";
    }},
  ];
  for (const [index,{name,snapshot,mutate}] of cases.entries()) {
    const descriptor={observation:snapshot.observation,receipt_id:snapshot.receipt_id,
      timestamp:snapshot.timestamp};
    const decision=projectPatchCompletionTransaction(snapshot.query,descriptor);
    assert.equal(canonicalJson(decision.source),
      canonicalJson(patchCompletionSource(decision.query,snapshot.observation)),name);
    const input={intent_id:`INTENT-20260903-${String(900+index).padStart(4,"0")}`,
      created_at:snapshot.timestamp,command:"release.approve",policy_revision:"POLICY-0001",
      source:decision.source,authority:null,planned_receipt_id:snapshot.receipt_id,
      operations:decision.operations};
    const intent=createOperationIntent(input);
    const aggregate=intent.operations.find(operation =>
      operation.payload.kind==="release-patch-completion-precondition");
    assert.equal(canonicalJson(aggregate.payload.descriptor),canonicalJson(descriptor),name);

    const substituted=structuredClone(decision.operations);
    mutate(substituted);
    assert.throws(() => createOperationIntent({...input,operations:substituted}),
      CoreValidationError,name);
    assert.throws(() => createOperationIntent({...input,source:{
      ...decision.source,sha256:"f".repeat(64),
    }}),CoreValidationError,`${name} source`);
    const reordered=structuredClone(intent);
    [reordered.operations[0],reordered.operations[1]]=
      [reordered.operations[1],reordered.operations[0]];
    assert.throws(() => validateOperationIntent(reordered),CoreValidationError,
      `${name} operation order`);

    let calls=0;
    const called=async () => { calls+=1; return null; };
    const runner=createOperationRunner({control:{head:called,findIntent:called,
      findReceipt:called,commitIntent:called,commitReceipt:called,
      inspectReleaseProgramOperation:called,commitReleaseProgramReceipt:called},
    github:{snapshot:called,inspect:called,apply:called},authorityRegistry:{keys:[]},
    clock:() => snapshot.timestamp,idGenerator:() => "RECEIPT-20260903-9999",
    policyRevision:() => "POLICY-0001"});
    const raw=structuredClone(intent);
    mutate(raw.operations);
    await assert.rejects(runner.apply(raw),CoreValidationError,name);
    const rawSource=structuredClone(intent);
    rawSource.source.sha256="e".repeat(64);
    await assert.rejects(runner.apply(rawSource),CoreValidationError,`${name} source runner`);
    assert.equal(calls,0,`${name} must reject before every port`);
  }
  const simultaneous=completionSnapshot({patch,paused,publication,ancestor:true,
    featureHead:MERGED_SHA,reviewFreshness:"STALE",checksState:"PENDING"});
  simultaneous.query.phase_evidence.review_gate.receipt.created_at=
    simultaneous.query.phase_evidence.reconciliation.receipt.created_at;
  rehashCompletionSnapshot(simultaneous);
  assert.throws(() => projectPatchCompletionTransaction(simultaneous.query,{
    observation:simultaneous.observation,receipt_id:simultaneous.receipt_id,
    timestamp:simultaneous.timestamp,
  }),CoreConflictError,"review gate must strictly postdate reconciliation");
  const legacy=cases[0].snapshot;
  const legacyOperations=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot:legacy});
  const legacyIntent={schema_version:"operation-intent.v1",document_type:"operation-intent",
    intent_id:"INTENT-20260903-0999",
    created_at:legacy.timestamp,command:"release.approve",policy_revision:"POLICY-0001",
    source:legacy.source,authority:null,planned_receipt_id:legacy.receipt_id,
    operations:legacyOperations.map((operation,index) => ({operation_id:`OP-${String(index+1)
      .padStart(4,"0")}`,...operation}))};
  assert.doesNotThrow(() => validatePersistedOperationIntent(legacyIntent));
  assert.throws(() => validateOperationIntent(legacyIntent),CoreValidationError);
  assert.throws(() => createOperationIntent({intent_id:legacyIntent.intent_id,
    created_at:legacyIntent.created_at,command:legacyIntent.command,
    policy_revision:legacyIntent.policy_revision,source:legacyIntent.source,
    authority:legacyIntent.authority,planned_receipt_id:legacyIntent.planned_receipt_id,
    operations:legacyOperations}),CoreValidationError);
});

test("patch completion reconciles and reruns review gates before it can resume",async () => {
  const activeFeature=featureProgram();
  const pausedRelease=transitionRepositoryRelease(activeFeature.repository_releases[0],{
    event:"PAUSE_FOR_PATCH",expected_revision:"REV-0002",timestamp:NOW,
    source_receipt:"RECEIPT-20260903-0100",activation:null});
  const paused={...activeFeature,phase:"PAUSED",revision:"REV-0003",
    repository_releases:[pausedRelease],updated_at:NOW};
  const fakePauseIntent={schema_version:"operation-intent.v1",document_type:"operation-intent",
    intent_id:"INTENT-20260903-0100",command:"issue.start",created_at:NOW,
    policy_revision:"POLICY-0001",source:{repository:CONTROL_REPOSITORY,
      revision:"control-before-pause",sha256:"e".repeat(64)},authority:null,
    planned_receipt_id:"RECEIPT-20260903-0100",operations:[{operation_id:"OP-0001",
      resource:"repository",action:"commit",repository:CONTROL_REPOSITORY,
      expected_revision:"REV-0002",payload:{kind:"release-program-manifest",
        expected_program_revision:"REV-0002",program:paused}}]};
  const fakePauseReceipt={schema_version:"operation-receipt.v1",document_type:"operation-receipt",
    receipt_id:"RECEIPT-20260903-0100",intent_id:fakePauseIntent.intent_id,
    intent_sha256:sha256Canonical(fakePauseIntent),created_at:NOW,status:"completed",
    observed_revisions:[{operation_id:"OP-0001",repository:CONTROL_REPOSITORY,
      revision:paused.revision}]};
  const draftState={revision:"control-paused",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[paused],
    intents:[fakePauseIntent],receipts:[fakePauseReceipt]};
  const observation=patchSnapshotBody(draftState,paused);
  const query={kind:"patch-interruption",control_revision:draftState.revision,bug_id:BUG,
    feature_program:paused,patch_programs:[],programs:[paused],
    ledger_sha256:sha256Canonical({intents:[fakePauseIntent],receipts:[fakePauseReceipt]}),
    transition_evidence:{program_id:paused.program_id,
      release_id:paused.repository_releases[0].release_id,event:"PAUSE_FOR_PATCH",
      intent:fakePauseIntent,receipt:fakePauseReceipt},organization:organization(),
    repositories:[repositoryConfiguration()],repository_configuration:repositoryConfiguration(),
    project:organization().project};
  const source={source:{repository:CONTROL_REPOSITORY,revision:draftState.revision,
    sha256:sha256Canonical({control:{revision:draftState.revision,
      organization:draftState.organization,repositories:draftState.repositories,
      programs:draftState.programs,ledger_sha256:query.ledger_sha256},github:observation})},query,observation,
    receipt_id:"RECEIPT-20260903-0101",timestamp:NOW};
  const activePatch=planPatchInterruption({bug:issueStartSnapshot(),
    latestPublished:publicationEvidence(),activeFeatureProgram:paused,snapshot:source}).patchProgram;
  const {program:patch,publication}=releasedPatchProgram(activePatch);

  const mergeOnly=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot:completionSnapshot({patch,paused,publication})});
  assert.deepEqual(mergeOnly.map(operation => operation.payload.kind),[
    "release-patch-completion-precondition","release-default-branch-precondition",
    "release-branch-precondition","release-patch-reconcile","release-program-manifest",
  ]);
  assert.equal(mergeOnly.find(operation => operation.payload.kind==="release-program-manifest")
    .payload.program.phase,"PAUSED");

  const gateWork=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot:completionSnapshot({patch,paused,publication,ancestor:true,
      featureHead:MERGED_SHA})});
  assert.equal(gateWork.some(operation => operation.payload.kind==="release-patch-review-stale"),true);
  assert.equal(gateWork.some(operation => operation.payload.kind==="release-check-request"),true);
  assert.equal(gateWork.find(operation => operation.payload.kind==="release-program-manifest")
    .payload.program.phase,"PAUSED");

  const resumed=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot:completionSnapshot({patch,paused,publication,ancestor:true,
      featureHead:MERGED_SHA,reviewFreshness:"STALE",checksState:"PENDING"})});
  const manifest=resumed.find(operation => operation.payload.kind==="release-program-manifest");
  assert.equal(manifest.payload.program.phase,"ACTIVE");
  assert.equal(manifest.payload.program.repository_releases[0].phase,"ACTIVE");
  assert.equal(manifest.payload.program.repository_releases[0].branch,"release/v2.2.0");
});

test("completed reconciliation stales every older reviewed PR in the exact assigned-work inventory",() => {
  const {paused,patch,publication}=completionFixture();
  const snapshot=ruledCompletionSnapshot({patch,paused,publication,reconciled:true});
  const reconciliation=completionPhaseEvidence({kind:"reconciliation",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:LATER_MAIN_SHA,
    createdAt:RECONCILED_AT,intentId:"INTENT-20260903-0401",
    receiptId:"RECEIPT-20260903-0401"});
  snapshot.query.phase_evidence.reconciliation=reconciliation;
  rehashCompletionSnapshot(snapshot);

  const operations=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot});
  const pullUpdates=operations.filter(operation =>
    operation.resource==="pull_request" && operation.payload.kind==="release-patch-review-stale");
  const projectUpdates=operations.filter(operation =>
    operation.resource==="project" && operation.payload.kind==="release-patch-review-stale");
  assert.deepEqual(pullUpdates.map(operation => operation.payload.work_item_id),[
    `${REPOSITORY}#10`,`${REPOSITORY}#11`,
  ]);
  assert.deepEqual(pullUpdates.map(operation => operation.payload.head_sha),[EPIC_HEAD,CHILD_HEAD],
    "epic and child PR heads are independent from the feature release branch head");
  assert.equal(pullUpdates.every(operation =>
    operation.payload.review_result.freshness==="STALE"),true);
  assert.equal(canonicalJson(projectUpdates.map(operation => operation.payload.fields)),canonicalJson([
    {Status:"In review",Gate:"REVIEW_REQUIRED"},
    {Status:"In review",Gate:"REVIEW_REQUIRED"},
  ]));
  assert.equal(operations.some(operation => operation.payload.work_item_id===`${REPOSITORY}#12`),false,
    "an assigned item without a pull request remains represented but needs no review mutation");
});

test("completed reconciliation evidence requires its exact preconditions and merge envelope",() => {
  const {paused,patch,publication}=completionFixture();
  const reconciliation=completionPhaseEvidence({kind:"reconciliation",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:LATER_MAIN_SHA,
    createdAt:RECONCILED_AT,intentId:"INTENT-20260903-0531",
    receiptId:"RECEIPT-20260903-0531"});
  const missingPreconditions=rewriteCompletedPhaseEvidence(reconciliation,operations => {
    for (const kind of ["release-patch-completion-precondition",
      "release-default-branch-precondition","release-branch-precondition"]) {
      operations.splice(operations.findIndex(operation => operation.payload.kind===kind),1);
    }
    operations.push({resource:"issue",action:"update",repository:REPOSITORY,
      expected_revision:"issue-extra",payload:{kind:"unrelated-mutation"}});
  });
  const mismatchedSource=rewriteCompletedPhaseEvidence(reconciliation,operations => {
    operations.find(operation => operation.payload.kind==="release-patch-reconcile")
      .payload.source_sha=PATCH_SHA;
  });
  const mismatchedTargetCas=rewriteCompletedPhaseEvidence(reconciliation,operations => {
    operations.find(operation => operation.payload.kind==="release-patch-reconcile")
      .expected_revision="feature-foreign";
  });
  for (const [label,evidence] of [["missing preconditions and extra mutation",missingPreconditions],
    ["source head mismatch",mismatchedSource],["target CAS mismatch",mismatchedTargetCas]]) {
    const snapshot=ruledCompletionSnapshot({patch,paused,publication,reconciled:true,
      phaseEvidence:{reconciliation:evidence,review_gate:null},checksState:"NOT_STARTED"});
    assert.throws(() => completePatchInterruption({patchProgram:patch,pausedProgram:paused,
      publication,snapshot}),CoreConflictError,label);
  }
});

test("assigned-work inventory IDs must exactly equal its unique canonical item identities",() => {
  const {paused,patch,publication}=completionFixture();
  const snapshot=ruledCompletionSnapshot({patch,paused,publication,reconciled:true});
  snapshot.observation.assigned_work.items.pop();
  rehashCompletionSnapshot(snapshot);

  assert.throws(() => completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot}),CoreConflictError);
});

test("assigned-work inventory cannot omit an in-scope release epic",() => {
  const {paused,patch,publication}=completionFixture();
  const snapshot=ruledCompletionSnapshot({patch,paused,publication,reconciled:false,items:[]});
  assert.throws(() => completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot}),CoreConflictError);
});

test("patch publication may predate current main while reconciliation merges exact current main CAS",() => {
  const {paused,patch,publication}=completionFixture();
  const snapshot=ruledCompletionSnapshot({patch,paused,publication,currentMain:LATER_MAIN_SHA,
    featureHead:FEATURE_RELEASE_HEAD,reconciled:false,checksState:"NOT_STARTED"});

  const operations=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot});
  const defaultPrecondition=operations.find(operation =>
    operation.payload.kind==="release-default-branch-precondition");
  const merge=operations.find(operation => operation.payload.kind==="release-patch-reconcile");
  assert.equal(defaultPrecondition.payload.head_sha,LATER_MAIN_SHA);
  assert.equal(merge.payload.source_sha,LATER_MAIN_SHA);
  assert.equal(merge.payload.target_sha,FEATURE_RELEASE_HEAD);
  assert.equal(merge.expected_revision,"feature-completion");
  assert.notEqual(merge.payload.source_sha,publication.expected_revision,
    "publication proves ancestry and does not pin current main to the old publication head");
});

test("a later main advance supersedes prior reconciliation and plans a new exact-head merge",() => {
  const {paused,patch,publication}=completionFixture();
  const prior=completionPhaseEvidence({kind:"reconciliation",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:PATCH_SHA,createdAt:RECONCILED_AT,
    intentId:"INTENT-20260903-0410",receiptId:"RECEIPT-20260903-0410"});
  const snapshot=ruledCompletionSnapshot({patch,paused,publication,currentMain:LATER_MAIN_SHA,
    featureHead:FEATURE_RELEASE_HEAD,reconciled:false,
    phaseEvidence:{reconciliation:prior,review_gate:null},checksState:"NOT_STARTED"});
  const operations=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot});
  assert.equal(operations.find(operation => operation.payload.kind==="release-patch-reconcile")
    .payload.source_sha,LATER_MAIN_SHA);
});

test("a reconciliation cannot be superseded without a changed current default head",() => {
  const {paused,patch,publication}=completionFixture();
  const prior=completionPhaseEvidence({kind:"reconciliation",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:PATCH_SHA,createdAt:RECONCILED_AT,
    intentId:"INTENT-20260903-0561",receiptId:"RECEIPT-20260903-0561"});
  const snapshot=ruledCompletionSnapshot({patch,paused,publication,currentMain:PATCH_SHA,
    featureHead:MERGED_SHA,reconciled:false,
    phaseEvidence:{reconciliation:prior,review_gate:null},checksState:"NOT_STARTED"});
  let operations=null;
  assert.throws(() => {
    operations=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
      publication,snapshot});
  },CoreConflictError);
  assert.equal(operations,null,"inconsistent ancestry must fail before returning operations");
});

test("a second reconciliation resets validated predecessor evidence and its receipt is consumable",() => {
  const {paused,patch,publication}=completionFixture();
  const initial=ruledCompletionSnapshot({patch,paused,publication,currentMain:PATCH_SHA,
    featureHead:FEATURE_RELEASE_HEAD,reconciled:false,
    phaseEvidence:{reconciliation:null,review_gate:null},checksState:"NOT_STARTED"});
  const firstOperations=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot:initial});
  const first=completedPatchOperations(firstOperations,{paused,createdAt:RECONCILED_AT,
    intentId:"INTENT-20260903-0541",receiptId:"RECEIPT-20260903-0541"});
  const advanced=ruledCompletionSnapshot({patch,paused,publication,currentMain:LATER_MAIN_SHA,
    featureHead:FEATURE_RELEASE_HEAD,reconciled:false,
    phaseEvidence:{reconciliation:first,review_gate:null},checksState:"NOT_STARTED"});
  const secondOperations=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot:advanced});
  const aggregate=secondOperations.find(operation =>
    operation.payload.kind==="release-patch-completion-precondition");
  assert.equal(canonicalJson(aggregate.payload.query.phase_evidence),
    canonicalJson({reconciliation:null,review_gate:null}));

  const second=completedPatchOperations(secondOperations,{paused,
    createdAt:"2026-09-03T10:25:00.000Z",intentId:"INTENT-20260903-0542",
    receiptId:"RECEIPT-20260903-0542"});
  assert.equal(canonicalJson(second).includes(first.intent.intent_id),false,
    "the active reconciliation round does not recursively embed its predecessor");
  const reconciled=ruledCompletionSnapshot({patch,paused,publication,
    currentMain:LATER_MAIN_SHA,featureHead:MERGED_SHA,reconciled:true,
    phaseEvidence:{reconciliation:second,review_gate:null},checksState:"NOT_STARTED"});
  const next=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot:reconciled});
  assert.equal(next.some(operation => operation.payload.kind==="release-patch-review-stale"),true);
  assert.equal(next.some(operation => operation.payload.kind==="release-check-request"),true);
});

test("a second reconciliation validates failed or unresolved predecessor evidence before planning",() => {
  const {paused,patch,publication}=completionFixture();
  const first=completionPhaseEvidence({kind:"reconciliation",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:PATCH_SHA,createdAt:RECONCILED_AT,
    intentId:"INTENT-20260903-0551",receiptId:"RECEIPT-20260903-0551"});
  const failed=structuredClone(first);
  failed.receipt.status="failed";
  const unresolved=structuredClone(first);
  unresolved.receipt.observed_revisions.pop();
  for (const [label,evidence] of [["failed",failed],["unresolved",unresolved]]) {
    const advanced=ruledCompletionSnapshot({patch,paused,publication,currentMain:LATER_MAIN_SHA,
      featureHead:FEATURE_RELEASE_HEAD,reconciled:false,
      phaseEvidence:{reconciliation:evidence,review_gate:null},checksState:"NOT_STARTED"});
    assert.throws(() => completePatchInterruption({patchProgram:patch,pausedProgram:paused,
      publication,snapshot:advanced}),CoreConflictError,label);
  }
});

test("a completed review gate is historically validated before a later main reconciliation",() => {
  const {paused,patch,publication,reconciliation,reviewGate,
    reviewGateOperations,current}=completedReviewedReconciliationRound();
  assert.equal(reviewGateOperations.filter(operation =>
    operation.payload.kind==="release-patch-review-stale").length,2);
  const advanced=ruledCompletionSnapshot({patch,paused,publication,currentMain:LATER_MAIN_SHA,
    featureHead:MERGED_SHA,reconciled:false,items:[current],
    phaseEvidence:{reconciliation,review_gate:reviewGate},checksState:"PENDING"});
  const secondOperations=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot:advanced});
  const aggregate=secondOperations.find(operation =>
    operation.payload.kind==="release-patch-completion-precondition");
  assert.equal(canonicalJson(aggregate.payload.query.phase_evidence),
    canonicalJson({reconciliation:null,review_gate:null}));

  const second=completedPatchOperations(secondOperations,{paused,
    createdAt:"2026-09-03T10:28:00.000Z",intentId:"INTENT-20260903-0604",
    receiptId:"RECEIPT-20260903-0604"});
  const reconciled=ruledCompletionSnapshot({patch,paused,publication,currentMain:LATER_MAIN_SHA,
    featureHead:SECOND_MERGED_SHA,reconciled:true,items:[current],
    phaseEvidence:{reconciliation:second,review_gate:null},checksState:"NOT_STARTED"});
  const next=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot:reconciled});
  assert.equal(next.some(operation => operation.payload.kind==="release-patch-review-stale"),true);
  assert.equal(next.some(operation => operation.payload.kind==="release-check-request"),true);
});

test("historical review gates reject corruption unresolved receipts and feature-head drift",() => {
  const {paused,patch,publication,reconciliation,reviewGate,
    current}=completedReviewedReconciliationRound();
  const corrupt=rewriteCompletedPhaseEvidence(reviewGate,operations => {
    operations.find(operation =>
      operation.payload.kind==="release-default-branch-precondition").payload.head_sha=LATER_MAIN_SHA;
  });
  const failed=structuredClone(reviewGate);
  failed.receipt.status="failed";
  const unresolved=structuredClone(reviewGate);
  unresolved.receipt.observed_revisions.pop();
  const cases=[
    ["corrupt historical default",corrupt,MERGED_SHA],
    ["failed historical gate",failed,MERGED_SHA],
    ["unresolved historical gate",unresolved,MERGED_SHA],
    ["unexpected feature-head drift",reviewGate,SECOND_MERGED_SHA],
  ];
  for (const [label,evidence,featureHead] of cases) {
    const advanced=ruledCompletionSnapshot({patch,paused,publication,currentMain:LATER_MAIN_SHA,
      featureHead,reconciled:false,items:[current],
      phaseEvidence:{reconciliation,review_gate:evidence},checksState:"PENDING"});
    let operations=null;
    assert.throws(() => {
      operations=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
        publication,snapshot:advanced});
    },CoreConflictError,label);
    assert.equal(operations,null,`${label} must fail before returning operations`);
  }
});

test("completed review gate preserves stored STALE evidence and does not stale a later distinct re-review",() => {
  const {paused,patch,publication}=completionFixture();
  const feature=paused.repository_releases[0];
  const original=ruledCompletionSnapshot({patch,paused,publication,reconciled:true});
  const reconciliation=completionPhaseEvidence({kind:"reconciliation",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:LATER_MAIN_SHA,
    createdAt:RECONCILED_AT,intentId:"INTENT-20260903-0402",
    receiptId:"RECEIPT-20260903-0402"});
  const reviewGate=completionPhaseEvidence({kind:"review_gate",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:LATER_MAIN_SHA,
    items:original.observation.assigned_work.items,createdAt:REVIEW_GATE_AT,
    phaseEvidence:{reconciliation,review_gate:null},
    intentId:"INTENT-20260903-0403",receiptId:"RECEIPT-20260903-0403"});
  const items=[
    assignedWorkItem(feature,{number:10,head:EPIC_HEAD,kind:"epic",
      reviewId:"REVIEW-20260903-0410",recordedAt:REREVIEWED_AT}),
    assignedWorkItem(feature,{number:11,head:CHILD_HEAD,
      reviewId:"REVIEW-20260903-0311",freshness:"STALE"}),
    assignedWorkItem(feature,{number:12,head:"5".repeat(40),hasPullRequest:false}),
  ];
  const snapshot=ruledCompletionSnapshot({patch,paused,publication,reconciled:true,items,
    phaseEvidence:{reconciliation,review_gate:reviewGate},checksState:"PENDING"});

  const operations=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot});
  assert.equal(operations.some(operation =>
    operation.payload.kind==="release-patch-review-stale"),false);
  const manifest=operations.find(operation => operation.payload.kind==="release-program-manifest");
  assert.equal(manifest.payload.program.phase,"ACTIVE");
  assert.equal(items[1].work.review,null);
  assert.equal(items[1].pull_request.formal_review.state,"APPROVED",
    "formal review remains immutable historical evidence");
});

test("patch resume requires authoritative Project fields for a later CURRENT re-review",() => {
  const {paused,patch,publication,reconciliation,reviewGate,current}=
    completedReviewedReconciliationRound();
  const exact=ruledCompletionSnapshot({patch,paused,publication,currentMain:PATCH_SHA,
    featureHead:MERGED_SHA,reconciled:true,items:[current],
    phaseEvidence:{reconciliation,review_gate:reviewGate},checksState:"PENDING"});
  const resumed=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot:exact});
  assert.equal(resumed.find(operation => operation.payload.kind==="release-program-manifest")
    .payload.program.phase,"ACTIVE");
  assert.equal(current.work.project.fields.Gate,"EPIC_ACCEPTANCE_REQUIRED");

  const drifted=structuredClone(exact);
  drifted.observation.assigned_work.items[0].work.project.fields.Gate="NONE";
  rehashCompletionSnapshot(drifted);
  let operations=null;
  assert.throws(() => {
    operations=completePatchInterruption({patchProgram:patch,pausedProgram:paused,
      publication,snapshot:drifted});
  },CoreConflictError);
  assert.equal(operations,null,"Project reconciliation drift must fail before operations are returned");
});

test("completed review-gate evidence binds each stale PR to its exact Project item",() => {
  const {paused,patch,publication}=completionFixture();
  const feature=paused.repository_releases[0];
  const current=assignedWorkItem(feature,{number:10,head:EPIC_HEAD,kind:"epic",
    reviewId:"REVIEW-20260903-0500",recordedAt:NOW});
  const reconciliation=completionPhaseEvidence({kind:"reconciliation",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:LATER_MAIN_SHA,
    createdAt:RECONCILED_AT,intentId:"INTENT-20260903-0501",
    receiptId:"RECEIPT-20260903-0501"});
  const reviewGate=completionPhaseEvidence({kind:"review_gate",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:LATER_MAIN_SHA,items:[current],
    phaseEvidence:{reconciliation,review_gate:null},createdAt:REVIEW_GATE_AT,
    intentId:"INTENT-20260903-0502",receiptId:"RECEIPT-20260903-0502"});
  const forged=rewriteCompletedPhaseEvidence(reviewGate,operations => {
    const project=operations.find(operation => operation.resource==="project" &&
      operation.action==="update" && operation.payload.kind==="release-patch-review-stale");
    project.expected_revision="project-foreign";
    project.payload.project_id="PVT_FOREIGN";
    project.payload.item_id="PVTI_foreign";
  });
  const stale=assignedWorkItem(feature,{number:10,head:EPIC_HEAD,kind:"epic",
    reviewId:"REVIEW-20260903-0500",recordedAt:NOW,freshness:"STALE"});
  const snapshot=ruledCompletionSnapshot({patch,paused,publication,reconciled:true,items:[stale],
    phaseEvidence:{reconciliation,review_gate:forged},checksState:"PENDING"});

  assert.throws(() => completePatchInterruption({patchProgram:patch,pausedProgram:paused,
    publication,snapshot}),CoreConflictError);
});

test("completed review-gate evidence requires all exact completion preconditions",() => {
  const {paused,patch,publication}=completionFixture();
  const feature=paused.repository_releases[0];
  const current=assignedWorkItem(feature,{number:10,head:EPIC_HEAD,kind:"epic",
    reviewId:"REVIEW-20260903-0510",recordedAt:NOW});
  const reconciliation=completionPhaseEvidence({kind:"reconciliation",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:LATER_MAIN_SHA,
    createdAt:RECONCILED_AT,intentId:"INTENT-20260903-0511",
    receiptId:"RECEIPT-20260903-0511"});
  const reviewGate=completionPhaseEvidence({kind:"review_gate",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:LATER_MAIN_SHA,items:[current],
    phaseEvidence:{reconciliation,review_gate:null},createdAt:REVIEW_GATE_AT,
    intentId:"INTENT-20260903-0512",receiptId:"RECEIPT-20260903-0512"});
  const stale=assignedWorkItem(feature,{number:10,head:EPIC_HEAD,kind:"epic",
    reviewId:"REVIEW-20260903-0510",recordedAt:NOW,freshness:"STALE"});
  for (const kind of ["release-patch-completion-precondition",
    "release-default-branch-precondition","release-branch-precondition"]) {
    const incomplete=rewriteCompletedPhaseEvidence(reviewGate,operations => {
      operations.splice(operations.findIndex(operation => operation.payload.kind===kind),1);
    });
    const snapshot=ruledCompletionSnapshot({patch,paused,publication,reconciled:true,items:[stale],
      phaseEvidence:{reconciliation,review_gate:incomplete},checksState:"PENDING"});
    assert.throws(() => completePatchInterruption({patchProgram:patch,pausedProgram:paused,
      publication,snapshot}),CoreConflictError,kind);
  }
});

test("completed review-gate evidence rejects extra operations and inexact receipt coverage",() => {
  const {paused,patch,publication}=completionFixture();
  const feature=paused.repository_releases[0];
  const current=assignedWorkItem(feature,{number:10,head:EPIC_HEAD,kind:"epic",
    reviewId:"REVIEW-20260903-0520",recordedAt:NOW});
  const reconciliation=completionPhaseEvidence({kind:"reconciliation",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:LATER_MAIN_SHA,
    createdAt:RECONCILED_AT,intentId:"INTENT-20260903-0521",
    receiptId:"RECEIPT-20260903-0521"});
  const reviewGate=completionPhaseEvidence({kind:"review_gate",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:LATER_MAIN_SHA,items:[current],
    phaseEvidence:{reconciliation,review_gate:null},createdAt:REVIEW_GATE_AT,
    intentId:"INTENT-20260903-0522",receiptId:"RECEIPT-20260903-0522"});
  const stale=assignedWorkItem(feature,{number:10,head:EPIC_HEAD,kind:"epic",
    reviewId:"REVIEW-20260903-0520",recordedAt:NOW,freshness:"STALE"});
  const assertRejected=(label,evidence) => {
    const snapshot=ruledCompletionSnapshot({patch,paused,publication,reconciled:true,items:[stale],
      phaseEvidence:{reconciliation,review_gate:evidence},checksState:"PENDING"});
    assert.throws(() => completePatchInterruption({patchProgram:patch,pausedProgram:paused,
      publication,snapshot}),error => error?.exitCode===5 || error instanceof CoreConflictError,label);
  };
  assert.throws(() => rewriteCompletedPhaseEvidence(reviewGate,operations => {
    operations.find(operation => operation.payload.kind==="release-program-manifest")
      .expected_revision="REV-9999";
  }),error => error?.exitCode===5,"manifest CAS");
  assertRejected("extra stale operation",rewriteCompletedPhaseEvidence(reviewGate,operations => {
    operations.push({resource:"issue",action:"update",repository:REPOSITORY,
      expected_revision:"issue-extra",payload:{kind:"release-patch-review-stale"}});
  }));
  const duplicated=structuredClone(reviewGate);
  duplicated.receipt.observed_revisions.push(duplicated.receipt.observed_revisions[0]);
  assertRejected("duplicate receipt observation",duplicated);
});

test("public release approve advances one Released patch completion phase with null authority",async () => {
  const {paused,patch,publication,next,intents,receipts}=completionFixture();
  const state={revision:"control-completion",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[paused,patch,next],intents,receipts};
  const ruled=ruledCompletionSnapshot({patch,paused,publication,reconciled:false});
  let request=null;
  let snapshots=0;
  const result=await dispatchCoreCommand(parseCoreCommand(["release","approve",
    `${REPOSITORY}@2.1.3`]),{services:{
    control:{async loadReleasePlanningState() { return state; }},
    github:{async snapshot(query) {
      snapshots+=1;
      assert.equal(query.kind,"patch-completion");
      assert.equal(canonicalJson(query.programs),canonicalJson(state.programs));
      assert.equal(canonicalJson(query.phase_evidence),
        canonicalJson({reconciliation:null,review_gate:null}));
      return ruled.observation;
    }},
    operations:{reserveReceiptId() { return "RECEIPT-20260903-0399"; },
      async execute(value) { request=value; return {status:"preview"}; }},
    clock:() => REREVIEWED_AT,
  }});
  assert.equal(result.exitCode,0,JSON.stringify(result));
  assert.equal(snapshots,1);
  assert.equal(request.authority,null);
  assert.equal(request.receipt_id,"RECEIPT-20260903-0399");
  assert.deepEqual(request.operations.map(operation => operation.payload.kind),[
    "release-patch-completion-precondition","release-default-branch-precondition",
    "release-branch-precondition","release-patch-reconcile","release-program-manifest",
  ]);
});

test("public release approve restarts patch reconciliation review gate and resume one receipt at a time",async () => {
  const {paused,patch,publication,next,intents,receipts}=completionFixture();
  const baseState={revision:"control-completion-1",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[paused,patch,next],intents,receipts};
  const evidenceForRequest=(request,{intentId,receiptId,createdAt}) => {
    const intent=createOperationIntent({intent_id:intentId,created_at:createdAt,
      command:"release.approve",policy_revision:"POLICY-0001",source:request.source,
      authority:null,planned_receipt_id:receiptId,
      operations:request.operations.map(({operation_id:_,...operation}) => operation)});
    return {intent,receipt:{schema_version:"operation-receipt.v1",
      document_type:"operation-receipt",receipt_id:receiptId,intent_id:intent.intent_id,
      intent_sha256:sha256Canonical(intent),created_at:createdAt,status:"completed",
      observed_revisions:intent.operations.map(operation => ({operation_id:operation.operation_id,
        repository:operation.repository,revision:operation.payload.kind==="release-program-manifest"
          ? operation.payload.program.revision : operation.expected_revision}))}};
  };
  const invoke=async ({state,receiptId,at,observation}) => {
    let request=null;
    let snapshots=0;
    let reservations=0;
    const result=await dispatchCoreCommand(parseCoreCommand(["release","approve",
      `${REPOSITORY}@2.1.3`]),{services:{
      control:{async loadReleasePlanningState() { return state; }},
      github:{async snapshot(query) { snapshots+=1; return observation(query); }},
      operations:{reserveReceiptId() { reservations+=1; return receiptId; },
        async execute(value) { request=value; return {status:"preview"}; }},clock:() => at,
    }});
    assert.equal(result.exitCode,0,JSON.stringify(result));
    return {request,result,snapshots,reservations};
  };
  const rejectBeforeSnapshot=async (state,{expectedReservations=1,expectedExitCode=6}={}) => {
    let snapshots=0;
    let reservations=0;
    const result=await dispatchCoreCommand(parseCoreCommand(["release","approve",
      `${REPOSITORY}@2.1.3`]),{services:{
      control:{async loadReleasePlanningState() { return state; }},
      github:{async snapshot() { snapshots+=1; throw new Error("must reject causality first"); }},
      operations:{reserveReceiptId() { reservations+=1;
        return "RECEIPT-20260903-0780"; },async execute() {
        throw new Error("must not execute"); }},clock:() => "2026-09-03T11:20:00.000Z",
    }});
    assert.equal(result.exitCode,expectedExitCode,JSON.stringify(result));
    assert.equal(snapshots,0);
    assert.equal(reservations,expectedReservations);
  };
  const legacyGateFor=({gate,reference,intentId,receiptId,createdAt}) => {
    const result=structuredClone(gate);
    result.intent.intent_id=intentId;
    result.intent.planned_receipt_id=receiptId;
    result.intent.created_at=createdAt;
    const aggregate=result.intent.operations.find(operation =>
      operation.payload.kind==="release-patch-completion-precondition");
    delete aggregate.payload.descriptor;
    aggregate.payload.query.phase_evidence={reconciliation:reference,review_gate:null};
    result.receipt={...result.receipt,receipt_id:receiptId,intent_id:intentId,
      created_at:createdAt,intent_sha256:sha256Canonical(result.intent)};
    return result;
  };
  const observed=(query,options) => {
    const ruled=ruledCompletionSnapshot({patch,paused,publication,
      phaseEvidence:query.phase_evidence,...options});
    return {...ruled.observation,control_revision:query.control_revision};
  };

  const first=await invoke({state:baseState,receiptId:"RECEIPT-20260903-0795",
    at:RECONCILED_AT,observation:query => observed(query,{reconciled:false})});
  assert.equal(first.request.operations.some(operation =>
    operation.payload.kind==="release-patch-reconcile"),true);
  const reconciliation=evidenceForRequest(first.request,{intentId:"INTENT-20260903-0795",
    receiptId:"RECEIPT-20260903-0795",createdAt:RECONCILED_AT});
  const nextAfterReconciliation={...next,updated_at:"2026-09-03T10:15:00.000Z"};
  const afterReconciliation={...baseState,revision:"control-completion-2",
    programs:[paused,patch,nextAfterReconciliation],
    intents:[...baseState.intents,reconciliation.intent],
    receipts:[...baseState.receipts,reconciliation.receipt]};
  await rejectBeforeSnapshot({...afterReconciliation,
    revision:"control-completion-linked-patch-drift",
    programs:[paused,{...patch,updated_at:"2026-09-03T10:14:00.000Z"},
      nextAfterReconciliation]});
  await rejectBeforeSnapshot({...afterReconciliation,
    revision:"control-completion-linked-policy-drift",
    organization:{...afterReconciliation.organization,policy_revision:"POLICY-0002"}});
  await rejectBeforeSnapshot({...afterReconciliation,
    revision:"control-completion-linked-config-drift",
    repositories:[{...repositoryConfiguration(),publication:{
      ...repositoryConfiguration().publication,workflow:"changed-publish.yml",
    }}]});

  const second=await invoke({state:afterReconciliation,receiptId:"RECEIPT-20260903-0794",
    at:REVIEW_GATE_AT,observation:query => observed(query,{reconciled:true,
      checksState:"NOT_STARTED"})});
  assert.equal(second.request.operations.some(operation =>
    operation.payload.kind==="release-patch-reconcile"),false);
  assert.equal(second.request.operations.some(operation =>
    operation.payload.kind==="release-patch-review-stale"),true);
  assert.equal(second.request.operations.some(operation =>
    operation.payload.kind==="release-check-request"),true);
  const reviewGate=evidenceForRequest(second.request,{intentId:"INTENT-20260903-0791",
    receiptId:"RECEIPT-20260903-0794",createdAt:REVIEW_GATE_AT});
  const afterReviewGate={...afterReconciliation,revision:"control-completion-3",
    intents:[...baseState.intents,reconciliation.intent,reviewGate.intent],
    receipts:[...baseState.receipts,reconciliation.receipt,reviewGate.receipt]};
  const feature=paused.repository_releases[0];
  const nextAfterReviewGate={...nextAfterReconciliation,
    updated_at:"2026-09-03T10:25:00.000Z"};
  const afterReviewGateEvolution={...afterReviewGate,
    revision:"control-completion-3-evolved",
    programs:[paused,patch,nextAfterReviewGate]};
  const third=await invoke({state:afterReviewGateEvolution,
    receiptId:"RECEIPT-20260903-0793",
    at:REREVIEWED_AT,observation:query => observed(query,{reconciled:false,
      currentMain:SECOND_MERGED_SHA})});
  assert.equal(third.request.operations.some(operation =>
    operation.payload.kind==="release-patch-reconcile"),true);
  const resetQuery=third.request.operations.find(operation =>
    operation.payload.kind==="release-patch-completion-precondition").payload.query;
  assert.equal(canonicalJson(resetQuery.phase_evidence),
    canonicalJson({reconciliation:null,review_gate:null}));
  const secondReconciliation=evidenceForRequest(third.request,{
    intentId:"INTENT-20260903-0794",receiptId:"RECEIPT-20260903-0793",
    createdAt:REREVIEWED_AT});
  const afterSecondReconciliation={...afterReviewGateEvolution,
    revision:"control-completion-4",
    intents:[...baseState.intents,reconciliation.intent,reviewGate.intent,
      secondReconciliation.intent],
    receipts:[...baseState.receipts,reconciliation.receipt,reviewGate.receipt,
      secondReconciliation.receipt]};

  const equalRoots=structuredClone(afterSecondReconciliation);
  equalRoots.receipts.find(receipt =>
    receipt.intent_id===secondReconciliation.intent.intent_id).created_at=RECONCILED_AT;
  await rejectBeforeSnapshot(equalRoots);

  const overlappingChains=structuredClone(afterSecondReconciliation);
  overlappingChains.receipts.find(receipt =>
    receipt.intent_id===reviewGate.intent.intent_id).created_at=
      "2026-09-03T10:40:00.000Z";
  await rejectBeforeSnapshot(overlappingChains);

  const invalidReceiptTime=structuredClone(afterReconciliation);
  invalidReceiptTime.receipts.find(receipt =>
    receipt.intent_id===reconciliation.intent.intent_id).created_at=
      "2026-02-31T10:10:00.000Z";
  await rejectBeforeSnapshot(invalidReceiptTime,{expectedReservations:0,expectedExitCode:5});

  const simultaneousGate=structuredClone(afterReviewGate);
  simultaneousGate.receipts.find(receipt =>
    receipt.intent_id===reviewGate.intent.intent_id).created_at=RECONCILED_AT;
  await rejectBeforeSnapshot(simultaneousGate);

  const danglingGate=legacyGateFor({gate:reviewGate,reference:secondReconciliation,
    intentId:"INTENT-20260903-0781",receiptId:"RECEIPT-20260903-0781",
    createdAt:"2026-09-03T10:50:00.000Z"});
  await rejectBeforeSnapshot({...afterReconciliation,revision:"control-completion-dangling",
    intents:[...afterReconciliation.intents,danglingGate.intent],
    receipts:[...afterReconciliation.receipts,danglingGate.receipt]});

  const crossLinkedGate=legacyGateFor({gate:reviewGate,reference:secondReconciliation,
    intentId:"INTENT-20260903-0782",receiptId:"RECEIPT-20260903-0782",
    createdAt:"2026-09-03T10:50:00.000Z"});
  await rejectBeforeSnapshot({...afterSecondReconciliation,
    revision:"control-completion-cross-linked",
    intents:[...afterSecondReconciliation.intents,crossLinkedGate.intent],
    receipts:[...afterSecondReconciliation.receipts,crossLinkedGate.receipt]});

  const duplicateGate=legacyGateFor({gate:reviewGate,reference:reconciliation,
    intentId:"INTENT-20260903-0783",receiptId:"RECEIPT-20260903-0783",
    createdAt:"2026-09-03T10:30:00.000Z"});
  await rejectBeforeSnapshot({...afterReviewGate,revision:"control-completion-duplicate-gate",
    intents:[...afterReviewGate.intents,duplicateGate.intent],
    receipts:[...afterReviewGate.receipts,duplicateGate.receipt]});
  const postReconciliationItems=[
    assignedWorkItem(feature,{number:10,head:EPIC_HEAD,kind:"epic",
      reviewId:"REVIEW-20260903-0800",recordedAt:"2026-09-03T10:40:00.000Z"}),
    assignedWorkItem(feature,{number:11,head:CHILD_HEAD,
      reviewId:"REVIEW-20260903-0801",recordedAt:"2026-09-03T10:40:00.000Z"}),
    assignedWorkItem(feature,{number:12,head:"5".repeat(40),hasPullRequest:false}),
  ];

  const fourth=await invoke({state:afterSecondReconciliation,
    receiptId:"RECEIPT-20260903-0792",at:"2026-09-03T10:50:00.000Z",
    observation:query => {
      assert.equal(query.phase_evidence.reconciliation.intent.intent_id,
        secondReconciliation.intent.intent_id);
      assert.equal(query.phase_evidence.review_gate,null);
      return observed(query,{reconciled:true,currentMain:SECOND_MERGED_SHA,
        items:postReconciliationItems,checksState:"NOT_STARTED"});
    }});
  assert.equal(fourth.request.operations.some(operation =>
    operation.payload.kind==="release-patch-reconcile"),false);
  const secondReviewGate=evidenceForRequest(fourth.request,{
    intentId:"INTENT-20260903-0792",receiptId:"RECEIPT-20260903-0792",
    createdAt:"2026-09-03T10:50:00.000Z"});
  const afterSecondReviewGate={...afterSecondReconciliation,
    revision:"control-completion-5",
    intents:[...baseState.intents,reconciliation.intent,reviewGate.intent,
      secondReconciliation.intent,secondReviewGate.intent],
    receipts:[...baseState.receipts,reconciliation.receipt,reviewGate.receipt,
      secondReconciliation.receipt,secondReviewGate.receipt]};
  const resumedItems=[
    assignedWorkItem(feature,{number:10,head:EPIC_HEAD,kind:"epic",
      reviewId:"REVIEW-20260903-0900",recordedAt:"2026-09-03T11:00:00.000Z"}),
    assignedWorkItem(feature,{number:11,head:CHILD_HEAD,
      reviewId:"REVIEW-20260903-0901",recordedAt:"2026-09-03T11:00:00.000Z"}),
    assignedWorkItem(feature,{number:12,head:"5".repeat(40),hasPullRequest:false}),
  ];
  const fifth=await invoke({state:afterSecondReviewGate,
    receiptId:"RECEIPT-20260903-0791",at:"2026-09-03T11:10:00.000Z",
    observation:query => observed(query,{reconciled:true,currentMain:SECOND_MERGED_SHA,
      items:resumedItems,checksState:"PENDING"})});
  assert.deepEqual(fifth.request.operations.map(operation => operation.payload.kind),[
    "release-patch-completion-precondition","release-default-branch-precondition",
    "release-branch-precondition","release-program-manifest",
  ]);
  const resumed=fifth.request.operations.find(operation =>
    operation.payload.kind==="release-program-manifest").payload.program;
  assert.equal(resumed.phase,"ACTIVE");
  const resume=evidenceForRequest(fifth.request,{intentId:"INTENT-20260903-0793",
    receiptId:"RECEIPT-20260903-0791",createdAt:"2026-09-03T11:10:00.000Z"});
  const terminalState={...baseState,revision:"control-completion-6",
    programs:[resumed,patch,nextAfterReviewGate],
    intents:[...baseState.intents,reconciliation.intent,
      reviewGate.intent,secondReconciliation.intent,secondReviewGate.intent,resume.intent],
    receipts:[...baseState.receipts,reconciliation.receipt,reviewGate.receipt,
      secondReconciliation.receipt,secondReviewGate.receipt,resume.receipt]};
  const terminal=await invoke({state:terminalState,receiptId:"RECEIPT-20260903-0790",
    at:"2026-09-03T11:20:00.000Z",
    observation:() => { throw new Error("terminal replay must not snapshot"); }});
  assert.equal(terminal.result.result.data.status,"already-released");
  assert.equal(terminal.snapshots,0);
  assert.equal(terminal.reservations,0);
  assert.equal(terminal.request,null);

  const evolvedNext={...nextAfterReviewGate,updated_at:"2026-09-03T11:15:00.000Z"};
  const evolvedTerminal={...terminalState,revision:"control-completion-7",
    programs:[resumed,patch,evolvedNext]};
  const evolvedReplay=await invoke({state:evolvedTerminal,
    receiptId:"RECEIPT-20260903-0786",at:"2026-09-03T11:20:00.000Z",
    observation:() => { throw new Error("terminal replay must ignore unrelated evolution"); }});
  assert.equal(evolvedReplay.result.result.data.status,"already-released");
  assert.equal(evolvedReplay.snapshots,0);
  assert.equal(evolvedReplay.reservations,0);
  assert.equal(evolvedReplay.request,null);

  const simultaneousTerminal=structuredClone(terminalState);
  const simultaneousResume=simultaneousTerminal.intents.find(intent =>
    intent.intent_id===resume.intent.intent_id);
  const simultaneousAggregate=simultaneousResume.operations.find(operation =>
    operation.payload.kind==="release-patch-completion-precondition");
  simultaneousAggregate.payload.query.phase_evidence.review_gate.receipt.created_at=
    simultaneousAggregate.payload.query.phase_evidence.reconciliation.receipt.created_at;
  simultaneousResume.source=patchCompletionSource(simultaneousAggregate.payload.query,
    simultaneousAggregate.payload.descriptor.observation);
  simultaneousTerminal.receipts.find(receipt =>
    receipt.intent_id===resume.intent.intent_id).intent_sha256=sha256Canonical(simultaneousResume);
  let simultaneousSnapshots=0;
  let simultaneousReservations=0;
  const simultaneousRejected=await dispatchCoreCommand(parseCoreCommand(["release","approve",
    `${REPOSITORY}@2.1.3`]),{services:{
    control:{async loadReleasePlanningState() { return simultaneousTerminal; }},
    github:{async snapshot() { simultaneousSnapshots+=1; return {}; }},
    operations:{reserveReceiptId() { simultaneousReservations+=1;
      return "RECEIPT-20260903-0788"; },async execute() {
      throw new Error("must not execute"); }},clock:() => "2026-09-03T11:20:00.000Z",
  }});
  assert.equal(simultaneousRejected.exitCode,6,JSON.stringify(simultaneousRejected));
  assert.equal(simultaneousSnapshots,0);
  assert.equal(simultaneousReservations,0);

  const duplicateTerminal={...terminalState,
    intents:[...terminalState.intents,duplicateGate.intent],
    receipts:[...terminalState.receipts,duplicateGate.receipt]};
  let duplicateTerminalSnapshots=0;
  let duplicateTerminalReservations=0;
  const duplicateTerminalRejected=await dispatchCoreCommand(parseCoreCommand([
    "release","approve",`${REPOSITORY}@2.1.3`,
  ]),{services:{control:{async loadReleasePlanningState() { return duplicateTerminal; }},
    github:{async snapshot() { duplicateTerminalSnapshots+=1; return {}; }},
    operations:{reserveReceiptId() { duplicateTerminalReservations+=1;
      return "RECEIPT-20260903-0787"; },async execute() {
      throw new Error("must not execute"); }},clock:() => "2026-09-03T11:20:00.000Z"}});
  assert.equal(duplicateTerminalRejected.exitCode,6,JSON.stringify(duplicateTerminalRejected));
  assert.equal(duplicateTerminalSnapshots,0);
  assert.equal(duplicateTerminalReservations,0);

  const forgedTerminal=structuredClone(terminalState);
  const forgedResume=forgedTerminal.intents.at(-1);
  const forgedAggregate=forgedResume.operations.find(operation =>
    operation.payload.kind==="release-patch-completion-precondition");
  forgedAggregate.payload.query.patch_program.updated_at="2026-09-03T11:09:59.000Z";
  forgedAggregate.payload.query.programs.find(program =>
    program.program_id===patch.program_id).updated_at="2026-09-03T11:09:59.000Z";
  forgedTerminal.receipts.at(-1).intent_sha256=sha256Canonical(forgedResume);
  let forgedSnapshots=0;
  let forgedReservations=0;
  const rejected=await dispatchCoreCommand(parseCoreCommand(["release","approve",
    `${REPOSITORY}@2.1.3`]),{services:{
    control:{async loadReleasePlanningState() { return forgedTerminal; }},
    github:{async snapshot() { forgedSnapshots+=1; return {}; }},
    operations:{reserveReceiptId() { forgedReservations+=1;
      return "RECEIPT-20260903-0789"; },async execute() { throw new Error("must not execute"); }},
    clock:() => "2026-09-03T11:20:00.000Z",
  }});
  assert.equal(rejected.exitCode,6);
  assert.equal(forgedSnapshots,0);
  assert.equal(forgedReservations,0);
});

test("post-reconciliation CURRENT exemption requires strict time and a new review identity",() => {
  const {paused,patch,publication}=completionFixture();
  const feature=paused.repository_releases[0];
  const original=ruledCompletionSnapshot({patch,paused,publication,reconciled:true});
  const reconciliation=completionPhaseEvidence({kind:"reconciliation",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:LATER_MAIN_SHA,
    createdAt:RECONCILED_AT,intentId:"INTENT-20260903-0404",
    receiptId:"RECEIPT-20260903-0404"});
  const reviewGate=completionPhaseEvidence({kind:"review_gate",paused,patch,publication,
    featureHead:FEATURE_RELEASE_HEAD,currentMain:LATER_MAIN_SHA,
    items:original.observation.assigned_work.items,createdAt:REVIEW_GATE_AT,
    phaseEvidence:{reconciliation,review_gate:null},
    intentId:"INTENT-20260903-0405",receiptId:"RECEIPT-20260903-0405"});
  for (const [label,reviewId,recordedAt,evidence] of [
    ["equal reconciliation receipt time","REVIEW-20260903-0410",RECONCILED_AT,
      {reconciliation,review_gate:null}],
    ["equal review-gate receipt time","REVIEW-20260903-0410",REVIEW_GATE_AT,
      {reconciliation,review_gate:reviewGate}],
    ["reused staled review ID","REVIEW-20260903-0310",REREVIEWED_AT,
      {reconciliation,review_gate:reviewGate}],
  ]) {
    const items=[assignedWorkItem(feature,{number:10,head:EPIC_HEAD,kind:"epic",
      reviewId,recordedAt})];
    const snapshot=ruledCompletionSnapshot({patch,paused,publication,reconciled:true,items,
      phaseEvidence:evidence,checksState:"PENDING"});
    assert.throws(() => completePatchInterruption({patchProgram:patch,pausedProgram:paused,
      publication,snapshot}),CoreConflictError,label);
  }
});
