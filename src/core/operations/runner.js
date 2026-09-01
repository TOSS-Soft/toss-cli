import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {compareCanonicalText,compareCanonicalValue} from "../canonical-order.js";
import {validateCoreDocument} from "../contracts.js";
import {authorityReference,verifyAuthority} from "../authority.js";
import {validateParsedCoreCommand} from "../commands/router.js";
import {CoreBlockedError,CoreConflictError,CoreInternalError,CoreRemoteError,CoreValidationError} from "../errors.js";
import {createOperationIntent,operationPreview} from "./plan.js";

function ownFunction(value,key,label) {
  if (!value || typeof value!=="object" || types.isProxy(value)) throw new CoreValidationError(`${label} must be a non-proxy object`);
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value!=="function" || types.isProxy(descriptor.value)) throw new CoreValidationError(`${label}.${key} must be an own-data non-proxy function`);
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
  for (const operation of intent.operations) {
    if (operation.repository===null) continue;
    if (revisions.has(operation.repository) && revisions.get(operation.repository)!==operation.expected_revision) throw new CoreBlockedError("Authority cannot bind conflicting expected revisions for one repository");
    revisions.set(operation.repository,operation.expected_revision);
  }
  const expected_revisions=[...revisions].map(([repository,revision]) => Object.freeze({repository,revision})).sort(compareCanonicalValue);
  return Object.freeze({
    command:intent.command,
    targets:[...revisions.keys()].sort(compareCanonicalText),
    expected_revisions:Object.freeze(expected_revisions),
    policy_revision:intent.policy_revision,
    now,
    implementation_actor:implementationActor,
  });
}

function inspectMatches(intent,values) {
  const byId=new Map(values.map(value => [value.operation_id,value]));
  if (byId.size!==values.length) throw new CoreValidationError("GitHub inspection has duplicate operation observations");
  for (const operation of intent.operations) {
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

function remoteResult(value,intent) {
  const result=clone(value,"apply result");
  exact(result,["status","observed_revisions"],"GitHub apply result");
  if (!["completed","failed"].includes(result.status)) throw new CoreValidationError("GitHub apply result status is invalid");
  const observedRevisions=observed(result.observed_revisions);
  if (result.status==="completed") {
    const byOperation=new Map(observedRevisions.map(item => [item.operation_id,item]));
    if (byOperation.size!==observedRevisions.length || byOperation.size!==intent.operations.length ||
        intent.operations.some(operation => byOperation.get(operation.operation_id)?.repository!==operation.repository)) {
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
  ownFunction(github,"snapshot","github");
  const inspect=ownFunction(github,"inspect","github");
  const applyRemote=ownFunction(github,"apply","github");
  const persistedFailureErrors=new WeakSet();
  if (typeof clock!=="function" || types.isProxy(clock) || typeof idGenerator!=="function" || types.isProxy(idGenerator) || typeof policyRevision!=="function" || types.isProxy(policyRevision) || typeof implementationActor!=="string" || !/\S/u.test(implementationActor)) throw new CoreValidationError("Operation runner providers must be explicit non-proxy functions");

  async function preview(intent) { return operationPreview(intent); }

  function verifyAuthorityFor(intent,authority) {
    const valid=validateCoreDocument(clone(intent,"intent"),"operation-intent.v1");
    if (valid.authority===null) throw new CoreBlockedError("Operation intent does not declare authority");
    if (authority===null || authority===undefined) throw new CoreBlockedError("Operation intent requires authority");
    const verified=verifyAuthority(authority,expectedAuthorityBinding(valid,clock(),implementationActor),authorityRegistry);
    if (canonicalJson(valid.authority)!==canonicalJson(authorityReference(verified)) && canonicalJson(valid.authority)!==canonicalJson(verified)) throw new CoreBlockedError("Operation intent authority does not bind the supplied authority record");
    return verified;
  }

  async function persistFailed(intent,expectedHead,observed_revisions=[]) {
    const receipt=receiptFor(intent,{receipt_id:idGenerator("receipt"),created_at:clock(),status:"failed",observed_revisions});
    await commitReceipt({expectedHead,receipt});
    return receipt;
  }

  async function apply(intent,{authority}={}) {
    const valid=validateCoreDocument(clone(intent,"intent"),"operation-intent.v1");
    let storedReceipt;
    try { storedReceipt=exactReceipt(await findReceipt(valid),valid); } catch (error) {
      const conflict=ledgerConflict(error,"receipt lookup");
      if (conflict) throw conflict;
      throw error;
    }
    if (storedReceipt) {
      if (storedReceipt.status==="failed") throw new CoreRemoteError("Operation has a recorded failed receipt");
      return storedReceipt;
    }
    if (valid.authority!==null) {
      verifyAuthorityFor(valid,authority);
    } else if (authority!==null && authority!==undefined) {
      throw new CoreBlockedError("Operation intent does not declare authority");
    }
    let prior;
    try { prior=await findIntent(valid); } catch (error) {
      const conflict=ledgerConflict(error,"intent lookup");
      if (conflict) throw conflict;
      throw error;
    }
    if (prior!==null) {
      let storedIntent;
      try { storedIntent=validateCoreDocument(clone(prior,"stored intent"),"operation-intent.v1"); } catch (error) {
        throw new CoreConflictError("Operation intent ledger is corrupt",{cause:error});
      }
      if (sha256Canonical(storedIntent)!==sha256Canonical(valid)) throw new CoreConflictError("Intent identity conflicts with the ledger");
    }
    let revision=await head();
    try {
      if (prior===null) revision=(await commitIntent({expectedHead:revision,intent:valid})).commit_sha;
    } catch (error) {
      const conflict=ledgerConflict(error,"intent commit");
      if (conflict) throw conflict;
      if (error instanceof CoreValidationError || error instanceof CoreBlockedError) throw error;
      throw new CoreInternalError("Control ledger intent commit failed",{cause:error});
    }
    let inspected=[];
    try {
      inspected=observed(await inspect(valid.operations));
      inspectMatches(valid,inspected);
    } catch (error) {
      try { await persistFailed(valid,revision,inspected); } catch (persistenceError) { throw new CoreRemoteError("GitHub inspection failed and failed receipt could not be persisted",{cause:persistenceError}); }
      if (error instanceof CoreConflictError) throw error;
      if (error instanceof CoreValidationError) throw error;
      throw new CoreRemoteError("GitHub inspection failed",{cause:error});
    }
    try {
      const result=remoteResult(await applyRemote(valid.operations,{idempotencyKey:sha256Canonical(valid)}),valid);
      const receipt=receiptFor(valid,{receipt_id:idGenerator("receipt"),created_at:clock(),status:result.status,observed_revisions:result.observed_revisions});
      await commitReceipt({expectedHead:revision,receipt});
      if (result.status==="failed") {
        const error=new CoreRemoteError("GitHub apply reported an incomplete or failed outcome");
        persistedFailureErrors.add(error);
        throw error;
      }
      return receipt;
    } catch (error) {
      if (error && typeof error==="object" && persistedFailureErrors.has(error)) throw error;
      try { await persistFailed(valid,revision,inspected); } catch (persistenceError) { throw new CoreRemoteError("GitHub apply failed and failed receipt could not be persisted",{cause:persistenceError}); }
      if (error instanceof CoreRemoteError) throw error;
      if (error instanceof CoreValidationError || error instanceof CoreConflictError) throw error;
      throw new CoreRemoteError("GitHub apply failed",{cause:error});
    }
  }

  async function execute(input) {
    const request=clone(input,"execute request");
    const requestKeys=Object.keys(request).sort();
    const allowed=["authority","command","operations","source"];
    const confirmedAllowed=[...allowed,"confirmed"].sort();
    if (canonicalJson(requestKeys)!==canonicalJson(allowed) && canonicalJson(requestKeys)!==canonicalJson(confirmedAllowed)) {
      throw new CoreValidationError("Operation execute request must use an exact closed shape");
    }
    if (Object.hasOwn(request,"confirmed") && typeof request.confirmed!=="boolean") throw new CoreValidationError("Operation confirmation must be boolean");
    let commandValue;
    try { commandValue=validateParsedCoreCommand(request.command); } catch (error) {
      throw new CoreValidationError("Operation command is not an exact normalized core command",{cause:error});
    }
    if (commandValue.options.apply!==true && request.confirmed===true) throw new CoreValidationError("Operation confirmation is valid only for apply");
    if (commandValue.options.apply===true && commandValue.options.nonInteractive!==true && request.confirmed!==true) throw new CoreBlockedError("Interactive apply requires CLI confirmation");
    const suppliedAuthority=request.authority===null ? null : clone(request.authority,"authority");
    const intent=createOperationIntent({intent_id:idGenerator("intent"),created_at:clock(),command:commandValue.name,policy_revision:policyRevision(),source:request.source,authority:suppliedAuthority===null ? null : authorityReference(suppliedAuthority),operations:request.operations});
    if (!commandValue.options.apply || commandValue.options.dryRun) return preview(intent);
    return apply(intent,{authority:suppliedAuthority});
  }
  return Object.freeze({preview,apply,execute,verifyAuthorityFor});
}
