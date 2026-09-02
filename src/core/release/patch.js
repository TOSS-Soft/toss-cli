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
    "publication","repository_configuration","project"],"patch completion query");
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
  const observed=snapshot.observation;
  exact(observed,["kind","control_revision","project","patch","feature","repository",
    "reviews","checks"],"patch completion observation");
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
  exact(observed.repository.reconciliation,["patch_commit","patch_commit_is_ancestor","drifted"],
    "patch completion reconciliation");
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
      observed.repository.default_branch.head_sha!==publication.expected_revision ||
      observed.repository.feature_branch.name!==featureRelease.branch ||
      observed.repository.reconciliation.patch_commit!==publication.expected_revision ||
      typeof observed.repository.reconciliation.patch_commit_is_ancestor!=="boolean" ||
      typeof observed.repository.reconciliation.drifted!=="boolean" ||
      !SHA.test(observed.repository.default_branch.head_sha) ||
      !SHA.test(observed.repository.feature_branch.head_sha)) {
    throw new CoreConflictError("Patch completion observations drifted from released and paused tracks");
  }
  if (observed.repository.reconciliation.drifted) {
    throw new CoreBlockedError("Patch completion reconciliation is drifted");
  }
  if (!Array.isArray(observed.reviews) || !Array.isArray(observed.checks.required) ||
      observed.checks.required.length===0 ||
      !["NOT_STARTED","PENDING","PASSED","FAILED"].includes(observed.checks.state) ||
      !(observed.checks.head_sha===null || SHA.test(observed.checks.head_sha))) {
    invalid("Patch completion reviews or checks are malformed");
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
  for (let index=0;index<observed.reviews.length;index+=1) {
    const review=observed.reviews[index];
    exact(review,["work_item_id","pull_request_number","pull_request_revision","head_sha",
      "body","review_result","work"],`patch completion review[${index}]`);
    const identity=parseWorkItemId(review.work_item_id);
    const result=validateCoreDocument(review.review_result,"review-result.v1");
    const state=deriveWorkItemState(review.work);
    const pullKey=`${identity.repository}#${review.pull_request_number}`;
    if (!Number.isSafeInteger(review.pull_request_number) || review.pull_request_number<1 ||
        typeof review.pull_request_revision!=="string" || review.pull_request_revision.length===0 ||
        typeof review.body!=="string" || !SHA.test(review.head_sha) ||
        review.head_sha!==observed.repository.feature_branch.head_sha ||
        result.pull_request_number!==review.pull_request_number ||
        result.reviewed_revision!==review.work.review?.reviewed_revision ||
        result.verdict!==review.work.review?.verdict ||
        updateManagedReviewBlock(review.body,result)!==review.body ||
        review.work.item.id!==review.work_item_id ||
        review.work.pull_request?.state!=="READY" ||
        review.work.pull_request.head_sha!==review.head_sha ||
        review.work.physical_branch.head_sha!==review.head_sha ||
        (result.reviewed_revision===review.head_sha && result.freshness!=="CURRENT") ||
        (result.reviewed_revision!==review.head_sha &&
          !["CURRENT","STALE"].includes(result.freshness))) {
      invalid(`Patch completion review[${index}] is malformed`);
    }
    if (identity.repository!==patchRelease.repository ||
        result.repository!==identity.repository ||
        review.work.item.repository!==identity.repository ||
        review.work.project.project_id!==observed.project.id ||
        review.work.project.fields.repository!==identity.repository) {
      throw new CoreConflictError("Patch completion review belongs to a foreign repository or Project");
    }
    const scopedEpicId=review.work.item.kind==="epic"
      ? review.work.item.id
      : review.work.item.kind==="issue" ? review.work.parent?.id : null;
    if (scopedEpicId===null || !featureRelease.scope.includes(scopedEpicId)) {
      throw new CoreConflictError("Patch completion review is outside the paused feature release scope");
    }
    if (review.work.item.kind==="epic") {
      const assignment=review.work.release;
      if (assignment.assigned!==true || assignment.active!==true ||
          assignment.id!==`${featureRelease.repository}@${featureRelease.branch}` ||
          assignment.repository!==featureRelease.repository ||
          assignment.branch!==featureRelease.branch ||
          assignment.milestone!==featureRelease.milestone ||
          assignment.revision!==featureRelease.revision) {
        throw new CoreConflictError("Patch completion epic assignment does not bind the paused feature release");
      }
    }
    if (reviewWorkIds.has(review.work_item_id) || reviewPullRequests.has(pullKey) ||
        reviewProjectItems.has(review.work.project.item_id) || reviewIds.has(result.review_id)) {
      throw new CoreConflictError("Patch completion review identities are duplicated or ambiguous");
    }
    reviewWorkIds.add(review.work_item_id);
    reviewPullRequests.add(pullKey);
    reviewProjectItems.add(review.work.project.item_id);
    reviewIds.add(result.review_id);
    if (result.reviewed_revision!==review.head_sha &&
        (state.status!=="In review" || state.gate!=="REVIEW_REQUIRED")) {
      throw new CoreConflictError("Stale patch review does not derive the authoritative Work state");
    }
  }
  return Object.freeze({value,patch,paused,publication,patchRelease,featureRelease,
    snapshot,query,observed});
}

function completionManifest(request,program=request.paused) {
  return {resource:"repository",action:"commit",repository:request.query.control_repository,
    expected_revision:request.paused.revision,payload:{kind:"release-program-manifest",
      expected_program_revision:request.paused.revision,program}};
}

function completionPreconditions(request) {
  return [{resource:"project",action:"verify",repository:null,
    expected_revision:request.observed.project.revision,
    payload:{kind:"release-patch-completion-precondition",
      project_id:request.observed.project.id,query:request.query,
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
  const operations=completionPreconditions(request);
  if (!request.observed.repository.reconciliation.patch_commit_is_ancestor) {
    operations.push({resource:"branch",action:"merge",repository:request.patchRelease.repository,
      expected_revision:request.observed.repository.feature_branch.revision,
      payload:{kind:"release-patch-reconcile",patch_program_id:request.patch.program_id,
        patch_release_id:request.patchRelease.release_id,
        feature_program_id:request.paused.program_id,
        feature_release_id:request.featureRelease.release_id,
        source_branch:request.observed.repository.default_branch.name,
        source_sha:request.publication.expected_revision,
        target_branch:request.featureRelease.branch,
        target_sha:request.observed.repository.feature_branch.head_sha}});
    operations.push(completionManifest(request));
    return closedData(operations,"patch reconciliation operations");
  }
  for (const review of request.observed.reviews) {
    const result=review.review_result;
    const state=deriveWorkItemState(review.work);
    if (result.reviewed_revision!==review.head_sha && result.freshness!=="STALE") {
      const stale=validateCoreDocument({...result,freshness:"STALE"},"review-result.v1");
      operations.push({resource:"pull_request",action:"update",
        repository:request.patchRelease.repository,expected_revision:review.pull_request_revision,
        payload:{kind:"release-patch-review-stale",patch_program_id:request.patch.program_id,
          feature_program_id:request.paused.program_id,work_item_id:review.work_item_id,
          pull_request_number:review.pull_request_number,head_sha:review.head_sha,
          reviewed_revision:result.reviewed_revision,current_revision:review.head_sha,
          freshness:"STALE",body:updateManagedReviewBlock(review.body,stale),review_result:stale}});
      operations.push({resource:"project",action:"update",
        repository:request.patchRelease.repository,expected_revision:review.work.project.revision,
        payload:{kind:"release-patch-review-stale",patch_program_id:request.patch.program_id,
          feature_program_id:request.paused.program_id,work_item_id:review.work_item_id,
          pull_request_number:review.pull_request_number,
          pull_request_revision:review.pull_request_revision,
          project_id:review.work.project.project_id,item_id:review.work.project.item_id,
          reviewed_revision:result.reviewed_revision,current_revision:review.head_sha,
          freshness:"STALE",fields:{Status:state.status,Gate:state.gate}}});
    } else if (result.reviewed_revision!==review.head_sha &&
        (review.work.project.fields.Status!==state.status ||
          review.work.project.fields.Gate!==state.gate)) {
      throw new CoreConflictError("Stale patch review does not carry REVIEW_REQUIRED Project state");
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
  }
  if (operations.length>3) {
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
