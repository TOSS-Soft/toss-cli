import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {authorityReference} from "../authority.js";
import {CoreBlockedError,CoreConflictError,CoreValidationError} from "../errors.js";
import {
  activationOperations,
  normalizeReleasePlanningState,
  releasePlanOperations,
  releaseReconciliationEvidence,
  releaseStatusResult,
} from "../release/operations.js";
import {projectPatchCompletionTransaction} from "../release/patch-completion-projector.js";
import {planPatchInterruption} from "../release/patch.js";
import {
  approvalOperations,publicationOperations,publicationSource,releasePublicationQuery,
} from "../release/verification.js";
import {parseSemVer} from "../release/semver.js";
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

function releaseTarget(value) {
  const match=typeof value==="string"
    ? /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@(.+)$/u.exec(value) : null;
  if (!match) throw new CoreValidationError("Release target must be canonical OWNER/REPO@VERSION");
  parseSemVer(match[2]);
  return Object.freeze({repository:match[1],version:match[2]});
}

async function matchPersistedApprovalAuthority(command,services,release) {
  if (command.options.authority===null) return;
  const supplied=await ownDataFunction(services,"readAuthority","services")(
    command.options.authority,
  );
  if (canonicalJson(authorityReference(supplied))!==canonicalJson(release.approval?.authority)) {
    throw new CoreConflictError("Supplied authority does not identify the persisted release approval");
  }
}

function completedPatchPhaseEvidence(state,patch,paused,publication,{excludeIntentId=null}={}) {
  const candidates=[];
  const configuration=state.repositories.find(value => value.repository===publication.repository);
  for (const intent of state.intents) {
    if (intent.intent_id===excludeIntentId) continue;
    const aggregates=intent.operations.filter(operation =>
      operation.payload?.kind==="release-patch-completion-precondition");
    const targeted=aggregates.filter(operation =>
      operation.payload.query?.patch_program?.program_id===patch.program_id &&
      operation.payload.query?.paused_program?.program_id===paused.program_id);
    if (targeted.length===0) continue;
    if (targeted.length!==1 || aggregates.length!==1 || intent.command!=="release.approve") {
      throw new CoreConflictError("Patch completion intent target is ambiguous or uses the wrong command");
    }
    const aggregate=targeted[0];
    const query=aggregate.payload.query;
    const queryConfiguration=query.repositories?.find(value =>
      value.repository===publication.repository) ?? null;
    if (query.control_repository!==state.organization.control_repository ||
        query.organization?.organization!==state.organization.organization ||
        query.organization?.control_repository!==state.organization.control_repository ||
        query.organization?.policy_revision!==state.organization.policy_revision ||
        canonicalJson(query.organization?.project)!==canonicalJson(state.organization.project) ||
        canonicalJson(query.patch_program)!==canonicalJson(patch) ||
        canonicalJson(query.paused_program)!==canonicalJson(paused) ||
        canonicalJson(query.publication)!==canonicalJson(publication) ||
        canonicalJson(queryConfiguration)!==canonicalJson(configuration) ||
        canonicalJson(query.repository_configuration)!==canonicalJson(configuration) ||
        canonicalJson(query.project)!==canonicalJson(state.organization.project)) {
      throw new CoreConflictError("Patch completion intent does not bind the current exact target set");
    }
    const manifests=intent.operations.filter(operation =>
      operation.payload?.kind==="release-program-manifest");
    if (manifests.length!==1 ||
        canonicalJson(manifests[0].payload.program)!==canonicalJson(paused)) {
      throw new CoreConflictError("Patch completion phase does not preserve the exact paused program");
    }
    const receipts=state.receipts.filter(value => value.intent_id===intent.intent_id);
    if (receipts.length!==1 || receipts[0].status!=="completed") {
      throw new CoreConflictError("Patch completion receipt evidence is absent, failed, or ambiguous");
    }
    assertReceiptCoverage(receipts[0],intent,"Patch completion receipt");
    if (aggregate.payload.descriptor!==undefined) {
      const projected=projectPatchCompletionTransaction(query,aggregate.payload.descriptor);
      const actual=intent.operations.map(({operation_id:_operationId,...operation}) => operation);
      if (intent.planned_receipt_id!==aggregate.payload.descriptor.receipt_id ||
          canonicalJson(intent.source)!==canonicalJson(projected.source) ||
          canonicalJson(actual)!==canonicalJson(projected.operations)) {
        throw new CoreConflictError(
          "Patch completion receipt does not bind its exact projected transaction",
        );
      }
    }
    const reconciliations=intent.operations.filter(operation =>
      operation.payload?.kind==="release-patch-reconcile");
    const kind=reconciliations.length===1 ? "reconciliation" :
      query.phase_evidence?.reconciliation!==null && query.phase_evidence?.review_gate===null
        ? "review_gate" : null;
    if (kind===null || reconciliations.length>1) {
      throw new CoreConflictError("Patch completion phase cannot be classified exactly");
    }
    const createdAt=Date.parse(receipts[0].created_at);
    if (!Number.isFinite(createdAt)) {
      throw new CoreConflictError("Patch completion receipt time is invalid");
    }
    candidates.push({kind,intent,receipt:receipts[0],createdAt,
      evidence:closedData({intent,receipt:receipts[0]},"patch completion phase evidence")});
  }
  const roots=candidates.filter(candidate => candidate.kind==="reconciliation");
  const gates=candidates.filter(candidate => candidate.kind==="review_gate");
  if (roots.length===0) {
    if (gates.length!==0) {
      throw new CoreConflictError("Patch review gate is detached from reconciliation evidence");
    }
    return closedData({reconciliation:null,review_gate:null},
      "patch completion phase evidence set");
  }
  roots.sort((left,right) => left.createdAt-right.createdAt);
  for (let index=1;index<roots.length;index+=1) {
    if (roots[index-1].createdAt===roots[index].createdAt) {
      throw new CoreConflictError(
        "Patch completion has multiple equally active reconciliation chains",
      );
    }
  }
  const attachments=new Map(roots.map(root => [root,null]));
  for (const gate of gates) {
    const aggregate=gate.intent.operations.find(operation =>
      operation.payload?.kind==="release-patch-completion-precondition");
    const reference=aggregate.payload.query.phase_evidence.reconciliation;
    const matches=roots.filter(root =>
      canonicalJson(root.evidence)===canonicalJson(reference));
    if (matches.length!==1) {
      throw new CoreConflictError(
        "Patch review gate has dangling or cross-linked reconciliation evidence",
      );
    }
    const root=matches[0];
    const gateDefaults=gate.intent.operations.filter(operation =>
      operation.payload?.kind==="release-default-branch-precondition");
    const rootDefaults=root.intent.operations.filter(operation =>
      operation.payload?.kind==="release-default-branch-precondition");
    const withoutId=operation => {
      const {operation_id:_operationId,...value}=operation;
      return value;
    };
    if (gateDefaults.length!==1 || rootDefaults.length!==1 ||
        canonicalJson(withoutId(gateDefaults[0]))!==canonicalJson(withoutId(rootDefaults[0]))) {
      throw new CoreConflictError(
        "Patch review gate is cross-linked to a different reconciliation source",
      );
    }
    if (gate.createdAt<=root.createdAt) {
      throw new CoreConflictError("Patch review gate must postdate its reconciliation root");
    }
    const nextRoot=roots[roots.indexOf(root)+1] ?? null;
    if (nextRoot!==null && gate.createdAt>=nextRoot.createdAt) {
      throw new CoreConflictError(
        "Patch review gate cannot overlap a superseding reconciliation chain",
      );
    }
    if (attachments.get(root)!==null) {
      throw new CoreConflictError("Patch reconciliation has duplicate review-gate attachments");
    }
    attachments.set(root,gate);
  }
  const active=roots.at(-1);
  return closedData({reconciliation:active.evidence,
    review_gate:attachments.get(active)?.evidence ?? null},
  "patch completion phase evidence set");
}

function historicalRevision(index) {
  return `REV-${String(index+2).padStart(4,"0")}`;
}

function completedPatchResume(state,patch,paused,releaseId) {
  const feature=paused.repository_releases.find(value => value.release_id===releaseId);
  if (feature===undefined) return null;
  const pauses=feature.transitions.map((transition,index) => ({transition,index}))
    .filter(value => value.transition.event==="PAUSE_FOR_PATCH" &&
      historicalRevision(value.index)===patch.interrupts.paused_release_revision);
  if (pauses.length!==1) {
    throw new CoreConflictError("Patch interruption lacks one exact historical pause transition");
  }
  const resumes=feature.transitions.map((transition,index) => ({transition,index}))
    .filter(value => value.index>pauses[0].index && value.transition.event==="RESUME_AFTER_PATCH");
  if (resumes.length===0) return null;
  const {transition,index}=resumes[0];
  const receipts=state.receipts.filter(value => value.receipt_id===transition.source_receipt);
  if (receipts.length!==1 || receipts[0].status!=="completed") {
    throw new CoreConflictError("Patch resume transition lacks one completed immutable receipt");
  }
  const intents=state.intents.filter(value => value.intent_id===receipts[0].intent_id);
  if (intents.length!==1) throw new CoreConflictError("Patch resume intent evidence is ambiguous");
  assertReceiptCoverage(receipts[0],intents[0],"Patch resume receipt");
  const manifests=intents[0].operations.filter(operation =>
    operation.payload?.kind==="release-program-manifest" &&
    operation.payload.program?.program_id===paused.program_id);
  const recordedFeature=manifests[0]?.payload.program.repository_releases.find(value =>
    value.release_id===releaseId) ?? null;
  const aggregates=intents[0].operations.filter(operation =>
    operation.payload?.kind==="release-patch-completion-precondition" &&
    operation.payload.query?.patch_program?.program_id===patch.program_id &&
    operation.payload.query?.paused_program?.program_id===paused.program_id);
  const query=aggregates[0]?.payload.query ?? null;
  const sourceFeature=query?.paused_program?.repository_releases.find(value =>
    value.release_id===releaseId) ?? null;
  const manifestObservations=receipts[0].observed_revisions.filter(value =>
    value.operation_id===manifests[0]?.operation_id);
  if (intents[0].command!=="release.approve" || manifests.length!==1 || aggregates.length!==1 ||
      intents[0].planned_receipt_id!==receipts[0].receipt_id ||
      canonicalJson(query.patch_program)!==canonicalJson(patch) ||
      canonicalJson(query.publication)!==canonicalJson(
        patch.repository_releases.find(value => value.repository===feature.repository)
          ?.publication_evidence ?? null) ||
      canonicalJson(query.programs.find(value => value.program_id===patch.program_id))!==canonicalJson(patch) ||
      canonicalJson(query.programs.find(value => value.program_id===paused.program_id))!==
        canonicalJson(query.paused_program) ||
      sourceFeature===null || sourceFeature.phase!=="PAUSED" ||
      sourceFeature.revision!==patch.interrupts.paused_release_revision ||
      canonicalJson(sourceFeature.transitions)!==canonicalJson(feature.transitions.slice(0,index)) ||
      recordedFeature===null || recordedFeature.revision!==historicalRevision(index) ||
      canonicalJson(recordedFeature.transitions)!==
        canonicalJson(feature.transitions.slice(0,index+1)) ||
      manifestObservations.length!==1 ||
      manifestObservations[0].repository!==state.organization.control_repository ||
      manifestObservations[0].revision!==manifests[0].payload.program.revision) {
    throw new CoreConflictError("Patch resume receipt does not prove the linked historical transition");
  }
  return Object.freeze({intent_id:intents[0].intent_id,query});
}

async function completeReleasedPatch(command,services,state,patch,patchRelease) {
  const paused=state.programs.find(value => value.program_id===patch.interrupts.program_id) ?? null;
  if (paused===null) throw new CoreConflictError("Released patch no longer identifies its feature program");
  const feature=paused.repository_releases.find(value =>
    value.release_id===patch.interrupts.repository_release_id) ?? null;
  if (feature===null || feature.repository!==patchRelease.repository) {
    throw new CoreConflictError("Released patch no longer identifies its feature release");
  }
  const completedResume=completedPatchResume(state,patch,paused,feature.release_id);
  if (completedResume!==null) {
    const historicalPaused=completedResume.query.paused_program;
    const historicalState={...state,revision:completedResume.query.control_revision,
      organization:completedResume.query.organization,
      repositories:completedResume.query.repositories,
      programs:completedResume.query.programs};
    const phaseEvidence=completedPatchPhaseEvidence(historicalState,
      patch,historicalPaused,patchRelease.publication_evidence,
      {excludeIntentId:completedResume.intent_id});
    if (canonicalJson(phaseEvidence)!==canonicalJson(completedResume.query.phase_evidence)) {
      throw new CoreConflictError("Patch resume does not bind the exact completed phase chain");
    }
    return closedData({status:"already-released",program_id:patch.program_id,
      release_id:patchRelease.release_id,version:patchRelease.version,
      patch_reconciled:true},"patch release replay result");
  }
  if (feature.phase!=="PAUSED" || paused.phase!=="PAUSED" ||
      feature.revision!==patch.interrupts.paused_release_revision) {
    throw new CoreConflictError("Released patch feature is neither paused nor receipt-backed resumed");
  }
  const configuration=state.repositories.find(value =>
    value.repository===patchRelease.repository) ?? null;
  if (configuration===null) throw new CoreConflictError("Released patch repository is not registered");
  const operations=ownDataValue(services,"operations","services");
  const receiptId=ownDataFunction(operations,"reserveReceiptId","operations")();
  const ledgerSha256=sha256Canonical({intents:state.intents,receipts:state.receipts});
  const phaseEvidence=completedPatchPhaseEvidence(
    state,patch,paused,patchRelease.publication_evidence,
  );
  const query=closedData({kind:"patch-completion",control_revision:state.revision,
    control_repository:state.organization.control_repository,organization:state.organization,
    repositories:state.repositories,programs:state.programs,ledger_sha256:ledgerSha256,
    patch_program:patch,paused_program:paused,publication:patchRelease.publication_evidence,
    repository_configuration:configuration,project:state.organization.project,
    phase_evidence:phaseEvidence},"patch completion query");
  const observation=closedData(await ownDataFunction(
    ownDataValue(services,"github","services"),"snapshot","github",
  )(query),"patch completion GitHub observation");
  const timestamp=ownDataFunction(services,"clock","services")();
  const selected=projectPatchCompletionTransaction(query,{observation,
    receipt_id:receiptId,timestamp});
  const confirm=confirmation(command,services);
  const result=await ownDataFunction(operations,"execute","operations")({command,
    source:selected.source,operations:selected.operations,authority:null,receipt_id:receiptId,
    ...(confirm===undefined ? {} : {confirm})});
  return closedData({...result,next_command:`toss-core release approve ${patchRelease.repository}@${patchRelease.version}`},
    "patch completion command result");
}

async function approve(command,services) {
  if (command.options.from!==null) {
    throw new CoreValidationError("Release approve does not accept an input file");
  }
  const target=releaseTarget(command.args[0]);
  const state=await planningState(services,{requireResolved:false});
  assertResolvedReleaseEvidence(state,{repository:target.repository});
  const matches=state.programs.flatMap(program => program.repository_releases
    .filter(release => release.repository===target.repository && release.version===target.version)
    .map(release => ({program,release})));
  if (matches.length!==1) {
    throw new CoreConflictError(`Release target must identify exactly one repository track: ${command.args[0]}`);
  }
  const {program,release}=matches[0];
  if (["PUBLISHING","RELEASED"].includes(release.phase)) {
    await matchPersistedApprovalAuthority(command,services,release);
  }
  if (release.phase==="RELEASED" && program.interrupts===null) {
    return closedData({status:"already-released",program_id:program.program_id,
      release_id:release.release_id,version:release.version},"release approval replay result");
  }
  if (release.phase==="RELEASED") {
    return completeReleasedPatch(command,services,state,program,release);
  }
  if (release.phase==="PUBLISHING") {
    const operations=ownDataValue(services,"operations","services");
    const receiptId=ownDataFunction(operations,"reserveReceiptId","operations")();
    const query=releasePublicationQuery(state,program.program_id,release.release_id);
    const githubSnapshot=closedData(await ownDataFunction(
      ownDataValue(services,"github","services"),"snapshot","github",
    )(query),"release publication GitHub snapshot");
    const snapshot=closedData({...githubSnapshot,source:publicationSource(query,githubSnapshot)},
      "release publication GitHub snapshot aggregate");
    const decision=publicationOperations({planningState:state,programId:program.program_id,
      releaseId:release.release_id,snapshot,receiptId,
      clock:ownDataFunction(services,"clock","services")});
    const confirm=confirmation(command,services);
    return ownDataFunction(operations,"execute","operations")({command,
      source:decision.source,operations:decision.operations,authority:null,
      receipt_id:receiptId,...(confirm===undefined ? {} : {confirm})});
  }
  if (release.phase!=="READY_FOR_APPROVAL") {
    throw new CoreConflictError(`Release ${command.args[0]} is not ready for approval`);
  }
  if (command.options.authority===null) {
    throw new CoreBlockedError("Release approval requires --authority <FILE>");
  }
  const authority=await ownDataFunction(services,"readAuthority","services")(
    command.options.authority,
  );
  const operations=ownDataValue(services,"operations","services");
  const receiptId=ownDataFunction(operations,"reserveReceiptId","operations")();
  const configuration=state.repositories.find(value => value.repository===release.repository);
  if (!configuration?.publication) {
    throw new CoreConflictError("Release approval requires registered publication policy");
  }
  const query=closedData({kind:"release-approval",control_revision:state.revision,
    organization:state.organization,programs:state.programs,program,release,
    repository_configuration:configuration,project:state.organization.project},
  "release approval query");
  const githubSnapshot=await ownDataFunction(
    ownDataValue(services,"github","services"),"snapshot","github",
  )(query);
  const snapshot=bindSnapshot(state,githubSnapshot,"release approval GitHub snapshot");
  const decision=approvalOperations({planningState:state,programId:program.program_id,
    releaseId:release.release_id,snapshot,receiptId,authority,
    clock:ownDataFunction(services,"clock","services")});
  const confirm=confirmation(command,services);
  return ownDataFunction(operations,"execute","operations")({
    command,source:decision.source,operations:decision.operations,authority,
    receipt_id:receiptId,...(confirm===undefined ? {} : {confirm}),
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
  if (command.name==="release.approve") return approve(command,services);
  throw new CoreValidationError("Unsupported release command");
}
