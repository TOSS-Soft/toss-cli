import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {compareCanonicalText} from "../canonical-order.js";
import {authorityReference} from "../authority.js";
import {closedData,exact} from "../commands/common.js";
import {validateCoreDocument} from "../contracts.js";
import {CoreConflictError,CoreValidationError} from "../errors.js";
import {assertIndependentReviewer,normalizeReviewResult,
  validateImplementationIdentity} from "../domain/review.js";
import {releaseApprovalLedgerEvidence} from "./approval-ledger.js";
import {normalizeReleasePlanningState} from "./operations.js";
import {releaseApprovalEnvelopeSha256} from "./approval-envelope.js";
import {projectPublicationTransaction,publicationSource} from "./publication-projector.js";
import {approveRepositoryRelease,assertRepositoryConcurrency} from "./state.js";

const RECEIPT=/^RECEIPT-[0-9]{8}-[0-9]{4,}$/u;
const COMMIT=/^[a-f0-9]{40}$/u;
const APPROVAL_SNAPSHOT_KEYS=Object.freeze([
  "kind","source","control_revision","project","repository","pull_request",
  "scope","review","checks",
]);
const PUBLICATION_SNAPSHOT_KEYS=Object.freeze([
  "kind","source","control_revision","repository_revision","publication","planning",
]);

function deepFreeze(value) {
  if (value===null || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function releaseOperationRequest(input,keys,label) {
  if (!input || typeof input!=="object" || Array.isArray(input) || types.isProxy(input) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(input))) {
    throw new CoreValidationError(`${label} must be a plain non-proxy object`);
  }
  const descriptors=Object.getOwnPropertyDescriptors(input);
  const names=Reflect.ownKeys(descriptors);
  if (names.some(key => typeof key!=="string") || names.length!==keys.length ||
      keys.some(key => !Object.hasOwn(descriptors,key))) {
    throw new CoreValidationError(`${label} must use the exact closed shape`);
  }
  const data=Object.create(null);
  let clock=null;
  for (const key of keys) {
    const descriptor=descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new CoreValidationError(`${label}.${key} must be own enumerable data`);
    }
    if (key==="clock") {
      if (typeof descriptor.value!=="function" || types.isProxy(descriptor.value)) {
        throw new CoreValidationError(`${label}.clock must be an own-data non-proxy function`);
      }
      clock=descriptor.value;
    } else {
      data[key]=descriptor.value;
    }
  }
  return Object.freeze({...closedData(data,label),clock});
}

export {completeProgram,projectPublicationTransaction,publicationComplete,
  publicationSource,verifyPublication} from "./publication-projector.js";

function incrementProgramRevision(value) {
  return incrementRevision(value);
}

function incrementRevision(value) {
  const match=/^REV-([0-9]{4,})$/u.exec(value);
  if (!match) throw new CoreValidationError("Program revision must be canonical");
  const number=Number(match[1]);
  if (!Number.isSafeInteger(number) || number<1 || number===Number.MAX_SAFE_INTEGER) {
    throw new CoreValidationError("Program revision cannot be incremented safely");
  }
  const next=String(number+1);
  return `REV-${next.padStart(Math.max(4,match[1].length),"0")}`;
}

function approvalSnapshot(input,state,program,release,configuration) {
  const snapshot=closedData(input,"Release approval snapshot");
  exact(snapshot,APPROVAL_SNAPSHOT_KEYS,"Release approval snapshot");
  exact(snapshot.source,["repository","revision","sha256"],"Release approval source");
  exact(snapshot.project,["id","revision"],"Release approval Project");
  exact(snapshot.repository,["repository","revision","rules_revision","required_checks",
    "workflow_revision"],"Release approval repository");
  exact(snapshot.pull_request,["number","revision","head","head_sha","base","base_sha",
    "base_revision","state","draft"],
    "Release approval pull request");
  exact(snapshot.review,["revision","result","formal_review","implementation_identity"],
    "Release approval review evidence");
  if (snapshot.kind!=="release-approval" || snapshot.control_revision!==state.revision ||
      snapshot.source.repository!==state.organization.control_repository ||
      snapshot.source.revision!==state.revision || !/^[a-f0-9]{64}$/u.test(snapshot.source.sha256) ||
      snapshot.project.id!==state.organization.project.node_id ||
      snapshot.repository.repository!==release.repository ||
      snapshot.pull_request.head!==release.branch ||
      snapshot.pull_request.base!==release.release_pr_intent.base ||
      snapshot.pull_request.state!=="OPEN" || snapshot.pull_request.draft!==false ||
      !Number.isSafeInteger(snapshot.pull_request.number) || snapshot.pull_request.number<1 ||
      !COMMIT.test(snapshot.pull_request.head_sha) || !COMMIT.test(snapshot.pull_request.base_sha) ||
      typeof snapshot.pull_request.base_revision!=="string" ||
      !/\S/u.test(snapshot.pull_request.base_revision)) {
    throw new CoreConflictError("Release approval snapshot does not bind the selected release and current PR");
  }
  const github={kind:snapshot.kind,control_revision:snapshot.control_revision,
    project:snapshot.project,repository:snapshot.repository,pull_request:snapshot.pull_request,
    scope:snapshot.scope,review:snapshot.review,checks:snapshot.checks};
  if (snapshot.source.sha256!==sha256Canonical({control:state,github})) {
    throw new CoreConflictError("Release approval source hash does not bind control and GitHub evidence");
  }
  if (typeof snapshot.repository.revision!=="string" || !snapshot.repository.revision ||
      typeof snapshot.repository.rules_revision!=="string" || !snapshot.repository.rules_revision ||
      typeof snapshot.repository.workflow_revision!=="string" || !snapshot.repository.workflow_revision) {
    throw new CoreConflictError("Release approval repository evidence is incomplete");
  }
  if (!Array.isArray(snapshot.scope) || !Array.isArray(snapshot.checks) ||
      !Array.isArray(snapshot.repository.required_checks) ||
      snapshot.repository.required_checks.length===0) {
    throw new CoreConflictError("Release approval requires complete scope and required checks");
  }
  const scopeIds=[];
  for (const work of snapshot.scope) {
    exact(work,["id","revision","project_item_id","project_revision","status","gate"],
      "Release approval scope item");
    if (typeof work.id!=="string" || typeof work.revision!=="string" ||
        typeof work.project_item_id!=="string" || typeof work.project_revision!=="string" ||
        work.status!=="Done") {
      throw new CoreConflictError("Every release scope item must be Done at its exact revision");
    }
    scopeIds.push(work.id);
  }
  scopeIds.sort(compareCanonicalText);
  if (new Set(scopeIds).size!==scopeIds.length ||
      canonicalJson(scopeIds)!==canonicalJson([...release.scope].sort(compareCanonicalText))) {
    throw new CoreConflictError("Release approval scope inventory is incomplete or ambiguous");
  }
  const result=normalizeReviewResult(snapshot.review.result);
  const implementation=validateImplementationIdentity(snapshot.review.implementation_identity);
  exact(snapshot.review.formal_review,["state","review_id","reviewed_revision","revision"],
    "Release approval formal review");
  const formal=snapshot.review.formal_review;
  if (canonicalJson(result)!==canonicalJson(snapshot.review.result) ||
      canonicalJson(implementation)!==canonicalJson(snapshot.review.implementation_identity) ||
      typeof snapshot.review.revision!=="string" || !/\S/u.test(snapshot.review.revision) ||
      result.repository!==release.repository ||
      result.pull_request_number!==snapshot.pull_request.number ||
      result.reviewed_revision!==snapshot.pull_request.head_sha ||
      result.freshness!=="CURRENT" || result.verdict!=="APPROVED" ||
      formal.state!=="APPROVED" || formal.review_id!==result.review_id ||
      formal.reviewed_revision!==snapshot.pull_request.head_sha ||
      typeof formal.revision!=="string" || !/\S/u.test(formal.revision) ||
      implementation.revision!==snapshot.pull_request.head_sha ||
      implementation.base_revision!==snapshot.pull_request.base_sha) {
    throw new CoreConflictError("Release approval requires one current approved exact-head review");
  }
  assertIndependentReviewer(result.reviewer.identity,implementation);
  const required=snapshot.repository.required_checks;
  const requiredOrdered=[...required].sort(compareCanonicalText);
  if (required.some(value => typeof value!=="string" || !/\S/u.test(value)) ||
      new Set(required).size!==required.length || canonicalJson(required)!==canonicalJson(requiredOrdered)) {
    throw new CoreConflictError("Release required checks are not a canonical nonempty identity set");
  }
  const checks=[];
  for (const check of snapshot.checks) {
    exact(check,["name","revision","head_sha","conclusion"],"Release approval check");
    if (typeof check.name!=="string" || typeof check.revision!=="string" ||
        check.head_sha!==snapshot.pull_request.head_sha || check.conclusion!=="SUCCESS") {
      throw new CoreConflictError("Every required check must pass for the exact release PR head");
    }
    checks.push(check.name);
  }
  if (new Set(checks).size!==checks.length || canonicalJson(checks)!==canonicalJson(required)) {
    throw new CoreConflictError("Release approval checks do not exactly cover repository rules");
  }
  return snapshot;
}

export function approvalOperations(input) {
  const request=releaseOperationRequest(input,
    ["planningState","programId","releaseId","snapshot","receiptId","authority","clock"],
    "Release approval operation request");
  const state=normalizeReleasePlanningState(request.planningState);
  const program=state.programs.find(value => value.program_id===request.programId);
  const release=program?.repository_releases.find(value => value.release_id===request.releaseId);
  const configuration=state.repositories.find(value => value.repository===release?.repository);
  if (!program || !release || !configuration || release.phase!=="READY_FOR_APPROVAL" ||
      release.approval!==null || typeof request.receiptId!=="string" ||
      !RECEIPT.test(request.receiptId)) {
    throw new CoreConflictError("Release approval requires one exact Ready for approval track");
  }
  validateCoreDocument(configuration,"repository-config.v1");
  const authority=validateCoreDocument(request.authority,"authority-record.v1");
  const snapshot=approvalSnapshot(request.snapshot,state,program,release,configuration);
  const approvedAt=request.clock();
  const approval={
    schema_version:"release-approval.v1",source_receipt:request.receiptId,
    authority:authorityReference(authority),program_id:program.program_id,
    release_id:release.release_id,manifest_revision:program.revision,
    manifest_sha256:sha256Canonical(program),
    pull_request:{number:snapshot.pull_request.number,revision:snapshot.pull_request.revision,
      head:snapshot.pull_request.head,head_sha:snapshot.pull_request.head_sha,
      base:snapshot.pull_request.base,base_sha:snapshot.pull_request.base_sha,
      base_revision:snapshot.pull_request.base_revision},
    scope:[...snapshot.scope].sort((left,right) => compareCanonicalText(left.id,right.id)),
    review:snapshot.review,required_checks:snapshot.repository.required_checks,
    checks:snapshot.checks.map(check => ({name:check.name,revision:check.revision,
      head_sha:check.head_sha,conclusion:check.conclusion})),
    rules_revision:snapshot.repository.rules_revision,
    policy_revision:state.organization.policy_revision,publication:configuration.publication,
    merge_result_revision:snapshot.pull_request.head_sha,approved_at:approvedAt,
  };
  const approvedRelease=approveRepositoryRelease(release,{event:"APPROVE",
    expected_revision:release.revision,timestamp:approvedAt,source_receipt:request.receiptId,
    activation:null},approval);
  const releases=program.repository_releases.map(value =>
    value.release_id===release.release_id ? approvedRelease : value);
  const updated=closedData({...program,phase:"PUBLISHING",
    revision:incrementProgramRevision(program.revision),repository_releases:releases,
    updated_at:approvedAt},"Approved release program");
  assertRepositoryConcurrency(state.programs.map(value =>
    value.program_id===program.program_id ? updated : value));
  const authorityBindingBase={
    program_id:program.program_id,release_id:release.release_id,
    manifest_revision:program.revision,manifest_sha256:sha256Canonical(program),
    pull_request:approval.pull_request,review:approval.review,checks:approval.checks,
    rules_revision:approval.rules_revision,version:release.version,
    policy_revision:approval.policy_revision,publication:approval.publication,
    scope:snapshot.scope,
    repository:{node_id:configuration.repository_node_id,revision:snapshot.repository.revision},
    project:{node_id:state.organization.project.node_id,revision:snapshot.project.revision},
    workflow:{name:configuration.publication.workflow,
      revision:snapshot.repository.workflow_revision},
  };
  const query=closedData({kind:"release-approval",control_revision:state.revision,
    organization:state.organization,programs:state.programs,program,release,repository_configuration:configuration,
    project:state.organization.project},"Release approval query");
  const {source:_source,...snapshotBody}=snapshot;
  void _source;
  const buildOperations=authorityBinding => [{
    resource:"project",action:"verify",repository:null,
    expected_revision:snapshot.project.revision,
    payload:{kind:"release-approval-precondition",project_id:snapshot.project.id,
      query,snapshot_sha256:sha256Canonical(snapshotBody),authority_binding:authorityBinding},
  },{
    resource:"branch",action:"verify",repository:release.repository,
    expected_revision:snapshot.pull_request.base_revision,
    payload:{kind:"release-approval-base-precondition",program_id:program.program_id,
      release_id:release.release_id,name:snapshot.pull_request.base,
      head_sha:snapshot.pull_request.base_sha,authority_binding:authorityBinding},
  },{
    resource:"pull_request",action:"merge",repository:release.repository,
    expected_revision:snapshot.pull_request.revision,
    payload:{kind:"release-pull-request-merge",program_id:program.program_id,
      release_id:release.release_id,number:snapshot.pull_request.number,
      head_branch:snapshot.pull_request.head,head_sha:snapshot.pull_request.head_sha,
      base_branch:snapshot.pull_request.base,base_sha:snapshot.pull_request.base_sha,
      base_revision:snapshot.pull_request.base_revision,merge_mode:"FAST_FORWARD_ONLY",
      merge_result_revision:snapshot.pull_request.head_sha,authority_binding:authorityBinding},
  },{
    resource:"workflow",action:"create",repository:release.repository,
    expected_revision:snapshot.repository.workflow_revision,
    payload:{kind:"release-publication-workflow",program_id:program.program_id,
      release_id:release.release_id,workflow:configuration.publication.workflow,
      version:release.version,tag:`v${release.version}`,
      expected_revision:snapshot.pull_request.head_sha,authority_binding:authorityBinding},
  },{
    resource:"repository",action:"commit",repository:state.organization.control_repository,
    expected_revision:program.revision,payload:{kind:"release-program-manifest",
      expected_program_revision:program.revision,program:updated,
      authority_binding:authorityBinding},
  }];
  const draftOperations=buildOperations(authorityBindingBase);
  const authorityBinding=closedData({...authorityBindingBase,
    operation_intent_sha256:releaseApprovalEnvelopeSha256({command:"release.approve",
      policy_revision:state.organization.policy_revision,source:snapshot.source,
      operations:draftOperations})},"Release approval authority binding");
  const operations=buildOperations(authorityBinding);
  return deepFreeze({source:snapshot.source,program:updated,approval,operations,authorityBinding});
}

export function releasePublicationQuery(planningState,programId,releaseId) {
  const state=normalizeReleasePlanningState(planningState);
  const program=state.programs.find(value => value.program_id===programId);
  const release=program?.repository_releases.find(value => value.release_id===releaseId);
  const configuration=state.repositories.find(value => value.repository===release?.repository);
  if (!program || !release || !configuration || release.phase!=="PUBLISHING") {
    throw new CoreConflictError("Publication query requires one exact Publishing release");
  }
  return closedData({kind:"release-publication",control_revision:state.revision,
    control_repository:state.organization.control_repository,organization:state.organization,
    programs:state.programs,program,release,repository_configuration:configuration,
    project:state.organization.project,approval_evidence:releaseApprovalLedgerEvidence(state,release)},
  "Release publication query");
}

function publicationSnapshot(input,state,release,query) {
  const snapshot=closedData(input,"Release publication snapshot");
  exact(snapshot,PUBLICATION_SNAPSHOT_KEYS,"Release publication snapshot");
  exact(snapshot.source,["repository","revision","sha256"],"Release publication source");
  exact(snapshot.publication,["tag","package","github_release"],"Release publication observation");
  if (snapshot.kind!=="release-publication" || snapshot.control_revision!==state.revision ||
      snapshot.source.repository!==state.organization.control_repository ||
      snapshot.source.revision!==state.revision || !/^[a-f0-9]{64}$/u.test(snapshot.source.sha256) ||
      typeof snapshot.repository_revision!=="string" || !snapshot.repository_revision) {
    throw new CoreConflictError("Release publication snapshot does not bind the current control revision");
  }
  const observation={kind:snapshot.kind,control_revision:snapshot.control_revision,
    repository_revision:snapshot.repository_revision,publication:snapshot.publication,
    planning:snapshot.planning};
  if (canonicalJson(snapshot.source)!==canonicalJson(publicationSource(query,observation))) {
    throw new CoreConflictError(
      "Release publication source does not bind its exact query and GitHub evidence",
    );
  }
  if (snapshot.planning!==null) {
    exact(snapshot.planning,["candidates","completed","repositories"],
      "Release publication fresh planning snapshot");
  }
  return snapshot;
}

export function publicationOperations(input) {
  const request=releaseOperationRequest(input,
    ["planningState","programId","releaseId","snapshot","receiptId","clock"],
    "Release publication operation request");
  if (typeof request.receiptId!=="string" || !RECEIPT.test(request.receiptId)) {
    throw new CoreValidationError("Release publication request is malformed");
  }
  const state=normalizeReleasePlanningState(request.planningState);
  const program=state.programs.find(value => value.program_id===request.programId);
  const release=program?.repository_releases.find(value => value.release_id===request.releaseId);
  const configuration=state.repositories.find(value => value.repository===release?.repository);
  if (!program || !release || !configuration || release.phase!=="PUBLISHING" ||
      release.approval===null) {
    throw new CoreConflictError("Publication verification requires one exact Publishing release");
  }
  if (release.approval.policy_revision!==state.organization.policy_revision ||
      canonicalJson(release.approval.publication)!==canonicalJson(configuration.publication)) {
    throw new CoreConflictError("Publication policy changed after release approval");
  }
  const query=releasePublicationQuery(state,program.program_id,release.release_id);
  const snapshot=publicationSnapshot(request.snapshot,state,release,query);
  const now=request.clock();
  const descriptor={repository_revision:snapshot.repository_revision,
    publication:snapshot.publication,planning:snapshot.planning,
    receipt_id:request.receiptId,verified_at:now};
  const projected=projectPublicationTransaction(query,descriptor);
  return closedData({source:projected.source,program:projected.program,
    nextProgram:projected.nextProgram,evidence:projected.evidence,
    operations:projected.operations},"Release publication operation result");
}
