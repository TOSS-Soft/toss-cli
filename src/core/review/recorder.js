import {sha256Canonical,canonicalJson} from "../../contracts/acp.js";
import {closedData,exact} from "../commands/common.js";
import {validateCoreDocument} from "../contracts.js";
import {assertValidPullRequestTarget} from "../domain/branching.js";
import {
  assertIndependentReviewer,
  normalizeReviewResult,
  reviewFreshness,
  validateImplementationIdentity,
} from "../domain/review.js";
import {parseWorkItemId,reserveBranch,workItemId} from "../domain/identity.js";
import {deriveWorkItemState,projectReconciliationOperations} from "../domain/state.js";
import {CoreBlockedError,CoreConflictError,CoreValidationError} from "../errors.js";
import {compareOperations} from "../operation-order.js";
import {
  REVIEW_MARKERS,
  parseManagedReviewBlock,
  renderManagedReviewBlock,
  updateManagedReviewBlock,
} from "./body.js";

const SHA=/^[a-f0-9]{40}$/u;
const REVIEW_ID=/^REVIEW-[0-9]{8}-[0-9]{4,}$/u;
const FINDING_ID=/^FINDING-[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function invalid(message,options={}) { throw new CoreValidationError(message,options); }
function conflict(message,options={}) { throw new CoreConflictError(message,options); }
function compare(left,right) { return left===right ? 0 : left<right ? -1 : 1; }

function text(value,label) {
  if (typeof value!=="string" || value.trim().length===0) invalid(`${label} must be nonblank text`);
  return value;
}

function sha(value,label) {
  if (typeof value!=="string" || !SHA.test(value)) invalid(`${label} must be a lowercase 40-character commit SHA`);
  return value;
}

function repository(value,label="Repository") {
  try { return parseWorkItemId(`${value}#1`).repository; }
  catch (error) { invalid(`${label} must be canonical OWNER/REPO ASCII`,{cause:error}); }
}

function reviewContext(reviewResult,identity,pullRequest) {
  return Object.freeze({
    review_result:reviewResult,
    implementation_identity:identity,
    head_sha:pullRequest.head_sha,
    checks:pullRequest.checks,
  });
}

function formalState(result) {
  return result.verdict==="APPROVED" ? "APPROVED" : "CHANGES_REQUESTED";
}

function formalAction(result) {
  return result.verdict==="APPROVED" ? "APPROVE" : "REQUEST_CHANGES";
}

function validateFormalReview(value) {
  exact(value,["state","review_id","reviewed_revision"],"Formal review evidence");
  if (!new Set(["NONE","APPROVED","CHANGES_REQUESTED"]).has(value.state)) {
    invalid("Formal review state is invalid");
  }
  if (value.state==="NONE") {
    if (value.review_id!==null || value.reviewed_revision!==null) {
      conflict("An empty formal review cannot carry review identity or revision evidence");
    }
  } else {
    if (typeof value.review_id!=="string" || !REVIEW_ID.test(value.review_id)) {
      conflict("Formal review identity is corrupt");
    }
    if (typeof value.reviewed_revision!=="string" || !SHA.test(value.reviewed_revision)) {
      conflict("Formal review revision is corrupt");
    }
  }
}

function validateChecks(value) {
  exact(value,["state","revision"],"Review check evidence");
  if (!new Set(["PENDING","PASSED","FAILED"]).has(value.state)) invalid("Review check state is invalid");
  sha(value.revision,"Review check revision");
  return value;
}

export function reviewObservationRevision(input) {
  const value=closedData(input,"review observation revision input");
  exact(value,[
    "native_revision","checks","implementation_identity",
  ],"review observation revision input");
  text(value.native_revision,"Native pull request revision");
  const checks=validateChecks(value.checks);
  const identity=validateImplementationIdentity(value.implementation_identity);
  return `review-observation:${sha256Canonical({
    native_revision:value.native_revision,checks,implementation_identity:identity,
  })}`;
}

function validatePullRequest(input) {
  const value=closedData(input,"review pull request");
  exact(value,[
    "repository","number","native_revision","revision","head_repository","base_repository","head","base",
    "head_sha","body","formal_review","recorded_result","checks","work",
  ],"review pull request");
  repository(value.repository,"Pull request repository");
  repository(value.head_repository,"Pull request head repository");
  repository(value.base_repository,"Pull request base repository");
  if (!Number.isSafeInteger(value.number) || value.number<1) invalid("Pull request number must be a positive safe integer");
  text(value.native_revision,"Native pull request revision");
  text(value.revision,"Pull request revision");
  sha(value.head_sha,"Pull request head");
  if (typeof value.body!=="string") invalid("Pull request body must be text");
  validateFormalReview(value.formal_review);
  validateChecks(value.checks);
  const state=deriveWorkItemState(value.work);
  const item=value.work.item;
  if (item.repository!==value.repository || value.head_repository!==value.repository ||
      value.base_repository!==value.repository || value.head!==item.branch ||
      value.base!==item.base_branch || value.work.pull_request?.state!=="READY" ||
      value.work.pull_request.head_sha!==value.head_sha ||
      value.work.physical_branch.head_sha!==value.head_sha) {
    conflict("Pull request evidence does not bind the exact governed work head and base");
  }
  assertValidPullRequestTarget({
    headRepository:value.head_repository,baseRepository:value.base_repository,
    head:value.head,base:value.base,expectedBase:item.base_branch,
  });
  if (value.work.checks===null || canonicalJson(value.work.checks)!==canonicalJson(value.checks)) {
    conflict("Pull request checks do not bind the exact Task 3 work snapshot");
  }
  if (value.checks.revision!==value.head_sha) {
    conflict("Pull request checks do not bind the current pull request head");
  }
  const recorded=value.recorded_result===null ? null : normalizeReviewResult(value.recorded_result);
  return Object.freeze({value,state,recorded});
}

export function reviewFollowUpMarker(reviewId,findingId) {
  if (typeof reviewId!=="string" || !REVIEW_ID.test(reviewId) ||
      typeof findingId!=="string" || !FINDING_ID.test(findingId)) {
    invalid("Review follow-up marker requires canonical review and finding identities");
  }
  return `<!-- toss-core:review-follow-up:${sha256Canonical({review_id:reviewId,finding_id:findingId})} -->`;
}

function validateMapping(mapping,project) {
  exact(mapping,[
    "review_id","finding_id","issue_id","repository","project_id","project_item_id",
    "issue_revision","project_revision","marker",
  ],"Review follow-up mapping");
  repository(mapping.repository,"Review follow-up repository");
  let issueIdentity;
  try { issueIdentity=parseWorkItemId(mapping.issue_id); }
  catch (error) { conflict("Review follow-up mapping issue identity is corrupt",{cause:error}); }
  let expectedMarker;
  try { expectedMarker=reviewFollowUpMarker(mapping.review_id,mapping.finding_id); }
  catch (error) { conflict("Review follow-up mapping identities are corrupt",{cause:error}); }
  if (issueIdentity.repository!==mapping.repository || mapping.project_id!==project.project_id ||
      mapping.project_revision!==project.revision || mapping.marker!==expectedMarker) {
    conflict("Review follow-up mapping is unmanaged, wrong-project, or corrupt");
  }
  text(mapping.project_item_id,"Review follow-up Project item identity");
  text(mapping.issue_revision,"Review follow-up issue revision");
  return mapping;
}

function validateReservation(reservation,project,pullRequest,result) {
  exact(reservation,[
    "review_id","finding_id","source_pull_request_repository","source_pull_request_number",
    "source_pull_request_revision","source_pull_request_head","reviewed_repository",
    "project_id","project_item_id","project_revision","issue_number","repository",
    "repository_revision",
  ],"Review follow-up reservation");
  repository(reservation.source_pull_request_repository,"Review follow-up source repository");
  repository(reservation.reviewed_repository,"Review follow-up reviewed repository");
  repository(reservation.repository,"Review follow-up reservation repository");
  if (typeof reservation.review_id!=="string" || !REVIEW_ID.test(reservation.review_id) ||
      typeof reservation.finding_id!=="string" || !FINDING_ID.test(reservation.finding_id) ||
      !Number.isSafeInteger(reservation.source_pull_request_number) ||
      reservation.source_pull_request_number<1 ||
      !Number.isSafeInteger(reservation.issue_number) || reservation.issue_number<1) {
    conflict("Review follow-up reservation identity is corrupt");
  }
  text(reservation.source_pull_request_revision,"Review follow-up source pull request revision");
  sha(reservation.source_pull_request_head,"Review follow-up source pull request head");
  text(reservation.project_id,"Review follow-up Project identity");
  text(reservation.project_item_id,"Review follow-up Project item identity");
  text(reservation.repository_revision,"Review follow-up repository revision");
  text(reservation.project_revision,"Review follow-up Project revision");
  if (reservation.source_pull_request_repository!==pullRequest.repository ||
      reservation.source_pull_request_number!==pullRequest.number ||
      reservation.source_pull_request_revision!==pullRequest.revision ||
      reservation.source_pull_request_head!==pullRequest.head_sha ||
      reservation.reviewed_repository!==pullRequest.repository ||
      reservation.repository!==pullRequest.repository ||
      reservation.project_id!==project.project_id ||
      reservation.project_item_id!==project.item_id ||
      reservation.project_revision!==project.revision) {
    conflict("Review follow-up reservation does not bind the exact review source and Project snapshot");
  }
  if (result!==null) {
    const finding=result.findings.find(candidate =>
      candidate.finding_id===reservation.finding_id && !candidate.resolved &&
      candidate.severity==="Minor");
    if (reservation.review_id!==result.review_id ||
        reservation.reviewed_repository!==result.repository || !finding) {
      conflict("Review follow-up reservation belongs to a different review or finding");
    }
  }
  return reservation;
}

function validateProject(input,pullRequest,result=null) {
  const value=closedData(input,"review Project evidence");
  exact(value,[
    "project_id","item_id","revision","follow_up_mappings","reservations",
  ],"review Project evidence");
  text(value.project_id,"Review Project identity");
  text(value.item_id,"Review Project item identity");
  text(value.revision,"Review Project revision");
  if (value.project_id!==pullRequest.work.project.project_id ||
      value.item_id!==pullRequest.work.project.item_id ||
      value.revision!==pullRequest.work.project.revision) {
    conflict("Review Project evidence does not bind the exact Task 3 Project item revision");
  }
  if (!Array.isArray(value.follow_up_mappings) || !Array.isArray(value.reservations)) {
    invalid("Review Project follow-up evidence must be arrays");
  }
  const mappings=value.follow_up_mappings.map(mapping => validateMapping(mapping,value));
  const reservations=value.reservations.map(reservation =>
    validateReservation(reservation,value,pullRequest,result));
  const mappingKeys=new Set();
  const mappingIssues=new Set();
  for (const mapping of mappings) {
    const key=`${mapping.review_id}\u0000${mapping.finding_id}`;
    if (mappingKeys.has(key) || mappingIssues.has(mapping.issue_id)) {
      conflict("Review follow-up mappings are duplicated or ambiguous");
    }
    mappingKeys.add(key);
    mappingIssues.add(mapping.issue_id);
  }
  const reservationKeys=new Set();
  const reservationIssues=new Set();
  for (const reservation of reservations) {
    const issueId=workItemId(reservation.repository,reservation.issue_number);
    const reservationKey=`${reservation.review_id}\u0000${reservation.finding_id}`;
    if (reservationKeys.has(reservationKey) || reservationIssues.has(issueId)) {
      conflict("Review follow-up reservations are duplicated or ambiguous");
    }
    reservationKeys.add(reservationKey);
    reservationIssues.add(issueId);
    if (mappingIssues.has(issueId)) {
      conflict("Review follow-up reservation conflicts with an existing governed issue mapping");
    }
  }
  return Object.freeze({
    value,
    mappings:Object.freeze(mappings),
    reservations:Object.freeze(reservations),
  });
}

function validateRecordedSurfaces(pullRequest,recorded) {
  const parsed=parseManagedReviewBlock(pullRequest.body);
  if (recorded===null) {
    if (parsed!==null || pullRequest.formal_review.state!=="NONE" || pullRequest.work.review!==null) {
      conflict("Review body, formal state, and work evidence disagree about the recorded result");
    }
    return parsed;
  }
  if (recorded.repository!==pullRequest.repository ||
      recorded.pull_request_number!==pullRequest.number) {
    conflict("The stored review result does not identify this pull request");
  }
  if (parsed===null || parsed.block!==renderManagedReviewBlock(recorded)) {
    conflict("The managed PR review body conflicts with the recorded review result");
  }
  const expectedFormal=formalState(recorded);
  if (pullRequest.formal_review.state!==expectedFormal ||
      pullRequest.formal_review.review_id!==recorded.review_id ||
      pullRequest.formal_review.reviewed_revision!==recorded.reviewed_revision) {
    conflict("The formal GitHub review conflicts with the recorded review result");
  }
  const expectedWork=recorded.freshness==="STALE" ? null : Object.freeze({
    verdict:recorded.verdict,reviewed_revision:recorded.reviewed_revision,
  });
  if (canonicalJson(pullRequest.work.review)!==canonicalJson(expectedWork)) {
    conflict("Task 3 work review evidence conflicts with the recorded result");
  }
  return parsed;
}

function projectOperation(projected,state,result,identity,pullRequest) {
  const observedAt=projected.project.fields.last_reconciled_at;
  const reconciledAt=Date.parse(result.recorded_at)>=Date.parse(observedAt)
    ? result.recorded_at
    : observedAt;
  const base=projectReconciliationOperations(
    projected,state,reconciledAt,
  );
  return base.map(operation => Object.freeze({
    ...operation,
    payload:Object.freeze({
      kind:"review-work-state",
      ...operation.payload,
      review_context:reviewContext(result,identity,pullRequest),
    }),
  }));
}

function followUpWork(pullRequest,reservation,finding) {
  const current=pullRequest.work.item;
  const child=current.kind!=="bug";
  const parentId=current.kind==="epic" ? current.id : current.parent_id;
  const baseBranch=current.kind==="epic" ? current.branch : current.base_branch;
  const kind=child ? "issue" : "bug";
  const id=workItemId(reservation.repository,reservation.issue_number);
  const workItem=Object.freeze({
    schema_version:"work-item.v1",id,repository:reservation.repository,
    issue_number:reservation.issue_number,kind,parent_id:child ? parentId : null,
    ...(child ? {acceptance_criteria:Object.freeze([finding.summary])} : {}),
    branch:reserveBranch({kind,number:reservation.issue_number,title:finding.summary}),
    base_branch:child ? baseBranch : null,milestone:null,status:"Backlog",gate:"RELEASE_PLANNING",
  });
  validateCoreDocument(workItem,"work-item.v1");
  return workItem;
}

function buildFollowUps(resultInput,projectEvidence,pullRequest,identity) {
  const minorFindings=resultInput.findings
    .filter(finding => !finding.resolved && finding.severity==="Minor")
    .sort((left,right) => compare(left.finding_id,right.finding_id));
  const minorIds=new Set(minorFindings.map(finding => finding.finding_id));
  const currentMappings=projectEvidence.mappings.filter(mapping => mapping.review_id===resultInput.review_id);
  for (const mapping of currentMappings) {
    if (!minorIds.has(mapping.finding_id) || mapping.repository!==resultInput.repository) {
      conflict("Review follow-up mapping names the wrong review finding or repository");
    }
  }
  const mappingByFinding=new Map(currentMappings.map(mapping => [mapping.finding_id,mapping]));
  const mappingByIssue=new Map(currentMappings.map(mapping => [mapping.issue_id,mapping]));
  for (const issueId of resultInput.follow_up_issues) {
    const mapping=mappingByIssue.get(issueId);
    if (!mapping) conflict(`Review follow-up ${issueId} is not governed by an exact Project mapping`);
  }

  const reservations=new Map(projectEvidence.reservations.map(value => [value.finding_id,value]));
  for (const findingId of mappingByFinding.keys()) {
    if (reservations.has(findingId)) {
      conflict("Review follow-up evidence contains both a mapping and reservation for one finding");
    }
  }
  const planned=[];
  const issueIds=[];
  for (const finding of minorFindings) {
    const existing=mappingByFinding.get(finding.finding_id);
    if (existing) {
      issueIds.push(existing.issue_id);
      continue;
    }
    const reservation=reservations.get(finding.finding_id);
    if (!reservation) {
      throw new CoreBlockedError(`Unresolved Minor ${finding.finding_id} requires a revision-pinned follow-up issue reservation`);
    }
    if (reservation.repository!==resultInput.repository) {
      conflict("Review follow-up reservation belongs to a different repository");
    }
    const issueId=workItemId(reservation.repository,reservation.issue_number);
    const marker=reviewFollowUpMarker(resultInput.review_id,finding.finding_id);
    const workItem=followUpWork(pullRequest,reservation,finding);
    planned.push(Object.freeze({finding,reservation,issueId,marker,workItem}));
    issueIds.push(issueId);
  }
  const finalResult=normalizeReviewResult({...resultInput,follow_up_issues:issueIds.sort(compare)});
  const context=reviewContext(finalResult,identity,pullRequest);
  const operations=[];
  for (const plan of planned) {
    operations.push(Object.freeze({
      resource:"issue",action:"create",repository:plan.reservation.repository,
      expected_revision:plan.reservation.repository_revision,
      payload:Object.freeze({
        kind:"review-minor-follow-up",issue_id:plan.issueId,review_id:finalResult.review_id,
        finding_id:plan.finding.finding_id,marker:plan.marker,
        title:`Follow up: ${plan.finding.summary}`,
        summary:plan.finding.summary,reserved_branch:plan.workItem.branch,
        work_item:plan.workItem,
        source_pull_request:`${pullRequest.repository}#${pullRequest.number}`,
        source_revision:pullRequest.head_sha,review_context:context,
      }),
    }));
    operations.push(Object.freeze({
      resource:"project",action:"create",repository:plan.reservation.repository,
      expected_revision:plan.reservation.project_revision,
      payload:Object.freeze({
        kind:"review-follow-up-membership",project_id:projectEvidence.value.project_id,
        issue_id:plan.issueId,review_id:finalResult.review_id,
        finding_id:plan.finding.finding_id,
        marker:plan.marker,reserved_branch:plan.workItem.branch,
        fields:Object.freeze({
          Status:"Backlog",Gate:"RELEASE_PLANNING",repository:plan.reservation.repository,
          parent:plan.workItem.parent_id,milestone:null,branch:plan.workItem.branch,
          base_branch:plan.workItem.base_branch,last_reconciled_at:finalResult.recorded_at,
        }),
        review_context:context,
      }),
    }));
  }
  return Object.freeze({result:finalResult,operations:Object.freeze(operations)});
}

function validateRecordingInput(input,{requireResult}) {
  const value=closedData(input,requireResult ? "record review input" : "review status input");
  const keys=requireResult
    ? ["pullRequest","result","implementationIdentity","project"]
    : ["pullRequest","implementationIdentity","project"];
  exact(value,keys,requireResult ? "record review input" : "review status input");
  const result=requireResult ? normalizeReviewResult(value.result) : null;
  const pull=validatePullRequest(value.pullRequest);
  const identity=validateImplementationIdentity(value.implementationIdentity);
  if (identity.revision!==pull.value.head_sha) {
    conflict("Implementation identity evidence is not bound to the current pull request head");
  }
  if (pull.value.revision!==reviewObservationRevision({
    native_revision:pull.value.native_revision,
    checks:pull.value.checks,
    implementation_identity:identity,
  })) {
    conflict("Pull request observation revision does not bind checks and implementation identity evidence");
  }
  const projectEvidence=validateProject(value.project,pull.value,result);
  validateRecordedSurfaces(pull.value,pull.recorded);
  return Object.freeze({value,pull,identity,projectEvidence,result});
}

export function recordReview(input) {
  const normalized=validateRecordingInput(input,{requireResult:true});
  const incoming=normalized.result;
  const pullRequest=normalized.pull.value;
  if (incoming.repository!==pullRequest.repository || incoming.pull_request_number!==pullRequest.number) {
    conflict("Review result does not identify the exact pull request");
  }
  if (reviewFreshness(incoming,pullRequest.head_sha)!=="CURRENT" || incoming.freshness!=="CURRENT") {
    conflict("A review can be recorded only for the exact current pull request head");
  }
  assertIndependentReviewer(incoming.reviewer.identity,normalized.identity);
  const followUps=buildFollowUps(
    incoming,normalized.projectEvidence,pullRequest,normalized.identity,
  );
  const finalResult=followUps.result;
  const context=reviewContext(finalResult,normalized.identity,pullRequest);
  const body=updateManagedReviewBlock(pullRequest.body,finalResult);
  const targetFormal=Object.freeze({
    state:formalState(finalResult),review_id:finalResult.review_id,
    reviewed_revision:finalResult.reviewed_revision,
  });
  const projected=closedData({
    ...pullRequest.work,
    review:{verdict:finalResult.verdict,reviewed_revision:finalResult.reviewed_revision},
    checks:pullRequest.checks,
  },"post-review work snapshot");
  const state=deriveWorkItemState(projected);
  const operations=[...followUps.operations];
  operations.push(...projectOperation(projected,state,finalResult,normalized.identity,pullRequest));
  const sameBody=body===pullRequest.body;
  const sameFormal=canonicalJson(targetFormal)===canonicalJson(pullRequest.formal_review);
  const sameResult=normalized.pull.recorded!==null &&
    canonicalJson(normalized.pull.recorded)===canonicalJson(finalResult);
  if (!sameBody || !sameFormal || !sameResult) {
    operations.push(Object.freeze({
      resource:"pull_request",action:"update",repository:pullRequest.repository,
      expected_revision:pullRequest.revision,
      payload:Object.freeze({
        kind:"review-record",pull_request_number:pullRequest.number,
        head_sha:pullRequest.head_sha,body,
        formal_review:Object.freeze({
          action:formalAction(finalResult),review_id:finalResult.review_id,
          reviewed_revision:finalResult.reviewed_revision,
        }),
        review_result:finalResult,
        implementation_identity:normalized.identity,
        checks:pullRequest.checks,
      }),
    }));
  }
  return Object.freeze(operations.sort(compareOperations));
}

export function reviewStatus(input) {
  const normalized=validateRecordingInput(input,{requireResult:false});
  const pullRequest=normalized.pull.value;
  const result=normalized.pull.recorded;
  const freshness=result===null ? null : reviewFreshness(result,pullRequest.head_sha);
  if (result!==null && freshness==="CURRENT") {
    assertIndependentReviewer(result.reviewer.identity,normalized.identity);
  }
  const state=deriveWorkItemState(pullRequest.work);
  const reconciliation=projectReconciliationOperations(
    pullRequest.work,state,pullRequest.work.project.fields.last_reconciled_at,
  ).length===0 ? "CURRENT" : "RECONCILE_REQUIRED";
  const parsed=parseManagedReviewBlock(pullRequest.body);
  const mergeEligible=result!==null && freshness==="CURRENT" && result.verdict==="APPROVED" &&
    pullRequest.checks.state==="PASSED" && pullRequest.checks.revision===pullRequest.head_sha &&
    state.gate==="NONE";
  return closedData({
    pull_request:`${pullRequest.repository}#${pullRequest.number}`,
    reviewed_revision:result?.reviewed_revision ?? null,
    current_head:pullRequest.head_sha,
    freshness,
    verdict:result?.verdict ?? null,
    findings:result?.findings ?? [],
    unresolved:result?.unresolved ?? [],
    follow_up_issues:result?.follow_up_issues ?? [],
    body_projection:parsed?.block ?? null,
    formal_review:pullRequest.formal_review,
    checks:pullRequest.checks,
    merge_eligible:mergeEligible,
    state,
    project_state:Object.freeze({
      Status:pullRequest.work.project.fields.Status,
      Gate:pullRequest.work.project.fields.Gate,
    }),
    reconciliation,
    next_command:reconciliation==="RECONCILE_REQUIRED" ? "toss-core sync" :
      state.next_command ?? "toss-core review status",
  },"review status result");
}

export {REVIEW_MARKERS};
