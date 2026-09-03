import assert from "node:assert/strict";
import {generateKeyPairSync,sign} from "node:crypto";
import test from "node:test";

import {dispatchCoreCommand,parseCoreCommand} from "../src/core/commands/router.js";
import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {authorityReference} from "../src/core/authority.js";
import {CoreBlockedError,CoreConflictError,CoreValidationError} from "../src/core/errors.js";
import {createOperationIntent} from "../src/core/operations/plan.js";
import {createOperationRunner} from "../src/core/operations/runner.js";
import {normalizeReleasePlanningState,releasePlanOperations} from "../src/core/release/operations.js";
import {
  approvalOperations,completeProgram,publicationComplete,publicationOperations,
  publicationSource,releasePublicationQuery,verifyPublication,
} from "../src/core/release/verification.js";
import {releaseApprovalEnvelopeSha256} from "../src/core/release/approval-envelope.js";
import {assertRepositoryConcurrency} from "../src/core/release/state.js";

const CONTROL_REPOSITORY="TOSS-Soft/toss-os-control";
const REPOSITORY="TOSS-Soft/toss-cli";
const VERSION="2.2.0";
const NOW="2026-09-03T12:00:00.000Z";
const PACKAGE_SRI=`sha512-${"A".repeat(86)}==`;

function organization(repositories=[REPOSITORY]) {
  return {schema_version:"organization-config.v1",organization:"TOSS-Soft",
    project:{node_id:"PVT_TOSS_OS_2",number:2},control_repository:CONTROL_REPOSITORY,
    policy_revision:"POLICY-0001",repositories};
}

function repositoryConfiguration(repository=REPOSITORY,packageName="@toss-software/cli") {
  return {schema_version:"repository-config.v1",repository,
    repository_node_id:`R_${repository.split("/")[1]}`,default_branch:"main",
    active_release:null,project_item_id:`PVTI_${repository.split("/")[1]}`,
    project_fields:{status:"Status",gate:"Gate"},publication:publicationPolicy(packageName),
    registered_at:"2026-09-01T08:00:00.000Z"};
}

function readyRelease() {
  return {schema_version:"repository-release.v1",release_id:"REL-TOSS-OS-R0001-toss-cli",
    program_id:"TOSS-OS-R0001",repository:REPOSITORY,phase:"READY_FOR_APPROVAL",
    revision:"REV-0004",version:VERSION,milestone:`v${VERSION}`,
    branch:`release/v${VERSION}`,release_pr_intent:{intent_id:"RELEASE-PR-INTENT-0001",
      head:`release/v${VERSION}`,base:"main",expected_head_revision:"9".repeat(40),
      recorded_at:NOW},scope:[`${REPOSITORY}#10`],approval:null,
    publication_evidence:null,transitions:[
      {event:"ACTIVATE",source_phase:"DRAFT",target_phase:"ACTIVE",timestamp:NOW,
        source_receipt:"RECEIPT-20260903-0002"},
      {event:"SCOPE_DONE",source_phase:"ACTIVE",target_phase:"READY_FOR_APPROVAL",
        timestamp:NOW,source_receipt:"RECEIPT-20260903-0003"},
    ]};
}

function readyProgram() {
  const track=readyRelease();
  return {schema_version:"release-program.v1",program_id:"TOSS-OS-R0001",phase:"ACTIVE",
    revision:"REV-0004",repository_releases:[track],
    dependency_stages:[{stage:1,repository_release_ids:[track.release_id]}],
    selected_scope:[{epic_id:`${REPOSITORY}#10`,outcome:"current",eligibility:{approved:true,
      unversioned:true,decomposed:true,registered_repository:true,unassigned:true}}],
    deferred_scope:[],rationale:[{repository:REPOSITORY,version:VERSION,
      change_class:"minor",reasons:[{rule:"backward_compatible_feature",
        scope_ids:[`${REPOSITORY}#10`]}]}],interrupts:null,created_at:NOW,updated_at:NOW};
}

function planningState(program=readyProgram()) {
  return {revision:"control-17",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[program],intents:[],receipts:[]};
}

function implementationIdentity(headSha="a".repeat(40),baseSha="0".repeat(40),
  actor="implementation-author") {
  const commits=[{revision:headSha,author:actor,committer:"merge-committer"}];
  return {base_revision:baseSha,revision:headSha,pull_request_author:actor,
    commit_count:commits.length,commits_sha256:sha256Canonical(commits),commits};
}

function approvalReview(headSha="a".repeat(40),baseSha="0".repeat(40),
  reviewer="reviewer",repository=REPOSITORY) {
  const result={schema_version:"review-result.v1",review_id:"REVIEW-20260903-0017",
    repository,pull_request_number:17,reviewed_revision:headSha,
    reviewer:{identity:reviewer,role:"independent-reviewer"},verdict:"APPROVED",
    freshness:"CURRENT",findings:[],unresolved:[],verification_evidence:["test:full"],
    follow_up_issues:[],reviewed_at:NOW,recorded_at:NOW};
  return {revision:"review-17",result,
    formal_review:{state:"APPROVED",review_id:result.review_id,
      reviewed_revision:headSha,revision:"formal-review-17"},
    implementation_identity:implementationIdentity(headSha,baseSha)};
}

function approvalObservation(overrides={}) {
  const headSha="a".repeat(40);
  const baseSha="0".repeat(40);
  return {kind:"release-approval",control_revision:"control-17",
    project:{id:"PVT_TOSS_OS_2",revision:"project-17"},
    repository:{repository:REPOSITORY,revision:"repository-17",rules_revision:"rules-17",
      required_checks:["build"],workflow_revision:"workflow-17"},
    pull_request:{number:17,revision:"pr-17",head:`release/v${VERSION}`,
      head_sha:headSha,base:"main",base_sha:baseSha,base_revision:"base-main-17",
      state:"OPEN",draft:false},
    scope:[{id:`${REPOSITORY}#10`,revision:"issue-10-17",project_item_id:"PVTI_10",
      project_revision:"project-item-10-17",status:"Done",gate:"RELEASE_APPROVAL_REQUIRED"}],
    review:approvalReview(headSha,baseSha),
    checks:[{name:"build",revision:"check-build-17",head_sha:headSha,
      conclusion:"SUCCESS"}],...overrides};
}

function authorityRecord() {
  return {schema_version:"authority-record.v1",document_type:"authority-record",
    record_id:"AUTH-20260903-0001",actor:"release-manager",command:"release.approve",
    targets:[REPOSITORY],expected_revisions:[{repository:REPOSITORY,revision:"repository-17"}],
    policy_revision:"POLICY-0001",issued_at:"2026-09-03T11:00:00.000Z",
    expires_at:"2026-09-03T13:00:00.000Z",
    signature:{algorithm:"ed25519",key_id:"release-key",value:`${"A".repeat(86)}==`}};
}

function publicationPolicy(packageName="@toss-software/cli") {
  return {package_name:packageName,workflow:"publish.yml",required_assets:["checksums.txt"]};
}

function approval(repository=REPOSITORY,version=VERSION,mergeRevision="a".repeat(40)) {
  const baseSha="0".repeat(40);
  return {
    schema_version:"release-approval.v1",source_receipt:"RECEIPT-20260903-0001",
    authority:{record_id:"AUTH-20260903-0001",sha256:"b".repeat(64)},
    program_id:"TOSS-OS-R0001",release_id:`REL-TOSS-OS-R0001-${repository.split("/")[1]}`,
    manifest_revision:"REV-0004",manifest_sha256:"c".repeat(64),
    pull_request:{number:17,revision:"pr-17",head:`release/v${version}`,
      head_sha:mergeRevision,base:"main",base_sha:baseSha,base_revision:"base-main-17"},
    scope:[{id:`${repository}#10`,revision:"issue-10-17",project_item_id:"PVTI_10",
      project_revision:"project-item-10-17",status:"Done",gate:"RELEASE_APPROVAL_REQUIRED"}],
    review:approvalReview(mergeRevision,baseSha,"reviewer",repository),required_checks:["build"],
    checks:[{name:"build",revision:"check-build-17",head_sha:mergeRevision,
      conclusion:"SUCCESS"}],
    rules_revision:"rules-17",policy_revision:"POLICY-0001",
    publication:publicationPolicy(),merge_result_revision:mergeRevision,approved_at:NOW,
  };
}

function release({repository=REPOSITORY,version=VERSION,phase="PUBLISHING",
  revision="REV-0005",approvalRecord=approval(repository,version),evidence=null}={}) {
  const releaseId=approvalRecord.release_id;
  const transitions=[
    {event:"ACTIVATE",source_phase:"DRAFT",target_phase:"ACTIVE",timestamp:NOW,
      source_receipt:"RECEIPT-20260903-0002"},
    {event:"SCOPE_DONE",source_phase:"ACTIVE",target_phase:"READY_FOR_APPROVAL",timestamp:NOW,
      source_receipt:"RECEIPT-20260903-0003"},
    {event:"APPROVE",source_phase:"READY_FOR_APPROVAL",target_phase:"PUBLISHING",timestamp:NOW,
      source_receipt:approvalRecord.source_receipt},
  ];
  if (phase==="RELEASED") transitions.push({event:"VERIFY_PUBLICATION",
    source_phase:"PUBLISHING",target_phase:"RELEASED",timestamp:NOW,
    source_receipt:evidence.source_receipt});
  return {
    schema_version:"repository-release.v1",release_id:releaseId,
    program_id:"TOSS-OS-R0001",repository,phase,revision,version,
    milestone:`v${version}`,branch:`release/v${version}`,
    release_pr_intent:{intent_id:"RELEASE-PR-INTENT-0001",head:`release/v${version}`,
      base:"main",expected_head_revision:approvalRecord.merge_result_revision,recorded_at:NOW},
    scope:[`${repository}#10`],approval:approvalRecord,
    publication_evidence:evidence,transitions,
  };
}

function publishingState() {
  const ready=planningState();
  const github=approvalObservation();
  const snapshot={...github,source:{repository:CONTROL_REPOSITORY,revision:ready.revision,
    sha256:sha256Canonical({control:ready,github})}};
  const decision=approvalOperations({planningState:ready,programId:"TOSS-OS-R0001",
    releaseId:ready.programs[0].repository_releases[0].release_id,snapshot,
    receiptId:"RECEIPT-20260903-0001",authority:authorityRecord(),clock:() => NOW});
  const program=decision.program;
  const track=program.repository_releases[0];
  const intent=createOperationIntent({intent_id:"INTENT-20260903-0003",created_at:NOW,
    command:"release.approve",policy_revision:"POLICY-0001",
    source:decision.source,
    authority:track.approval.authority,planned_receipt_id:track.approval.source_receipt,
    operations:decision.operations});
  const receipt={schema_version:"operation-receipt.v1",document_type:"operation-receipt",
    receipt_id:track.approval.source_receipt,intent_id:intent.intent_id,
    intent_sha256:sha256Canonical(intent),created_at:NOW,status:"completed",
    observed_revisions:intent.operations.map(operation => ({operation_id:operation.operation_id,
      repository:operation.repository,
      revision:operation.payload.kind==="release-program-manifest" ? program.revision
        : operation.payload.kind==="release-pull-request-merge"
          ? operation.payload.merge_result_revision
          : operation.payload.kind==="release-publication-workflow"
            ? operation.payload.expected_revision : operation.expected_revision}))};
  return {revision:"control-18",organization:organization(),
    repositories:[repositoryConfiguration()],programs:[program],intents:[intent],receipts:[receipt]};
}

function publicationObservation() {
  return {kind:"release-publication",control_revision:"control-18",
    repository_revision:"repository-published-18",publication:{
      tag:{name:`v${VERSION}`,target_revision:"a".repeat(40)},
      package:{name:"@toss-software/cli",version:VERSION,integrity:PACKAGE_SRI},
      github_release:{release_id:"GH-18",tag_name:`v${VERSION}`,
        target_revision:"a".repeat(40),draft:false,prerelease:false,
        assets:[{name:"checksums.txt",sha256:"d".repeat(64)}]},
    },planning:{candidates:[],completed:[`${REPOSITORY}#10`],
      repositories:[{repository:REPOSITORY,latest_published_version:VERSION}]}};
}

function releasedPlanningState() {
  const state=publishingState();
  const github=publicationObservation();
  const query=releasePublicationQuery(state,"TOSS-OS-R0001",
    state.programs[0].repository_releases[0].release_id);
  const snapshot={...github,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
    sha256:publicationSource(query,github).sha256}};
  const decision=publicationOperations({planningState:state,programId:"TOSS-OS-R0001",
    releaseId:state.programs[0].repository_releases[0].release_id,snapshot,
    receiptId:"RECEIPT-20260903-0004",clock:() => NOW});
  const intent=createOperationIntent({intent_id:"INTENT-20260903-0004",created_at:NOW,
    command:"release.approve",policy_revision:"POLICY-0001",source:decision.source,
    authority:null,planned_receipt_id:"RECEIPT-20260903-0004",operations:decision.operations});
  const receipt={schema_version:"operation-receipt.v1",document_type:"operation-receipt",
    receipt_id:"RECEIPT-20260903-0004",intent_id:intent.intent_id,
    intent_sha256:sha256Canonical(intent),created_at:NOW,status:"completed",
    observed_revisions:intent.operations.map(operation => ({operation_id:operation.operation_id,
      repository:operation.repository,revision:operation.payload.kind==="release-program-manifest-set"
        ? operation.payload.resulting_set_sha256 : operation.expected_revision}))};
  return {...state,revision:"control-19",
    programs:decision.operations[1].payload.entries.map(entry => entry.program),
    intents:[...state.intents,intent],receipts:[...state.receipts,receipt]};
}

function evidenceFor(releaseValue,{sourceReceipt="RECEIPT-20260903-0004",overrides={}}={}) {
  const value={
    schema_version:"publication-evidence.v1",
    evidence_id:`PUB-${sourceReceipt.slice("RECEIPT-".length)}`,
    release_id:releaseValue.release_id,repository:releaseValue.repository,
    version:releaseValue.version,expected_revision:releaseValue.approval.merge_result_revision,
    tag:{name:`v${releaseValue.version}`,target_revision:releaseValue.approval.merge_result_revision},
    package:{name:releaseValue.approval.publication.package_name,version:releaseValue.version,
      integrity:PACKAGE_SRI},
    github_release:{release_id:"GH-17",tag_name:`v${releaseValue.version}`,
      target_revision:releaseValue.approval.merge_result_revision,draft:false,prerelease:false,
      assets:[{name:"checksums.txt",sha256:"d".repeat(64)}]},
    source_receipt:sourceReceipt,verified_at:NOW,...overrides,
  };
  value.evidence_sha256=sha256Canonical(value);
  return value;
}

test("public release approve grammar routes to the built-in release lifecycle",async () => {
  const command=parseCoreCommand([
    "release","approve",`${REPOSITORY}@${VERSION}`,"--authority","authority.json",
  ]);
  assert.equal(command.name,"release.approve");
  assert.deepEqual(command.args,[`${REPOSITORY}@${VERSION}`]);
  assert.equal(command.options.authority,"authority.json");

  let planningLoads=0;
  const result=await dispatchCoreCommand(command,{services:{
    control:{async loadReleasePlanningState() {
      planningLoads+=1;
      throw new CoreConflictError("approval route reached");
    }},
  }});
  assert.equal(planningLoads,1);
  assert.equal(result.exitCode,6);
  assert.equal(result.result.error.code,"CORE_CONFLICT");
});

test("the real runner finalizes a manifest-set locally and never sends it to GitHub",async () => {
  let head="control-1";
  let localInspections=0;
  let localFinalizations=0;
  let remoteCalls=0;
  const program={
    schema_version:"release-program.v1",program_id:"TOSS-OS-R0002",
    phase:"WAITING_FOR_EPIC",revision:"REV-0001",repository_releases:[],
    dependency_stages:[],selected_scope:[],deferred_scope:[],rationale:[],
    interrupts:null,created_at:NOW,updated_at:NOW,
  };
  const operation={
    resource:"repository",action:"commit",repository:CONTROL_REPOSITORY,
    expected_revision:sha256Canonical([]),payload:{kind:"release-program-manifest-set",
      expected_set_sha256:sha256Canonical([]),resulting_set_sha256:sha256Canonical([program]),
      entries:[{program_id:program.program_id,expected_program_revision:null,program}]},
  };
  const intent=createOperationIntent({
    intent_id:"INTENT-20260903-0001",created_at:NOW,command:"core.manifest-set",
    policy_revision:"POLICY-0001",source:{repository:CONTROL_REPOSITORY,revision:head,
      sha256:"2".repeat(64)},authority:null,planned_receipt_id:"RECEIPT-20260903-0001",
    operations:[operation],
  });
  const runner=createOperationRunner({
    control:{
      async head() { return head; },async findIntent() { return null; },
      async findReceipt() { return null; },async commitIntent() {
        head="control-2";
        return {commit_sha:head};
      },
      async commitReceipt() { throw new Error("manifest-set must finalize atomically"); },
      async inspectReleaseProgramSetOperation(value) {
        localInspections+=1;
        return {operation_id:value.operation_id,repository:value.repository,
          revision:value.expected_revision};
      },
      async commitReleaseProgramSetReceipt() { localFinalizations+=1; },
    },
    github:{async snapshot() {},async inspect() { remoteCalls+=1; return []; },
      async apply() { remoteCalls+=1; return {status:"completed",observed_revisions:[]}; }},
    authorityRegistry:{},clock:() => NOW,
    idGenerator:kind => kind==="receipt" ? "RECEIPT-20260903-0001" : "INTENT-20260903-0001",
    policyRevision:() => "POLICY-0001",
  });
  const receipt=await runner.apply(intent);
  assert.equal(receipt.status,"completed");
  assert.equal(localInspections,1);
  assert.equal(localFinalizations,1);
  assert.equal(remoteCalls,0);

  const extra={...program,program_id:"TOSS-OS-R0003"};
  const extraOperation=structuredClone(operation);
  extraOperation.payload.entries.push({program_id:extra.program_id,
    expected_program_revision:null,program:extra});
  extraOperation.payload.resulting_set_sha256=sha256Canonical(
    extraOperation.payload.entries.map(value => value.program),
  );
  assert.throws(() => createOperationIntent({
    intent_id:"INTENT-20260903-0002",created_at:NOW,command:"release.approve",
    policy_revision:"POLICY-0001",source:intent.source,authority:null,
    planned_receipt_id:"RECEIPT-20260903-0002",operations:[extraOperation],
  }),CoreValidationError);
  const badDigest=structuredClone(operation);
  badDigest.payload.resulting_set_sha256="f".repeat(64);
  assert.throws(() => createOperationIntent({
    intent_id:"INTENT-20260903-0002",created_at:NOW,command:"release.approve",
    policy_revision:"POLICY-0001",source:intent.source,authority:null,
    planned_receipt_id:"RECEIPT-20260903-0002",operations:[badDigest],
  }),CoreValidationError);
});

test("publication verification binds tag, package, final release, assets, receipt, and immutable hash",() => {
  const publishing=release();
  const evidence=evidenceFor(publishing);
  assert.deepEqual(verifyPublication(publishing,evidence),{verified:true,failures:[]});
  assert.deepEqual(verifyPublication(publishing,evidence),{verified:true,failures:[]});

  const cases=[
    ["TAG_TARGET_MISMATCH",{tag:{...evidence.tag,target_revision:"e".repeat(40)}}],
    ["PACKAGE_MISSING",{package:null}],
    ["PACKAGE_VERSION_MISMATCH",{package:{...evidence.package,version:"2.1.9"}}],
    ["PACKAGE_INTEGRITY_INVALID",{package:{...evidence.package,
      integrity:"sha512-YWJjZA=="}}],
    ["PACKAGE_INTEGRITY_INVALID",{package:{...evidence.package,
      integrity:PACKAGE_SRI.slice(0,-1)}}],
    ["PACKAGE_INTEGRITY_INVALID",{package:{...evidence.package,
      integrity:`${PACKAGE_SRI.slice(0,-3)}R==`}}],
    ["PACKAGE_INTEGRITY_INVALID",{package:{...evidence.package,
      integrity:`sha512-${"A".repeat(85)}B==`}}],
    ["PACKAGE_INTEGRITY_INVALID",{package:{...evidence.package,
      integrity:`sha512-${"A".repeat(85)}-==`}}],
    ["GITHUB_RELEASE_NOT_FINAL",{github_release:{...evidence.github_release,draft:true}}],
    ["GITHUB_RELEASE_NOT_FINAL",{github_release:{...evidence.github_release,prerelease:true}}],
    ["EVIDENCE_HASH_MISMATCH",{evidence_sha256:"f".repeat(64)}],
  ];
  for (const [code,changes] of cases) {
    const candidate={...evidence,...changes};
    if (!Object.hasOwn(changes,"evidence_sha256")) {
      const {evidence_sha256:_,...hashable}=candidate;
      void _;
      candidate.evidence_sha256=sha256Canonical(hashable);
    }
    const result=verifyPublication(publishing,candidate);
    assert.equal(result.verified,false);
    assert(result.failures.some(failure => failure.code===code),code);
  }

  for (const [code,changes] of [
    ["EVIDENCE_ID_INVALID",{evidence_id:null}],
    ["EVIDENCE_RECEIPT_MISMATCH",{evidence_id:"PUB-20260903-9999"}],
    ["VERIFIED_AT_INVALID",{verified_at:null}],
    ["VERIFIED_AT_INVALID",{verified_at:"2026-02-31T11:00:00.000Z"}],
    ["GITHUB_RELEASE_ID_INVALID",{
      github_release:{...evidence.github_release,release_id:null},
    }],
    ["GITHUB_RELEASE_ID_INVALID",{
      github_release:{...evidence.github_release,release_id:" release-17 "},
    }],
    ["TAG_MISSING",{tag:null}],
    ["GITHUB_RELEASE_MISSING",{github_release:null}],
  ]) {
    const candidate={...evidence,...changes};
    const {evidence_sha256:_,...hashable}=candidate;
    void _;
    candidate.evidence_sha256=sha256Canonical(hashable);
    const result=verifyPublication(publishing,candidate);
    assert.equal(result.verified,false,code);
    assert(result.failures.some(value => value.code===code),code);
  }

  let evidenceTraps=0;
  const accessor=structuredClone(evidence);
  Object.defineProperty(accessor.github_release,"release_id",{
    enumerable:true,get() { evidenceTraps+=1; return "GH-trap"; },
  });
  const sparse=structuredClone(evidence);
  sparse.github_release.assets=new Array(1);
  const deep=structuredClone(evidence);
  deep.unexpected={};
  let cursor=deep.unexpected;
  for (let index=0;index<66;index+=1) cursor=cursor.next={};
  for (const hostile of [
    new Proxy(evidence,{ownKeys() {
      evidenceTraps+=1; throw new Error("must not enumerate publication evidence proxy");
    }}),accessor,sparse,deep,
  ]) {
    assert.throws(() => verifyPublication(publishing,hostile),CoreValidationError);
  }
  assert.equal(evidenceTraps,0);
});

test("release operation wrappers reject hostile request records without invoking traps",() => {
  let traps=0;
  const requests=[
    {invoke:approvalOperations,base:() => ({planningState:null,programId:null,
      releaseId:null,snapshot:null,receiptId:null,authority:null,clock() {}})},
    {invoke:publicationOperations,base:() => ({planningState:null,programId:null,
      releaseId:null,snapshot:null,receiptId:null,clock() {}})},
  ];
  for (const {invoke,base} of requests) {
    const accessor=base();
    Object.defineProperty(accessor,"planningState",{
      enumerable:true,get() { traps+=1; return null; },
    });
    const symbolic={...base(),[Symbol("hidden")]:true};
    const hidden=base();
    Object.defineProperty(hidden,"hidden",{value:true});
    const cyclic=base();
    cyclic.planningState={};
    cyclic.planningState.loop=cyclic.planningState;
    const sparse=base();
    sparse.planningState=new Array(1);
    const deep=base();
    deep.planningState={};
    let cursor=deep.planningState;
    for (let index=0;index<66;index+=1) cursor=cursor.next={};
    const proxy=new Proxy(base(), {
      ownKeys() { traps+=1; throw new Error("must not enumerate hostile release request"); },
    });
    for (const hostile of [proxy,accessor,symbolic,hidden,cyclic,sparse,deep]) {
      assert.throws(() => invoke(hostile),CoreValidationError);
    }
  }
  assert.equal(traps,0);
});

test("publication failure aggregation is closed deterministic and rejects ambiguous or hostile input",() => {
  const failures=[{code:"Z_FAILURE",message:"z"},{code:"A_FAILURE",message:"a"}];
  const result=publicationComplete(failures);
  assert.deepEqual(result.failures.map(value => value.code),["A_FAILURE","Z_FAILURE"]);
  assert(Object.isFrozen(result) && Object.isFrozen(result.failures));
  assert.throws(() => publicationComplete([...failures,failures[0]]),CoreValidationError);
  let traps=0;
  const accessor={code:"A_FAILURE"};
  Object.defineProperty(accessor,"message",{enumerable:true,get() { traps+=1; return "a"; }});
  assert.throws(() => publicationComplete([accessor]),CoreValidationError);
  assert.throws(() => publicationComplete(new Proxy([],{ownKeys() { traps+=1; return []; }})),
    CoreValidationError);
  assert.equal(traps,0);
});

test("release approve previews exact-head merge and configured workflow with one authority binding",async () => {
  const state=planningState();
  const observation=approvalObservation();
  let request;
  const operations={reserveReceiptId() { return "RECEIPT-20260903-0001"; },
    async execute(value) { request=value; return {status:"preview"}; }};
  const services={control:{async loadReleasePlanningState() { return state; }},
    github:{async snapshot(query) {
      assert.equal(query.kind,"release-approval");
      return observation;
    }},operations,readAuthority:async () => authorityRecord(),clock:() => NOW};
  const command=parseCoreCommand(["release","approve",`${REPOSITORY}@${VERSION}`,
    "--authority","authority.json"]);
  const result=await dispatchCoreCommand(command,{services});
  assert.equal(result.exitCode,0);
  assert.equal(result.result.data.status,"preview");
  assert.deepEqual(request.operations.map(value => value.payload.kind),[
    "release-approval-precondition","release-approval-base-precondition",
    "release-pull-request-merge",
    "release-publication-workflow","release-program-manifest",
  ]);
  assert(request.operations.every(value =>
    value.payload.authority_binding===request.operations[0].payload.authority_binding));
  const manifest=request.operations.at(-1).payload.program;
  assert.equal(manifest.phase,"PUBLISHING");
  assert.equal(manifest.repository_releases[0].phase,"PUBLISHING");
  assert.equal(manifest.repository_releases[0].approval.pull_request.head_sha,"a".repeat(40));
  assert.equal(manifest.repository_releases[0].approval.publication.workflow,"publish.yml");
  assert.doesNotThrow(() => createOperationIntent({intent_id:"INTENT-20260903-0002",
    created_at:NOW,command:"release.approve",policy_revision:"POLICY-0001",
    source:request.source,authority:authorityReference(authorityRecord()),
    planned_receipt_id:"RECEIPT-20260903-0001",
    operations:request.operations}));
});

test("release approval pins the exact base head and emits a pre-mutation base CAS",() => {
  const state=planningState();
  const github=approvalObservation();
  github.pull_request={...github.pull_request,base_sha:"0".repeat(40),
    base_revision:"base-main-17"};
  const decision=approvalOperations({planningState:state,programId:"TOSS-OS-R0001",
    releaseId:state.programs[0].repository_releases[0].release_id,
    snapshot:{...github,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
      sha256:sha256Canonical({control:state,github})}},
    receiptId:"RECEIPT-20260903-0001",authority:authorityRecord(),clock:() => NOW});
  assert.deepEqual(decision.operations.map(value => value.payload.kind),[
    "release-approval-precondition","release-approval-base-precondition",
    "release-pull-request-merge","release-publication-workflow","release-program-manifest",
  ]);
  const base=decision.operations[1];
  assert.deepEqual({resource:base.resource,action:base.action,repository:base.repository,
    expected_revision:base.expected_revision},
  {resource:"branch",action:"verify",repository:REPOSITORY,
    expected_revision:"base-main-17"});
  assert.equal(base.payload.head_sha,"0".repeat(40));
  assert.equal(decision.approval.pull_request.base_sha,"0".repeat(40));
  assert.equal(decision.approval.pull_request.base_revision,"base-main-17");
});

test("release approval rejects an implementer review even when the authority actor differs",() => {
  const state=planningState();
  const prior=approvalObservation();
  const github=approvalObservation({review:{...prior.review,result:{...prior.review.result,
    reviewer:{identity:"implementation-author",role:"independent-reviewer"}}}});
  assert.throws(() => approvalOperations({planningState:state,programId:"TOSS-OS-R0001",
    releaseId:state.programs[0].repository_releases[0].release_id,
    snapshot:{...github,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
      sha256:sha256Canonical({control:state,github})}},
    receiptId:"RECEIPT-20260903-0001",authority:authorityRecord(),clock:() => NOW}),
  CoreBlockedError);
});

test("release approval requires a formal approved review and complete implementation identity",() => {
  const state=planningState();
  const github=approvalObservation();
  delete github.review.formal_review;
  delete github.review.implementation_identity;
  assert.throws(() => approvalOperations({planningState:state,programId:"TOSS-OS-R0001",
    releaseId:state.programs[0].repository_releases[0].release_id,
    snapshot:{...github,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
      sha256:sha256Canonical({control:state,github})}},
    receiptId:"RECEIPT-20260903-0001",authority:authorityRecord(),clock:() => NOW}),
  CoreValidationError);
});

test("release approval operation envelopes are exact and digest-bound",() => {
  const state=planningState();
  const github=approvalObservation();
  const decision=approvalOperations({planningState:state,programId:"TOSS-OS-R0001",
    releaseId:state.programs[0].repository_releases[0].release_id,
    snapshot:{...github,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
      sha256:sha256Canonical({control:state,github})}},
    receiptId:"RECEIPT-20260903-0001",authority:authorityRecord(),clock:() => NOW});
  const request={intent_id:"INTENT-20260903-0090",created_at:NOW,
    command:"release.approve",policy_revision:"POLICY-0001",source:decision.source,
    authority:authorityReference(authorityRecord()),
    planned_receipt_id:"RECEIPT-20260903-0001"};
  const extra=structuredClone(decision.operations);
  extra.find(value => value.payload.kind==="release-pull-request-merge")
    .payload.adapter_override="squash";
  assert.throws(() => createOperationIntent({...request,operations:extra}),CoreValidationError);
  const substituted=structuredClone(decision.operations);
  const merge=substituted.find(value => value.payload.kind==="release-pull-request-merge");
  merge.action="update";
  assert.throws(() => createOperationIntent({...request,operations:substituted}),CoreValidationError);

  for (const [label,mutate] of [
    ["merge program",operations => { operations.find(value =>
      value.payload.kind==="release-pull-request-merge").payload.program_id="TOSS-OS-R9999"; }],
    ["workflow release",operations => { operations.find(value =>
      value.payload.kind==="release-publication-workflow").payload.release_id="REL-substituted"; }],
    ["workflow version",operations => { const workflow=operations.find(value =>
      value.payload.kind==="release-publication-workflow"); workflow.payload.version="9.9.9";
    workflow.payload.tag="v9.9.9"; }],
  ]) {
    const operations=structuredClone(decision.operations);
    mutate(operations);
    const digest=releaseApprovalEnvelopeSha256({command:request.command,
      policy_revision:request.policy_revision,source:request.source,operations});
    for (const operation of operations) {
      operation.payload.authority_binding.operation_intent_sha256=digest;
    }
    assert.throws(() => createOperationIntent({...request,operations}),CoreValidationError,label);
  }

  for (const field of ["record_id","sha256"]) {
    const wrong=structuredClone(decision.operations);
    const authority=wrong.find(value => value.payload.kind==="release-program-manifest")
      .payload.program.repository_releases[0].approval.authority;
    authority[field]=field==="record_id" ? "AUTH-20260903-9999" : "f".repeat(64);
    assert.throws(() => createOperationIntent({...request,operations:wrong}),
      CoreValidationError,field);
  }
  assert.throws(() => createOperationIntent({...request,
    authority:{record_id:"AUTH-20260903-9999",sha256:"f".repeat(64)},
    operations:decision.operations}),CoreValidationError);
  let traps=0;
  const hostile=new Proxy(decision.operations,{ownKeys() { traps+=1; return []; }});
  assert.throws(() => releaseApprovalEnvelopeSha256({command:"release.approve",
    policy_revision:"POLICY-0001",source:decision.source,operations:hostile}),
  CoreValidationError);
  const nullPayload=structuredClone(decision.operations);
  nullPayload[0].payload=null;
  assert.throws(() => releaseApprovalEnvelopeSha256({command:"release.approve",
    policy_revision:"POLICY-0001",source:decision.source,operations:nullPayload}),
  CoreValidationError);
  const deep=structuredClone(decision.operations);
  let cursor=deep[0].payload;
  for (let index=0;index<20_000;index+=1) cursor=cursor.child={};
  assert.throws(() => releaseApprovalEnvelopeSha256({command:"release.approve",
    policy_revision:"POLICY-0001",source:decision.source,operations:deep}),
  CoreValidationError);
  const cyclic=structuredClone(decision.operations);
  cyclic[0].payload.loop=cyclic[0].payload;
  assert.throws(() => releaseApprovalEnvelopeSha256({command:"release.approve",
    policy_revision:"POLICY-0001",source:decision.source,operations:cyclic}),
  CoreValidationError);
  const sparse=[];
  sparse.length=2;
  sparse[1]=decision.operations[0];
  assert.throws(() => releaseApprovalEnvelopeSha256({command:"release.approve",
    policy_revision:"POLICY-0001",source:decision.source,operations:sparse}),
  CoreValidationError);
  const accessor=structuredClone(decision.operations);
  Object.defineProperty(accessor[0].payload,"hidden",{get() { traps+=1; return true; },
    enumerable:true});
  assert.throws(() => releaseApprovalEnvelopeSha256({command:"release.approve",
    policy_revision:"POLICY-0001",source:decision.source,operations:accessor}),
  CoreValidationError);
  const symbol=structuredClone(decision.operations);
  symbol[0].payload[Symbol("hidden")]=true;
  assert.throws(() => releaseApprovalEnvelopeSha256({command:"release.approve",
    policy_revision:"POLICY-0001",source:decision.source,operations:symbol}),
  CoreValidationError);
  const malformedManifest=structuredClone(decision.operations);
  malformedManifest.find(operation => operation.payload.kind==="release-program-manifest")
    .payload.program.repository_releases={};
  assert.throws(() => releaseApprovalEnvelopeSha256({command:"release.approve",
    policy_revision:"POLICY-0001",source:decision.source,operations:malformedManifest}),
  CoreValidationError);
  assert.equal(traps,0);
});

test("non-waivable approval semantics apply to persisted state and direct intents",() => {
  const state=publishingState();
  const program=structuredClone(state.programs[0]);
  program.repository_releases[0].approval.review.result.reviewer.identity=
    "implementation-author";
  assert.throws(() => assertRepositoryConcurrency([program]),CoreBlockedError);

  const forged=structuredClone(state.intents[0]);
  const selfReview={...forged.operations[0].payload.authority_binding.review,
    result:{...forged.operations[0].payload.authority_binding.review.result,
      reviewer:{identity:"implementation-author",role:"independent-reviewer"}}};
  for (const operation of forged.operations) operation.payload.authority_binding.review=selfReview;
  const recorded=forged.operations.find(operation =>
    operation.payload.kind==="release-program-manifest").payload.program.repository_releases[0];
  recorded.approval.review=selfReview;
  const digest=releaseApprovalEnvelopeSha256({command:forged.command,
    policy_revision:forged.policy_revision,source:forged.source,operations:forged.operations});
  for (const operation of forged.operations) {
    operation.payload.authority_binding.operation_intent_sha256=digest;
  }
  assert.throws(() => createOperationIntent({intent_id:forged.intent_id,
    created_at:forged.created_at,command:forged.command,
    policy_revision:forged.policy_revision,source:forged.source,authority:forged.authority,
    planned_receipt_id:forged.planned_receipt_id,
    operations:forged.operations.map(({operation_id:_,...operation}) => operation)}),
  CoreBlockedError);
});

test("release approval authority signs every granular PR review check rules policy and workflow revision",async () => {
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  let preview;
  const servicesFor=authority => ({control:{async loadReleasePlanningState() {
    return planningState();
  }},github:{async snapshot() { return approvalObservation(); }},
  operations:{reserveReceiptId() { return "RECEIPT-20260903-0001"; },
    async execute(value) { preview=value; return {status:"preview"}; }},
  readAuthority:async () => authority,clock:() => NOW});
  await dispatchCoreCommand(parseCoreCommand(["release","approve",`${REPOSITORY}@${VERSION}`,
    "--authority","authority.json"]),{services:servicesFor({...authorityRecord(),
    record_id:"AUTH-20260903-0002"})});
  const binding=preview.operations[0].payload.authority_binding;
  assert.equal(canonicalJson(binding.scope),canonicalJson(approvalObservation().scope));
  const revisions=[
    {target:"PVT_TOSS_OS_2",repository:null,revision:"project-17"},
    {target:`${REPOSITORY}#pull-request:17`,repository:REPOSITORY,revision:"pr-17"},
    {target:`${REPOSITORY}#workflow:publish.yml`,repository:REPOSITORY,revision:"workflow-17"},
    {target:"program:TOSS-OS-R0001",repository:CONTROL_REPOSITORY,revision:"REV-0004"},
    {target:REPOSITORY,repository:REPOSITORY,revision:"repository-17"},
    {target:`${REPOSITORY}#branch:release/v${VERSION}`,repository:REPOSITORY,
      revision:"a".repeat(40)},
    {target:`${REPOSITORY}#base:main`,repository:REPOSITORY,revision:"base-main-17"},
    {target:`${REPOSITORY}#base-head:main`,repository:REPOSITORY,revision:"0".repeat(40)},
    {target:`${REPOSITORY}#review:REVIEW-20260903-0017`,repository:REPOSITORY,
      revision:"review-17"},
    {target:`${REPOSITORY}#formal-review:REVIEW-20260903-0017`,repository:REPOSITORY,
      revision:"formal-review-17"},
    {target:`${REPOSITORY}#check:build`,repository:REPOSITORY,revision:"check-build-17"},
    {target:`${REPOSITORY}#rules`,repository:REPOSITORY,revision:"rules-17"},
    {target:"policy:POLICY-0001",repository:null,revision:"POLICY-0001"},
  ].sort((left,right) => canonicalJson(left)<canonicalJson(right) ? -1 : 1);
  const targets=[...revisions.map(value => value.target),`binding:${sha256Canonical(binding)}`].sort();
  const unsigned={schema_version:"authority-record.v1",document_type:"authority-record",
    record_id:"AUTH-20260903-0002",actor:"release-manager",command:"release.approve",
    targets,expected_revisions:revisions,policy_revision:"POLICY-0001",
    issued_at:"2026-09-03T11:00:00.000Z",expires_at:"2026-09-03T13:00:00.000Z"};
  const signed={...unsigned,signature:{algorithm:"ed25519",key_id:"release-key",
    value:sign(null,Buffer.from(canonicalJson(unsigned)),privateKey).toString("base64")}};
  await dispatchCoreCommand(parseCoreCommand(["release","approve",`${REPOSITORY}@${VERSION}`,
    "--authority","authority.json"]),{services:servicesFor(signed)});
  const intent=createOperationIntent({intent_id:"INTENT-20260903-0002",created_at:NOW,
    command:"release.approve",policy_revision:"POLICY-0001",source:preview.source,
    authority:authorityReference(signed),planned_receipt_id:preview.receipt_id,
    operations:preview.operations});
  const noop=async () => null;
  const runner=createOperationRunner({control:{head:noop,findIntent:noop,findReceipt:noop,
    commitIntent:noop,commitReceipt:noop,inspectReleaseProgramOperation:noop,
    commitReleaseProgramReceipt:noop},github:{snapshot:noop,inspect:noop,apply:noop},
  authorityRegistry:{keys:[{key_id:"release-key",actor:"release-manager",
    public_key:publicKey.export({format:"pem",type:"spki"}).toString()}]},clock:() => NOW,
  idGenerator:() => "RECEIPT-20260903-0001",policyRevision:() => "POLICY-0001"});
  assert.equal(runner.verifyAuthorityFor(intent,signed).record_id,signed.record_id);

  const wrongRevisions=revisions.map(value => value.target===`${REPOSITORY}#check:build`
    ? {...value,revision:"check-build-18"} : value)
    .sort((left,right) => canonicalJson(left)<canonicalJson(right) ? -1 : 1);
  const wrongUnsigned={...unsigned,expected_revisions:wrongRevisions};
  const wrong={...wrongUnsigned,signature:{algorithm:"ed25519",key_id:"release-key",
    value:sign(null,Buffer.from(canonicalJson(wrongUnsigned)),privateKey).toString("base64")}};
  const wrongDecision=approvalOperations({planningState:planningState(),programId:"TOSS-OS-R0001",
    releaseId:planningState().programs[0].repository_releases[0].release_id,
    snapshot:{...approvalObservation(),source:preview.source},
    receiptId:preview.receipt_id,authority:wrong,clock:() => NOW});
  const wrongIntent=createOperationIntent({intent_id:"INTENT-20260903-0003",created_at:NOW,
    command:"release.approve",policy_revision:"POLICY-0001",source:preview.source,
    authority:authorityReference(wrong),planned_receipt_id:preview.receipt_id,
    operations:wrongDecision.operations});
  assert.throws(() => runner.verifyAuthorityFor(wrongIntent,wrong),CoreBlockedError);

  let head=preview.source.revision;
  let persistedIntent=null;
  let failedReceipt=null;
  let remoteWrites=0;
  let manifestFinalizations=0;
  const driftControl={async head() { return head; },async findIntent() { return persistedIntent; },
    async findReceipt() { return null; },async commitIntent({intent:committed}) {
      persistedIntent=committed; head="control-approval-intent"; return {commit_sha:head};
    },async commitReceipt({receipt}) { failedReceipt=receipt; head="control-approval-failed";
      return {commit_sha:head}; },async inspectReleaseProgramOperation() {
      throw new Error("rules drift must stop before local manifest inspection");
    },async commitReleaseProgramReceipt() { manifestFinalizations+=1; }};
  const driftRunner=createOperationRunner({control:driftControl,github:{async snapshot() {},
    async inspect(operations) {
      const aggregate=operations.find(operation =>
        operation.payload.kind==="release-approval-precondition");
      const current=approvalObservation({repository:{...approvalObservation().repository,
        rules_revision:"rules-18"}});
      assert.notEqual(sha256Canonical(current),aggregate.payload.snapshot_sha256);
      throw new CoreConflictError("repository rules changed");
    },async apply() { remoteWrites+=1; return {status:"completed",observed_revisions:[]}; }},
  authorityRegistry:{keys:[{key_id:"release-key",actor:"release-manager",
    public_key:publicKey.export({format:"pem",type:"spki"}).toString()}]},clock:() => NOW,
  idGenerator:() => "RECEIPT-20260903-0001",policyRevision:() => "POLICY-0001"});
  await assert.rejects(driftRunner.apply(intent,{authority:signed}),CoreConflictError);
  assert.equal(failedReceipt.status,"failed");
  assert.equal(remoteWrites,0);
  assert.equal(manifestFinalizations,0);
});

test("a stateful release fake enforces approval order and a restarted runner replays once",async () => {
  const state=planningState();
  const observation=approvalObservation();
  const preview=approvalOperations({planningState:state,programId:"TOSS-OS-R0001",
    releaseId:state.programs[0].repository_releases[0].release_id,
    snapshot:{...observation,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
      sha256:sha256Canonical({control:state,github:observation})}},
    receiptId:"RECEIPT-20260903-0011",authority:{...authorityRecord(),
      record_id:"AUTH-20260903-0011"},clock:() => NOW});
  const binding=preview.operations[0].payload.authority_binding;
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  const expectedRevisions=[
    {target:"PVT_TOSS_OS_2",repository:null,revision:"project-17"},
    {target:`${REPOSITORY}#pull-request:17`,repository:REPOSITORY,revision:"pr-17"},
    {target:`${REPOSITORY}#workflow:publish.yml`,repository:REPOSITORY,revision:"workflow-17"},
    {target:"program:TOSS-OS-R0001",repository:CONTROL_REPOSITORY,revision:"REV-0004"},
    {target:REPOSITORY,repository:REPOSITORY,revision:"repository-17"},
    {target:`${REPOSITORY}#branch:release/v${VERSION}`,repository:REPOSITORY,
      revision:"a".repeat(40)},
    {target:`${REPOSITORY}#base:main`,repository:REPOSITORY,revision:"base-main-17"},
    {target:`${REPOSITORY}#base-head:main`,repository:REPOSITORY,revision:"0".repeat(40)},
    {target:`${REPOSITORY}#review:REVIEW-20260903-0017`,repository:REPOSITORY,
      revision:"review-17"},
    {target:`${REPOSITORY}#formal-review:REVIEW-20260903-0017`,repository:REPOSITORY,
      revision:"formal-review-17"},
    {target:`${REPOSITORY}#check:build`,repository:REPOSITORY,revision:"check-build-17"},
    {target:`${REPOSITORY}#rules`,repository:REPOSITORY,revision:"rules-17"},
    {target:"policy:POLICY-0001",repository:null,revision:"POLICY-0001"},
  ].sort((left,right) => canonicalJson(left)<canonicalJson(right) ? -1 : 1);
  const unsigned={schema_version:"authority-record.v1",document_type:"authority-record",
    record_id:"AUTH-20260903-0011",actor:"release-manager",command:"release.approve",
    targets:[...expectedRevisions.map(value => value.target),
      `binding:${sha256Canonical(binding)}`].sort(),expected_revisions:expectedRevisions,
    policy_revision:"POLICY-0001",issued_at:"2026-09-03T11:00:00.000Z",
    expires_at:"2026-09-03T13:00:00.000Z"};
  const authority={...unsigned,signature:{algorithm:"ed25519",key_id:"release-key",
    value:sign(null,Buffer.from(canonicalJson(unsigned)),privateKey).toString("base64")}};
  const approved=approvalOperations({planningState:state,programId:"TOSS-OS-R0001",
    releaseId:state.programs[0].repository_releases[0].release_id,
    snapshot:{...observation,source:preview.source},receiptId:"RECEIPT-20260903-0011",
    authority,clock:() => NOW});
  const intent=createOperationIntent({intent_id:"INTENT-20260903-0011",created_at:NOW,
    command:"release.approve",policy_revision:"POLICY-0001",source:approved.source,
    authority:authorityReference(authority),planned_receipt_id:"RECEIPT-20260903-0011",
    operations:approved.operations});

  let head=state.revision;
  let persistedIntent=null;
  let persistedReceipt=null;
  let finalizations=0;
  let applies=0;
  const remote={merged:false,workflow_started:false};
  const control={async head() { return head; },async findIntent() { return persistedIntent; },
    async findReceipt() { return persistedReceipt; },async commitIntent({intent:value}) {
      persistedIntent=value; head="control-approval-intent"; return {commit_sha:head};
    },async commitReceipt() { throw new Error("approval must finalize manifest and receipt together"); },
    async inspectReleaseProgramOperation(operation) {
      assert.equal(operation.expected_revision,"REV-0004");
      assert.equal(operation.payload.program.phase,"PUBLISHING");
      return {operation_id:operation.operation_id,repository:operation.repository,
        revision:"REV-0004"};
    },async commitReleaseProgramReceipt({receipt,operation}) {
      finalizations+=1;
      assert.equal(operation.payload.program.phase,"PUBLISHING");
      persistedReceipt=receipt; head="control-approval-completed";
      return {commit_sha:head};
    }};
  const github={async snapshot() { throw new Error("runner must not resnapshot"); },
    async inspect(operations) {
      assert.deepEqual(operations.map(value => value.payload.kind),[
        "release-approval-precondition","release-approval-base-precondition",
        "release-pull-request-merge",
        "release-publication-workflow",
      ]);
      assert.deepEqual(operations.map(value => value.expected_revision),[
        "project-17","base-main-17","pr-17","workflow-17",
      ]);
      return operations.map(operation => ({operation_id:operation.operation_id,
        repository:operation.repository,revision:operation.expected_revision}));
    },async apply(operations) {
      applies+=1;
      assert.equal(operations.length,1);
      const kind=operations[0].payload.kind;
      if (kind==="release-pull-request-merge") {
        assert.equal(remote.merged,false);
        remote.merged=true;
      } else {
        assert.equal(kind,"release-publication-workflow");
        assert.equal(remote.merged,true);
        assert.equal(remote.workflow_started,false);
        remote.workflow_started=true;
      }
      return {status:"completed",observed_revisions:operations.map(operation => ({
        operation_id:operation.operation_id,repository:operation.repository,
        revision:operation.payload.kind==="release-pull-request-merge"
          ? operation.payload.merge_result_revision : operation.payload.expected_revision,
      }))};
    }};
  const runtime=() => createOperationRunner({control,github,
    authorityRegistry:{keys:[{key_id:"release-key",actor:"release-manager",
      public_key:publicKey.export({format:"pem",type:"spki"}).toString()}]},clock:() => NOW,
    idGenerator:() => "RECEIPT-20260903-9999",policyRevision:() => "POLICY-0001"});
  const first=await runtime().apply(intent,{authority});
  const replay=await runtime().apply(intent,{authority});
  assert.equal(canonicalJson(replay),canonicalJson(first));
  assert.deepEqual(remote,{merged:true,workflow_started:true});
  assert.equal(applies,2);
  assert.equal(finalizations,1);
  assert.doesNotThrow(() => normalizeReleasePlanningState({...state,
    revision:head,programs:[approved.program],intents:[persistedIntent],
    receipts:[persistedReceipt]}));

  let badHead=state.revision;
  let failedReceipt=null;
  let badFinalizations=0;
  const badRunner=createOperationRunner({control:{
    async head() { return badHead; },async findIntent() { return null; },
    async findReceipt() { return null; },async commitIntent() {
      badHead="control-bad-workflow-intent"; return {commit_sha:badHead};
    },async commitReceipt({receipt}) { failedReceipt=receipt; },
    async inspectReleaseProgramOperation(operation) {
      return {operation_id:operation.operation_id,repository:operation.repository,
        revision:operation.expected_revision};
    },async commitReleaseProgramReceipt() { badFinalizations+=1; },
  },github:{async snapshot() {},async inspect(operations) {
    return operations.map(operation => ({operation_id:operation.operation_id,
      repository:operation.repository,revision:operation.expected_revision}));
  },async apply(operations) {
    return {status:"completed",observed_revisions:operations.map(operation => ({
      operation_id:operation.operation_id,repository:operation.repository,
      revision:operation.payload.kind==="release-pull-request-merge"
        ? operation.payload.merge_result_revision : "workflow-run-1",
    }))};
  }},authorityRegistry:{keys:[{key_id:"release-key",actor:"release-manager",
    public_key:publicKey.export({format:"pem",type:"spki"}).toString()}]},clock:() => NOW,
  idGenerator:() => "RECEIPT-20260903-9999",policyRevision:() => "POLICY-0001"});
  await assert.rejects(badRunner.apply(intent,{authority}),CoreConflictError);
  assert.equal(failedReceipt.status,"failed");
  assert.equal(badFinalizations,0);
});

test("approval runner rejects a non-fast-forward merge result before workflow initiation",async () => {
  const state=planningState();
  const observation=approvalObservation();
  const preview=approvalOperations({planningState:state,programId:"TOSS-OS-R0001",
    releaseId:state.programs[0].repository_releases[0].release_id,
    snapshot:{...observation,source:{repository:CONTROL_REPOSITORY,revision:state.revision,
      sha256:sha256Canonical({control:state,github:observation})}},
    receiptId:"RECEIPT-20260903-0012",authority:{...authorityRecord(),
      record_id:"AUTH-20260903-0012"},clock:() => NOW});
  const binding=preview.operations[0].payload.authority_binding;
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  const expectedRevisions=[
    {target:"PVT_TOSS_OS_2",repository:null,revision:"project-17"},
    {target:`${REPOSITORY}#pull-request:17`,repository:REPOSITORY,revision:"pr-17"},
    {target:`${REPOSITORY}#workflow:publish.yml`,repository:REPOSITORY,revision:"workflow-17"},
    {target:"program:TOSS-OS-R0001",repository:CONTROL_REPOSITORY,revision:"REV-0004"},
    {target:REPOSITORY,repository:REPOSITORY,revision:"repository-17"},
    {target:`${REPOSITORY}#branch:release/v${VERSION}`,repository:REPOSITORY,
      revision:"a".repeat(40)},
    {target:`${REPOSITORY}#base:main`,repository:REPOSITORY,revision:"base-main-17"},
    {target:`${REPOSITORY}#base-head:main`,repository:REPOSITORY,revision:"0".repeat(40)},
    {target:`${REPOSITORY}#review:REVIEW-20260903-0017`,repository:REPOSITORY,
      revision:"review-17"},
    {target:`${REPOSITORY}#formal-review:REVIEW-20260903-0017`,repository:REPOSITORY,
      revision:"formal-review-17"},
    {target:`${REPOSITORY}#check:build`,repository:REPOSITORY,revision:"check-build-17"},
    {target:`${REPOSITORY}#rules`,repository:REPOSITORY,revision:"rules-17"},
    {target:"policy:POLICY-0001",repository:null,revision:"POLICY-0001"},
  ].sort((left,right) => canonicalJson(left)<canonicalJson(right) ? -1 : 1);
  const unsigned={schema_version:"authority-record.v1",document_type:"authority-record",
    record_id:"AUTH-20260903-0012",actor:"release-manager",command:"release.approve",
    targets:[...expectedRevisions.map(value => value.target),
      `binding:${sha256Canonical(binding)}`].sort(),expected_revisions:expectedRevisions,
    policy_revision:"POLICY-0001",issued_at:"2026-09-03T11:00:00.000Z",
    expires_at:"2026-09-03T13:00:00.000Z"};
  const authority={...unsigned,signature:{algorithm:"ed25519",key_id:"release-key",
    value:sign(null,Buffer.from(canonicalJson(unsigned)),privateKey).toString("base64")}};
  const approved=approvalOperations({planningState:state,programId:"TOSS-OS-R0001",
    releaseId:state.programs[0].repository_releases[0].release_id,
    snapshot:{...observation,source:preview.source},receiptId:"RECEIPT-20260903-0012",
    authority,clock:() => NOW});
  const intent=createOperationIntent({intent_id:"INTENT-20260903-0012",created_at:NOW,
    command:"release.approve",policy_revision:"POLICY-0001",source:approved.source,
    authority:authorityReference(authority),planned_receipt_id:"RECEIPT-20260903-0012",
    operations:approved.operations});
  let head=state.revision;
  let storedIntent=null;
  let storedReceipt=null;
  let workflowCalls=0;
  let finalizations=0;
  const runner=createOperationRunner({control:{async head() { return head; },
    async findIntent() { return storedIntent; },async findReceipt() { return storedReceipt; },
    async commitIntent({intent:value}) { storedIntent=value; head="control-intent";
      return {commit_sha:head}; },async commitReceipt({receipt}) { storedReceipt=receipt;
      head="control-failed"; return {commit_sha:head}; },
    async inspectReleaseProgramOperation(operation) {
      return {operation_id:operation.operation_id,repository:operation.repository,
        revision:operation.expected_revision}; },
    async commitReleaseProgramReceipt() { finalizations+=1; }},
  github:{async snapshot() {},async inspect(operations) {
    return operations.map(operation => ({operation_id:operation.operation_id,
      repository:operation.repository,revision:operation.expected_revision})); },
  async apply(operations) {
    if (operations.some(operation => operation.payload.kind==="release-publication-workflow")) {
      workflowCalls+=1;
    }
    return {status:"completed",observed_revisions:operations.map(operation => ({
      operation_id:operation.operation_id,repository:operation.repository,
      revision:operation.payload.kind==="release-pull-request-merge"
        ? "f".repeat(40) : "workflow-run-12"}))}; }},
  authorityRegistry:{keys:[{key_id:"release-key",actor:"release-manager",
    public_key:publicKey.export({format:"pem",type:"spki"}).toString()}]},clock:() => NOW,
  idGenerator:() => "RECEIPT-20260903-0012",policyRevision:() => "POLICY-0001"});
  await assert.rejects(runner.apply(intent,{authority}),CoreConflictError);
  assert.equal(workflowCalls,0);
  assert.equal(finalizations,0);
  assert.equal(storedReceipt.status,"failed");
});

test("release approval blocks incomplete scope, stale or changed review, and non-success checks",async () => {
  const cases=[
    ["incomplete scope",approvalObservation({scope:[]})],
    ["stale review",approvalObservation({review:{...approvalObservation().review,
      result:{...approvalObservation().review.result,freshness:"STALE"}}})],
    ["changes requested",approvalObservation({review:{...approvalObservation().review,
      result:{...approvalObservation().review.result,verdict:"CHANGES_REQUESTED",
        findings:[{finding_id:"FINDING-release-blocker",severity:"Important",
          summary:"Release remains blocked.",resolved:false}],
        unresolved:["FINDING-release-blocker"]}}})],
    ["pending checks",approvalObservation({checks:[{...approvalObservation().checks[0],
      conclusion:"PENDING"}]})],
  ];
  for (const [label,observation] of cases) {
    let writes=0;
    const result=await dispatchCoreCommand(parseCoreCommand(["release","approve",
      `${REPOSITORY}@${VERSION}`,"--authority","authority.json"]),{services:{
      control:{async loadReleasePlanningState() { return planningState(); }},
      github:{async snapshot() { return observation; }},
      operations:{reserveReceiptId() { return "RECEIPT-20260903-0001"; },
        async execute() { writes+=1; }},readAuthority:async () => authorityRecord(),clock:() => NOW,
    }});
    assert.equal(result.exitCode,6,label);
    assert.equal(writes,0,label);
  }
});

test("Publishing re-entry independently verifies publication and atomically creates the next waiting program",async () => {
  const state=publishingState();
  let request;
  const services={control:{async loadReleasePlanningState() { return state; }},
    github:{async snapshot(query) {
      assert.equal(query.kind,"release-publication");
      assert.equal(query.approval_evidence.receipt.status,"completed");
      return publicationObservation();
    }},operations:{reserveReceiptId() { return "RECEIPT-20260903-0004"; },
      async execute(value) { request=value; return {status:"preview"}; }},clock:() => NOW};
  const result=await dispatchCoreCommand(parseCoreCommand(["release","approve",
    `${REPOSITORY}@${VERSION}`]),{services});
  assert.equal(result.exitCode,0);
  assert.deepEqual(request.operations.map(value => value.payload.kind),[
    "release-publication-precondition","release-program-manifest-set",
  ]);
  const set=request.operations[1].payload;
  assert.equal(set.entries.length,2);
  assert.equal(set.entries[0].program.phase,"RELEASED");
  assert.equal(set.entries[1].program.phase,"WAITING_FOR_EPIC");
  assert.equal(set.entries[1].program.program_id,"TOSS-OS-R0002");
  assert.equal(request.authority,null);
  const intent=createOperationIntent({intent_id:"INTENT-20260903-0004",created_at:NOW,
    command:"release.approve",policy_revision:"POLICY-0001",source:request.source,
    authority:null,planned_receipt_id:"RECEIPT-20260903-0004",operations:request.operations});
  assert.equal(intent.operations[0].payload.kind,"release-publication-precondition");
});

test("last-track publication reuses one preexisting future program without appending a duplicate",() => {
  const state=publishingState();
  const createdAt="2026-09-02T09:00:00.000Z";
  const waiting={schema_version:"release-program.v1",program_id:"TOSS-OS-R0002",
    phase:"WAITING_FOR_EPIC",revision:"REV-0001",repository_releases:[],
    dependency_stages:[],selected_scope:[],deferred_scope:[],rationale:[],interrupts:null,
    created_at:createdAt,updated_at:createdAt};
  state.programs.push(waiting);
  const candidate={id:`${REPOSITORY}#20`,repository:REPOSITORY,approved:true,version:null,
    decomposed:true,priority:9,risk:"low",outcome:"next",
    change_class:"backward_compatible_feature",dependencies:[]};
  const github={...publicationObservation(),planning:{candidates:[candidate],
    completed:[`${REPOSITORY}#10`],
    repositories:[{repository:REPOSITORY,latest_published_version:VERSION}]}};
  const query=releasePublicationQuery(state,"TOSS-OS-R0001",
    state.programs[0].repository_releases[0].release_id);
  const decision=publicationOperations({planningState:state,programId:"TOSS-OS-R0001",
    releaseId:state.programs[0].repository_releases[0].release_id,
    snapshot:{...github,source:publicationSource(query,github)},
    receiptId:"RECEIPT-20260903-0004",clock:() => NOW});
  const set=decision.operations.find(operation =>
    operation.payload.kind==="release-program-manifest-set").payload;
  assert.equal(set.entries.length,2);
  const future=set.entries.find(entry => entry.program_id===waiting.program_id);
  assert.equal(future.expected_program_revision,waiting.revision);
  assert.equal(future.program.created_at,createdAt);
  assert.equal(future.program.revision,"REV-0002");
  assert.equal(future.program.phase,"DRAFT");
});

test("non-final publication requires exact source-program bytes in its single-manifest CAS",() => {
  const consoleRepository="TOSS-Soft/toss-console";
  const cli=readyRelease();
  const consoleRelease={schema_version:"repository-release.v1",
    release_id:"REL-TOSS-OS-R0001-toss-console",program_id:"TOSS-OS-R0001",
    repository:consoleRepository,phase:"DRAFT",revision:"REV-0001",version:null,
    milestone:null,branch:null,release_pr_intent:null,scope:[`${consoleRepository}#20`],
    approval:null,publication_evidence:null,transitions:[]};
  const sourceProgram={...readyProgram(),repository_releases:[cli,consoleRelease],
    dependency_stages:[{stage:1,repository_release_ids:[cli.release_id,
      consoleRelease.release_id].sort()}],selected_scope:[
      ...readyProgram().selected_scope,
      {epic_id:`${consoleRepository}#20`,outcome:"next",eligibility:{approved:true,
        unversioned:true,decomposed:true,registered_repository:true,unassigned:true}},
    ].sort((left,right) => left.epic_id<right.epic_id ? -1 : 1),rationale:[
      ...readyProgram().rationale,
      {repository:consoleRepository,version:"1.0.0",change_class:"minor",
        reasons:[{rule:"backward_compatible_feature",scope_ids:[`${consoleRepository}#20`]}]},
    ].sort((left,right) => left.repository<right.repository ? -1 : 1)};
  const ready={revision:"control-multi-17",organization:organization([
    REPOSITORY,consoleRepository,
  ]),repositories:[repositoryConfiguration(),
    repositoryConfiguration(consoleRepository,"@toss-software/console")],
  programs:[sourceProgram],intents:[],receipts:[]};
  const observedApproval=approvalObservation();
  const approved=approvalOperations({planningState:ready,programId:sourceProgram.program_id,
    releaseId:cli.release_id,snapshot:{...observedApproval,
      control_revision:ready.revision,source:{repository:CONTROL_REPOSITORY,
        revision:ready.revision,sha256:sha256Canonical({control:ready,
          github:{...observedApproval,control_revision:ready.revision}})}},
  receiptId:"RECEIPT-20260903-0041",authority:{...authorityRecord(),
    record_id:"AUTH-20260903-0041"},clock:() => NOW});
  const approvalIntent=createOperationIntent({intent_id:"INTENT-20260903-0041",
    created_at:NOW,command:"release.approve",policy_revision:"POLICY-0001",
    source:approved.source,authority:approved.program.repository_releases[0].approval.authority,
    planned_receipt_id:"RECEIPT-20260903-0041",operations:approved.operations});
  const approvalReceipt={schema_version:"operation-receipt.v1",
    document_type:"operation-receipt",receipt_id:"RECEIPT-20260903-0041",
    intent_id:approvalIntent.intent_id,intent_sha256:sha256Canonical(approvalIntent),
    created_at:NOW,status:"completed",observed_revisions:approvalIntent.operations.map(
      operation => ({operation_id:operation.operation_id,repository:operation.repository,
        revision:operation.payload.kind==="release-program-manifest"
          ? approved.program.revision
          : ["release-pull-request-merge","release-publication-workflow"].includes(
            operation.payload.kind) ? "a".repeat(40) : operation.expected_revision}))};
  const state={...ready,revision:"control-multi-18",programs:[approved.program],
    intents:[approvalIntent],receipts:[approvalReceipt]};
  const query=releasePublicationQuery(state,sourceProgram.program_id,cli.release_id);
  const observation={...publicationObservation(),control_revision:state.revision,planning:null};
  const decision=publicationOperations({planningState:state,programId:sourceProgram.program_id,
    releaseId:cli.release_id,snapshot:{...observation,source:publicationSource(query,observation)},
    receiptId:"RECEIPT-20260903-0042",clock:() => NOW});
  const local=decision.operations.find(operation =>
    operation.payload.kind==="release-program-manifest");
  assert.equal(local.payload.expected_program_sha256,sha256Canonical(approved.program));
  assert.doesNotThrow(() => createOperationIntent({intent_id:"INTENT-20260903-0042",
    created_at:NOW,command:"release.approve",policy_revision:"POLICY-0001",
    source:decision.source,authority:null,planned_receipt_id:"RECEIPT-20260903-0042",
    operations:decision.operations}));
  const omitted=structuredClone(decision.operations);
  delete omitted.find(operation => operation.payload.kind==="release-program-manifest")
    .payload.expected_program_sha256;
  assert.throws(() => createOperationIntent({intent_id:"INTENT-20260903-0042",
    created_at:NOW,command:"release.approve",policy_revision:"POLICY-0001",
    source:decision.source,authority:null,planned_receipt_id:"RECEIPT-20260903-0042",
    operations:omitted}),CoreValidationError);
});

test("publication intent survives a stateless runner restart and replays its original receipt",async () => {
  const state=publishingState();
  let execution;
  await dispatchCoreCommand(parseCoreCommand(["release","approve",`${REPOSITORY}@${VERSION}`]),
    {services:{control:{async loadReleasePlanningState() { return state; }},
      github:{async snapshot() { return publicationObservation(); }},
      operations:{reserveReceiptId() { return "RECEIPT-20260903-0004"; },
        async execute(value) { execution=value; return {status:"preview"}; }},clock:() => NOW}});
  const intent=createOperationIntent({intent_id:"INTENT-20260903-0004",created_at:NOW,
    command:"release.approve",policy_revision:"POLICY-0001",source:execution.source,
    authority:null,planned_receipt_id:execution.receipt_id,operations:execution.operations});
  let head=state.revision;
  let storedIntent=null;
  let storedReceipt=null;
  let remoteInspections=0;
  let remoteMutations=0;
  let setInspections=0;
  let setFinalizations=0;
  const control={
    async head() { return head; },
    async findIntent() { return storedIntent; },
    async findReceipt() { return storedReceipt; },
    async commitIntent({expectedHead,value,intent:committed}) {
      void value;
      assert.equal(expectedHead,head);
      storedIntent=committed;
      head="control-19";
      return {commit_sha:head};
    },
    async commitReceipt() { throw new Error("manifest-set must own completed receipt finalization"); },
    async inspectReleaseProgramSetOperation(operation) {
      setInspections+=1;
      assert.equal(operation.payload.kind,"release-program-manifest-set");
      return {operation_id:operation.operation_id,repository:operation.repository,
        revision:operation.expected_revision};
    },
    async commitReleaseProgramSetReceipt({expectedHead,receipt}) {
      setFinalizations+=1;
      assert.equal(expectedHead,head);
      storedReceipt=receipt;
      head="control-20";
      return {commit_sha:head};
    },
  };
  const github={async snapshot() { throw new Error("runner apply must use persisted query"); },
    async inspect(operations) {
      remoteInspections+=1;
      assert.equal(operations.length,1);
      assert.equal(operations[0].payload.query.kind,"release-publication");
      assert.equal(operations[0].payload.query.approval_evidence.receipt.status,"completed");
      return operations.map(operation => ({operation_id:operation.operation_id,
        repository:operation.repository,revision:operation.expected_revision}));
    },async apply() { remoteMutations+=1; throw new Error("publication verification is verify-only"); }};
  const runtime=() => createOperationRunner({control,github,authorityRegistry:{keys:[]},
    clock:() => NOW,idGenerator:() => "RECEIPT-20260903-9999",
    policyRevision:() => "POLICY-0001"});
  const first=await runtime().apply(intent);
  const replay=await runtime().apply(intent);
  assert.equal(JSON.stringify(replay),JSON.stringify(first));
  assert.equal(first.receipt_id,"RECEIPT-20260903-0004");
  assert.equal(remoteInspections,1);
  assert.equal(remoteMutations,0);
  assert.equal(setInspections,1);
  assert.equal(setFinalizations,1);
});

test("publication query rejects an approval hash that does not bind its source manifest",() => {
  const state=structuredClone(publishingState());
  const changedApproval={...state.programs[0].repository_releases[0].approval,
    manifest_sha256:"f".repeat(64)};
  state.programs[0].repository_releases[0].approval=changedApproval;
  const persisted=state.intents[0].operations.find(operation =>
    operation.payload.kind==="release-program-manifest").payload.program;
  persisted.repository_releases[0].approval=structuredClone(changedApproval);
  state.receipts[0].intent_sha256=sha256Canonical(state.intents[0]);
  assert.throws(() => releasePublicationQuery(state,"TOSS-OS-R0001",
    state.programs[0].repository_releases[0].release_id),
  error => error instanceof CoreConflictError || error instanceof CoreValidationError);

  const reviewDrift=structuredClone(publishingState());
  const originalReview=reviewDrift.programs[0].repository_releases[0].approval.review;
  const driftedApproval={...reviewDrift.programs[0].repository_releases[0].approval,
    review:{...originalReview,result:{...originalReview.result,
      reviewer:{identity:"different-reviewer",role:"independent-reviewer"}}}};
  reviewDrift.programs[0].repository_releases[0].approval=driftedApproval;
  reviewDrift.intents[0].operations.find(operation =>
    operation.payload.kind==="release-program-manifest").payload.program
    .repository_releases[0].approval=structuredClone(driftedApproval);
  reviewDrift.receipts[0].intent_sha256=sha256Canonical(reviewDrift.intents[0]);
  assert.throws(() => releasePublicationQuery(reviewDrift,"TOSS-OS-R0001",
    reviewDrift.programs[0].repository_releases[0].release_id),
  error => error instanceof CoreConflictError || error instanceof CoreValidationError);
});

test("completeProgram closes every independently verified track and uses the pure planner for the next draft",() => {
  const firstPublishing=release();
  const firstEvidence=evidenceFor(firstPublishing);
  const firstReleased=release({phase:"RELEASED",revision:"REV-0006",evidence:firstEvidence});
  const consoleRepository="TOSS-Soft/toss-console";
  const consoleApproval={...approval(consoleRepository,"1.4.0","2".repeat(40)),
    release_id:"REL-TOSS-OS-R0001-toss-console",publication:publicationPolicy("@toss-software/console")};
  const consolePublishing=release({repository:consoleRepository,version:"1.4.0",
    approvalRecord:consoleApproval});
  const consoleEvidence=evidenceFor(consolePublishing);
  const consoleReleased=release({repository:consoleRepository,version:"1.4.0",phase:"RELEASED",
    revision:"REV-0006",approvalRecord:consoleApproval,evidence:consoleEvidence});
  const current={
    schema_version:"release-program.v1",program_id:"TOSS-OS-R0001",phase:"PUBLISHING",
    revision:"REV-0005",repository_releases:[firstPublishing,consolePublishing],
    dependency_stages:[{stage:1,repository_release_ids:[firstPublishing.release_id,
      consolePublishing.release_id].sort()}],
    selected_scope:[
      {epic_id:`${REPOSITORY}#10`,outcome:"current",eligibility:{approved:true,
        unversioned:true,decomposed:true,registered_repository:true,unassigned:true}},
      {epic_id:`${consoleRepository}#10`,outcome:"current",eligibility:{approved:true,
        unversioned:true,decomposed:true,registered_repository:true,unassigned:true}},
    ].sort((left,right) => left.epic_id.localeCompare(right.epic_id)),
    deferred_scope:[],rationale:[
      {repository:REPOSITORY,version:VERSION,change_class:"minor",
        reasons:[{rule:"backward_compatible_feature",scope_ids:[`${REPOSITORY}#10`]}]},
      {repository:consoleRepository,version:"1.4.0",change_class:"minor",
        reasons:[{rule:"backward_compatible_feature",scope_ids:[`${consoleRepository}#10`]}]},
    ].sort((left,right) => left.repository.localeCompare(right.repository)),
    interrupts:null,created_at:NOW,updated_at:NOW,
  };
  const fresh={
    candidates:[{id:`${REPOSITORY}#20`,repository:REPOSITORY,approved:true,version:null,
      decomposed:true,priority:9,risk:"low",outcome:"next",
      change_class:"backward_compatible_feature",dependencies:[]}],
    completed:[`${REPOSITORY}#10`,`${consoleRepository}#10`].sort(),
    repositories:[
      {repository:REPOSITORY,latest_published_version:VERSION},
      {repository:consoleRepository,latest_published_version:"1.4.0"},
    ].sort((left,right) => left.repository.localeCompare(right.repository)),
    activePrograms:[current],
  };
  const result=completeProgram(current,[firstReleased,consoleReleased],fresh,() => NOW);
  assert.equal(result.program.phase,"RELEASED");
  assert.equal(result.program.revision,"REV-0006");
  assert.equal(result.nextProgram.program_id,"TOSS-OS-R0002");
  assert.equal(result.nextProgram.phase,"DRAFT");
  assert.deepEqual(result.nextProgram.repository_releases.map(value => value.repository),[REPOSITORY]);
  assert(Object.isFrozen(result) && Object.isFrozen(result.program) && Object.isFrozen(result.nextProgram));
  assert.equal(canonicalJson(completeProgram(current,[firstReleased,consoleReleased],fresh,
    () => NOW).nextProgram),canonicalJson(result.nextProgram));
  const waitingCreatedAt="2026-09-02T09:00:00.000Z";
  const waiting={schema_version:"release-program.v1",program_id:"TOSS-OS-R0002",
    phase:"WAITING_FOR_EPIC",revision:"REV-0001",repository_releases:[],
    dependency_stages:[],selected_scope:[],deferred_scope:[],rationale:[],interrupts:null,
    created_at:waitingCreatedAt,updated_at:waitingCreatedAt};
  const reused=completeProgram(current,[firstReleased,consoleReleased],
    {...fresh,activePrograms:[current,waiting]},() => NOW);
  assert.equal(reused.nextProgram.program_id,waiting.program_id);
  assert.equal(reused.nextProgram.created_at,waitingCreatedAt);
  assert.equal(reused.nextProgram.revision,"REV-0002");
  assert.equal(reused.nextProgram.phase,"DRAFT");
  assert.deepEqual(reused.nextProgram.rationale.map(value => value.version),["2.3.0"]);
  const unchangedWaiting=completeProgram(current,[firstReleased,consoleReleased],
    {...fresh,candidates:[],activePrograms:[current,waiting]},() => NOW);
  assert.equal(canonicalJson(unchangedWaiting.nextProgram),canonicalJson(waiting));
  const unchanged=completeProgram(current,[firstReleased,consoleReleased],
    {...fresh,activePrograms:[current,reused.nextProgram]},() => "2026-09-03T12:05:00.000Z");
  assert.equal(canonicalJson(unchanged.nextProgram),canonicalJson(reused.nextProgram));
  assert.throws(() => completeProgram(current,[firstReleased,consoleReleased],
    {...fresh,activePrograms:[current,waiting,{...waiting,program_id:"TOSS-OS-R0003"}]},
    () => NOW),CoreConflictError);
  assert.throws(() => completeProgram(current,[consoleReleased,firstReleased],fresh,() => NOW),
    CoreConflictError);
  assert.throws(() => completeProgram(current,[firstReleased,firstReleased],fresh,() => NOW),
    CoreConflictError);
  assert.throws(() => completeProgram(current,[firstReleased,consoleReleased],
    {...fresh,activePrograms:[current,current]},() => NOW),CoreConflictError);
  let clockTraps=0;
  const hostileClock=new Proxy(() => NOW,{apply() {
    clockTraps+=1;
    throw new Error("must not invoke a proxied completion clock");
  }});
  assert.throws(() => completeProgram(current,[firstReleased,consoleReleased],fresh,
    hostileClock),CoreValidationError);
  assert.equal(clockTraps,0);

  const wrongRevision="e".repeat(40);
  const wrongEvidence={...firstEvidence,expected_revision:wrongRevision,
    tag:{...firstEvidence.tag,target_revision:wrongRevision},
    github_release:{...firstEvidence.github_release,target_revision:wrongRevision}};
  wrongEvidence.evidence_sha256=sha256Canonical((({evidence_sha256:_,...value}) => {
    void _;
    return value;
  })(wrongEvidence));
  const forgedReleased=release({phase:"RELEASED",revision:"REV-0006",evidence:wrongEvidence});
  const singleCurrent={...current,repository_releases:[firstPublishing],
    dependency_stages:[{stage:1,repository_release_ids:[firstPublishing.release_id]}],
    selected_scope:[current.selected_scope.find(value => value.epic_id===`${REPOSITORY}#10`)],
    rationale:[current.rationale.find(value => value.repository===REPOSITORY)]};
  assert.throws(() => completeProgram(singleCurrent,
    [forgedReleased],{candidates:[],completed:[`${REPOSITORY}#10`],
      repositories:[{repository:REPOSITORY,latest_published_version:VERSION}],
      activePrograms:[singleCurrent]},() => NOW),
  error => error instanceof CoreConflictError || error instanceof CoreValidationError);
});

test("release planning never regresses or reuses a version below verified Released history",() => {
  const state=releasedPlanningState();
  const snapshot=(sourceState,latest) => {
    const github={kind:"release-plan",control_revision:sourceState.revision,
      project:{id:"PVT_TOSS_OS_2",revision:"project-plan-20"},
      candidates:[{id:`${REPOSITORY}#20`,repository:REPOSITORY,approved:true,version:null,
        decomposed:true,priority:9,risk:"low",outcome:"next",
        change_class:"backward_compatible_feature",dependencies:[]}],
      completed:[`${REPOSITORY}#10`],
      repositories:[{repository:REPOSITORY,latest_published_version:latest}]};
    return {...github,source:{repository:CONTROL_REPOSITORY,revision:sourceState.revision,
      sha256:sha256Canonical({control:sourceState,github})}};
  };
  assert.throws(() => releasePlanOperations({planningState:state,
    snapshot:snapshot(state,"2.1.0"),clock:() => NOW}),CoreConflictError);

  const equal=releasePlanOperations({planningState:state,
    snapshot:snapshot(state,VERSION),clock:() => NOW});
  assert.equal(equal.program.program_id,"TOSS-OS-R0002");
  assert.equal(equal.program.revision,"REV-0002");
  assert.equal(equal.program.rationale[0].version,"2.3.0");

  const advanced=releasePlanOperations({planningState:state,
    snapshot:snapshot(state,"2.10.0"),clock:() => NOW});
  assert.equal(advanced.program.rationale[0].version,"2.11.0");

  const occupied=readyProgram();
  occupied.program_id="TOSS-OS-R0003";
  occupied.selected_scope[0].epic_id=`${REPOSITORY}#30`;
  occupied.rationale[0].version="2.10.0";
  occupied.rationale[0].reasons[0].scope_ids=[`${REPOSITORY}#30`];
  const occupiedRelease=occupied.repository_releases[0];
  occupiedRelease.program_id=occupied.program_id;
  occupiedRelease.release_id="REL-TOSS-OS-R0003-toss-cli";
  occupiedRelease.version="2.10.0";
  occupiedRelease.milestone="v2.10.0";
  occupiedRelease.branch="release/v2.10.0";
  occupiedRelease.release_pr_intent.head="release/v2.10.0";
  occupiedRelease.scope=[`${REPOSITORY}#30`];
  occupied.dependency_stages[0].repository_release_ids=[occupiedRelease.release_id];
  const duplicateState={...state,revision:"control-20",
    programs:[...state.programs,occupied]};
  assert.throws(() => releasePlanOperations({planningState:duplicateState,
    snapshot:snapshot(duplicateState,VERSION),clock:() => NOW}),CoreConflictError);
});

test("Released publication evidence must cite the exact VERIFY_PUBLICATION receipt",() => {
  const publishing=release();
  const evidence=evidenceFor(publishing);
  const released=release({phase:"RELEASED",revision:"REV-0006",evidence});
  const forged=structuredClone(released);
  forged.transitions.at(-1).source_receipt="RECEIPT-20260903-9999";
  const current={...readyProgram(),phase:"PUBLISHING",revision:"REV-0005",
    repository_releases:[publishing],updated_at:NOW};
  assert.throws(() => completeProgram(current,[forged],{
    candidates:[],completed:[`${REPOSITORY}#10`],
    repositories:[{repository:REPOSITORY,latest_published_version:VERSION}],
    activePrograms:[current]},() => NOW),CoreValidationError);
});

test("persisted Released publication requires its exact completed verification transaction",() => {
  const state=releasedPlanningState();
  assert.doesNotThrow(() => normalizeReleasePlanningState(state));
  const publicationReceipt=state.programs[0].repository_releases[0]
    .publication_evidence.source_receipt;
  const laterReceipt=structuredClone(state);
  laterReceipt.receipts.find(receipt => receipt.receipt_id===publicationReceipt)
    .created_at="2026-09-03T12:00:01.000Z";
  assert.doesNotThrow(() => normalizeReleasePlanningState(laterReceipt));
  const cases=[
    ["missing receipt",value => { value.receipts=value.receipts.filter(receipt =>
      receipt.receipt_id!==publicationReceipt); }],
    ["failed receipt",value => { value.receipts.find(receipt =>
      receipt.receipt_id===publicationReceipt).status="failed"; }],
    ["mismatched intent",value => { value.receipts.find(receipt =>
      receipt.receipt_id===publicationReceipt).intent_sha256="f".repeat(64); }],
    ["incomplete coverage",value => { value.receipts.find(receipt =>
      receipt.receipt_id===publicationReceipt).observed_revisions.pop(); }],
    ["substituted approval proof",value => {
      const receipt=value.receipts.find(candidate => candidate.receipt_id===publicationReceipt);
      const intent=value.intents.find(candidate => candidate.intent_id===receipt.intent_id);
      intent.operations[0].payload.query.approval_evidence.receipt.intent_sha256="e".repeat(64);
      receipt.intent_sha256=sha256Canonical(intent);
    }],
  ];
  for (const [label,mutate] of cases) {
    const forged=structuredClone(state);
    mutate(forged);
    assert.throws(() => normalizeReleasePlanningState(forged),CoreConflictError,label);
  }

  const forgedNext=structuredClone(state);
  const publicationIntent=forgedNext.intents.find(value =>
    value.planned_receipt_id===publicationReceipt);
  const set=publicationIntent.operations.find(operation =>
    operation.payload.kind==="release-program-manifest-set");
  const next=set.payload.entries.find(entry => entry.expected_program_revision===null);
  next.program.updated_at="2026-09-03T12:00:01.000Z";
  set.payload.resulting_set_sha256=sha256Canonical(
    set.payload.entries.map(entry => entry.program),
  );
  forgedNext.programs=structuredClone(set.payload.entries.map(entry => entry.program));
  const publicationLedgerReceipt=forgedNext.receipts.find(value =>
    value.receipt_id===publicationReceipt);
  publicationLedgerReceipt.intent_sha256=sha256Canonical(publicationIntent);
  publicationLedgerReceipt.observed_revisions.find(value =>
    value.operation_id===set.operation_id).revision=set.payload.resulting_set_sha256;
  assert.throws(() => normalizeReleasePlanningState(forgedNext),CoreConflictError);
});

test("publication intent derives the exact next program before any authority-null write",() => {
  const state=releasedPlanningState();
  const receipt=state.receipts.find(value => value.receipt_id==="RECEIPT-20260903-0004");
  const intent=structuredClone(state.intents.find(value => value.intent_id===receipt.intent_id));
  const set=intent.operations.find(operation =>
    operation.payload.kind==="release-program-manifest-set");
  const next=set.payload.entries.find(entry => entry.expected_program_revision===null);
  next.program.updated_at="2026-09-03T12:00:01.000Z";
  set.payload.resulting_set_sha256=sha256Canonical(set.payload.entries.map(entry => entry.program));
  const request=operations => ({intent_id:intent.intent_id,
    created_at:intent.created_at,command:intent.command,policy_revision:intent.policy_revision,
    source:intent.source,authority:intent.authority,planned_receipt_id:intent.planned_receipt_id,
    operations});
  const withoutIds=operations => operations.map(({operation_id:_,...operation}) => operation);
  assert.throws(() => createOperationIntent(request(withoutIds(intent.operations))),
  CoreValidationError);
  const original=state.intents.find(value => value.intent_id===receipt.intent_id);
  const exactOperations=withoutIds(original.operations);
  assert.throws(() => createOperationIntent({...request(exactOperations),source:{
    ...intent.source,sha256:"f".repeat(64),
  }}),CoreValidationError);
  assert.throws(() => createOperationIntent({...request(exactOperations),
    authority:{record_id:"AUTH-20260903-0001",sha256:"a".repeat(64)}}),CoreValidationError);
  assert.throws(() => createOperationIntent(request(exactOperations.slice(1))),CoreValidationError);
  assert.throws(() => createOperationIntent(request([...exactOperations,exactOperations[0]])),
    CoreValidationError);
  const draft=structuredClone(exactOperations);
  draft.find(operation => operation.payload.kind==="release-publication-precondition")
    .payload.descriptor.publication.github_release.draft=true;
  assert.throws(() => createOperationIntent(request(draft)),CoreValidationError);
});

test("runner rejects a forged authority-null publication before every port call",async () => {
  const state=releasedPlanningState();
  const original=state.intents.find(value =>
    value.planned_receipt_id==="RECEIPT-20260903-0004");
  const forged=structuredClone(original);
  const set=forged.operations.find(operation =>
    operation.payload.kind==="release-program-manifest-set");
  const next=set.payload.entries.find(entry => entry.expected_program_revision===null);
  next.program.updated_at="2026-09-03T12:00:01.000Z";
  set.payload.resulting_set_sha256=sha256Canonical(
    set.payload.entries.map(entry => entry.program),
  );
  let calls=0;
  const called=async () => { calls+=1; return null; };
  const runner=createOperationRunner({control:{head:called,findIntent:called,
    findReceipt:called,commitIntent:called,commitReceipt:called,
    inspectReleaseProgramSetOperation:called,commitReleaseProgramSetReceipt:called},
  github:{snapshot:called,inspect:called,apply:called},authorityRegistry:{keys:[]},
  clock:() => NOW,idGenerator:() => "RECEIPT-20260903-9999",
  policyRevision:() => "POLICY-0001"});
  await assert.rejects(runner.apply(forged),CoreValidationError);
  await assert.rejects(runner.apply({...structuredClone(original),source:{
    ...original.source,sha256:"f".repeat(64),
  }}),CoreValidationError);
  assert.equal(calls,0);
});

test("authority-null release approval cannot evade publication or patch transaction ownership",() => {
  const state=releasedPlanningState();
  const current=state.programs.find(value => value.program_id==="TOSS-OS-R0001");
  const program={...structuredClone(current),revision:"REV-0007",
    updated_at:"2026-09-03T12:00:01.000Z"};
  assert.throws(() => createOperationIntent({
    intent_id:"INTENT-20260903-0099",created_at:"2026-09-03T12:00:01.000Z",
    command:"release.approve",policy_revision:"POLICY-0001",
    source:{repository:CONTROL_REPOSITORY,revision:state.revision,sha256:"f".repeat(64)},
    authority:null,planned_receipt_id:"RECEIPT-20260903-0099",operations:[{
      resource:"repository",action:"commit",repository:CONTROL_REPOSITORY,
      expected_revision:current.revision,payload:{kind:"release-program-manifest",
        expected_program_revision:current.revision,program},
    }],
  }),CoreValidationError);
});

test("every persisted approval receipt rechecks exact base and fast-forward observations",() => {
  const state=publishingState();
  for (const kind of ["release-approval-base-precondition","release-pull-request-merge"]) {
    const forged=structuredClone(state);
    const intent=forged.intents[0];
    const operation=intent.operations.find(value => value.payload.kind===kind);
    forged.receipts[0].observed_revisions.find(value =>
      value.operation_id===operation.operation_id).revision="f".repeat(40);
    assert.throws(() => normalizeReleasePlanningState(forged),CoreConflictError,kind);
  }
});

test("next planning rejects omitted completed scope duplicate candidates and stale publication history",() => {
  const publishing=release();
  const evidence=evidenceFor(publishing);
  const released=release({phase:"RELEASED",revision:"REV-0006",evidence});
  const current={...readyProgram(),phase:"PUBLISHING",revision:"REV-0005",
    repository_releases:[publishing],updated_at:NOW};
  const duplicate={id:`${REPOSITORY}#10`,repository:REPOSITORY,approved:true,version:null,
    decomposed:true,priority:9,risk:"low",outcome:"current",
    change_class:"backward_compatible_feature",dependencies:[]};
  for (const [label,bundle] of [
    ["omitted completion",{candidates:[],completed:[],
      repositories:[{repository:REPOSITORY,latest_published_version:VERSION}],
      activePrograms:[current]}],
    ["duplicate candidate",{candidates:[duplicate],completed:[],
      repositories:[{repository:REPOSITORY,latest_published_version:VERSION}],
      activePrograms:[current]}],
    ["stale publication history",{candidates:[],completed:[`${REPOSITORY}#10`],
      repositories:[{repository:REPOSITORY,latest_published_version:"2.1.9"}],
      activePrograms:[current]}],
  ]) {
    assert.throws(() => completeProgram(current,[released],bundle,() => NOW),
      CoreConflictError,label);
  }
});
