import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";

import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {dispatchCoreCommand,parseCoreCommand} from "../src/core/commands/router.js";
import {CoreConflictError,CoreValidationError} from "../src/core/errors.js";
import {createOperationIntent} from "../src/core/operations/plan.js";
import {createOperationRunner} from "../src/core/operations/runner.js";
import {updateManagedReviewBlock} from "../src/core/review/body.js";
import {
  completePatchInterruption,patchVersionFor,planPatchInterruption,
} from "../src/core/release/patch.js";
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
    release_pr_intent:releasePrIntent("2.2.0",programId,repository),scope:[feature],publication_evidence:null,
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
  return {schema_version:"publication-evidence.v1",evidence_id:"PUB-20260903-0001",
    release_id:"REL-published-2.1.2",repository:REPOSITORY,version:"2.1.2",
    expected_revision:MAIN_SHA,tag:{name:"v2.1.2",target_revision:MAIN_SHA},
    package:{name:"@toss-software/cli",version:"2.1.2",integrity:"sha512-dGVzdA=="},
    github_release:{release_id:"R_2_1_2",tag_name:"v2.1.2",target_revision:MAIN_SHA,
      draft:false,prerelease:false,assets:[{name:"toss-cli-2.1.2.tgz",sha256:"c".repeat(64)}]},
    evidence_sha256:"d".repeat(64),source_receipt:"RECEIPT-20260903-0002",verified_at:NOW};
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
      expected_head_revision:MAIN_SHA,recorded_at:NOW},scope:[scope],publication_evidence:null,
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
  let release=active.repository_releases[0];
  for (const [event,receipt] of [["SCOPE_DONE","0200"],["APPROVE","0201"]]) {
    release=transitionRepositoryRelease(release,{event,expected_revision:release.revision,
      timestamp:NOW,source_receipt:`RECEIPT-20260903-${receipt}`,activation:null});
  }
  const publication={...publicationEvidence(),release_id:release.release_id,version:"2.1.3",
    expected_revision:PATCH_SHA,tag:{name:"v2.1.3",target_revision:PATCH_SHA},
    package:{...publicationEvidence().package,version:"2.1.3"},
    github_release:{...publicationEvidence().github_release,tag_name:"v2.1.3",
      target_revision:PATCH_SHA}};
  release={...release,publication_evidence:publication};
  release=transitionRepositoryRelease(release,{event:"VERIFY_PUBLICATION",
    expected_revision:release.revision,timestamp:NOW,
    source_receipt:"RECEIPT-20260903-0202",activation:null});
  return {publication,program:{...active,phase:"RELEASED",revision:"REV-0004",
    repository_releases:[release],updated_at:NOW}};
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
  const release=patch.repository_releases[0];
  const feature=paused.repository_releases[0];
  const programs=[paused,patch].sort((left,right) => left.program_id<right.program_id ? -1 : 1);
  const query={kind:"patch-completion",control_revision:"control-completion",
    control_repository:CONTROL_REPOSITORY,organization:organization(),
    repositories:[repositoryConfiguration()],programs,ledger_sha256:"6".repeat(64),
    patch_program:patch,paused_program:paused,publication,
    repository_configuration:repositoryConfiguration(),project:organization().project};
  const reviewResult=completionReviewResult(reviewFreshness);
  const reviewWork=completionReviewWork(featureHead,reviewResult);
  const observation={kind:"patch-completion",control_revision:"control-completion",
    project:{id:"PVT_TOSS_OS_2",revision:"project-completion"},
    patch:{program_id:patch.program_id,program_revision:patch.revision,
      release_id:release.release_id,release_revision:release.revision},
    feature:{program_id:paused.program_id,program_revision:paused.revision,
      release_id:feature.release_id,release_revision:feature.revision},
    repository:{repository:REPOSITORY,revision:"repository-completion",
      default_branch:{name:"main",revision:"main-completion",head_sha:PATCH_SHA},
      feature_branch:{name:feature.branch,revision:"feature-completion",head_sha:featureHead},
      reconciliation:{patch_commit:PATCH_SHA,patch_commit_is_ancestor:ancestor,drifted}},
    reviews:[{work_item_id:FEATURE,pull_request_number:10,
      pull_request_revision:"pr-10-completion",head_sha:featureHead,
      body:updateManagedReviewBlock("Human context.",reviewResult),
      review_result:reviewResult,work:reviewWork}],
    checks:{head_sha:checksState==="NOT_STARTED" ? null : featureHead,
      state:checksState,required:["ci"]}};
  return {source:{repository:CONTROL_REPOSITORY,revision:"control-completion",
    sha256:sha256Canonical({control:{revision:query.control_revision,
      organization:query.organization,repositories:query.repositories,programs:query.programs,
      ledger_sha256:query.ledger_sha256},github:observation})},query,observation,
  receipt_id:"RECEIPT-20260903-0300",timestamp:NOW};
}

function completionFixture() {
  const paused=pausedFeatureProgram();
  const {program:patch,publication}=releasedPatchProgram(activePatchProgram(paused));
  return {paused,patch,publication};
}

function rehashCompletionSnapshot(snapshot) {
  snapshot.source.sha256=sha256Canonical({control:{revision:snapshot.query.control_revision,
    organization:snapshot.query.organization,repositories:snapshot.query.repositories,
    programs:snapshot.query.programs,ledger_sha256:snapshot.query.ledger_sha256},
  github:snapshot.observation});
  return snapshot;
}

function makeCompletionChildReview(snapshot,{parentId=FEATURE}={}) {
  const review=snapshot.observation.reviews[0];
  const childId=`${REPOSITORY}#11`;
  const parentBranch=`epic/${parentId.slice(parentId.lastIndexOf("#")+1)}-feature`;
  review.work_item_id=childId;
  review.pull_request_number=11;
  review.review_result={...review.review_result,pull_request_number:11,
    review_id:"REVIEW-20260903-0311"};
  review.body=updateManagedReviewBlock("Human context.",review.review_result);
  review.work={...review.work,
    item:{...review.work.item,id:childId,issue_number:11,kind:"issue",parent_id:parentId,
      acceptance_criteria:["The governed child remains reviewable after patch reconciliation."],
      branch:"issue/11-governed-child",base_branch:parentBranch,milestone:"v2.2.0"},
    prepared:null,scope_approved:null,children_complete:null,
    parent:{id:parentId,branch:parentBranch,revision:"issue-10-1"},
    authority:{epic_acceptance_required:false,release_approval_required:false},
    project:{...review.work.project,item_id:"PVTI_issue_11",revision:"project-issue-11",
      fields:{...review.work.project.fields,parent:parentId,branch:"issue/11-governed-child",
        base_branch:parentBranch}}};
  return review;
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
      const review=snapshot.observation.reviews[0];
      review.work_item_id="Other/repo#10";
      review.review_result.repository="Other/repo";
      review.body=updateManagedReviewBlock("Human context.",review.review_result);
      review.work.item.id="Other/repo#10";
      review.work.item.repository="Other/repo";
      review.work.release.repository="Other/repo";
      review.work.release.id=`Other/repo@${review.work.release.branch}`;
      review.work.project.fields.repository="Other/repo";
    }],
    ["Project",snapshot => { snapshot.observation.reviews[0].work.project.project_id="PVT_FOREIGN"; }],
    ["duplicate",snapshot => { snapshot.observation.reviews.push(
      structuredClone(snapshot.observation.reviews[0])); }],
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
  const outsideEpicReview=outsideEpic.observation.reviews[0];
  outsideEpicReview.work_item_id=`${REPOSITORY}#11`;
  outsideEpicReview.work.item={...outsideEpicReview.work.item,id:`${REPOSITORY}#11`,issue_number:11,
    branch:"epic/11-unrelated"};
  outsideEpicReview.work.project={...outsideEpicReview.work.project,item_id:"PVTI_epic_11",
    fields:{...outsideEpicReview.work.project.fields,branch:"epic/11-unrelated"}};
  assert.throws(() => completePatchInterruption(request(outsideEpic)),CoreConflictError,
    "direct epic outside paused release scope");

  const wrongAssignment=completionSnapshot({patch,paused,publication,ancestor:true,
    featureHead:MERGED_SHA});
  wrongAssignment.observation.reviews[0].work.release.revision="REV-9999";
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
  const bugWork=bug.observation.reviews[0].work;
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
  snapshot.observation.reviews[0].work.release.active=false;
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
  completion.observation.reviews[0].work.project.fields.repository=OTHER_REPOSITORY;
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
  assert.equal(pull.payload.body.includes("Human context."),true);
  assert.equal(pull.payload.body.includes("- Freshness: STALE"),true);
  assert.ok(project,"the exact Project item must be projected in the same plan");
  assert.equal(project.expected_revision,"project-feature-10");

  let controlRevision=snapshot.source.revision;
  let storedIntent=null;
  let storedReceipt=null;
  let storedProgram=paused;
  let storedBody=snapshot.observation.reviews[0].body;
  let storedResult=snapshot.observation.reviews[0].review_result;
  let storedFields=snapshot.observation.reviews[0].work.project.fields;
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
