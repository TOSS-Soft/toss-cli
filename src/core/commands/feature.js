import {types} from "node:util";

import {CoreBlockedError,CoreValidationError} from "../errors.js";
import {
  featureAddOperations,
  featureRequestIdentity,
  normalizeFeatureInput,
  workStatusResult,
} from "../work/operations.js";
import {
  applyReconciliationGate,closedData,ownDataFunction,ownDataValue,reconciliationEvidence,
} from "./common.js";

function confirmation(command,services) {
  if (!command.options.apply || !command.interactive) return undefined;
  if (!services || typeof services!=="object" || types.isProxy(services) ||
      !Object.hasOwn(services,"confirm")) {
    throw new CoreBlockedError("Interactive apply requires CLI confirmation");
  }
  return ownDataFunction(services,"confirm","services");
}

function assertUngated(command) {
  if (command.options.authority!==null) throw new CoreValidationError("Feature commands do not accept an authority record");
}

async function add(command,services) {
  assertUngated(command);
  if (command.options.from===null) throw new CoreValidationError("feature add requires --from <FILE>");
  const repository=command.args[0];
  const input=normalizeFeatureInput(await ownDataFunction(services,"readInput","services")(command.options.from));
  const requestIdentity=featureRequestIdentity(repository,input);
  const snapshot=await ownDataFunction(ownDataValue(services,"github","services"),"snapshot","github")({kind:"feature-by-marker",repository,request_identity:requestIdentity});
  const decision=featureAddOperations({repository,input,snapshot,reconciled_at:ownDataFunction(services,"clock","services")()});
  if (decision.operations.length===0) return closedData({status:"already-reconciled",request_identity:decision.request_identity,work_item:decision.work.item},"feature replay result");
  const confirm=confirmation(command,services);
  return ownDataFunction(ownDataValue(services,"operations","services"),"execute","operations")({
    command,source:closedData(snapshot,"feature snapshot").source,operations:decision.operations,authority:null,
    ...(confirm===undefined ? {} : {confirm}),
  });
}

async function status(command,services) {
  if (command.options.from!==null || command.options.authority!==null) throw new CoreValidationError("feature status does not consume input or authority files");
  const id=command.args[0];
  const observed=await ownDataFunction(ownDataValue(services,"github","services"),"snapshot","github")({kind:"work-item",id});
  const reconciliation=await reconciliationEvidence(services,id);
  const snapshot=reconciliation.required
    ? closedData({...observed,work:applyReconciliationGate(observed.work,reconciliation)},"reconciliation-gated feature status snapshot")
    : observed;
  return closedData({...workStatusResult(snapshot,id),reconciliation},"feature status with reconciliation evidence");
}

export async function runFeatureCommand(command,services) {
  if (command.name==="feature.add") return add(command,services);
  if (command.name==="feature.status") return status(command,services);
  throw new CoreValidationError("Unsupported feature command");
}
