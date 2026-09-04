import {canonicalJson} from "../../contracts/acp.js";
import {closedData} from "../commands/common.js";
import {validateCoreDocument} from "../contracts.js";
import {CoreValidationError} from "../errors.js";
import {assertReleaseApprovalSemantics} from "../release/approval.js";
import {projectPatchCompletionTransaction} from "../release/patch-completion-projector.js";
import {projectPublicationTransaction} from "../release/publication-projector.js";

function fail(message) {
  throw new CoreValidationError(message);
}

function assertApprovalIntentSemantics(intent) {
  if (!intent.operations.some(operation =>
    operation.payload?.kind==="release-approval-precondition")) return;
  const manifest=intent.operations.find(operation =>
    operation.payload.kind==="release-program-manifest");
  const binding=manifest?.payload.authority_binding;
  const release=manifest?.payload.program.repository_releases.find(value =>
    value.program_id===binding?.program_id && value.release_id===binding?.release_id);
  if (!release) fail("Release approval intent does not contain its selected release");
  assertReleaseApprovalSemantics(release);
}

function assertPatchCompletionIntentSemantics(intent,aggregates,localOperations) {
  if (intent.command!=="release.approve" || intent.authority!==null ||
      typeof intent.planned_receipt_id!=="string" || aggregates.length!==1 ||
      localOperations.length!==1 || localOperations[0].payload.kind!=="release-program-manifest" ||
      aggregates[0].payload.descriptor===undefined) {
    fail("Patch completion must be one exact authority-null release approval transaction");
  }
  let projected;
  try {
    projected=projectPatchCompletionTransaction(aggregates[0].payload.query,
      aggregates[0].payload.descriptor);
  } catch (error) {
    fail(`Patch completion intent cannot derive its immutable result: ${error.message}`);
  }
  const actual=intent.operations.map(({operation_id:_operationId,...operation}) => operation);
  if (intent.planned_receipt_id!==aggregates[0].payload.descriptor.receipt_id ||
      canonicalJson(intent.source)!==canonicalJson(projected.source) ||
      canonicalJson(actual)!==canonicalJson(projected.operations)) {
    fail("Patch completion intent does not equal its derived immutable transaction");
  }
}

function assertPublicationIntentSemantics(intent) {
  const matching=intent.operations.filter(operation =>
    operation.payload?.kind==="release-publication-precondition");
  const patchMatching=intent.operations.filter(operation =>
    operation.payload?.kind==="release-patch-completion-precondition");
  const localOperations=intent.operations.filter(operation =>
    ["release-program-manifest","release-program-manifest-set"].includes(
      operation.payload?.kind));
  const publicationLocal=intent.operations.some(operation => {
    const programs=operation.payload?.kind==="release-program-manifest"
      ? [operation.payload.program] : operation.payload?.kind==="release-program-manifest-set"
        ? operation.payload.entries.map(entry => entry.program) : [];
    return programs.some(program => program.repository_releases.some(release => {
      const transition=release.transitions.at(-1);
      return transition?.event==="VERIFY_PUBLICATION" &&
        transition.source_receipt===intent.planned_receipt_id;
    }));
  });
  const authorityNullReleaseLocal=intent.command==="release.approve" &&
    intent.authority===null && localOperations.length>0;
  if (matching.length===0 && !publicationLocal) {
    if (authorityNullReleaseLocal) {
      assertPatchCompletionIntentSemantics(intent,patchMatching,localOperations);
    }
    return;
  }
  if (patchMatching.length!==0) {
    fail("Release approval intent cannot mix publication and patch completion transactions");
  }
  if (matching.length!==1 || intent.command!=="release.approve" || intent.authority!==null ||
      intent.operations.length!==2 || typeof intent.planned_receipt_id!=="string") {
    fail("Release publication intent must be one exact authority-null two-operation transaction");
  }
  let projected;
  try {
    projected=projectPublicationTransaction(matching[0].payload.query,
      matching[0].payload.descriptor);
  } catch (error) {
    fail(`Release publication intent cannot derive its immutable result: ${error.message}`);
  }
  const actual=intent.operations.map(({operation_id:_operationId,...operation}) => operation);
  if (intent.planned_receipt_id!==matching[0].payload.descriptor.receipt_id ||
      canonicalJson(intent.source)!==canonicalJson(projected.source) ||
      canonicalJson(actual)!==canonicalJson(projected.operations)) {
    fail("Release publication intent does not equal its derived immutable transaction");
  }
}

function isPersistedLegacyPatchCompletion(intent) {
  const patch=intent.operations.filter(operation =>
    operation.payload?.kind==="release-patch-completion-precondition");
  const publication=intent.operations.filter(operation =>
    operation.payload?.kind==="release-publication-precondition");
  const local=intent.operations.filter(operation =>
    ["release-program-manifest","release-program-manifest-set"].includes(
      operation.payload?.kind));
  return intent.command==="release.approve" && intent.authority===null &&
    patch.length===1 && patch[0].payload.descriptor===undefined &&
    publication.length===0 && local.length===1 &&
    local[0].payload.kind==="release-program-manifest";
}

export function validatePersistedOperationIntent(input) {
  const valid=validateCoreDocument(
    closedData(input,"Persisted operation intent"),"operation-intent.v1",
  );
  assertApprovalIntentSemantics(valid);
  if (!isPersistedLegacyPatchCompletion(valid)) assertPublicationIntentSemantics(valid);
  return valid;
}

export function validateOperationIntent(input) {
  const valid=validateCoreDocument(
    closedData(input,"Operation intent"),"operation-intent.v1",
  );
  assertApprovalIntentSemantics(valid);
  assertPublicationIntentSemantics(valid);
  return valid;
}
