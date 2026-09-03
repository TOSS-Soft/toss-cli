import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {compareCanonicalText,compareCanonicalValue} from "../canonical-order.js";
import {validateCoreDocument} from "../contracts.js";
import {authorityReference,verifyAuthority} from "../authority.js";
import {validateParsedCoreCommand} from "../commands/router.js";
import {CoreBlockedError,CoreConflictError,CoreInternalError,CoreRemoteError,CoreValidationError} from "../errors.js";
import {validateOperationIntent} from "./intent-contract.js";
import {createOperationIntent,operationPreview} from "./plan.js";

function ownFunction(value,key,label) {
  if (!value || typeof value!=="object" || types.isProxy(value)) throw new CoreValidationError(`${label} must be a non-proxy object`);
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value!=="function" || types.isProxy(descriptor.value)) throw new CoreValidationError(`${label}.${key} must be an own-data non-proxy function`);
  return descriptor.value;
}

function optionalOwnFunction(value,key,label) {
  if (!value || typeof value!=="object" || types.isProxy(value)) throw new CoreValidationError(`${label} must be a non-proxy object`);
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if (!descriptor) return null;
  if (!("value" in descriptor) || typeof descriptor.value!=="function" || types.isProxy(descriptor.value)) throw new CoreValidationError(`${label}.${key} must be an own-data non-proxy function when provided`);
  return descriptor.value;
}

function clone(value,path="$",ancestors=new Set()) {
  if (value===null || ["string","number","boolean"].includes(typeof value)) return value;
  if (typeof value!=="object" || types.isProxy(value) || ancestors.has(value)) throw new CoreValidationError(`Remote ${path} must be a closed non-proxy JSON value`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value)!==Array.prototype || Object.getOwnPropertySymbols(value).length!==0 || Object.getOwnPropertyNames(value).length!==value.length+1) throw new CoreValidationError(`Remote ${path} must be a dense array`);
      return Object.freeze(value.map((_,index) => {
        const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new CoreValidationError(`Remote ${path} contains an accessor`);
        return clone(descriptor.value,`${path}[${index}]`,ancestors);
      }));
    }
    if (![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length!==0) throw new CoreValidationError(`Remote ${path} must be a plain object`);
    const out=Object.create(null);
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new CoreValidationError(`Remote ${path}.${key} contains an accessor or hidden field`);
      out[key]=clone(descriptor.value,`${path}.${key}`,ancestors);
    }
    return Object.freeze(out);
  } finally { ancestors.delete(value); }
}

function exact(value,keys,label) {
  if (!value || typeof value!=="object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort())!==canonicalJson([...keys].sort())) throw new CoreValidationError(`${label} must use an exact closed shape`);
}

function observed(value) {
  const result=clone(value,"observed revisions");
  if (!Array.isArray(result)) throw new CoreValidationError("GitHub observed revisions must be an array");
  for (const item of result) {
    exact(item,["operation_id","repository","revision"],"GitHub observed revision");
    if (typeof item.operation_id!=="string" || !(item.repository===null || typeof item.repository==="string") || !(item.revision===null || typeof item.revision==="string")) throw new CoreValidationError("GitHub observed revision is malformed");
  }
  return result;
}

function expectedAuthorityBinding(intent,now,implementationActor) {
  const revisions=new Map();
  let authorityBinding=null;
  let releaseApprovalRepository=null;
  const addRevision=(target,repository,revision) => {
    if (typeof target!=="string" || !target ||
        !(repository===null || typeof repository==="string") ||
        !(revision===null || typeof revision==="string")) {
      throw new CoreBlockedError("Authority cannot bind malformed release approval evidence");
    }
    const binding=Object.freeze({target,repository,revision});
    if (revisions.has(target) && canonicalJson(revisions.get(target))!==canonicalJson(binding)) {
      throw new CoreBlockedError("Authority cannot bind conflicting expected revisions for one target");
    }
    revisions.set(target,binding);
  };
  for (const operation of intent.operations) {
    if (operation.payload && Object.hasOwn(operation.payload,"authority_binding")) {
      const candidate=operation.payload.authority_binding;
      if (authorityBinding!==null && canonicalJson(authorityBinding)!==canonicalJson(candidate)) {
        throw new CoreBlockedError("Authority cannot bind unequal authority binding values");
      }
      authorityBinding=candidate;
    }
    const releaseApprovalKind=["release-approval-precondition","release-approval-base-precondition",
      "release-pull-request-merge",
      "release-publication-workflow"].includes(operation.payload?.kind) ||
      (operation.payload?.kind==="release-program-manifest" &&
       operation.payload?.authority_binding?.publication!==undefined);
    if (releaseApprovalKind && operation.repository!==null &&
        operation.repository!==intent.source.repository) {
      if (releaseApprovalRepository!==null && releaseApprovalRepository!==operation.repository) {
        throw new CoreBlockedError("Authority cannot bind release approval across repositories");
      }
      releaseApprovalRepository=operation.repository;
    }
    // A Project change is always authorized against the Project node, not the
    // incidental repository that carries the mutation. Release approval adds
    // resource-granular targets so independent PR/workflow/control revisions
    // cannot collapse into one repository revision.
    const target=releaseApprovalKind
      ? operation.payload.kind==="release-approval-precondition"
        ? operation.payload.project_id
        : operation.payload.kind==="release-approval-base-precondition"
          ? `${operation.repository}#base:${operation.payload.name}`
        : operation.payload.kind==="release-pull-request-merge"
          ? `${operation.repository}#pull-request:${operation.payload.number}`
          : operation.payload.kind==="release-publication-workflow"
            ? `${operation.repository}#workflow:${operation.payload.workflow}`
            : `program:${operation.payload.program.program_id}`
      : operation.resource==="project"
        ? (operation.payload?.project?.node_id ?? operation.payload?.project_id)
        : operation.repository;
    if (typeof target!=="string" || !target) throw new CoreBlockedError("Authority cannot bind an operation without an explicit target identity");
    if (releaseApprovalKind) {
      addRevision(target,operation.resource==="project" ? null : operation.repository,
        operation.expected_revision);
    } else {
      const binding=Object.freeze({repository:operation.resource==="project" ? null : operation.repository,
        revision:operation.expected_revision});
      if (revisions.has(target) && canonicalJson(revisions.get(target))!==canonicalJson(binding)) throw new CoreBlockedError("Authority cannot bind conflicting expected revisions for one target");
      revisions.set(target,binding);
    }
  }
  if (authorityBinding!==null) {
    if (authorityBinding.publication!==undefined) {
      const repository=releaseApprovalRepository;
      if (repository===null) {
        throw new CoreBlockedError("Authority cannot bind release approval without its repository");
      }
      addRevision(repository,repository,authorityBinding.repository.revision);
      addRevision(`${repository}#branch:${authorityBinding.pull_request.head}`,repository,
        authorityBinding.pull_request.head_sha);
      addRevision(`${repository}#base:${authorityBinding.pull_request.base}`,repository,
        authorityBinding.pull_request.base_revision);
      addRevision(`${repository}#base-head:${authorityBinding.pull_request.base}`,repository,
        authorityBinding.pull_request.base_sha);
      addRevision(`${repository}#review:${authorityBinding.review.result.review_id}`,repository,
        authorityBinding.review.revision);
      addRevision(`${repository}#formal-review:${authorityBinding.review.formal_review.review_id}`,
        repository,authorityBinding.review.formal_review.revision);
      for (const check of authorityBinding.checks) {
        addRevision(`${repository}#check:${check.name}`,repository,check.revision);
      }
      addRevision(`${repository}#rules`,repository,authorityBinding.rules_revision);
      addRevision(`policy:${authorityBinding.policy_revision}`,null,
        authorityBinding.policy_revision);
    }
    revisions.set(`binding:${sha256Canonical(authorityBinding)}`,null);
  }
  const expected_revisions=[...revisions.values()]
    .filter(value => value!==null)
    .sort(compareCanonicalValue);
  return Object.freeze({
    command:intent.command,
    targets:[...revisions.keys()].sort(compareCanonicalText),
    expected_revisions:Object.freeze(expected_revisions),
    policy_revision:intent.policy_revision,
    now,
    implementation_actor:implementationActor,
  });
}

function inspectMatches(operations,values) {
  const byId=new Map(values.map(value => [value.operation_id,value]));
  if (byId.size!==values.length) throw new CoreValidationError("GitHub inspection has duplicate operation observations");
  for (const operation of operations) {
    const inspection=byId.get(operation.operation_id);
    if (!inspection || inspection.repository!==operation.repository || inspection.revision!==operation.expected_revision) throw new CoreConflictError(`Operation ${operation.operation_id} has a stale expected revision`);
  }
}

function receiptFor(intent,{receipt_id,created_at,status,observed_revisions}) {
  const receipt=Object.freeze({
    schema_version:"operation-receipt.v1",document_type:"operation-receipt",receipt_id,
    intent_id:intent.intent_id,intent_sha256:sha256Canonical(intent),created_at,status,observed_revisions,
  });
  validateCoreDocument(receipt,"operation-receipt.v1");
  return receipt;
}

function remoteResult(value,operations) {
  const result=clone(value,"apply result");
  exact(result,["status","observed_revisions"],"GitHub apply result");
  if (!["completed","failed"].includes(result.status)) throw new CoreValidationError("GitHub apply result status is invalid");
  const observedRevisions=observed(result.observed_revisions);
  if (result.status==="completed") {
    const byOperation=new Map(observedRevisions.map(item => [item.operation_id,item]));
    if (byOperation.size!==observedRevisions.length || byOperation.size!==operations.length ||
        operations.some(operation => byOperation.get(operation.operation_id)?.repository!==operation.repository)) {
      return Object.freeze({status:"failed",observed_revisions:observedRevisions});
    }
  }
  return Object.freeze({status:result.status,observed_revisions:observedRevisions});
}

function exactReceipt(value,intent) {
  if (value===null) return null;
  if (Array.isArray(value)) throw new CoreConflictError("Operation receipt lookup is ambiguous");
  let receipt;
  try { receipt=validateCoreDocument(clone(value,"stored receipt"),"operation-receipt.v1"); } catch (error) {
    throw new CoreConflictError("Operation receipt ledger is corrupt",{cause:error});
  }
  if (receipt.intent_id!==intent.intent_id || receipt.intent_sha256!==sha256Canonical(intent)) throw new CoreConflictError("Operation receipt conflicts with the intent ledger");
  if (intent.planned_receipt_id!==undefined && receipt.receipt_id!==intent.planned_receipt_id) {
    throw new CoreConflictError("Operation receipt does not use its durably planned identity");
  }
  if (receipt.status==="completed") {
    const observations=new Map(receipt.observed_revisions.map(observation => [observation.operation_id,observation]));
    if (observations.size!==receipt.observed_revisions.length || observations.size!==intent.operations.length ||
        intent.operations.some(operation => observations.get(operation.operation_id)?.repository!==operation.repository)) {
      throw new CoreConflictError("Completed operation receipt does not exactly cover the intent");
    }
  }
  return receipt;
}

function ledgerConflict(error,operation) {
  if (error instanceof CoreConflictError) return error;
  if (["CONTROL_LEDGER_CONFLICT","CORE_CONTROL_CONFLICT"].includes(error?.code)) {
    return new CoreConflictError(`Control ledger ${operation} conflict`,{cause:error});
  }
  return null;
}

export function createOperationRunner({control,github,authorityRegistry,clock,idGenerator,policyRevision,implementationActor="toss-core"}) {
  const head=ownFunction(control,"head","control");
  const findIntent=ownFunction(control,"findIntent","control");
  const findReceipt=ownFunction(control,"findReceipt","control");
  const commitIntent=ownFunction(control,"commitIntent","control");
  const commitReceipt=ownFunction(control,"commitReceipt","control");
  const inspectReleaseProgramOperation=optionalOwnFunction(control,"inspectReleaseProgramOperation","control");
  const commitReleaseProgramReceipt=optionalOwnFunction(control,"commitReleaseProgramReceipt","control");
  if ((inspectReleaseProgramOperation===null)!==(commitReleaseProgramReceipt===null)) throw new CoreValidationError("control release-program operation methods must be provided together");
  const inspectReleaseProgramSetOperation=optionalOwnFunction(control,"inspectReleaseProgramSetOperation","control");
  const commitReleaseProgramSetReceipt=optionalOwnFunction(control,"commitReleaseProgramSetReceipt","control");
  if ((inspectReleaseProgramSetOperation===null)!==(commitReleaseProgramSetReceipt===null)) throw new CoreValidationError("control release-program set operation methods must be provided together");
  ownFunction(github,"snapshot","github");
  const inspect=ownFunction(github,"inspect","github");
  const applyRemote=ownFunction(github,"apply","github");
  const persistedFailureErrors=new WeakSet();
  if (typeof clock!=="function" || types.isProxy(clock) || typeof idGenerator!=="function" || types.isProxy(idGenerator) || typeof policyRevision!=="function" || types.isProxy(policyRevision) || typeof implementationActor!=="string" || !/\S/u.test(implementationActor)) throw new CoreValidationError("Operation runner providers must be explicit non-proxy functions");

  async function preview(intent) { return operationPreview(intent); }

  function reserveReceiptId() {
    const value=idGenerator("receipt");
    if (typeof value!=="string" || !/^RECEIPT-[0-9]{8}-[0-9]{4,}$/u.test(value)) {
      throw new CoreValidationError("Operation receipt id generator returned a non-canonical receipt identity");
    }
    return value;
  }

  function verifyAuthorityFor(intent,authority) {
    const valid=validateOperationIntent(clone(intent,"intent"));
    if (valid.authority===null) throw new CoreBlockedError("Operation intent does not declare authority");
    if (authority===null || authority===undefined) throw new CoreBlockedError("Operation intent requires authority");
    const verified=verifyAuthority(authority,expectedAuthorityBinding(valid,clock(),implementationActor),authorityRegistry);
    if (canonicalJson(valid.authority)!==canonicalJson(authorityReference(verified)) && canonicalJson(valid.authority)!==canonicalJson(verified)) throw new CoreBlockedError("Operation intent authority does not bind the supplied authority record");
    return verified;
  }

  async function persistFailed(intent,expectedHead,receiptId,observed_revisions=[]) {
    const receipt=receiptFor(intent,{receipt_id:receiptId,created_at:clock(),status:"failed",observed_revisions});
    try {
      await commitReceipt({expectedHead,receipt});
    } catch (error) {
      const current=await head();
      if (current===expectedHead) throw error;
      const existing=exactReceipt(await findReceipt(intent),intent);
      if (existing!==null) {
        if (existing.receipt_id!==receiptId) {
          throw new CoreConflictError("Operation receipt identity conflicts with concurrent evidence");
        }
        return existing;
      }
      await commitReceipt({expectedHead:current,receipt});
    }
    return receipt;
  }

  async function applyIntent(intent,{authority,receiptId=null}={}) {
    const valid=validateOperationIntent(clone(intent,"intent"));
    if (receiptId!==null && valid.planned_receipt_id!==undefined &&
        receiptId!==valid.planned_receipt_id) {
      throw new CoreConflictError("Operation receipt identity conflicts with its immutable reservation");
    }
    let storedReceipt;
    try { storedReceipt=exactReceipt(await findReceipt(valid),valid); } catch (error) {
      const conflict=ledgerConflict(error,"receipt lookup");
      if (conflict) throw conflict;
      throw error;
    }
    if (storedReceipt) {
      if (receiptId!==null && storedReceipt.receipt_id!==receiptId) throw new CoreConflictError("Operation receipt identity conflicts with caller-bound evidence");
      if (storedReceipt.status==="failed") throw new CoreRemoteError("Operation has a recorded failed receipt");
      return storedReceipt;
    }
    if (valid.authority===null && valid.operations.some(operation =>
      Object.hasOwn(operation.payload,"authority_binding"))) {
      throw new CoreBlockedError("Authority-bound operations require one immutable authority record");
    }
    if (valid.authority!==null) {
      verifyAuthorityFor(valid,authority);
    } else if (authority!==null && authority!==undefined) {
      throw new CoreBlockedError("Operation intent does not declare authority");
    }
    const localKinds=new Set(["release-program-manifest","release-program-manifest-set"]);
    const localOperations=valid.operations.filter(operation => localKinds.has(operation.payload?.kind));
    if (localOperations.length>1 || (localOperations.length===1 &&
        ((localOperations[0].payload.kind==="release-program-manifest" && inspectReleaseProgramOperation===null) ||
         (localOperations[0].payload.kind==="release-program-manifest-set" && inspectReleaseProgramSetOperation===null)))) {
      throw new CoreValidationError("Operation intent contains an unsupported release-program manifest mutation");
    }
    const githubOperations=valid.operations.filter(operation => !localKinds.has(operation.payload?.kind));
    const verifyOperations=githubOperations.filter(operation => operation.action==="verify");
    const mutationOperations=githubOperations.filter(operation => operation.action!=="verify");
    const controlBound=localOperations.length===1 || verifyOperations.some(operation =>
      ["release-plan-precondition","release-activation-precondition",
        "release-patch-precondition","release-patch-completion-precondition",
        "release-approval-precondition","release-publication-precondition"].includes(
        operation.payload?.kind));
    let prior;
    try { prior=await findIntent(valid); } catch (error) {
      const conflict=ledgerConflict(error,"intent lookup");
      if (conflict) throw conflict;
      throw error;
    }
    if (prior!==null) {
      let storedIntent;
      try { storedIntent=validateOperationIntent(clone(prior,"stored intent")); } catch (error) {
        throw new CoreConflictError("Operation intent ledger is corrupt",{cause:error});
      }
      if (sha256Canonical(storedIntent)!==sha256Canonical(valid)) throw new CoreConflictError("Intent identity conflicts with the ledger");
    }
    let revision=await head();
    if (prior===null && controlBound && revision!==valid.source.revision) {
      throw new CoreConflictError("Release operation source control revision is stale");
    }
    try {
      if (prior===null) revision=(await commitIntent({expectedHead:revision,intent:valid})).commit_sha;
    } catch (error) {
      const conflict=ledgerConflict(error,"intent commit");
      if (conflict) throw conflict;
      if (error instanceof CoreValidationError || error instanceof CoreBlockedError) throw error;
      throw new CoreInternalError("Control ledger intent commit failed",{cause:error});
    }
    const selectedReceiptId=valid.planned_receipt_id ?? receiptId ?? reserveReceiptId();
    let inspected=[];
    try {
      const remoteInspected=githubOperations.length===0 ? [] : observed(await inspect(githubOperations));
      const localInspected=localOperations.length===0 ? [] : [localOperations[0].payload.kind==="release-program-manifest"
        ? await inspectReleaseProgramOperation(localOperations[0])
        : await inspectReleaseProgramSetOperation(localOperations[0])];
      inspected=observed([...remoteInspected,...localInspected]);
      inspectMatches(valid.operations,inspected);
    } catch (error) {
      try {
        const recovered=await persistFailed(valid,revision,selectedReceiptId,inspected);
        if (recovered.status==="completed") return recovered;
      } catch (persistenceError) { throw new CoreRemoteError("GitHub inspection failed and failed receipt could not be persisted",{cause:persistenceError}); }
      if (error instanceof CoreConflictError) throw error;
      if (error instanceof CoreValidationError) throw error;
      throw new CoreRemoteError("GitHub inspection failed",{cause:error});
    }
    let appliedObservations=[];
    try {
      const verifiedIds=new Set(verifyOperations.map(operation => operation.operation_id));
      const verifiedObservations=inspected.filter(value => verifiedIds.has(value.operation_id));
      const approvalMerge=mutationOperations.find(operation =>
        operation.payload?.kind==="release-pull-request-merge") ?? null;
      const approvalWorkflow=mutationOperations.find(operation =>
        operation.payload?.kind==="release-publication-workflow") ?? null;
      let result;
      if (approvalMerge!==null || approvalWorkflow!==null) {
        if (mutationOperations.length!==2 || approvalMerge===null || approvalWorkflow===null) {
          throw new CoreValidationError("Release approval mutations must contain one merge and one workflow operation");
        }
        const applyOne=async operation => remoteResult(await applyRemote([operation],{
          idempotencyKey:sha256Canonical({intent_sha256:sha256Canonical(valid),
            operation_id:operation.operation_id}),
        }),[operation]);
        const mergeResult=await applyOne(approvalMerge);
        appliedObservations=observed([...verifiedObservations,...mergeResult.observed_revisions]);
        const merged=mergeResult.observed_revisions[0] ?? null;
        if (mergeResult.status!=="completed") {
          result=mergeResult;
        } else if (merged.revision!==approvalMerge.payload.merge_result_revision ||
            merged.revision!==approvalMerge.payload.head_sha) {
          throw new CoreConflictError("Release approval merge was not an exact fast-forward result");
        } else {
          const workflowResult=await applyOne(approvalWorkflow);
          appliedObservations=observed([
            ...verifiedObservations,...mergeResult.observed_revisions,
            ...workflowResult.observed_revisions,
          ]);
          const workflowObservation=workflowResult.observed_revisions[0] ?? null;
          if (workflowResult.status==="completed" &&
              workflowObservation?.revision!==approvalWorkflow.payload.expected_revision) {
            throw new CoreConflictError(
              "Release publication workflow did not bind the approved merge result",
            );
          }
          result=Object.freeze({status:workflowResult.status,
            observed_revisions:Object.freeze([
              ...mergeResult.observed_revisions,...workflowResult.observed_revisions,
            ])});
        }
      } else {
        result=mutationOperations.length===0
          ? Object.freeze({status:"completed",observed_revisions:Object.freeze([])})
          : remoteResult(await applyRemote(mutationOperations,
            {idempotencyKey:sha256Canonical(valid)}),mutationOperations);
      }
      appliedObservations=observed([...verifiedObservations,...result.observed_revisions]);
      const localObserved=localOperations.map(operation => Object.freeze({
        operation_id:operation.operation_id,
        repository:operation.repository,
        revision:operation.payload.kind==="release-program-manifest"
          ? operation.payload.program.revision
          : operation.payload.resulting_set_sha256,
      }));
      const completedObservations=result.status==="completed"
        ? observed([...appliedObservations,...localObserved])
        : appliedObservations;
      const receipt=receiptFor(valid,{receipt_id:selectedReceiptId,created_at:clock(),status:result.status,observed_revisions:completedObservations});
      if (localOperations.length===1 && result.status==="completed") {
        if (localOperations[0].payload.kind==="release-program-manifest") {
          await commitReleaseProgramReceipt({expectedHead:revision,operation:localOperations[0],receipt});
        } else {
          await commitReleaseProgramSetReceipt({expectedHead:revision,operation:localOperations[0],receipt});
        }
      } else {
        await commitReceipt({expectedHead:revision,receipt});
      }
      if (result.status==="failed") {
        const error=new CoreRemoteError("GitHub apply reported an incomplete or failed outcome");
        persistedFailureErrors.add(error);
        throw error;
      }
      return receipt;
    } catch (error) {
      if (error && typeof error==="object" && persistedFailureErrors.has(error)) throw error;
      try {
        const recovered=await persistFailed(valid,revision,selectedReceiptId,appliedObservations);
        if (recovered.status==="completed") return recovered;
      } catch (persistenceError) { throw new CoreRemoteError("GitHub apply failed and failed receipt could not be persisted",{cause:persistenceError}); }
      if (error instanceof CoreRemoteError) throw error;
      if (error instanceof CoreValidationError || error instanceof CoreConflictError) throw error;
      throw new CoreRemoteError("GitHub apply failed",{cause:error});
    }
  }

  async function apply(intent,{authority}={}) {
    const valid=validateOperationIntent(clone(intent,"intent"));
    if (valid.planned_receipt_id!==undefined) return applyIntent(valid,{authority});
    let prior;
    try { prior=await findIntent(valid); } catch (error) {
      const conflict=ledgerConflict(error,"legacy intent lookup");
      if (conflict) throw conflict;
      throw error;
    }
    if (prior!==null) {
      let storedIntent;
      try { storedIntent=validateOperationIntent(clone(prior,"stored legacy intent")); } catch (error) {
        throw new CoreConflictError("Legacy operation intent ledger is corrupt",{cause:error});
      }
      if (storedIntent.planned_receipt_id!==undefined) {
        const {planned_receipt_id:_reservation,...legacyShape}=storedIntent;
        if (canonicalJson(legacyShape)!==canonicalJson(valid)) {
          throw new CoreConflictError("Legacy intent identity conflicts with the ledger");
        }
        return applyIntent(storedIntent,{authority});
      }
      if (sha256Canonical(storedIntent)!==sha256Canonical(valid)) {
        throw new CoreConflictError("Legacy intent identity conflicts with the ledger");
      }
      let storedReceipt;
      try { storedReceipt=exactReceipt(await findReceipt(storedIntent),storedIntent); } catch (error) {
        const conflict=ledgerConflict(error,"legacy receipt lookup");
        if (conflict) throw conflict;
        throw error;
      }
      if (storedReceipt?.status==="completed") return storedReceipt;
      throw new CoreBlockedError(storedReceipt===null
        ? "Persisted legacy operation has no durable receipt reservation and requires reconciliation"
        : "Persisted legacy operation has unresolved receipt evidence and requires reconciliation");
    }
    let orphanedReceipt;
    try { orphanedReceipt=exactReceipt(await findReceipt(valid),valid); } catch (error) {
      const conflict=ledgerConflict(error,"legacy receipt lookup");
      if (conflict) throw conflict;
      throw error;
    }
    if (orphanedReceipt!==null) {
      if (orphanedReceipt.status!=="completed") {
        throw new CoreBlockedError("Persisted legacy operation has unresolved receipt evidence and requires reconciliation");
      }
      return orphanedReceipt;
    }
    const receiptId=reserveReceiptId();
    const planned=validateOperationIntent(clone({...valid,planned_receipt_id:receiptId},
      "planned legacy intent"));
    return applyIntent(planned,{authority,receiptId});
  }

  async function execute(input) {
    if (!input || typeof input!=="object" || Array.isArray(input) || types.isProxy(input) ||
        ![Object.prototype,null].includes(Object.getPrototypeOf(input))) {
      throw new CoreValidationError("Operation execute request must be a plain non-proxy object");
    }
    const descriptors=Object.getOwnPropertyDescriptors(input);
    const confirmation=descriptors.confirm?.value;
    if (Object.hasOwn(descriptors,"confirm") && (!descriptors.confirm.enumerable || !("value" in descriptors.confirm) || typeof confirmation!=="function" || types.isProxy(confirmation))) throw new CoreValidationError("Operation confirmation callback must be an own-data non-proxy function");
    const clean=Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key!=="string") throw new CoreValidationError("Operation execute request contains a symbol field");
      const descriptor=descriptors[key];
      if (key==="confirm") continue;
      if (!descriptor.enumerable || !("value" in descriptor)) throw new CoreValidationError("Operation execute request contains an accessor or hidden field");
      clean[key]=descriptor.value;
    }
    const request=clone(clean,"execute request");
    const requestKeys=Object.keys(request).sort();
    const required=["authority","command","operations","source"];
    const allowed=[...required,"receipt_id"].sort();
    if (required.some(key => !Object.hasOwn(request,key)) || requestKeys.some(key => !allowed.includes(key))) {
      throw new CoreValidationError("Operation execute request must use an exact closed shape");
    }
    if (Object.hasOwn(request,"receipt_id") && (typeof request.receipt_id!=="string" || !/^RECEIPT-[0-9]{8}-[0-9]{4,}$/u.test(request.receipt_id))) throw new CoreValidationError("Operation execute receipt identity must be canonical");
    let commandValue;
    try { commandValue=validateParsedCoreCommand(request.command); } catch (error) {
      throw new CoreValidationError("Operation command is not an exact normalized core command",{cause:error});
    }
    if (commandValue.options.apply!==true && confirmation!==undefined) throw new CoreValidationError("Operation confirmation is valid only for apply");
    if (commandValue.options.apply===true && commandValue.options.nonInteractive!==true && confirmation===undefined) throw new CoreBlockedError("Interactive apply requires CLI confirmation");
    const suppliedAuthority=request.authority===null ? null : clone(request.authority,"authority");
    const intentId=idGenerator("intent");
    const plannedReceiptId=Object.hasOwn(request,"receipt_id")
      ? request.receipt_id
      : commandValue.options.apply && !commandValue.options.dryRun
        ? reserveReceiptId()
        : null;
    const intent=createOperationIntent({intent_id:intentId,created_at:clock(),command:commandValue.name,policy_revision:policyRevision(),source:request.source,authority:suppliedAuthority===null ? null : authorityReference(suppliedAuthority),...(plannedReceiptId===null ? {} : {planned_receipt_id:plannedReceiptId}),operations:request.operations});
    const previewValue=await preview(intent);
    if (!commandValue.options.apply || commandValue.options.dryRun) return previewValue;
    if (confirmation!==undefined && await Reflect.apply(confirmation,undefined,[previewValue])!==true) throw new CoreBlockedError("Interactive apply was not confirmed");
    return applyIntent(intent,{authority:suppliedAuthority,receiptId:plannedReceiptId});
  }
  return Object.freeze({preview,apply,execute,reserveReceiptId,verifyAuthorityFor});
}
