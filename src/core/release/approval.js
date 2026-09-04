import {canonicalJson} from "../../contracts/acp.js";
import {compareCanonicalText} from "../canonical-order.js";
import {normalizeReviewResult,validateImplementationIdentity,
  assertIndependentReviewer} from "../domain/review.js";
import {CoreValidationError} from "../errors.js";

function invalid(message) {
  throw new CoreValidationError(message);
}

function orderedUnique(values,identity,label) {
  const seen=new Set();
  let previous=null;
  for (const value of values) {
    const current=identity(value);
    if (typeof current!=="string" || !/\S/u.test(current) || seen.has(current) ||
        (previous!==null && compareCanonicalText(previous,current)>=0)) {
      invalid(`${label} must use canonical unique identity order`);
    }
    seen.add(current);
    previous=current;
  }
}

export function assertReleaseApprovalSemantics(release) {
  const approval=release?.approval;
  if (!approval || !["PUBLISHING","RELEASED"].includes(release.phase)) {
    invalid("Release approval semantics require a Publishing or Released track");
  }
  const result=normalizeReviewResult(approval.review.result);
  const implementation=validateImplementationIdentity(
    approval.review.implementation_identity,
  );
  if (canonicalJson(result)!==canonicalJson(approval.review.result) ||
      canonicalJson(implementation)!==canonicalJson(approval.review.implementation_identity)) {
    invalid("Release approval review and implementation evidence must be canonical");
  }
  assertIndependentReviewer(result.reviewer.identity,implementation);
  const formal=approval.review.formal_review;
  const approvalTransitions=release.transitions.filter(value => value.event==="APPROVE");
  const approvalTransition=approvalTransitions[0] ?? null;
  if (approval.program_id!==release.program_id || approval.release_id!==release.release_id ||
      approval.pull_request.head!==release.release_pr_intent.head ||
      approval.pull_request.base!==release.release_pr_intent.base ||
      approval.pull_request.head_sha!==approval.merge_result_revision ||
      result.repository!==release.repository ||
      result.pull_request_number!==approval.pull_request.number ||
      result.reviewed_revision!==approval.pull_request.head_sha ||
      result.verdict!=="APPROVED" || result.freshness!=="CURRENT" ||
      formal.state!=="APPROVED" || formal.review_id!==result.review_id ||
      formal.reviewed_revision!==approval.pull_request.head_sha ||
      implementation.revision!==approval.pull_request.head_sha ||
      implementation.base_revision!==approval.pull_request.base_sha ||
      approvalTransitions.length!==1 ||
      approvalTransition.source_receipt!==approval.source_receipt ||
      approvalTransition.timestamp!==approval.approved_at ||
      approvalTransition.source_phase!=="READY_FOR_APPROVAL" ||
      approvalTransition.target_phase!=="PUBLISHING") {
    invalid("Release approval review must bind the exact repository, PR, head, and base");
  }

  orderedUnique(approval.scope,value => value.id,"Release approval scope");
  if (approval.scope.some(value => value.status!=="Done") ||
      canonicalJson(approval.scope.map(value => value.id))!==canonicalJson(release.scope)) {
    invalid("Release approval scope must exactly cover every Done release item");
  }
  orderedUnique(approval.required_checks,value => value,"Release approval required checks");
  orderedUnique(approval.checks,value => value.name,"Release approval checks");
  if (canonicalJson(approval.checks.map(value => value.name))!==
        canonicalJson(approval.required_checks) ||
      approval.checks.some(value => value.conclusion!=="SUCCESS" ||
        value.head_sha!==approval.pull_request.head_sha)) {
    invalid("Release approval checks must exactly pass at the approved head");
  }
  const publication=approval.publication;
  orderedUnique(publication.required_assets,value => value,
    "Release approval required publication assets");
  if (publication.package_name.trim()!==publication.package_name ||
      publication.workflow.trim()!==publication.workflow ||
      publication.required_assets.some(value => value.trim()!==value) ||
      typeof approval.rules_revision!=="string" || !/\S/u.test(approval.rules_revision) ||
      typeof approval.policy_revision!=="string" || !/\S/u.test(approval.policy_revision)) {
    invalid("Release approval policy, rules, workflow, and publication identities are malformed");
  }
  return true;
}
