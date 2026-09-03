import {createHash} from "node:crypto";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {compareCanonicalText} from "../canonical-order.js";
import {closedData,exact} from "../commands/common.js";
import {validateCoreDocument} from "../contracts.js";
import {parseWorkItemId} from "../domain/identity.js";
import {deriveWorkItemState} from "../domain/state.js";
import {CoreBlockedError,CoreConflictError,CoreValidationError} from "../errors.js";
import {updateManagedReviewBlock} from "../review/body.js";
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
    publication_evidence:null,transitions:[],
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

function completedPhaseEvidence(value,label,{paused,patch,patchRelease,featureRelease,completionQuery}) {
  if (value===null) return null;
  exact(value,["intent","receipt"],`${label} phase evidence`);
  const intent=validateCoreDocument(value.intent,"operation-intent.v1");
  const receipt=validateCoreDocument(value.receipt,"operation-receipt.v1");
  if (receipt.status!=="completed" || intent.intent_id!==receipt.intent_id ||
      intent.planned_receipt_id!==receipt.receipt_id ||
      receipt.intent_sha256!==sha256Canonical(intent)) {
    throw new CoreConflictError(`${label} phase receipt does not bind its immutable intent`);
  }
  const observations=new Map(receipt.observed_revisions.map(observation =>
    [observation.operation_id,observation]));
  if (receipt.observed_revisions.length!==intent.operations.length ||
      observations.size!==intent.operations.length || intent.operations.some(operation =>
    observations.get(operation.operation_id)?.repository!==operation.repository)) {
    throw new CoreConflictError(`${label} phase receipt omits exact operation evidence`);
  }
  const manifests=intent.operations.filter(operation =>
    operation.payload?.kind==="release-program-manifest");
  if (manifests.length!==1 ||
      canonicalJson(manifests[0].payload.program)!==canonicalJson(paused) ||
      manifests[0].payload.expected_program_revision!==paused.revision ||
      manifests[0].resource!=="repository" || manifests[0].action!=="commit" ||
      manifests[0].repository!==completionQuery.control_repository ||
      manifests[0].expected_revision!==paused.revision) {
    throw new CoreConflictError(`${label} phase does not preserve the exact paused program`);
  }
  const reconciliations=intent.operations.filter(operation =>
    operation.payload?.kind==="release-patch-reconcile");
  const stalePulls=intent.operations.filter(operation =>
    operation.resource==="pull_request" && operation.payload?.kind==="release-patch-review-stale");
  const staleProjects=intent.operations.filter(operation =>
    operation.resource==="project" && operation.payload?.kind==="release-patch-review-stale");
  const aggregates=intent.operations.filter(operation =>
    operation.payload?.kind==="release-patch-completion-precondition");
  const defaultBranches=intent.operations.filter(operation =>
    operation.payload?.kind==="release-default-branch-precondition");
  const featureBranches=intent.operations.filter(operation =>
    operation.payload?.kind==="release-branch-precondition");
  if (aggregates.length!==1 || defaultBranches.length!==1 || featureBranches.length!==1) {
    throw new CoreConflictError(`${label} phase omits exact completion preconditions`);
  }
  const aggregate=aggregates[0];
  const defaultBranch=defaultBranches[0];
  const featureBranch=featureBranches[0];
  const evidenceQuery=aggregate.payload.query;
  const expectedPhaseEvidence=label==="reconciliation"
    ? {reconciliation:null,review_gate:null}
    : {reconciliation:completionQuery.phase_evidence.reconciliation,review_gate:null};
  if (intent.policy_revision!==completionQuery.organization.policy_revision ||
      aggregate.resource!=="project" || aggregate.action!=="verify" ||
      aggregate.repository!==null || aggregate.payload.project_id!==completionQuery.project.node_id ||
      evidenceQuery.control_repository!==completionQuery.control_repository ||
      canonicalJson(evidenceQuery.organization)!==canonicalJson(completionQuery.organization) ||
      canonicalJson(evidenceQuery.repositories)!==canonicalJson(completionQuery.repositories) ||
      canonicalJson(evidenceQuery.programs)!==canonicalJson(completionQuery.programs) ||
      canonicalJson(evidenceQuery.patch_program)!==canonicalJson(patch) ||
      canonicalJson(evidenceQuery.paused_program)!==canonicalJson(paused) ||
      canonicalJson(evidenceQuery.publication)!==canonicalJson(completionQuery.publication) ||
      canonicalJson(evidenceQuery.repository_configuration)!==
        canonicalJson(completionQuery.repository_configuration) ||
      canonicalJson(evidenceQuery.project)!==canonicalJson(completionQuery.project) ||
      canonicalJson(evidenceQuery.phase_evidence)!==canonicalJson(expectedPhaseEvidence)) {
    throw new CoreConflictError(`${label} aggregate does not bind the exact completion source`);
  }
  if (defaultBranch.resource!=="branch" || defaultBranch.action!=="verify" ||
      defaultBranch.repository!==patchRelease.repository ||
      featureBranch.resource!=="branch" || featureBranch.action!=="verify" ||
      featureBranch.repository!==patchRelease.repository ||
      defaultBranch.payload.name!==completionQuery.repository_configuration.default_branch ||
      featureBranch.payload.name!==featureRelease.branch ||
      featureBranch.payload.base_branch!==defaultBranch.payload.name) {
    throw new CoreConflictError(`${label} branch preconditions do not own the release repository`);
  }
  let reviewGateDetails=null;
  if (label==="reconciliation") {
    const operation=reconciliations[0];
    const classified=aggregates.length+defaultBranches.length+featureBranches.length+
      reconciliations.length+manifests.length;
    if (reconciliations.length!==1 || stalePulls.length!==0 || staleProjects.length!==0 ||
        classified!==intent.operations.length || operation.resource!=="branch" ||
        operation.action!=="merge" || operation.repository!==patchRelease.repository ||
        operation.expected_revision!==featureBranch.expected_revision ||
        operation.payload.patch_program_id!==patch.program_id ||
        operation.payload.patch_release_id!==patchRelease.release_id ||
        operation.payload.feature_program_id!==paused.program_id ||
        operation.payload.feature_release_id!==featureRelease.release_id ||
        operation.payload.source_branch!==defaultBranch.payload.name ||
        operation.payload.source_sha!==defaultBranch.payload.head_sha ||
        operation.payload.target_branch!==featureBranch.payload.name ||
        operation.payload.target_sha!==featureBranch.payload.head_sha) {
      throw new CoreConflictError("Patch reconciliation evidence does not own the exact releases");
    }
    exact(operation.payload,["kind","patch_program_id","patch_release_id",
      "feature_program_id","feature_release_id","source_branch","source_sha",
      "target_branch","target_sha"],"patch reconciliation payload");
  } else {
    const workflows=intent.operations.filter(operation =>
      operation.payload?.kind==="release-check-request");
    const classified=aggregates.length+defaultBranches.length+featureBranches.length+
      stalePulls.length+staleProjects.length+workflows.length+manifests.length;
    if (reconciliations.length!==0 || stalePulls.length!==staleProjects.length ||
        aggregates.length!==1 || defaultBranches.length!==1 || featureBranches.length!==1 ||
        workflows.length>1 || classified!==intent.operations.length) {
      throw new CoreConflictError("Patch review-gate evidence is not one exact stale surface set");
    }
    if (stalePulls.some(operation => operation.payload.patch_program_id!==patch.program_id ||
        operation.payload.feature_program_id!==paused.program_id ||
        operation.resource!=="pull_request" || operation.action!=="update" ||
        operation.repository!==patchRelease.repository || operation.payload.work_review!==null) ||
        staleProjects.some(operation => operation.payload.patch_program_id!==patch.program_id ||
          operation.payload.feature_program_id!==paused.program_id ||
          operation.resource!=="project" || operation.action!=="update" ||
          operation.repository!==patchRelease.repository ||
          operation.payload.fields?.Status!=="In review" ||
          operation.payload.fields?.Gate!=="REVIEW_REQUIRED")) {
      throw new CoreConflictError("Patch review-gate evidence does not own exact stale semantics");
    }
    const pullIds=stalePulls.map(operation => operation.payload.work_item_id)
      .sort(compareCanonicalText);
    const projectIds=staleProjects.map(operation => operation.payload.work_item_id)
      .sort(compareCanonicalText);
    if (new Set(pullIds).size!==pullIds.length || canonicalJson(pullIds)!==canonicalJson(projectIds)) {
      throw new CoreConflictError("Patch review-gate evidence has ambiguous stale Work identities");
    }
    for (const pull of stalePulls) {
      exact(pull.payload,["kind","patch_program_id","feature_program_id","work_item_id",
        "pull_request_number","head_sha","reviewed_revision","current_revision","freshness",
        "review_result","body","work_review"],"patch review-gate PR stale payload");
      validateCoreDocument(pull.payload.review_result,"review-result.v1");
    }
    for (const project of staleProjects) {
      exact(project.payload,["kind","patch_program_id","feature_program_id","project_id",
        "item_id","work_item_id","pull_request_number","pull_request_revision",
        "reviewed_revision","current_revision","freshness","fields"],
      "patch review-gate Project stale payload");
      exact(project.payload.fields,["Status","Gate"],"patch review-gate Project fields");
    }
    if (workflows.some(operation => operation.resource!=="workflow" ||
        operation.action!=="create" || operation.repository!==patchRelease.repository ||
        operation.payload.patch_program_id!==patch.program_id ||
        operation.payload.feature_program_id!==paused.program_id ||
        operation.payload.branch!==featureRelease.branch)) {
      throw new CoreConflictError("Patch review-gate check evidence does not own the release branch");
    }
    reviewGateDetails={stalePulls:Object.freeze(stalePulls),
      staleProjects:Object.freeze(staleProjects)};
  }
  timestamp(receipt.created_at,`${label} phase receipt time`);
  const staledReviewIds=stalePulls.map(operation => operation.payload.review_result?.review_id);
  if (staledReviewIds.some(reviewId => typeof reviewId!=="string") ||
      new Set(staledReviewIds).size!==staledReviewIds.length) {
    throw new CoreConflictError("Patch review-gate evidence has ambiguous review identities");
  }
  return Object.freeze({intent,receipt,reconciliation:reconciliations[0] ?? null,
    aggregate,defaultBranch,featureBranch,staledReviewIds:Object.freeze(staledReviewIds),
    ...(reviewGateDetails ?? {})});
}

function assertReviewGateBindings(request,{superseding=false}={}) {
  const evidence=request.reviewGateEvidence;
  if (evidence===null) return;
  const defaultBranch=evidence.defaultBranch;
  const featureBranch=evidence.featureBranch;
  const observedDefault=request.observed.repository.default_branch;
  const observedFeature=request.observed.repository.feature_branch;
  if (defaultBranch.payload.name!==observedDefault.name ||
      featureBranch.expected_revision!==observedFeature.revision ||
      featureBranch.payload.name!==request.observed.repository.feature_branch.name ||
      featureBranch.payload.base_branch!==observedDefault.name ||
      featureBranch.payload.head_sha!==observedFeature.head_sha) {
    throw new CoreConflictError("Patch review-gate branch preconditions do not bind current heads");
  }
  if (superseding) {
    const reconciliationDefault=request.reconciliationEvidence.defaultBranch;
    if (defaultBranch.expected_revision!==reconciliationDefault.expected_revision ||
        defaultBranch.payload.name!==reconciliationDefault.payload.name ||
        defaultBranch.payload.head_sha!==reconciliationDefault.payload.head_sha) {
      throw new CoreConflictError("Historical review gate does not bind its superseded reconciliation");
    }
  } else if (defaultBranch.expected_revision!==observedDefault.revision ||
      defaultBranch.payload.head_sha!==observedDefault.head_sha) {
    throw new CoreConflictError("Patch review-gate branch preconditions do not bind current heads");
  }
  const workflows=evidence.intent.operations.filter(operation =>
    operation.payload?.kind==="release-check-request");
  for (const operation of workflows) {
    exact(operation.payload,["kind","patch_program_id","feature_program_id","branch",
      "head_sha","required"],"patch review-gate check payload");
    if (operation.payload.head_sha!==request.observed.repository.feature_branch.head_sha ||
        canonicalJson(operation.payload.required)!==canonicalJson(request.observed.checks.required)) {
      throw new CoreConflictError("Patch review-gate check evidence does not bind current checks");
    }
  }
  const items=new Map(request.items.map(item => [item.work.item.id,item]));
  const projects=new Map(evidence.staleProjects.map(operation =>
    [operation.payload.work_item_id,operation]));
  const reconciliationTime=Date.parse(request.reconciliationEvidence.receipt.created_at);
  for (const pull of evidence.stalePulls) {
    const payload=pull.payload;
    const project=projects.get(payload.work_item_id);
    const item=items.get(payload.work_item_id);
    const result=payload.review_result;
    if (project===undefined || item===undefined || item.pull_request===null || item.review===null ||
        payload.patch_program_id!==project.payload.patch_program_id ||
        payload.feature_program_id!==project.payload.feature_program_id ||
        payload.pull_request_number!==project.payload.pull_request_number ||
        payload.reviewed_revision!==project.payload.reviewed_revision ||
        payload.current_revision!==project.payload.current_revision ||
        payload.freshness!=="STALE" || project.payload.freshness!=="STALE" ||
        payload.head_sha!==payload.reviewed_revision ||
        payload.head_sha!==payload.current_revision ||
        payload.reviewed_revision!==result.reviewed_revision ||
        result.repository!==pull.repository ||
        result.pull_request_number!==payload.pull_request_number ||
        result.freshness!=="STALE" ||
        Date.parse(result.recorded_at)>=reconciliationTime ||
        updateManagedReviewBlock(payload.body,result)!==payload.body ||
        project.payload.pull_request_revision!==pull.expected_revision ||
        pull.repository!==item.work.item.repository ||
        project.repository!==item.work.item.repository ||
        payload.pull_request_number!==item.pull_request.number ||
        project.payload.project_id!==item.work.project.project_id ||
        project.payload.item_id!==item.work.project.item_id) {
      throw new CoreConflictError("Patch review-gate stale pair does not bind its assigned Work item");
    }
    if (item.review.freshness==="STALE" &&
        (pull.expected_revision!==item.pull_request.revision ||
          project.expected_revision!==item.work.project.revision ||
          project.payload.pull_request_revision!==item.pull_request.revision ||
          payload.head_sha!==item.pull_request.head_sha ||
          canonicalJson(result)!==canonicalJson(item.review) ||
          payload.body!==item.pull_request.body)) {
      throw new CoreConflictError("Stored stale review advanced beyond its completed review gate");
    }
  }
}

function normalizeCompletion(input) {
  const value=closedData(input,"patch completion request");
  exact(value,["patchProgram","pausedProgram","publication","snapshot"],
    "patch completion request");
  const patch=validateCoreDocument(value.patchProgram,"release-program.v1");
  const paused=validateCoreDocument(value.pausedProgram,"release-program.v1");
  const publication=validateCoreDocument(value.publication,"publication-evidence.v1");
  assertRepositoryConcurrency([paused,patch]);
  if (patch.interrupts===null || patch.repository_releases.length!==1) {
    throw new CoreConflictError("Patch completion requires one linked patch release");
  }
  const patchRelease=patch.repository_releases[0];
  const featureRelease=paused.repository_releases.find(release =>
    release.release_id===patch.interrupts.repository_release_id);
  if (patch.phase!=="RELEASED" || patchRelease.phase!=="RELEASED" ||
      featureRelease?.phase!=="PAUSED" || paused.phase!=="PAUSED" ||
      patch.interrupts.program_id!==paused.program_id ||
      patch.interrupts.paused_release_revision!==featureRelease.revision ||
      patchRelease.repository!==featureRelease.repository ||
      canonicalJson(patchRelease.publication_evidence)!==canonicalJson(publication) ||
      publication.release_id!==patchRelease.release_id ||
      publication.repository!==patchRelease.repository || publication.version!==patchRelease.version) {
    throw new CoreConflictError("Patch completion inputs do not bind the released patch and exact paused feature");
  }
  const snapshot=value.snapshot;
  exact(snapshot,PATCH_SNAPSHOT_KEYS,"patch completion snapshot");
  exact(snapshot.source,["repository","revision","sha256"],"patch completion source");
  exact(snapshot.query,["kind","control_revision","control_repository","organization",
    "repositories","programs","ledger_sha256","patch_program","paused_program",
    "publication","repository_configuration","project","phase_evidence"],"patch completion query");
  const query=snapshot.query;
  const queryOrganization=validateCoreDocument(query.organization,"organization-config.v1");
  const queryRepositories=Array.isArray(query.repositories) ? query.repositories.map(repository =>
    validateCoreDocument(repository,"repository-config.v1")) : invalid("Patch completion registry must be an array");
  if (!Array.isArray(query.programs)) invalid("Patch completion programs must be an array");
  for (const program of query.programs) validateCoreDocument(program,"release-program.v1");
  assertRepositoryConcurrency(query.programs);
  const programIds=query.programs.map(program => program.program_id);
  const repositoryIds=queryRepositories.map(repository => repository.repository);
  if (query.kind!=="patch-completion" || query.control_revision!==snapshot.source.revision ||
      query.control_repository!==snapshot.source.repository ||
      query.control_repository!==queryOrganization.control_repository ||
      canonicalJson(query.project)!==canonicalJson(queryOrganization.project) ||
      canonicalJson(repositoryIds)!==canonicalJson(queryOrganization.repositories) ||
      canonicalJson(queryRepositories.find(repository =>
        repository.repository===patchRelease.repository))!==canonicalJson(query.repository_configuration) ||
      programIds.some((id,index) => index>0 && programIds[index-1]>=id) ||
      canonicalJson(query.programs.find(program => program.program_id===patch.program_id))!==canonicalJson(patch) ||
      canonicalJson(query.programs.find(program => program.program_id===paused.program_id))!==canonicalJson(paused) ||
      !HASH.test(query.ledger_sha256) ||
      canonicalJson(query.patch_program)!==canonicalJson(patch) ||
      canonicalJson(query.paused_program)!==canonicalJson(paused) ||
      canonicalJson(query.publication)!==canonicalJson(publication) ||
      query.repository_configuration?.repository!==patchRelease.repository ||
      query.project?.node_id===undefined || !HASH.test(snapshot.source.sha256) ||
      snapshot.source.sha256!==sha256Canonical({control:{revision:query.control_revision,
        organization:query.organization,repositories:query.repositories,programs:query.programs,
        ledger_sha256:query.ledger_sha256},github:snapshot.observation}) ||
      !RECEIPT_ID.test(snapshot.receipt_id)) {
    throw new CoreConflictError("Patch completion query and immutable source are inconsistent");
  }
  timestamp(snapshot.timestamp,"Patch completion timestamp");
  exact(query.phase_evidence,["reconciliation","review_gate"],
    "patch completion phase evidence");
  const reconciliationEvidence=completedPhaseEvidence(query.phase_evidence.reconciliation,
    "reconciliation",{paused,patch,patchRelease,featureRelease,completionQuery:query});
  const reviewGateEvidence=completedPhaseEvidence(query.phase_evidence.review_gate,
    "review-gate",{paused,patch,patchRelease,featureRelease,completionQuery:query});
  if (reviewGateEvidence!==null && reconciliationEvidence===null) {
    throw new CoreConflictError("Patch review-gate evidence requires completed reconciliation evidence");
  }
  if (reviewGateEvidence!==null &&
      Date.parse(reviewGateEvidence.receipt.created_at)<Date.parse(reconciliationEvidence.receipt.created_at)) {
    throw new CoreConflictError("Patch review-gate receipt predates reconciliation");
  }
  if ((reconciliationEvidence!==null &&
        Date.parse(reconciliationEvidence.receipt.created_at)>Date.parse(snapshot.timestamp)) ||
      (reviewGateEvidence!==null &&
        Date.parse(reviewGateEvidence.receipt.created_at)>Date.parse(snapshot.timestamp))) {
    throw new CoreConflictError("Patch completion phase evidence is newer than its snapshot");
  }
  const observed=snapshot.observation;
  exact(observed,["kind","control_revision","project","patch","feature","repository",
    "assigned_work","checks"],"patch completion observation");
  exact(observed.project,["id","revision"],"patch completion Project");
  exact(observed.patch,["program_id","program_revision","release_id","release_revision"],
    "patch completion release observation");
  exact(observed.feature,["program_id","program_revision","release_id","release_revision"],
    "patch completion feature observation");
  exact(observed.repository,["repository","revision","default_branch","feature_branch",
    "reconciliation"],"patch completion repository");
  exact(observed.repository.default_branch,["name","revision","head_sha"],
    "patch completion default branch");
  exact(observed.repository.feature_branch,["name","revision","head_sha"],
    "patch completion feature branch");
  exact(observed.repository.reconciliation,["publication_commit",
    "publication_is_ancestor_of_current_default","current_default_is_ancestor_of_feature_release",
    "drifted"],
    "patch completion reconciliation");
  exact(observed.assigned_work,["release_id","release_revision","project_id",
    "project_revision","work_item_ids","items"],"patch completion assigned Work inventory");
  exact(observed.checks,["head_sha","state","required"],"patch completion checks");
  if (observed.kind!=="patch-completion" || observed.control_revision!==query.control_revision ||
      observed.project.id!==query.project.node_id ||
      observed.patch.program_id!==patch.program_id || observed.patch.program_revision!==patch.revision ||
      observed.patch.release_id!==patchRelease.release_id ||
      observed.patch.release_revision!==patchRelease.revision ||
      observed.feature.program_id!==paused.program_id || observed.feature.program_revision!==paused.revision ||
      observed.feature.release_id!==featureRelease.release_id ||
      observed.feature.release_revision!==featureRelease.revision ||
      observed.repository.repository!==patchRelease.repository ||
      observed.repository.default_branch.name!==query.repository_configuration.default_branch ||
      observed.repository.feature_branch.name!==featureRelease.branch ||
      observed.repository.reconciliation.publication_commit!==publication.expected_revision ||
      observed.repository.reconciliation.publication_is_ancestor_of_current_default!==true ||
      typeof observed.repository.reconciliation.current_default_is_ancestor_of_feature_release!=="boolean" ||
      typeof observed.repository.reconciliation.drifted!=="boolean" ||
      !SHA.test(observed.repository.default_branch.head_sha) ||
      !SHA.test(observed.repository.feature_branch.head_sha)) {
    throw new CoreConflictError("Patch completion observations drifted from released and paused tracks");
  }
  if (observed.repository.reconciliation.drifted) {
    throw new CoreBlockedError("Patch completion reconciliation is drifted");
  }
  if (!Array.isArray(observed.assigned_work.work_item_ids) ||
      !Array.isArray(observed.assigned_work.items) || !Array.isArray(observed.checks.required) ||
      observed.checks.required.length===0 ||
      !["NOT_STARTED","PENDING","PASSED","FAILED"].includes(observed.checks.state) ||
      !(observed.checks.head_sha===null || SHA.test(observed.checks.head_sha))) {
    invalid("Patch completion reviews or checks are malformed");
  }
  if (observed.assigned_work.release_id!==featureRelease.release_id ||
      observed.assigned_work.release_revision!==featureRelease.revision ||
      observed.assigned_work.project_id!==observed.project.id ||
      observed.assigned_work.project_revision!==observed.project.revision) {
    throw new CoreConflictError("Patch completion Work inventory is not bound to the release and Project revision");
  }
  for (let index=0;index<observed.checks.required.length;index+=1) {
    const name=observed.checks.required[index];
    if (typeof name!=="string" || name.trim().length===0 || name!==name.trim() ||
        (index>0 && compareCanonicalText(observed.checks.required[index-1],name)>=0)) {
      invalid("Patch completion required checks must use unique canonical nonblank names");
    }
  }
  const reviewWorkIds=new Set();
  const reviewPullRequests=new Set();
  const reviewProjectItems=new Set();
  const reviewIds=new Set();
  const itemIds=[];
  const items=[];
  for (let index=0;index<observed.assigned_work.items.length;index+=1) {
    const item=observed.assigned_work.items[index];
    exact(item,["work","pull_request","review"],`patch completion assigned Work[${index}]`);
    const work=item.work;
    const derived=deriveWorkItemState(work);
    if (work.project.fields.Status!==derived.status || work.project.fields.Gate!==derived.gate) {
      throw new CoreConflictError("Patch completion Project Status or Gate is not authoritative");
    }
    const identity=parseWorkItemId(work.item.id);
    itemIds.push(work.item.id);
    if (index>0 && itemIds[index-1]===work.item.id) {
      throw new CoreConflictError("Patch completion assigned Work identities are duplicated");
    }
    if (index>0 && compareCanonicalText(itemIds[index-1],work.item.id)>0) {
      invalid("Patch completion assigned Work identities must be unique and canonically ordered");
    }
    const assignment=work.release;
    if (assignment.assigned!==true || assignment.active!==true ||
        assignment.id!==`${featureRelease.repository}@${featureRelease.branch}` ||
        assignment.repository!==featureRelease.repository ||
        assignment.branch!==featureRelease.branch ||
        assignment.milestone!==featureRelease.milestone ||
        assignment.revision!==featureRelease.revision) {
      throw new CoreConflictError("Patch completion Work assignment does not bind the paused feature release");
    }
    if (identity.repository!==patchRelease.repository ||
        work.item.repository!==identity.repository ||
        work.project.project_id!==observed.project.id ||
        work.project.fields.repository!==identity.repository) {
      throw new CoreConflictError("Patch completion Work belongs to a foreign repository or Project");
    }
    const scopedEpicId=work.item.kind==="epic"
      ? work.item.id
      : work.item.kind==="issue" ? work.parent?.id : null;
    if (scopedEpicId===null || !featureRelease.scope.includes(scopedEpicId)) {
      throw new CoreConflictError("Patch completion Work is outside the paused feature release scope");
    }
    if (item.pull_request===null) {
      if (item.review!==null || work.pull_request!==null || work.review!==null) {
        throw new CoreConflictError("Patch completion Work without a pull request carries review evidence");
      }
    } else {
      const pull=item.pull_request;
      exact(pull,["repository","number","revision","head_branch","base_branch","head_sha",
        "body","formal_review"],`patch completion pull request[${index}]`);
      exact(pull.formal_review,["state","review_id","reviewed_revision"],
        `patch completion formal review[${index}]`);
      const pullKey=`${pull.repository}#${pull.number}`;
      if (pull.repository!==identity.repository || !Number.isSafeInteger(pull.number) || pull.number<1 ||
          typeof pull.revision!=="string" || pull.revision.length===0 ||
          pull.head_branch!==work.item.branch || pull.base_branch!==work.item.base_branch ||
          !SHA.test(pull.head_sha) || typeof pull.body!=="string" ||
          work.pull_request?.state!=="READY" || work.pull_request.head_sha!==pull.head_sha ||
          work.physical_branch.head_sha!==pull.head_sha) {
        invalid(`Patch completion pull request[${index}] is malformed`);
      }
      if (reviewPullRequests.has(pullKey)) {
        throw new CoreConflictError("Patch completion pull request identities are duplicated or ambiguous");
      }
      reviewPullRequests.add(pullKey);
      if (item.review===null) {
        if (work.review!==null || pull.formal_review.state!=="NONE" ||
            pull.formal_review.review_id!==null || pull.formal_review.reviewed_revision!==null) {
          throw new CoreConflictError("Patch completion unreviewed pull request carries review evidence");
        }
      } else {
        const result=validateCoreDocument(item.review,"review-result.v1");
        const expectedFormal=result.verdict==="APPROVED" ? "APPROVED" : "CHANGES_REQUESTED";
        const expectedWorkReview=result.freshness==="STALE" ? null :
          {verdict:result.verdict,reviewed_revision:result.reviewed_revision};
        if (result.repository!==identity.repository || result.pull_request_number!==pull.number ||
            result.reviewed_revision!==pull.head_sha || updateManagedReviewBlock(pull.body,result)!==pull.body ||
            pull.formal_review.state!==expectedFormal || pull.formal_review.review_id!==result.review_id ||
            pull.formal_review.reviewed_revision!==result.reviewed_revision ||
            canonicalJson(work.review)!==canonicalJson(expectedWorkReview)) {
          throw new CoreConflictError(`Patch completion review[${index}] is not exact`);
        }
        if (reviewIds.has(result.review_id)) {
          throw new CoreConflictError("Patch completion review identities are duplicated or ambiguous");
        }
        reviewIds.add(result.review_id);
      }
    }
    if (reviewWorkIds.has(work.item.id) || reviewProjectItems.has(work.project.item_id)) {
      throw new CoreConflictError("Patch completion Work identities are duplicated or ambiguous");
    }
    reviewWorkIds.add(work.item.id);
    reviewProjectItems.add(work.project.item_id);
    items.push(Object.freeze({work,pull_request:item.pull_request,review:item.review}));
  }
  if (canonicalJson(observed.assigned_work.work_item_ids)!==canonicalJson(itemIds)) {
    throw new CoreConflictError("Patch completion Work inventory is incomplete or ambiguous");
  }
  if (featureRelease.scope.some(epicId => !reviewWorkIds.has(epicId))) {
    throw new CoreConflictError("Patch completion Work inventory omits a release-scope epic");
  }
  const requiresReconciliation=
    !observed.repository.reconciliation.current_default_is_ancestor_of_feature_release;
  if (requiresReconciliation && reconciliationEvidence!==null &&
      observed.repository.default_branch.head_sha===
        reconciliationEvidence.defaultBranch.payload.head_sha) {
    throw new CoreConflictError("Patch reconciliation cannot be superseded without a new default head");
  }
  assertReviewGateBindings({reviewGateEvidence,reconciliationEvidence,observed,items},
    {superseding:requiresReconciliation});
  if (observed.repository.reconciliation.current_default_is_ancestor_of_feature_release &&
      reconciliationEvidence!==null &&
      reconciliationEvidence.reconciliation.payload.source_sha!==
        observed.repository.default_branch.head_sha) {
    throw new CoreConflictError("Patch reconciliation receipt does not bind current main");
  }
  if (observed.repository.reconciliation.current_default_is_ancestor_of_feature_release &&
      reconciliationEvidence===null) {
    throw new CoreConflictError("Patch completion lacks receipt-backed current-main reconciliation");
  }
  return Object.freeze({value,patch,paused,publication,patchRelease,featureRelease,
    snapshot,query,observed,items,reconciliationEvidence,reviewGateEvidence,
    requiresReconciliation});
}

function completionManifest(request,program=request.paused) {
  return {resource:"repository",action:"commit",repository:request.query.control_repository,
    expected_revision:request.paused.revision,payload:{kind:"release-program-manifest",
      expected_program_revision:request.paused.revision,program}};
}

function completionPreconditions(request,{resetPhaseEvidence=false}={}) {
  const query=resetPhaseEvidence
    ? {...request.query,phase_evidence:{reconciliation:null,review_gate:null}}
    : request.query;
  return [{resource:"project",action:"verify",repository:null,
    expected_revision:request.observed.project.revision,
    payload:{kind:"release-patch-completion-precondition",
      project_id:request.observed.project.id,query,
      snapshot_sha256:sha256Canonical(request.observed)}},
  {resource:"branch",action:"verify",repository:request.patchRelease.repository,
    expected_revision:request.observed.repository.default_branch.revision,
    payload:{kind:"release-default-branch-precondition",
      name:request.observed.repository.default_branch.name,
      head_sha:request.observed.repository.default_branch.head_sha}},
  {resource:"branch",action:"verify",repository:request.patchRelease.repository,
    expected_revision:request.observed.repository.feature_branch.revision,
    payload:{kind:"release-branch-precondition",
      name:request.observed.repository.feature_branch.name,
      base_branch:request.observed.repository.default_branch.name,
      head_sha:request.observed.repository.feature_branch.head_sha}}];
}

export function completePatchInterruption(input) {
  const request=normalizeCompletion(input);
  const operations=completionPreconditions(request,
    {resetPhaseEvidence:request.requiresReconciliation});
  if (request.requiresReconciliation) {
    operations.push({resource:"branch",action:"merge",repository:request.patchRelease.repository,
      expected_revision:request.observed.repository.feature_branch.revision,
      payload:{kind:"release-patch-reconcile",patch_program_id:request.patch.program_id,
        patch_release_id:request.patchRelease.release_id,
        feature_program_id:request.paused.program_id,
        feature_release_id:request.featureRelease.release_id,
        source_branch:request.observed.repository.default_branch.name,
        source_sha:request.observed.repository.default_branch.head_sha,
        target_branch:request.featureRelease.branch,
        target_sha:request.observed.repository.feature_branch.head_sha}});
    operations.push(completionManifest(request));
    return closedData(operations,"patch reconciliation operations");
  }
  let reviewPhaseChanged=request.reviewGateEvidence===null;
  for (const item of request.items) {
    if (item.review===null) continue;
    const result=item.review;
    const pull=item.pull_request;
    if (request.reviewGateEvidence!==null) {
      const gateTime=Date.parse(request.reviewGateEvidence.receipt.created_at);
      const recordedTime=Date.parse(result.recorded_at);
      const staled=request.reviewGateEvidence.intent.operations.find(operation =>
        operation.resource==="pull_request" && operation.payload?.kind==="release-patch-review-stale" &&
        operation.payload.work_item_id===item.work.item.id &&
        operation.payload.review_result?.review_id===result.review_id);
      if (result.freshness==="STALE") {
        const state=deriveWorkItemState(item.work);
        if (!staled || canonicalJson(staled.payload.review_result)!==canonicalJson(result) ||
            staled.payload.body!==pull.body || state.status!=="In review" ||
            state.gate!=="REVIEW_REQUIRED" ||
            item.work.project.fields.Status!==state.status ||
            item.work.project.fields.Gate!==state.gate) {
          throw new CoreConflictError("Stored stale review is not backed by the completed review gate");
        }
        continue;
      }
      if (recordedTime<=gateTime ||
          request.reviewGateEvidence.staledReviewIds.includes(result.review_id)) {
        throw new CoreConflictError("Current review does not postdate the completed review gate uniquely");
      }
      continue;
    }
    if (result.freshness==="STALE") {
      throw new CoreConflictError("Stored stale review lacks completed review-gate evidence");
    }
    const reconciliationTime=Date.parse(request.reconciliationEvidence.receipt.created_at);
    const recordedTime=Date.parse(result.recorded_at);
    if (recordedTime===reconciliationTime) {
      throw new CoreConflictError("Review time is ambiguous with the reconciliation receipt");
    }
    if (recordedTime<reconciliationTime) {
      const stale=validateCoreDocument({...result,freshness:"STALE"},"review-result.v1");
      const projected=closedData({...item.work,review:null},"patch-staled Work snapshot");
      const state=deriveWorkItemState(projected);
      operations.push({resource:"pull_request",action:"update",
        repository:request.patchRelease.repository,expected_revision:pull.revision,
        payload:{kind:"release-patch-review-stale",patch_program_id:request.patch.program_id,
          feature_program_id:request.paused.program_id,work_item_id:item.work.item.id,
          pull_request_number:pull.number,head_sha:pull.head_sha,
          reviewed_revision:result.reviewed_revision,current_revision:pull.head_sha,
          freshness:"STALE",body:updateManagedReviewBlock(pull.body,stale),
          review_result:stale,work_review:null}});
      operations.push({resource:"project",action:"update",
        repository:request.patchRelease.repository,expected_revision:item.work.project.revision,
        payload:{kind:"release-patch-review-stale",patch_program_id:request.patch.program_id,
          feature_program_id:request.paused.program_id,work_item_id:item.work.item.id,
          pull_request_number:pull.number,pull_request_revision:pull.revision,
          project_id:item.work.project.project_id,item_id:item.work.project.item_id,
          reviewed_revision:result.reviewed_revision,current_revision:pull.head_sha,
          freshness:"STALE",fields:{Status:state.status,Gate:state.gate}}});
    }
  }
  const checksCurrent=request.observed.checks.head_sha===
    request.observed.repository.feature_branch.head_sha;
  if (!checksCurrent || request.observed.checks.state==="NOT_STARTED") {
    operations.push({resource:"workflow",action:"create",
      repository:request.patchRelease.repository,
      expected_revision:request.observed.repository.revision,
      payload:{kind:"release-check-request",patch_program_id:request.patch.program_id,
        feature_program_id:request.paused.program_id,branch:request.featureRelease.branch,
        head_sha:request.observed.repository.feature_branch.head_sha,
        required:request.observed.checks.required}});
    reviewPhaseChanged=true;
  }
  if (reviewPhaseChanged) {
    operations.push(completionManifest(request));
    return closedData(operations,"patch review and check operations");
  }
  if (!["PENDING","PASSED"].includes(request.observed.checks.state) || !checksCurrent) {
    throw new CoreBlockedError("Feature release checks have not started at the reconciled head");
  }
  const resumedRelease=transitionRepositoryRelease(request.featureRelease,{
    event:"RESUME_AFTER_PATCH",expected_revision:request.featureRelease.revision,
    timestamp:request.snapshot.timestamp,source_receipt:request.snapshot.receipt_id,
    activation:null,
  });
  const releases=request.paused.repository_releases.map(release =>
    release.release_id===resumedRelease.release_id ? resumedRelease : release);
  const resumed=closedData({...request.paused,phase:programPhase(releases),
    revision:incrementRevision(request.paused.revision,"Paused program revision"),
    repository_releases:releases,updated_at:request.snapshot.timestamp},
  "resumed feature program");
  operations.push(completionManifest(request,resumed));
  return closedData(operations,"patch resume operations");
}
