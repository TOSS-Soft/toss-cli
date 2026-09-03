import {types} from "node:util";

import {sha256Canonical} from "../../contracts/acp.js";
import {CoreBlockedError,CoreConflictError,CoreValidationError} from "../errors.js";
import {
  activationOperations,
  normalizeReleasePlanningState,
  releasePlanOperations,
  releaseReconciliationEvidence,
  releaseStatusResult,
} from "../release/operations.js";
import {planPatchInterruption} from "../release/patch.js";
import {closedData,ownDataFunction,ownDataValue} from "./common.js";

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

function assertResolvedReleaseEvidence(state,{programId=null,repository=null}={}) {
  const reconciliation=releaseReconciliationEvidence({planningState:state,programId,repository});
  if (reconciliation.required) {
    throw new CoreBlockedError(`Release operation ${reconciliation.evidence[0].intent.intent_id} has unresolved partial or failed evidence`);
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
  )({kind:"release-status",control_revision:state.revision,programs:state.programs,
    program:candidates[0]?.program ?? null,
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

function featureProgramForBug(state,repository) {
  const candidates=state.programs.filter(program => program.interrupts===null &&
    program.repository_releases.some(release => release.repository===repository &&
      ["ACTIVE","PAUSED"].includes(release.phase)));
  if (candidates.length!==1) {
    throw new CoreConflictError("Bounded production bug requires exactly one active or paused feature release");
  }
  return candidates[0];
}

function patchNextResult(result,id) {
  return closedData({...result,next_command:`toss-core issue start ${id}`},
    "patch interruption command result");
}

function patchTransitionEvidence(state,featureProgram,patchPrograms,repository,id) {
  const activePatch=patchPrograms.find(program => program.repository_releases.some(release =>
    release.repository===repository && ["ACTIVE","READY_FOR_APPROVAL","PUBLISHING"].includes(release.phase) &&
    release.scope.includes(id))) ?? null;
  const selectedProgram=activePatch ?? (featureProgram.repository_releases.some(release =>
    release.repository===repository && release.phase==="PAUSED") ? featureProgram : null);
  if (selectedProgram===null) return null;
  const release=selectedProgram.repository_releases.find(value => value.repository===repository);
  const transition=release?.transitions.at(-1) ?? null;
  const matchingReceipts=transition===null ? [] : state.receipts.filter(value =>
    value.receipt_id===transition.source_receipt);
  if (matchingReceipts.length>1) throw new CoreConflictError("Patch transition receipt identity is ambiguous");
  const receipt=matchingReceipts[0] ?? null;
  const matchingIntents=receipt===null ? [] : state.intents.filter(value =>
    value.intent_id===receipt.intent_id);
  if (matchingIntents.length>1) throw new CoreConflictError("Patch transition intent identity is ambiguous");
  return closedData({program_id:selectedProgram.program_id,release_id:release.release_id,
    event:transition?.event ?? null,intent:matchingIntents[0] ?? null,receipt},
  "patch transition evidence");
}

export async function runPatchInterruptionStep(command,services,bugSnapshot) {
  const bug=closedData(bugSnapshot,"patch interruption bug snapshot");
  if (bug?.work?.item?.kind!=="bug") return null;
  const id=bug.work.item.id;
  const repository=bug.work.item.repository;
  const state=await planningState(services,{requireResolved:false});
  assertResolvedReleaseEvidence(state,{repository});
  const program=featureProgramForBug(state,repository);
  const operations=ownDataValue(services,"operations","services");
  const receiptId=ownDataFunction(operations,"reserveReceiptId","operations")();
  const repositoryConfiguration=state.repositories.find(value =>
    value.repository===repository) ?? null;
  if (repositoryConfiguration===null) {
    throw new CoreConflictError(`Repository is not registered for patch interruption: ${repository}`);
  }
  const patchPrograms=state.programs.filter(value => value.interrupts!==null);
  const transitionEvidence=patchTransitionEvidence(state,program,patchPrograms,repository,id);
  const ledgerSha256=sha256Canonical({intents:state.intents,receipts:state.receipts});
  const query=closedData({kind:"patch-interruption",control_revision:state.revision,
    bug_id:id,feature_program:program,patch_programs:patchPrograms,
    programs:state.programs,ledger_sha256:ledgerSha256,
    transition_evidence:transitionEvidence,
    organization:state.organization,repositories:state.repositories,
    repository_configuration:repositoryConfiguration,
    project:state.organization.project},"patch interruption query");
  const observation=await ownDataFunction(
    ownDataValue(services,"github","services"),"snapshot","github",
  )(query);
  const snapshot=closedData({
    source:{repository:state.organization.control_repository,revision:state.revision,
      sha256:sha256Canonical({control:{revision:state.revision,
        organization:state.organization,repositories:state.repositories,programs:state.programs,
        ledger_sha256:ledgerSha256},github:observation})},
    query,observation,receipt_id:receiptId,
    timestamp:ownDataFunction(services,"clock","services")(),
  },"patch interruption aggregate snapshot");
  const decision=planPatchInterruption({bug,
    latestPublished:observation.latest_published,activeFeatureProgram:program,snapshot});
  const selected=decision.pauseOperations.length>0
    ? decision.pauseOperations
    : decision.patchOperations;
  if (selected.length>0 && selected.every(operation => operation.action==="verify")) {
    return closedData({continue_issue_start:true,source:snapshot.source,
      operations:selected,receipt_id:receiptId},"patch issue-start continuation");
  }
  if (selected.length===0) return null;
  const confirm=confirmation(command,services);
  const result=await ownDataFunction(operations,"execute","operations")({
    command,source:snapshot.source,operations:selected,authority:null,receipt_id:receiptId,
    ...(confirm===undefined ? {} : {confirm}),
  });
  return patchNextResult(result,id);
}

export async function runReleaseCommand(command,services) {
  if (command.name==="release.plan") return plan(command,services);
  if (command.name==="release.activate") return activate(command,services);
  if (command.name==="release.status") return status(command,services);
  throw new CoreValidationError("Unsupported release command");
}
