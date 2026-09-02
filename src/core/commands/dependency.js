import {types} from "node:util";

import {parseWorkItemId} from "../domain/identity.js";
import {CoreBlockedError,CoreValidationError} from "../errors.js";
import {
  dependencyAddOperations,
  dependencyGraphResult,
  dependencyRemoveOperations,
  normalizeDependencyAddInput,
  normalizeDependencyRemoveInput,
} from "../work/operations.js";
import {closedData,ownDataFunction} from "./common.js";

function confirmation(command,services) {
  if (!command.options.apply || !command.interactive) return undefined;
  if (!services || typeof services!=="object" || types.isProxy(services) || !Object.hasOwn(services,"confirm")) throw new CoreBlockedError("Interactive apply requires CLI confirmation");
  return ownDataFunction(services,"confirm","services");
}

function assertUngated(command) {
  if (command.options.authority!==null) throw new CoreValidationError("Dependency commands do not accept an authority record");
}

async function mutation(command,services,remove) {
  assertUngated(command);
  if (command.options.from===null) throw new CoreValidationError(`dependency ${remove ? "remove" : "add"} requires --from <FILE>`);
  const [source,target]=command.args; parseWorkItemId(source); parseWorkItemId(target);
  const raw=await ownDataFunction(services,"readInput","services")(command.options.from);
  const input=remove ? normalizeDependencyRemoveInput(raw) : normalizeDependencyAddInput(raw);
  const snapshot=await ownDataFunction(services.github,"snapshot","github")({kind:"dependency-graph",root:null});
  const decision=remove
    ? dependencyRemoveOperations({source,target,input,snapshot,removed_at:ownDataFunction(services,"clock","services")()})
    : dependencyAddOperations({source,target,input,snapshot});
  if (decision.operations.length===0) return closedData({status:"already-reconciled",[remove ? "tombstone" : "edge"]:remove ? decision.tombstone : decision.edge},"dependency replay result");
  const confirm=confirmation(command,services);
  return ownDataFunction(services.operations,"execute","operations")({
    command,source:closedData(snapshot,"dependency mutation snapshot").source,
    operations:decision.operations,authority:null,...(confirm===undefined ? {} : {confirm}),
  });
}

async function read(command,services,check) {
  const root=command.args[0] ?? null;
  if (root!==null) parseWorkItemId(root);
  const snapshot=await ownDataFunction(services.github,"snapshot","github")({kind:"dependency-graph",root});
  return dependencyGraphResult(snapshot,root,{check});
}

export async function runDependencyCommand(command,services) {
  if (command.name==="dependency.add") return mutation(command,services,false);
  if (command.name==="dependency.remove") return mutation(command,services,true);
  if (command.name==="dependency.graph") return read(command,services,false);
  if (command.name==="dependency.check") return read(command,services,true);
  throw new CoreValidationError("Unsupported dependency command");
}
