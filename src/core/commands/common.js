import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {validateCoreDocument} from "../contracts.js";
import {CoreBlockedError,CoreConflictError,CoreValidationError} from "../errors.js";

const MAX_CLOSED_DATA_DEPTH=64;

export function closedData(value,label,path="$",ancestors=new Set(),depth=0) {
  if (depth>MAX_CLOSED_DATA_DEPTH) {
    throw new CoreValidationError(`${label} ${path} exceeds the maximum closed-data depth`);
  }
  if (value===null || ["string","boolean"].includes(typeof value)) return value;
  if (typeof value==="number") {
    if (!Number.isFinite(value)) throw new CoreValidationError(`${label} ${path} must be finite`);
    return value;
  }
  if (!value || typeof value!=="object" || types.isProxy(value) || ancestors.has(value)) {
    throw new CoreValidationError(`${label} ${path} must be closed plain non-proxy data`);
  }
  ancestors.add(value);
  try {
    const prototype=Object.getPrototypeOf(value);
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const keys=Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      const lengthDescriptor=Object.getOwnPropertyDescriptor(descriptors,"length")?.value;
      const length=lengthDescriptor?.value;
      if (prototype!==Array.prototype || !lengthDescriptor || !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(length) || length<0 || length>0xffffffff ||
          lengthDescriptor.enumerable!==false || lengthDescriptor.configurable!==false ||
          typeof lengthDescriptor.writable!=="boolean" ||
          (lengthDescriptor.writable===false && Object.isExtensible(value)) ||
          keys.length!==length+1) {
        throw new CoreValidationError(`${label} ${path} must be a dense plain array`);
      }
      const output=[];
      for (let index=0;index<length;index+=1) {
        const captured=Object.getOwnPropertyDescriptor(descriptors,String(index));
        const descriptor=captured?.value;
        if (!captured || !("value" in captured) || !descriptor ||
            !("value" in descriptor) || !descriptor.enumerable ||
            (lengthDescriptor.writable===false &&
             (descriptor.writable!==false || descriptor.configurable!==false))) {
          throw new CoreValidationError(`${label} ${path} must contain dense own data`);
        }
        output.push(closedData(descriptor.value,label,`${path}[${index}]`,ancestors,depth+1));
      }
      return Object.freeze(output);
    }
    if (![Object.prototype,null].includes(prototype) ||
        keys.some(key => typeof key!=="string")) {
      throw new CoreValidationError(`${label} ${path} must be a plain object`);
    }
    const output=Object.create(null);
    for (const key of keys) {
      const descriptor=Object.getOwnPropertyDescriptor(descriptors,key)?.value;
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new CoreValidationError(`${label} ${path}.${key} contains an accessor or hidden property`);
      output[key]=closedData(descriptor.value,label,`${path}.${key}`,ancestors,depth+1);
    }
    return Object.freeze(output);
  } finally { ancestors.delete(value); }
}

export function exact(value,keys,label) {
  if (!value || typeof value!=="object" || Array.isArray(value) ||
      canonicalJson(Object.keys(value).sort())!==canonicalJson([...keys].sort())) {
    throw new CoreValidationError(`${label} must use an exact closed shape`);
  }
  return value;
}

export function ownDataFunction(value,key,label) {
  if (!value || typeof value!=="object" || types.isProxy(value)) throw new CoreValidationError(`${label} must be a non-proxy object`);
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value!=="function" || types.isProxy(descriptor.value)) {
    throw new CoreValidationError(`${label}.${key} must be an own-data non-proxy function`);
  }
  return descriptor.value;
}

export function ownDataValue(value,key,label) {
  if (!value || typeof value!=="object" || types.isProxy(value)) throw new CoreValidationError(`${label} must be a non-proxy object`);
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw new CoreValidationError(`${label}.${key} must be an own enumerable data property`);
  }
  return descriptor.value;
}

export function requireAuthority(command,services) {
  if (command.options.apply!==true) return Promise.resolve(null);
  if (command.options.authority===null) throw new CoreBlockedError("Apply requires an explicit authority record");
  return ownDataFunction(services,"readAuthority","services")(command.options.authority);
}

function operationAffectsWork(operation,id) {
  const payload=operation.payload ?? {};
  return payload.work_item_id===id || payload.epic_id===id || payload.issue_id===id ||
    payload.source===id || payload.target===id || payload.work?.item?.id===id ||
    payload.work_item?.id===id || payload.plan?.epic?.id===id ||
    payload.edge?.source===id || payload.edge?.target===id ||
    payload.tombstone?.source===id || payload.tombstone?.target===id ||
    payload.authority_binding?.epic?.id===id;
}

function orderedReceipt(left,right) {
  if (left.receipt.created_at!==right.receipt.created_at) {
    return left.receipt.created_at<right.receipt.created_at ? -1 : 1;
  }
  if (left.receipt.receipt_id!==right.receipt.receipt_id) {
    return left.receipt.receipt_id<right.receipt.receipt_id ? -1 : 1;
  }
  return 0;
}

export function assertReceiptCoverage(receipt,intent,label="Operation receipt") {
  if (receipt.intent_id!==intent.intent_id || receipt.intent_sha256!==sha256Canonical(intent)) {
    throw new CoreConflictError(`${label} does not bind its immutable intent`);
  }
  const operations=new Map();
  for (const operation of intent.operations) {
    if (operations.has(operation.operation_id)) {
      throw new CoreConflictError(`${label} intent operation identity is duplicated`);
    }
    operations.set(operation.operation_id,operation);
  }
  const observed=new Set();
  for (const observation of receipt.observed_revisions) {
    const operation=operations.get(observation.operation_id);
    if (!operation || operation.repository!==observation.repository || observed.has(observation.operation_id)) {
      throw new CoreConflictError(`${label} contains incompatible operation evidence`);
    }
    observed.add(observation.operation_id);
  }
  if (receipt.status==="completed" &&
      (observed.size!==operations.size || [...operations.keys()].some(operationId => !observed.has(operationId)))) {
    throw new CoreConflictError(`${label} does not exactly cover its completed intent`);
  }
  return observed;
}

export async function reconciliationEvidence(services,id) {
  const empty=closedData({required:false,receipts:[]},"work reconciliation evidence");
  const controlDescriptor=services && typeof services==="object" && !types.isProxy(services)
    ? Object.getOwnPropertyDescriptor(services,"control")
    : null;
  if (!controlDescriptor || !("value" in controlDescriptor)) return empty;
  const control=controlDescriptor.value;
  const loaderDescriptor=control && typeof control==="object" && !types.isProxy(control)
    ? Object.getOwnPropertyDescriptor(control,"loadOperationState")
    : null;
  if (!loaderDescriptor) return empty;
  const ledger=closedData(await ownDataFunction(control,"loadOperationState","control")(),"operation ledger evidence");
  exact(ledger,["revision","intents","receipts"],"operation ledger evidence");
  if (!(ledger.revision===null || typeof ledger.revision==="string") ||
      !Array.isArray(ledger.intents) || !Array.isArray(ledger.receipts)) {
    throw new CoreValidationError("Operation ledger evidence is malformed");
  }
  const intents=new Map();
  for (const candidate of ledger.intents) {
    const intent=validateCoreDocument(candidate,"operation-intent.v1");
    if (intents.has(intent.intent_id)) throw new CoreConflictError("Operation ledger intent identity is duplicated");
    intents.set(intent.intent_id,intent);
  }
  const records=ledger.receipts.map(candidate => {
    const receipt=validateCoreDocument(candidate,"operation-receipt.v1");
    const intent=intents.get(receipt.intent_id);
    if (!intent) {
      throw new CoreConflictError("Operation reconciliation receipt does not bind an immutable intent");
    }
    assertReceiptCoverage(receipt,intent,"Operation reconciliation receipt");
    return {receipt,intent,affects:intent.operations.some(operation => operationAffectsWork(operation,id))};
  }).sort(orderedReceipt);
  const unresolved=records.filter((record,index) => record.affects && record.receipt.status==="failed" &&
    !records.slice(index+1).some(later => later.affects && later.receipt.status==="completed" &&
      later.intent.command==="sync"));
  return closedData({required:unresolved.length>0,receipts:unresolved.map(({receipt,intent}) => ({
    receipt_id:receipt.receipt_id,intent_id:receipt.intent_id,
    intent_sha256:receipt.intent_sha256,
    completed_operation_ids:receipt.observed_revisions.map(value => value.operation_id)
      .filter(operationId => intent.operations.some(operation => operation.operation_id===operationId))
      .sort(),
  }))},"work reconciliation evidence");
}

export function applyReconciliationGate(work,evidence) {
  const value=closedData(work,"work reconciliation projection");
  const reconciliation=closedData(evidence,"work reconciliation evidence");
  exact(reconciliation,["required","receipts"],"work reconciliation evidence");
  if (!reconciliation.required) return value;
  return closedData({...value,drifted:true},"reconciliation-gated work");
}
