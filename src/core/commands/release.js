import {types} from "node:util";

import {sha256Canonical} from "../../contracts/acp.js";
import {validateCoreDocument} from "../contracts.js";
import {CoreBlockedError,CoreConflictError,CoreValidationError} from "../errors.js";
import {
  activationOperations,
  normalizeReleasePlanningState,
  releasePlanOperations,
  releaseStatusResult,
} from "../release/operations.js";
import {assertReceiptCoverage,closedData,ownDataFunction,ownDataValue} from "./common.js";

function assertUngated(command) {
  if (command.options.authority!==null || command.options.from!==null) {
    throw new CoreValidationError("Release planning and activation do not accept authority or input files");
  }
}

function confirmation(command,services) {
  if (!command.options.apply || !command.interactive) return undefined;
  if (!services || typeof services!=="object" || types.isProxy(services) ||
      !Object.hasOwn(services,"confirm")) {
    throw new CoreBlockedError("Interactive apply requires CLI confirmation");
  }
  return ownDataFunction(services,"confirm","services");
}

function compareProgramIds(left,right) {
  const leftMatch=typeof left==="string" ? /^TOSS-OS-R([0-9]{4,})$/u.exec(left) : null;
  const rightMatch=typeof right==="string" ? /^TOSS-OS-R([0-9]{4,})$/u.exec(right) : null;
  if (!leftMatch || !rightMatch) throw new CoreValidationError("Release program identity is not canonical");
  const leftNumber=BigInt(leftMatch[1]);
  const rightNumber=BigInt(rightMatch[1]);
  return leftNumber<rightNumber ? -1 : leftNumber>rightNumber ? 1 : left<right ? -1 : left>right ? 1 : 0;
}

function releaseIntentAffects(intent,{programId,repository}) {
  if (programId===null && repository===null) return true;
  const operations=intent.operations;
  const programMatch=programId!==null && operations.some(operation =>
    operation.payload?.program_id===programId || operation.payload?.program?.program_id===programId);
  const repositoryMatch=repository!==null && operations.some(operation =>
    (operation.payload?.kind!=="release-program-manifest" && operation.repository===repository) ||
    (Array.isArray(operation.payload?.program?.repository_releases) &&
      operation.payload.program.repository_releases.some(release => release?.repository===repository)));
  return programMatch || repositoryMatch;
}

function assertResolvedReleaseEvidence(state,{programId=null,repository=null}={}) {
  const receipts=new Map();
  for (const value of state.receipts) {
    const receipt=validateCoreDocument(value,"operation-receipt.v1");
    if (receipts.has(receipt.intent_id)) throw new CoreConflictError("Release receipt evidence is ambiguous");
    receipts.set(receipt.intent_id,receipt);
  }
  for (const value of state.intents) {
    const intent=validateCoreDocument(value,"operation-intent.v1");
    if (!intent.command.startsWith("release.") ||
        !releaseIntentAffects(intent,{programId,repository})) continue;
    const receipt=receipts.get(intent.intent_id);
    if (receipt) assertReceiptCoverage(receipt,intent,"Release operation receipt");
    if (!receipt || receipt.status!=="completed") {
      throw new CoreBlockedError(`Release operation ${intent.intent_id} has unresolved partial or failed evidence`);
    }
  }
}

async function planningState(services,{requireResolved=true}={}) {
  const control=ownDataValue(services,"control","services");
  const state=normalizeReleasePlanningState(
    await ownDataFunction(control,"loadReleasePlanningState","control")(),
  );
  if (requireResolved) assertResolvedReleaseEvidence(state);
  return state;
}

function bindSnapshot(state,input,label) {
  const github=closedData(input,label);
  if (!github || typeof github!=="object" || Array.isArray(github) || Object.hasOwn(github,"source")) {
    throw new CoreValidationError(`${label} must contain only independent GitHub evidence`);
  }
  return closedData({...github,source:{
    repository:state.organization.control_repository,
    revision:state.revision,
    sha256:sha256Canonical({control:state,github}),
  }},`${label} aggregate`);
}

async function status(command,services) {
  if (command.options.from!==null || command.options.authority!==null) {
    throw new CoreValidationError("Release status does not accept authority or input files");
  }
  const state=await planningState(services,{requireResolved:false});
  const repository=command.args[0];
  const active=new Set(["ACTIVE","PAUSED","READY_FOR_APPROVAL","PUBLISHING"]);
  const candidates=state.programs.flatMap(program => program.repository_releases
    .filter(release => release.repository===repository)
    .map(release => ({program,release,rank:active.has(release.phase) ? 2 : release.phase!=="RELEASED" ? 1 : 0})));
  candidates.sort((left,right) => right.rank-left.rank ||
    compareProgramIds(right.program.program_id,left.program.program_id));
  const programId=candidates[0]?.program.program_id ?? null;
  const githubSnapshot=await ownDataFunction(
    ownDataValue(services,"github","services"),"snapshot","github",
  )({kind:"release-status",control_revision:state.revision,program:candidates[0]?.program ?? null,
    release:candidates[0]?.release ?? null,repository,
    repository_configuration:state.repositories.find(value => value.repository===repository) ?? null,
    project:state.organization.project});
  const snapshot=bindSnapshot(state,githubSnapshot,"release status GitHub snapshot");
  return releaseStatusResult({planningState:state,repository,snapshot});
}

async function plan(command,services) {
  assertUngated(command);
  const state=await planningState(services);
  const github=ownDataValue(services,"github","services");
  const githubSnapshot=await ownDataFunction(github,"snapshot","github")({
    kind:"release-plan",
    control_revision:state.revision,
    organization:state.organization,
    repositories:state.repositories,
    programs:state.programs,
  });
  const snapshot=bindSnapshot(state,githubSnapshot,"release plan GitHub snapshot");
  const decision=releasePlanOperations({
    planningState:state,
    snapshot,
    clock:ownDataFunction(services,"clock","services"),
  });
  if (decision.operations.length===0) {
    return closedData({status:"already-reconciled",program:decision.program},"release plan replay result");
  }
  const confirm=confirmation(command,services);
  return ownDataFunction(
    ownDataValue(services,"operations","services"),"execute","operations",
  )({
    command,
    source:decision.source,
    operations:decision.operations,
    authority:null,
    ...(confirm===undefined ? {} : {confirm}),
  });
}

async function activate(command,services) {
  assertUngated(command);
  const programId=command.args[0];
  const repository=command.args[1] ?? null;
  const state=await planningState(services,{requireResolved:false});
  assertResolvedReleaseEvidence(state,{programId,repository});
  const operations=ownDataValue(services,"operations","services");
  const receiptId=ownDataFunction(operations,"reserveReceiptId","operations")();
  const selectedProgram=state.programs.find(value => value.program_id===programId) ?? null;
  if (selectedProgram===null) throw new CoreConflictError(`Unknown release program: ${programId}`);
  const selectedRepositories=repository===null
    ? state.repositories.filter(configuration => selectedProgram?.repository_releases.some(release =>
      release.repository===configuration.repository))
    : state.repositories.filter(configuration => configuration.repository===repository);
  const githubSnapshot=await ownDataFunction(
    ownDataValue(services,"github","services"),"snapshot","github",
  )({
    kind:"release-activation",
    control_revision:state.revision,
    program:selectedProgram,
    repository,
    repository_configurations:selectedRepositories,
    project:state.organization.project,
  });
  const snapshot=bindSnapshot(state,githubSnapshot,"release activation GitHub snapshot");
  const decision=activationOperations({
    planningState:state,programId,repository,snapshot,receiptId,
    clock:ownDataFunction(services,"clock","services"),
  });
  const confirm=confirmation(command,services);
  return ownDataFunction(operations,"execute","operations")({
    command,source:decision.source,operations:decision.operations,authority:null,
    receipt_id:receiptId,
    ...(confirm===undefined ? {} : {confirm}),
  });
}

export async function runReleaseCommand(command,services) {
  if (command.name==="release.plan") return plan(command,services);
  if (command.name==="release.activate") return activate(command,services);
  if (command.name==="release.status") return status(command,services);
  throw new CoreValidationError("Unsupported release command");
}
