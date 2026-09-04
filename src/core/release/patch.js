import {createHash} from "node:crypto";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {closedData,exact} from "../commands/common.js";
import {validateCoreDocument} from "../contracts.js";
import {parseWorkItemId} from "../domain/identity.js";
import {deriveWorkItemState} from "../domain/state.js";
import {CoreBlockedError,CoreConflictError,CoreValidationError} from "../errors.js";
import {projectPatchCompletionTransaction} from "./patch-completion-projector.js";
import {nextVersion,parseSemVer} from "./semver.js";
import {assertRepositoryConcurrency,transitionRepositoryRelease} from "./state.js";

const PATCH_REQUEST_KEYS=Object.freeze([
  "bug","latestPublished","activeFeatureProgram","snapshot",
]);
const PATCH_SNAPSHOT_KEYS=Object.freeze([
  "source","query","observation","receipt_id","timestamp",
]);
const PATCH_OBSERVATION_KEYS=Object.freeze([
  "kind","control_revision","project","feature","patch_program_revisions",
  "bug","latest_published","repository",
]);
const PROGRAM_ID=/^TOSS-OS-R([0-9]{4,})$/u;
const RECEIPT_ID=/^RECEIPT-[0-9]{8}-[0-9]{4,}$/u;
const SHA=/^[a-f0-9]{40}$/u;
const HASH=/^[a-f0-9]{64}$/u;
const RFC3339=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u;

function invalid(message,options={}) {
  throw new CoreValidationError(message,options);
}

function timestamp(value,label) {
  const match=typeof value==="string" ? RFC3339.exec(value) : null;
  if (!match) invalid(`${label} must be an RFC3339 timestamp`);
  const [,yearText,monthText,dayText,hourText,minuteText,secondText,
    offsetHourText,offsetMinuteText]=match;
  const year=Number(yearText); const month=Number(monthText); const day=Number(dayText);
  const leap=year%4===0 && (year%100!==0 || year%400===0);
  const days=month===2 ? (leap ? 29 : 28) : [4,6,9,11].includes(month) ? 30 : 31;
  if (month<1 || month>12 || day<1 || day>days || Number(hourText)>23 ||
      Number(minuteText)>59 || Number(secondText)>59 ||
      (offsetHourText!==undefined &&
        (Number(offsetHourText)>23 || Number(offsetMinuteText)>59))) {
    invalid(`${label} must be an RFC3339 timestamp`);
  }
  return value;
}

function incrementRevision(value,label) {
  const match=/^REV-([0-9]{4,})$/u.exec(value);
  if (!match) invalid(`${label} must be a canonical revision`);
  const revision=Number(match[1]);
  if (!Number.isSafeInteger(revision) || revision<1 || revision===Number.MAX_SAFE_INTEGER) {
    invalid(`${label} cannot be incremented safely`);
  }
  const next=String(revision+1);
  return `REV-${next.padStart(Math.max(4,match[1].length),"0")}`;
}

function nextProgramId(programs) {
  let greatest=0n;
  let width=4;
  for (const program of programs) {
    const match=PROGRAM_ID.exec(program.program_id);
    if (!match) invalid("Patch snapshot contains a noncanonical program identity");
    const value=BigInt(match[1]);
    if (value>greatest) greatest=value;
    width=Math.max(width,match[1].length);
  }
  const next=String(greatest+1n);
  return `TOSS-OS-R${next.padStart(Math.max(width,next.length),"0")}`;
}

function releaseId(programId,repository) {
  const digest=createHash("sha256").update(repository,"utf8").digest("hex");
  return `REL-${programId}-${digest}`;
}

function releaseIntentId(releaseIdentity) {
  return `RELEASE-PR-INTENT-${BigInt(`0x${sha256Canonical(releaseIdentity)}`).toString(10)}`;
}

function programPhase(releases) {
  if (releases.every(release => release.phase==="RELEASED")) return "RELEASED";
  if (releases.some(release => release.phase==="PUBLISHING")) return "PUBLISHING";
  if (releases.some(release => release.phase==="PAUSED")) return "PAUSED";
  return "ACTIVE";
}

function normalizeRequest(input) {
  const value=closedData(input,"patch interruption request");
  exact(value,PATCH_REQUEST_KEYS,"patch interruption request");
  const bug=value.bug;
  exact(bug,["kind","source","repository_revision","work","branch","base","pull_request","bug_lineage"],"patch bug snapshot");
  if (bug.kind!=="issue-start" || bug.work?.item?.kind!=="bug") {
    invalid("Patch interruption requires an issue-start snapshot for one bounded bug");
  }
  deriveWorkItemState(bug.work);
  const identity=parseWorkItemId(bug.work.item.id);
  exact(bug.bug_lineage,["classification","affected_version","patch_version"],"patch bug lineage");
  if (bug.bug_lineage.classification!=="patch") invalid("Bounded bug lineage must be patch");
  const latest=validateCoreDocument(value.latestPublished,"publication-evidence.v1");
  if (latest?.schema_version!=="publication-evidence.v1" || latest.repository!==identity.repository ||
      latest.version!==bug.bug_lineage.affected_version || latest.expected_revision!==latest.tag?.target_revision ||
      latest.expected_revision!==latest.github_release?.target_revision || latest.tag?.name!==`v${latest.version}` ||
      latest.github_release?.tag_name!==`v${latest.version}` || latest.package?.version!==latest.version ||
      latest.github_release?.draft!==false || latest.github_release?.prerelease!==false) {
    throw new CoreConflictError("Bounded bug affected version is not the exact verified latest publication");
  }
  const version=patchVersionFor(latest.version);
  if (bug.bug_lineage.patch_version!==version.version) {
    throw new CoreConflictError("Bounded bug patch lineage conflicts with verified publication history");
  }
  assertRepositoryConcurrency([value.activeFeatureProgram]);
  const feature=value.activeFeatureProgram.repository_releases.find(release =>
    release.repository===identity.repository);
  if (!feature || !["ACTIVE","PAUSED"].includes(feature.phase) ||
      value.activeFeatureProgram.interrupts!==null) {
    throw new CoreConflictError("Patch interruption requires the exact active or paused feature release");
  }
  if (feature.version===latest.version) {
    throw new CoreConflictError("Patch interruption requires a distinct unreleased feature release");
  }
  parseSemVer(feature.version);

  const snapshot=value.snapshot;
  exact(snapshot,PATCH_SNAPSHOT_KEYS,"patch interruption snapshot");
  exact(snapshot.source,["repository","revision","sha256"],"patch interruption source");
  const query=snapshot.query;
  exact(query,["kind","control_revision","bug_id","feature_program","patch_programs",
    "programs","ledger_sha256","transition_evidence","organization","repositories",
    "repository_configuration","project"],"patch interruption query");
  timestamp(snapshot.timestamp,"Patch interruption timestamp");
  const queryOrganization=validateCoreDocument(query.organization,"organization-config.v1");
  const queryRepositories=Array.isArray(query.repositories) ? query.repositories.map(repository =>
    validateCoreDocument(repository,"repository-config.v1")) : invalid("Patch repository registry must be an array");
  validateCoreDocument(query.repository_configuration,"repository-config.v1");
  if (!Array.isArray(query.programs) || !Array.isArray(query.patch_programs)) {
    invalid("Patch query program collections must be arrays");
  }
  assertRepositoryConcurrency(query.programs);
  const queryFeature=query.programs.find(program =>
    program.program_id===value.activeFeatureProgram.program_id);
  const queryPatches=query.programs.filter(program => program.interrupts!==null);
  if (canonicalJson(queryFeature)!==canonicalJson(value.activeFeatureProgram) ||
      canonicalJson(queryPatches)!==canonicalJson(query.patch_programs) ||
      canonicalJson(queryRepositories.map(repository => repository.repository))!==
        canonicalJson(queryOrganization.repositories) ||
      canonicalJson(queryRepositories.find(repository => repository.repository===identity.repository))!==
        canonicalJson(query.repository_configuration) ||
      canonicalJson(query.project)!==canonicalJson(queryOrganization.project)) {
    throw new CoreConflictError("Patch query conflicts with its program, repository, or Project registry");
  }
  const control=query===null || typeof query!=="object" ? null : {
    revision:query.control_revision,organization:query.organization,
    repositories:query.repositories,programs:query.programs,
    ledger_sha256:query.ledger_sha256,
  };
  if (snapshot.source.revision!==snapshot.observation?.control_revision ||
      query.kind!=="patch-interruption" || query.control_revision!==snapshot.source.revision ||
      query.bug_id!==bug.work.item.id ||
      snapshot.source.repository!==query?.organization?.control_repository ||
      typeof snapshot.source.repository!=="string" || !HASH.test(snapshot.source.sha256) ||
      snapshot.source.sha256!==sha256Canonical({control,github:snapshot.observation}) ||
      !RECEIPT_ID.test(snapshot.receipt_id)) {
    throw new CoreConflictError("Patch interruption snapshot does not bind its control revision and receipt");
  }
  const observed=snapshot.observation;
  exact(observed,PATCH_OBSERVATION_KEYS,"patch interruption observation");
  exact(observed.project,["id","revision"],"patch Project observation");
  exact(observed.feature,["program_id","program_revision","release_id","release_revision"],"patch feature observation");
  exact(observed.bug,["id","revision","affected_version","work_sha256"],"patch bug observation");
  exact(observed.repository,["repository","revision","default_branch","milestone","release_branch"],"patch repository observation");
  exact(observed.repository.default_branch,["name","revision","head_sha"],"patch default branch observation");
  if (observed.kind!=="patch-interruption" || observed.feature.program_id!==value.activeFeatureProgram.program_id ||
      observed.feature.program_revision!==value.activeFeatureProgram.revision ||
      observed.feature.release_id!==feature.release_id || observed.feature.release_revision!==feature.revision ||
      observed.bug.id!==bug.work.item.id || observed.bug.affected_version!==latest.version ||
      observed.bug.work_sha256!==sha256Canonical(bug.work) || observed.latest_published.evidence_id!==latest.evidence_id ||
      canonicalJson(observed.latest_published)!==canonicalJson(latest) ||
      observed.repository.repository!==identity.repository ||
      observed.repository.default_branch.name!==snapshot.query?.repository_configuration?.default_branch ||
      !SHA.test(observed.repository.default_branch.head_sha) ||
      observed.project.id!==snapshot.query?.project?.node_id ||
      bug.work.item.repository!==identity.repository ||
      bug.work.project.project_id!==snapshot.query?.project?.node_id ||
      bug.work.project.fields.repository!==identity.repository) {
    throw new CoreConflictError("Patch interruption observations conflict with the exact bug, program, repository, or publication");
  }
  if (!Array.isArray(observed.patch_program_revisions)) invalid("Patch program revisions must be an array");
  if (observed.patch_program_revisions.some((entry,index) => {
    exact(entry,["program_id","revision","phase","release_id","release_revision","scope"],`patch program revision[${index}]`);
    return !PROGRAM_ID.test(entry.program_id) || !Array.isArray(entry.scope);
  })) invalid("Patch program revision evidence is malformed");
  if (observed.patch_program_revisions.some(entry =>
    ["ACTIVE","READY_FOR_APPROVAL","PUBLISHING"].includes(entry.phase) && !entry.scope.includes(bug.work.item.id))) {
    throw new CoreConflictError("A second active patch release already owns the repository");
  }
  const patchPrograms=snapshot.query?.patch_programs;
  if (!Array.isArray(snapshot.query?.programs) || !Array.isArray(patchPrograms) ||
      !HASH.test(snapshot.query?.ledger_sha256) ||
      !(snapshot.query?.transition_evidence===null ||
        typeof snapshot.query?.transition_evidence==="object")) {
    invalid("Patch query must include persisted programs and exact transition evidence");
  }
  const targetPatchPrograms=patchPrograms.filter(program =>
    program.repository_releases.some(release => release.repository===identity.repository));
  const expectedPatchRevisions=targetPatchPrograms.map(program => {
    const release=program.repository_releases.find(value => value.repository===identity.repository);
    return {program_id:program.program_id,revision:program.revision,phase:program.phase,
      release_id:release.release_id,release_revision:release.revision,scope:release.scope};
  });
  if (canonicalJson(observed.patch_program_revisions)!==canonicalJson(expectedPatchRevisions)) {
    throw new CoreConflictError("Patch program observations do not bind every persisted patch program");
  }
  return Object.freeze({value,bug,identity,latest,version,feature,snapshot,observed,
    patchPrograms});
}

function completedManifestTransition(program,releaseId,event,query) {
  const release=program.repository_releases.find(value => value.release_id===releaseId);
  const transition=release?.transitions.at(-1);
  if (!release || transition?.event!==event) {
    throw new CoreBlockedError(`Patch interruption requires ${event} as the release's current transition`);
  }
  const evidence=query.transition_evidence;
  if (evidence===null || evidence.program_id!==program.program_id ||
      evidence.release_id!==releaseId || evidence.event!==event) {
    throw new CoreBlockedError(`Patch interruption ${event} transition evidence is absent`);
  }
  const receipt=evidence.receipt;
  if (receipt===null || receipt.receipt_id!==transition.source_receipt ||
      receipt.status!=="completed") {
    throw new CoreBlockedError(`Patch interruption ${event} transition has no exact completed receipt`);
  }
  const intent=evidence.intent;
  if (intent===null || intent.intent_id!==receipt.intent_id ||
      intent.planned_receipt_id!==receipt.receipt_id ||
      receipt.intent_sha256!==sha256Canonical(intent)) {
    throw new CoreConflictError(`Patch interruption ${event} receipt conflicts with its immutable intent`);
  }
  const manifests=intent.operations.filter(operation =>
    operation.payload?.kind==="release-program-manifest");
  if (manifests.length!==1 || canonicalJson(manifests[0].payload.program)!==canonicalJson(program)) {
    throw new CoreConflictError(`Patch interruption ${event} intent does not own the current program manifest`);
  }
  const observations=new Map(receipt.observed_revisions.map(value =>
    [value.operation_id,value]));
  if (observations.size!==intent.operations.length || intent.operations.some(operation =>
    observations.get(operation.operation_id)?.repository!==operation.repository)) {
    throw new CoreConflictError(`Patch interruption ${event} receipt omits operation evidence`);
  }
}

function patchProgramFor({value,identity,version,feature,snapshot,observed}) {
  const programs=value.snapshot.query.programs;
  if (!Array.isArray(programs)) invalid("Patch query must include every persisted release program");
  const programId=nextProgramId(programs);
  const identityValue=releaseId(programId,identity.repository);
  const draft={
    schema_version:"repository-release.v1",release_id:identityValue,program_id:programId,
    repository:identity.repository,phase:"DRAFT",revision:"REV-0001",version:null,
    milestone:null,branch:null,release_pr_intent:null,scope:[value.bug.work.item.id],
    approval:null,publication_evidence:null,transitions:[],
  };
  const active=transitionRepositoryRelease(draft,{
    event:"ACTIVATE",expected_revision:"REV-0001",timestamp:snapshot.timestamp,
    source_receipt:snapshot.receipt_id,
    activation:{version:version.version,milestone:`v${version.version}`,
      branch:`release/v${version.version}`,release_pr_intent:{
        intent_id:releaseIntentId(identityValue),head:`release/v${version.version}`,
        base:observed.repository.default_branch.name,
        expected_head_revision:observed.repository.default_branch.head_sha,
        recorded_at:snapshot.timestamp,
      }},
  });
  return {
    schema_version:"release-program.v1",program_id:programId,phase:"ACTIVE",revision:"REV-0001",
    repository_releases:[active],dependency_stages:[{stage:1,repository_release_ids:[identityValue]}],
    selected_scope:[{epic_id:value.bug.work.item.id,outcome:"production-patch",eligibility:{
      approved:true,unversioned:true,decomposed:true,registered_repository:true,unassigned:true,
    }}],deferred_scope:[],rationale:[{repository:identity.repository,version:version.version,
      change_class:"patch",reasons:[{rule:"published_product_fix",scope_ids:[value.bug.work.item.id]}]}],
    interrupts:{program_id:value.activeFeatureProgram.program_id,
      repository_release_id:feature.release_id,
      paused_release_revision:feature.phase==="PAUSED" ? feature.revision : incrementRevision(feature.revision,"Paused release revision")},
    created_at:snapshot.timestamp,updated_at:snapshot.timestamp,
  };
}

function aggregatePrecondition(snapshot) {
  return {resource:"project",action:"verify",repository:null,
    expected_revision:snapshot.observation.project.revision,
    payload:{kind:"release-patch-precondition",project_id:snapshot.observation.project.id,
      query:snapshot.query,snapshot_sha256:sha256Canonical(snapshot.observation)}};
}

function patchProgramOperations(request,program) {
  if (request.bug.work.release.assigned) {
    throw new CoreConflictError("Bounded bug is already owned by a release before patch activation");
  }
  const release=program.repository_releases[0];
  const fields={...request.bug.work.project.fields,Status:"Ready",Gate:"NONE",
    milestone:release.milestone,base_branch:release.branch,
    last_reconciled_at:request.snapshot.timestamp};
  const assignment={assigned:true,active:true,id:`${release.repository}@${release.branch}`,
    repository:release.repository,branch:release.branch,milestone:release.milestone,
    revision:release.revision};
  const operations=[aggregatePrecondition(request.snapshot),{
    resource:"repository",action:"verify",repository:release.repository,
    expected_revision:request.observed.repository.revision,
    payload:{kind:"release-repository-precondition",program_id:program.program_id,
      release_id:release.release_id,
      snapshot_sha256:sha256Canonical(request.observed.repository)},
  },{
    resource:"branch",action:"verify",repository:release.repository,
    expected_revision:request.observed.repository.default_branch.revision,
    payload:{kind:"release-default-branch-precondition",
      name:request.observed.repository.default_branch.name,
      head_sha:request.observed.repository.default_branch.head_sha},
  }];
  if (request.observed.repository.milestone===null) operations.push({
    resource:"milestone",action:"create",repository:release.repository,
    expected_revision:request.observed.repository.revision,
    payload:{kind:"release-milestone",program_id:program.program_id,
      release_id:release.release_id,title:release.milestone,state:"OPEN"},
  });
  else {
    const milestone=request.observed.repository.milestone;
    exact(milestone,["title","state","revision"],"patch milestone observation");
    if (milestone.title!==release.milestone || milestone.state!=="OPEN") {
      throw new CoreConflictError("Existing patch milestone conflicts with the planned release");
    }
    operations.push({resource:"milestone",action:"verify",repository:release.repository,
      expected_revision:milestone.revision,payload:{kind:"release-milestone-precondition",
        title:milestone.title,state:milestone.state}});
  }
  if (request.observed.repository.release_branch===null) operations.push({
    resource:"branch",action:"create",repository:release.repository,
    expected_revision:request.observed.repository.default_branch.revision,
    payload:{kind:"release-branch",program_id:program.program_id,
      release_id:release.release_id,name:release.branch,
      base_branch:request.observed.repository.default_branch.name,
      head_sha:request.observed.repository.default_branch.head_sha,
      base_revision:request.observed.repository.default_branch.revision},
  });
  else {
    const branch=request.observed.repository.release_branch;
    exact(branch,["name","base_branch","head_sha","revision"],"patch branch observation");
    if (branch.name!==release.branch ||
        branch.base_branch!==request.observed.repository.default_branch.name ||
        branch.head_sha!==request.observed.repository.default_branch.head_sha) {
      throw new CoreConflictError("Existing patch branch conflicts with the planned release");
    }
    operations.push({resource:"branch",action:"verify",repository:release.repository,
      expected_revision:branch.revision,payload:{kind:"release-branch-precondition",
        name:branch.name,base_branch:branch.base_branch,head_sha:branch.head_sha}});
  }
  operations.push({resource:"repository",action:"commit",
    repository:request.snapshot.source.repository,expected_revision:null,
    payload:{kind:"release-program-manifest",expected_program_revision:null,program}},
  {resource:"issue",action:"update",repository:release.repository,
    expected_revision:request.observed.bug.revision,
    payload:{kind:"release-assignment",program_id:program.program_id,
      release_id:release.release_id,work_item_id:request.bug.work.item.id,
      release:assignment,item:{milestone:release.milestone,base_branch:release.branch}}},
  {resource:"project",action:"update",repository:release.repository,
    expected_revision:request.bug.work.project.revision,
    payload:{kind:"release-project-state",program_id:program.program_id,
      release_id:release.release_id,work_item_id:request.bug.work.item.id,
      project_id:request.bug.work.project.project_id,
      item_id:request.bug.work.project.item_id,fields}});
  return closedData(operations,"patch activation operations");
}

function activePatchForBug(request) {
  const candidates=request.patchPrograms.filter(program => {
    const release=program.repository_releases.find(value =>
      value.repository===request.identity.repository);
    return release && ["ACTIVE","READY_FOR_APPROVAL","PUBLISHING"].includes(release.phase);
  });
  if (candidates.length===0) return null;
  if (candidates.length!==1) throw new CoreConflictError("Multiple active patch releases own the repository");
  const program=candidates[0];
  const release=program.repository_releases.find(value =>
    value.repository===request.identity.repository);
  const expectedInterrupts={program_id:request.value.activeFeatureProgram.program_id,
    repository_release_id:request.feature.release_id,
    paused_release_revision:request.feature.revision};
  if (canonicalJson(program.interrupts)!==canonicalJson(expectedInterrupts) ||
      release.version!==request.version.version ||
      canonicalJson(release.scope)!==canonicalJson([request.bug.work.item.id])) {
    throw new CoreConflictError("Active patch release conflicts with the bounded bug interruption");
  }
  const expectedAssignment={assigned:true,active:true,
    id:`${release.repository}@${release.branch}`,repository:release.repository,
    branch:release.branch,milestone:release.milestone,revision:release.revision};
  if (canonicalJson(request.bug.work.release)!==canonicalJson(expectedAssignment) ||
      request.bug.work.item.base_branch!==release.branch ||
      request.bug.work.item.milestone!==release.milestone) {
    throw new CoreConflictError("Bounded bug does not carry its exact active patch assignment");
  }
  completedManifestTransition(program,release.release_id,"ACTIVATE",request.snapshot.query);
  return program;
}

function pauseProgram(request) {
  const pausedRelease=transitionRepositoryRelease(request.feature,{
    event:"PAUSE_FOR_PATCH",expected_revision:request.feature.revision,
    timestamp:request.snapshot.timestamp,source_receipt:request.snapshot.receipt_id,activation:null,
  });
  const releases=request.value.activeFeatureProgram.repository_releases.map(release =>
    release.release_id===pausedRelease.release_id ? pausedRelease : release);
  return closedData({...request.value.activeFeatureProgram,phase:programPhase(releases),
    revision:incrementRevision(request.value.activeFeatureProgram.revision,"Feature program revision"),
    repository_releases:releases,updated_at:request.snapshot.timestamp},"paused feature program");
}

export function patchVersionFor(latestPublishedVersion) {
  return Object.freeze({
    version:nextVersion(latestPublishedVersion,"patch"),
    change_class:"patch",
    based_on:latestPublishedVersion,
  });
}

export function planPatchInterruption(input) {
  const request=normalizeRequest(input);
  const existingPatch=activePatchForBug(request);
  if (existingPatch!==null) {
    return Object.freeze({patchProgram:existingPatch,pauseOperations:Object.freeze([]),
      patchOperations:Object.freeze([aggregatePrecondition(request.snapshot)])});
  }
  const patchProgram=closedData(patchProgramFor(request),"patch release program");
  assertRepositoryConcurrency(request.feature.phase==="PAUSED"
    ? [request.value.activeFeatureProgram,patchProgram]
    : [request.value.activeFeatureProgram]);
  if (request.feature.phase==="ACTIVE") {
    const paused=pauseProgram(request);
    const pauseOperations=closedData([aggregatePrecondition(request.snapshot),{
      resource:"repository",action:"commit",repository:request.snapshot.source.repository,
      expected_revision:request.value.activeFeatureProgram.revision,
      payload:{kind:"release-program-manifest",
        expected_program_revision:request.value.activeFeatureProgram.revision,program:paused},
    }],"patch pause operations");
    return Object.freeze({patchProgram,pauseOperations,patchOperations:Object.freeze([])});
  }
  completedManifestTransition(request.value.activeFeatureProgram,request.feature.release_id,"PAUSE_FOR_PATCH",
    request.snapshot.query);
  return Object.freeze({patchProgram,pauseOperations:Object.freeze([]),
    patchOperations:patchProgramOperations(request,patchProgram)});
}

export function completePatchInterruption(input) {
  const value=closedData(input,"patch completion compatibility request");
  exact(value,["patchProgram","pausedProgram","publication","snapshot"],
    "patch completion compatibility request");
  const snapshot=value.snapshot;
  if (canonicalJson(value.patchProgram)!==canonicalJson(snapshot?.query?.patch_program) ||
      canonicalJson(value.pausedProgram)!==canonicalJson(snapshot?.query?.paused_program) ||
      canonicalJson(value.publication)!==canonicalJson(snapshot?.query?.publication)) {
    throw new CoreConflictError(
      "Patch completion compatibility inputs do not bind the serialized query",
    );
  }
  const decision=projectPatchCompletionTransaction(snapshot.query,{
    observation:snapshot.observation,receipt_id:snapshot.receipt_id,
    timestamp:snapshot.timestamp,
  });
  if (canonicalJson(snapshot.source)!==canonicalJson(decision.source)) {
    throw new CoreConflictError(
      "Patch completion compatibility source does not bind the projected transaction",
    );
  }
  return closedData(decision.operations.map(operation =>
    operation.payload.kind==="release-patch-completion-precondition"
      ? {...operation,payload:Object.fromEntries(Object.entries(operation.payload)
        .filter(([key]) => key!=="descriptor"))} : operation),
  "patch completion compatibility operations");
}
