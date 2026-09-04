import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {closedData} from "../commands/common.js";
import {validateCoreDocument} from "../contracts.js";
import {CoreConflictError,CoreValidationError} from "../errors.js";
import {assertReleaseApprovalSemantics} from "./approval.js";

export function assertReleaseReceiptCoverage(receipt,intent) {
  if (receipt.intent_id!==intent.intent_id || receipt.intent_sha256!==sha256Canonical(intent)) {
    throw new CoreConflictError("Release reconciliation receipt does not bind its immutable intent");
  }
  if (intent.planned_receipt_id!==undefined &&
      receipt.receipt_id!==intent.planned_receipt_id) {
    throw new CoreConflictError("Release reconciliation receipt does not own its planned identity");
  }
  const operations=new Map(intent.operations.map(operation => [operation.operation_id,operation]));
  const observed=new Set();
  for (const observation of receipt.observed_revisions) {
    const operation=operations.get(observation.operation_id);
    if (!operation || operation.repository!==observation.repository ||
        observed.has(observation.operation_id)) {
      throw new CoreConflictError(
        "Release reconciliation receipt contains incompatible operation evidence",
      );
    }
    observed.add(observation.operation_id);
  }
  if (receipt.status==="completed" && observed.size!==operations.size) {
    throw new CoreConflictError("Release reconciliation receipt omits completed operation evidence");
  }
}

export function previousReleaseRevision(value) {
  const match=/^REV-([0-9]{4,})$/u.exec(value);
  if (!match) throw new CoreConflictError("Released publication revision is not canonical");
  const number=Number(match[1]);
  if (!Number.isSafeInteger(number) || number<=1) {
    throw new CoreConflictError("Released publication revision has no canonical predecessor");
  }
  const prior=String(number-1);
  return `REV-${prior.padStart(match[1].length,"0")}`;
}

export function releaseApprovalLedgerEvidence(stateInput,releaseInput) {
  const state=closedData(stateInput,"Release approval ledger state");
  const release=validateCoreDocument(
    closedData(releaseInput,"Release approval ledger release"),"repository-release.v1",
  );
  if (!state?.organization || !Array.isArray(state.intents) || !Array.isArray(state.receipts)) {
    throw new CoreValidationError("Release approval ledger state is malformed");
  }
  const intents=state.intents.map(value => validateCoreDocument(value,"operation-intent.v1"));
  const receipts=state.receipts.map(value => validateCoreDocument(value,"operation-receipt.v1"));
  assertReleaseApprovalSemantics(release);
  const approval=release.approval;
  const matchingReceipts=receipts.filter(value => value.receipt_id===approval.source_receipt);
  if (matchingReceipts.length!==1 || matchingReceipts[0].status!=="completed") {
    throw new CoreConflictError("Publishing release approval receipt is absent, failed, or ambiguous");
  }
  const receipt=matchingReceipts[0];
  const matchingIntents=intents.filter(value => value.intent_id===receipt.intent_id);
  if (matchingIntents.length!==1) {
    throw new CoreConflictError("Publishing release approval intent is absent or ambiguous");
  }
  const intent=matchingIntents[0];
  assertReleaseReceiptCoverage(receipt,intent);
  const kinds=["release-approval-precondition","release-approval-base-precondition",
    "release-pull-request-merge","release-publication-workflow","release-program-manifest"];
  const byKind=new Map(kinds.map(kind => [kind,intent.operations.filter(operation =>
    operation.payload?.kind===kind)]));
  const aggregate=byKind.get(kinds[0])?.[0] ?? null;
  const base=byKind.get(kinds[1])?.[0] ?? null;
  const merge=byKind.get(kinds[2])?.[0] ?? null;
  const workflow=byKind.get(kinds[3])?.[0] ?? null;
  const manifest=byKind.get(kinds[4])?.[0] ?? null;
  const sourceProgram=aggregate?.payload.query?.program ?? null;
  const sourceRelease=sourceProgram?.repository_releases?.find(candidate =>
    candidate.release_id===release.release_id) ?? null;
  const recordedRelease=manifest?.payload.program?.repository_releases?.find(candidate =>
    candidate.release_id===release.release_id) ?? null;
  const binding=aggregate?.payload.authority_binding ?? null;
  const transition=recordedRelease?.transitions?.at(-1) ?? null;
  const observations=new Map(receipt.observed_revisions.map(value => [value.operation_id,value]));
  if (intent.command!=="release.approve" || intent.planned_receipt_id!==receipt.receipt_id ||
      canonicalJson(intent.authority)!==canonicalJson(approval.authority) ||
      intent.operations.length!==kinds.length || [...byKind.values()].some(values => values.length!==1) ||
      sourceProgram===null || sourceRelease===null ||
      sourceProgram.program_id!==release.program_id || sourceRelease.release_id!==release.release_id ||
      sourceRelease.phase!=="READY_FOR_APPROVAL" || sourceRelease.approval!==null ||
      sourceProgram.revision!==approval.manifest_revision ||
      sha256Canonical(sourceProgram)!==approval.manifest_sha256 ||
      aggregate.repository!==null || aggregate.resource!=="project" || aggregate.action!=="verify" ||
      aggregate.payload.query.control_revision!==intent.source.revision ||
      aggregate.payload.query.organization?.control_repository!==intent.source.repository ||
      canonicalJson(aggregate.payload.query.release)!==canonicalJson(sourceRelease) ||
      recordedRelease===null || binding===null || recordedRelease.phase!=="PUBLISHING" ||
      canonicalJson(recordedRelease.approval)!==canonicalJson(approval) ||
      canonicalJson(binding.pull_request)!==canonicalJson(approval.pull_request) ||
      canonicalJson(binding.review)!==canonicalJson(approval.review) ||
      canonicalJson(binding.scope)!==canonicalJson(approval.scope) ||
      canonicalJson(binding.checks)!==canonicalJson(approval.checks) ||
      canonicalJson(binding.publication)!==canonicalJson(approval.publication) ||
      binding.program_id!==release.program_id || binding.release_id!==release.release_id ||
      binding.manifest_revision!==approval.manifest_revision ||
      binding.manifest_sha256!==approval.manifest_sha256 ||
      binding.rules_revision!==approval.rules_revision || binding.policy_revision!==approval.policy_revision ||
      binding.version!==release.version ||
      base.resource!=="branch" || base.action!=="verify" || base.repository!==release.repository ||
      base.payload.name!==approval.pull_request.base || base.payload.head_sha!==approval.pull_request.base_sha ||
      base.expected_revision!==approval.pull_request.base_revision ||
      merge.resource!=="pull_request" || merge.action!=="merge" || merge.repository!==release.repository ||
      merge.payload.number!==approval.pull_request.number ||
      merge.payload.head_branch!==approval.pull_request.head ||
      merge.payload.head_sha!==approval.pull_request.head_sha ||
      merge.payload.base_branch!==approval.pull_request.base ||
      merge.payload.base_sha!==approval.pull_request.base_sha ||
      merge.payload.base_revision!==approval.pull_request.base_revision ||
      merge.payload.merge_mode!=="FAST_FORWARD_ONLY" ||
      merge.payload.merge_result_revision!==approval.merge_result_revision ||
      workflow.resource!=="workflow" || workflow.action!=="create" ||
      workflow.repository!==release.repository ||
      workflow.payload.workflow!==approval.publication.workflow ||
      workflow.payload.version!==release.version || workflow.payload.tag!==`v${release.version}` ||
      workflow.payload.expected_revision!==approval.merge_result_revision ||
      manifest.resource!=="repository" || manifest.action!=="commit" ||
      manifest.repository!==state.organization.control_repository ||
      manifest.expected_revision!==approval.manifest_revision ||
      manifest.payload.expected_program_revision!==approval.manifest_revision ||
      transition?.event!=="APPROVE" || transition.source_receipt!==receipt.receipt_id ||
      transition.timestamp!==approval.approved_at ||
      observations.get(aggregate.operation_id)?.revision!==aggregate.expected_revision ||
      observations.get(base.operation_id)?.revision!==approval.pull_request.base_revision ||
      observations.get(merge.operation_id)?.revision!==approval.merge_result_revision ||
      observations.get(workflow.operation_id)?.revision!==approval.merge_result_revision ||
      observations.get(manifest.operation_id)?.revision!==manifest.payload.program.revision) {
    throw new CoreConflictError(
      "Publishing release approval evidence does not bind its immutable transaction",
    );
  }
  return closedData({intent,receipt},"Release approval ledger evidence");
}
