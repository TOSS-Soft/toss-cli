import {types} from "node:util";

import {parseWorkItemId} from "../domain/identity.js";
import {CoreBlockedError,CoreValidationError} from "../errors.js";
import {
  issueAddOperations,
  issueRequestIdentity,
  issueStartOperations,
  issueSubmitOperations,
  normalizeIssueInput,
  workStatusResult,
} from "../work/operations.js";
import {
  applyReconciliationGate,closedData,ownDataFunction,ownDataValue,reconciliationEvidence,
} from "./common.js";

function confirmation(command,services) {
  if (!command.options.apply || !command.interactive) return undefined;
  if (!services || typeof services!=="object" || types.isProxy(services) || !Object.hasOwn(services,"confirm")) {
    throw new CoreBlockedError("Interactive apply requires CLI confirmation");
  }
  return ownDataFunction(services,"confirm","services");
}

function assertUngated(command) {
  if (command.options.authority!==null) throw new CoreValidationError("Issue commands do not accept an authority record");
}

async function execute(command,services,snapshot,decision,label) {
  if (decision.operations.length===0) return closedData({status:"already-reconciled",work_item:decision.work.item,state:decision.state ?? null},label);
  const confirm=confirmation(command,services);
  return ownDataFunction(ownDataValue(services,"operations","services"),"execute","operations")({
    command,source:closedData(snapshot,"issue mutation snapshot").source,operations:decision.operations,authority:null,
    ...(confirm===undefined ? {} : {confirm}),
  });
}

async function add(command,services) {
  assertUngated(command);
  if (command.options.from===null) throw new CoreValidationError("issue add requires --from <FILE>");
  const repository=command.args[0];
  const input=normalizeIssueInput(await ownDataFunction(services,"readInput","services")(command.options.from));
  const requestIdentity=issueRequestIdentity(repository,input);
  const snapshot=await ownDataFunction(ownDataValue(services,"github","services"),"snapshot","github")({kind:"issue-by-marker",repository,request_identity:requestIdentity});
  const decision=issueAddOperations({repository,input,snapshot,reconciled_at:ownDataFunction(services,"clock","services")()});
  if (decision.operations.length===0) return closedData({status:"already-reconciled",request_identity:decision.request_identity,work_item:decision.work.item},"issue replay result");
  const confirm=confirmation(command,services);
  return ownDataFunction(ownDataValue(services,"operations","services"),"execute","operations")({command,source:closedData(snapshot,"issue intake snapshot").source,operations:decision.operations,authority:null,...(confirm===undefined ? {} : {confirm})});
}

async function start(command,services) {
  assertUngated(command);
  if (command.options.from!==null) throw new CoreValidationError("issue start does not consume an input file");
  const id=command.args[0]; parseWorkItemId(id);
  const observed=await ownDataFunction(ownDataValue(services,"github","services"),"snapshot","github")({kind:"issue-start",id});
  const reconciliation=await reconciliationEvidence(services,id);
  const snapshot=reconciliation.required
    ? closedData({...observed,work:applyReconciliationGate(observed.work,reconciliation)},"reconciliation-gated issue start snapshot")
    : observed;
  const decision=issueStartOperations({id,snapshot,reconciled_at:ownDataFunction(services,"clock","services")()});
  return execute(command,services,snapshot,decision,"issue start replay result");
}

async function submit(command,services) {
  assertUngated(command);
  if (command.options.from!==null) throw new CoreValidationError("issue submit does not consume an input file");
  const id=command.args[0]; parseWorkItemId(id);
  const observed=await ownDataFunction(ownDataValue(services,"github","services"),"snapshot","github")({kind:"issue-submit",id});
  const reconciliation=await reconciliationEvidence(services,id);
  const snapshot=reconciliation.required
    ? closedData({...observed,work:applyReconciliationGate(observed.work,reconciliation)},"reconciliation-gated issue submit snapshot")
    : observed;
  const decision=issueSubmitOperations({id,snapshot,reconciled_at:ownDataFunction(services,"clock","services")()});
  return execute(command,services,snapshot,decision,"issue submit replay result");
}

async function status(command,services) {
  if (command.options.from!==null || command.options.authority!==null) throw new CoreValidationError("issue status does not consume input or authority files");
  const id=command.args[0]; parseWorkItemId(id);
  const observed=await ownDataFunction(ownDataValue(services,"github","services"),"snapshot","github")({kind:"work-item",id});
  const reconciliation=await reconciliationEvidence(services,id);
  const snapshot=reconciliation.required
    ? closedData({...observed,work:applyReconciliationGate(observed.work,reconciliation)},"reconciliation-gated issue status snapshot")
    : observed;
  return closedData({...workStatusResult(snapshot,id),reconciliation},"issue status with reconciliation evidence");
}

export async function runIssueCommand(command,services) {
  if (command.name==="issue.add") return add(command,services);
  if (command.name==="issue.start") return start(command,services);
  if (command.name==="issue.submit") return submit(command,services);
  if (command.name==="issue.status") return status(command,services);
  throw new CoreValidationError("Unsupported issue command");
}
