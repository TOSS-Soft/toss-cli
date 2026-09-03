import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {compareCanonicalText} from "../canonical-order.js";
import {validateCoreDocument} from "../contracts.js";
import {parseWorkItemId} from "../domain/identity.js";
import {CoreConflictError,CoreValidationError} from "../errors.js";
import {parseSemVer} from "./semver.js";
import {assertReleaseApprovalSemantics} from "./approval.js";

export const REPOSITORY_RELEASE_PHASES=Object.freeze([
  "DRAFT","ACTIVE","PAUSED","READY_FOR_APPROVAL","PUBLISHING","RELEASED",
]);
export const PROGRAM_PHASES=Object.freeze([
  "DRAFT","ACTIVE","PAUSED","PUBLISHING","RELEASED","WAITING_FOR_EPIC",
]);
export const TRANSITIONS=Object.freeze({
  ACTIVATE:Object.freeze({DRAFT:"ACTIVE"}),
  PAUSE_FOR_PATCH:Object.freeze({ACTIVE:"PAUSED"}),
  RESUME_AFTER_PATCH:Object.freeze({PAUSED:"ACTIVE"}),
  SCOPE_DONE:Object.freeze({ACTIVE:"READY_FOR_APPROVAL"}),
  APPROVE:Object.freeze({READY_FOR_APPROVAL:"PUBLISHING"}),
  VERIFY_PUBLICATION:Object.freeze({PUBLISHING:"RELEASED"}),
});

const EVENT_KEYS=Object.freeze([
  "event","expected_revision","timestamp","source_receipt","activation",
]);
const ACTIVATION_KEYS=Object.freeze([
  "version","milestone","branch","release_pr_intent",
]);
const PROGRAM_KEYS=Object.freeze([
  "schema_version","program_id","phase","revision","repository_releases",
  "dependency_stages","selected_scope","deferred_scope","rationale","interrupts",
  "created_at","updated_at",
]);
const REPOSITORY_RELEASE_KEYS=Object.freeze([
  "schema_version","release_id","program_id","repository","phase","revision",
  "version","milestone","branch","release_pr_intent","scope","approval","publication_evidence",
  "transitions",
]);
const ACTIVE_CONCURRENCY_PHASES=Object.freeze(new Set([
  "ACTIVE","READY_FOR_APPROVAL","PUBLISHING",
]));
const PROGRAM_TRACK_PHASES=Object.freeze(new Map([
  ["DRAFT",Object.freeze(new Set(["DRAFT"]))],
  ["ACTIVE",Object.freeze(new Set([
    "DRAFT","ACTIVE","READY_FOR_APPROVAL","RELEASED",
  ]))],
  ["PAUSED",Object.freeze(new Set([
    "DRAFT","ACTIVE","PAUSED","READY_FOR_APPROVAL","RELEASED",
  ]))],
  ["PUBLISHING",Object.freeze(new Set(REPOSITORY_RELEASE_PHASES))],
  ["RELEASED",Object.freeze(new Set(["RELEASED"]))],
  ["WAITING_FOR_EPIC",Object.freeze(new Set())],
]));
const VERSION_REASON_ORDER=Object.freeze(new Map([
  ["breaking_public_boundary",0],
  ["backward_compatible_feature",1],
  ["published_product_fix",2],
  ["unreleased_defect_excluded",3],
]));
const SELECTABLE_CHANGE_CLASS=Object.freeze(new Map([
  ["breaking_public_boundary","major"],
  ["backward_compatible_feature","minor"],
  ["published_product_fix","patch"],
]));
const DEFERRED_REASON_CODES=Object.freeze(new Set([
  "EPIC_UNAPPROVED","EPIC_ALREADY_VERSIONED","EPIC_NOT_DECOMPOSED",
  "REPOSITORY_UNREGISTERED","ACTIVE_PROGRAM_ASSIGNMENT","DEPENDENCY_MISSING",
  "DEPENDENCY_INELIGIBLE","OUTCOME_NOT_SELECTED",
]));
const REVISION=/^REV-(?:000[1-9]|00[1-9][0-9]|0[1-9][0-9]{2}|[1-9][0-9]{3,})$/;
const RECEIPT=/^RECEIPT-[0-9]{8}-[0-9]{4,}$/;
const RFC3339_DATE_TIME=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const MAX_CLOSED_DATA_DEPTH=64;

function invalid(message,options={}) {
  throw new CoreValidationError(message,options);
}

function defineData(target,key,value) {
  Object.defineProperty(target,key,{
    value,
    enumerable:true,
    writable:true,
    configurable:true,
  });
}

function shallowExactRecord(value,keys,label) {
  if (value===null || typeof value!=="object" || Array.isArray(value) ||
      types.isProxy(value)) {
    invalid(`${label} must be a plain non-proxy record`);
  }
  const prototype=Object.getPrototypeOf(value);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const ownKeys=Reflect.ownKeys(descriptors);
  if (![Object.prototype,null].includes(prototype) || ownKeys.length!==keys.length ||
      ownKeys.some(key => typeof key!=="string") ||
      keys.some(key => !Object.hasOwn(descriptors,key))) {
    invalid(`${label} must use the exact closed shape`);
  }
  const captured=Object.create(null);
  for (const key of keys) {
    const descriptor=descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor)) {
      invalid(`${label}.${key} must be an own enumerable data property`);
    }
    captured[key]=descriptor.value;
  }
  return captured;
}

function shallowDenseArray(value,label) {
  if (value===null || typeof value!=="object" || types.isProxy(value) ||
      !Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype) {
    invalid(`${label} must be a dense plain array`);
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const keys=Reflect.ownKeys(descriptors);
  const lengthDescriptor=descriptors.length;
  const length=lengthDescriptor?.value;
  if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.enumerable ||
      !Number.isSafeInteger(length) || length<0 || keys.length!==length+1) {
    invalid(`${label} must be a dense plain array`);
  }
  const captured=[];
  for (let index=0;index<length;index+=1) {
    const descriptor=descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      invalid(`${label} must contain dense own data`);
    }
    captured.push(descriptor.value);
  }
  return captured;
}

function copyClosed(value,label,ancestors=new Set(),depth=0) {
  if (depth>MAX_CLOSED_DATA_DEPTH) {
    invalid(`${label} exceeds the maximum closed-data depth`);
  }
  if (value===null || typeof value==="string" || typeof value==="boolean") return value;
  if (typeof value==="number") {
    if (!Number.isFinite(value)) invalid(`${label} must contain only finite JSON numbers`);
    return value;
  }
  if (typeof value!=="object" || types.isProxy(value)) {
    invalid(`${label} must contain only plain non-proxy JSON data`);
  }
  if (ancestors.has(value)) invalid(`${label} must not be cyclic`);
  ancestors.add(value);
  try {
    const prototype=Object.getPrototypeOf(value);
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const keys=Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      if (prototype!==Array.prototype) invalid(`${label} arrays must be plain`);
      const lengthDescriptor=descriptors.length;
      const length=lengthDescriptor?.value;
      const dataKeys=keys.filter(key => key!=="length");
      if (!lengthDescriptor || !("value" in lengthDescriptor) ||
          lengthDescriptor.enumerable || !Number.isSafeInteger(length) || length<0 ||
          dataKeys.length!==length) {
        invalid(`${label} arrays must be dense own data`);
      }
      const result=[];
      for (let index=0;index<length;index+=1) {
        const descriptor=descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          invalid(`${label} arrays must be dense own data`);
        }
        result.push(copyClosed(descriptor.value,`${label}[${index}]`,ancestors,depth+1));
      }
      return Object.freeze(result);
    }
    if (prototype!==Object.prototype && prototype!==null) {
      invalid(`${label} objects must be plain`);
    }
    const result={};
    for (const key of keys) {
      const descriptor=descriptors[key];
      if (typeof key!=="string" || !descriptor.enumerable || !("value" in descriptor)) {
        invalid(`${label} objects must contain only own enumerable data`);
      }
      defineData(result,key,copyClosed(descriptor.value,`${label}.${key}`,ancestors,depth+1));
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function exactKeys(value,expected,label) {
  if (value===null || typeof value!=="object" || Array.isArray(value) ||
      canonicalJson(Object.keys(value).sort())!==canonicalJson([...expected].sort())) {
    invalid(`${label} must use the exact closed shape`);
  }
}

function assertAsciiOrderedUnique(values,label) {
  for (let index=1;index<values.length;index+=1) {
    if (compareCanonicalText(values[index-1],values[index])>=0) {
      invalid(`${label} must use unique stable ASCII order`);
    }
  }
}

function assertIdentityOrderedUnique(values,identity,label) {
  for (let index=1;index<values.length;index+=1) {
    if (compareCanonicalText(identity(values[index-1]),identity(values[index]))>=0) {
      invalid(`${label} must use unique stable raw code-point order`);
    }
  }
}

function isRfc3339DateTime(value) {
  if (typeof value!=="string") return false;
  const match=RFC3339_DATE_TIME.exec(value);
  if (!match) return false;
  const [
    ,yearText,monthText,dayText,hourText,minuteText,secondText,
    offsetHourText,offsetMinuteText,
  ]=match;
  const year=Number(yearText);
  const month=Number(monthText);
  const day=Number(dayText);
  const leap=year%4===0 && (year%100!==0 || year%400===0);
  const days=month===2 ? (leap ? 29 : 28) : [4,6,9,11].includes(month) ? 30 : 31;
  if (month<1 || month>12 || day<1 || day>days || Number(hourText)>23 ||
      Number(minuteText)>59 || Number(secondText)>59) return false;
  return offsetHourText===undefined ||
    (Number(offsetHourText)<=23 && Number(offsetMinuteText)<=59);
}

function parseRevision(value,label) {
  if (typeof value!=="string" || !REVISION.test(value)) {
    invalid(`${label} must be a canonical REV-#### revision`);
  }
  const digits=value.slice(4);
  const revision=Number(digits);
  if (!Number.isSafeInteger(revision) || revision<1) {
    invalid(`${label} exceeds the supported safe revision range`);
  }
  return Object.freeze({digits,revision});
}

function incrementRevision(value) {
  const parsed=parseRevision(value,"Repository release revision");
  if (parsed.revision===Number.MAX_SAFE_INTEGER) {
    invalid("Repository release revision cannot be incremented safely");
  }
  const incremented=String(parsed.revision+1);
  return `REV-${incremented.padStart(Math.max(4,parsed.digits.length),"0")}`;
}

function assertReleaseIdentities(release) {
  if (release.phase!=="DRAFT") {
    if (release.milestone!==`v${release.version}` ||
        release.branch!==`release/v${release.version}` ||
        release.release_pr_intent.head!==release.branch) {
      invalid("Repository release version, milestone, branch, and release PR intent must agree");
    }
  }

  const approval=release.approval;
  if (["PUBLISHING","RELEASED"].includes(release.phase)!==(approval!==null)) {
    invalid("Repository release approval must exist exactly in Publishing or Released");
  }
  if (approval!==null) {
    const review=approval.review;
    if (approval.program_id!==release.program_id || approval.release_id!==release.release_id ||
        approval.pull_request.head!==release.release_pr_intent.head ||
        approval.pull_request.base!==release.release_pr_intent.base ||
        approval.pull_request.head_sha!==approval.merge_result_revision ||
        approval.pull_request.base_sha!==review.implementation_identity.base_revision ||
        approval.pull_request.head_sha!==review.implementation_identity.revision ||
        review.result.reviewed_revision!==approval.pull_request.head_sha ||
        review.result.verdict!=="APPROVED" || review.result.freshness!=="CURRENT" ||
        review.formal_review.state!=="APPROVED" ||
        review.formal_review.review_id!==review.result.review_id ||
        review.formal_review.reviewed_revision!==approval.pull_request.head_sha ||
        approval.publication.package_name.trim()!==approval.publication.package_name ||
        approval.publication.workflow.trim()!==approval.publication.workflow ||
        approval.publication.required_assets.some(asset => asset.trim()!==asset)) {
      invalid("Release approval must bind the exact program, release, manifest, PR, and merge revision");
    }
    assertIdentityOrderedUnique(approval.checks,check => check.name,"Release approval checks by name");
    assertAsciiOrderedUnique(approval.publication.required_assets,
      "Release approval required publication assets");
    assertReleaseApprovalSemantics(release);
  }
  assertAsciiOrderedUnique(release.scope,"Repository release scope");
  for (const scopeId of release.scope) {
    if (parseWorkItemId(scopeId).repository!==release.repository) {
      invalid(`Repository release scope ${scopeId} must belong to ${release.repository}`);
    }
  }

  const evidence=release.publication_evidence;
  if (evidence!==null) {
    const verification=release.transitions.filter(transition =>
      transition.event==="VERIFY_PUBLICATION");
    if (evidence.release_id!==release.release_id ||
        evidence.repository!==release.repository ||
        evidence.version!==release.version ||
        evidence.tag.name!==`v${release.version}` ||
        evidence.package.version!==release.version ||
        evidence.package.name!==approval?.publication.package_name ||
        evidence.github_release.tag_name!==`v${release.version}` ||
        evidence.expected_revision!==approval?.merge_result_revision ||
        evidence.tag.target_revision!==evidence.expected_revision ||
        evidence.github_release.target_revision!==evidence.expected_revision ||
        (release.phase==="RELEASED" && (verification.length!==1 ||
          verification[0].source_receipt!==evidence.source_receipt ||
          verification[0].timestamp!==evidence.verified_at))) {
      invalid("Publication evidence must bind the exact repository release identity and revision");
    }
    const {evidence_sha256,...unsignedEvidence}=evidence;
    if (evidence_sha256!==sha256Canonical(unsignedEvidence)) {
      invalid("Publication evidence hash must bind the exact immutable evidence content");
    }
    assertIdentityOrderedUnique(
      evidence.github_release.assets,
      asset => asset.name,
      "Publication evidence assets by name",
    );
    const assets=evidence.github_release.assets.map(asset => asset.name);
    if (canonicalJson(assets)!==canonicalJson(approval.publication.required_assets)) {
      invalid("Publication evidence assets must equal the approval-frozen required asset set");
    }
  }
}

function normalizeRepositoryRelease(input,label="Repository release") {
  const release=copyClosed(shallowExactRecord(input,REPOSITORY_RELEASE_KEYS,label),label);
  validateCoreDocument(release,"repository-release.v1");
  parseRevision(release.revision,`${label} revision`);
  assertReleaseIdentities(release);
  for (let index=0;index<release.transitions.length;index+=1) {
    const transition=release.transitions[index];
    if (TRANSITIONS[transition.event]?.[transition.source_phase]!==transition.target_phase) {
      invalid(`${label} transition ${index} is not a legal repository release transition`);
    }
    if (index>0 && release.transitions[index-1].target_phase!==transition.source_phase) {
      invalid(`${label} transition history is not contiguous`);
    }
  }
  if (release.phase==="DRAFT") {
    if (release.transitions.length!==0) {
      invalid(`${label} in DRAFT must not have transition history`);
    }
  } else {
    const first=release.transitions[0];
    if (first===undefined || first.event!=="ACTIVATE" ||
        first.source_phase!=="DRAFT" || first.target_phase!=="ACTIVE") {
      invalid(`${label} transition history must begin with DRAFT to ACTIVE activation`);
    }
    if (release.transitions.at(-1).target_phase!==release.phase) {
      invalid(`${label} phase must equal its final transition target`);
    }
  }
  return release;
}

function assertProgramTrackPhaseCoherence(program,releases) {
  const allowed=PROGRAM_TRACK_PHASES.get(program.phase);
  if (releases.some(release => !allowed.has(release.phase))) {
    invalid(`Program ${program.program_id} phase ${program.phase} contains an incoherent repository release phase`);
  }
  if (program.phase==="ACTIVE" &&
      (releases.every(release => release.phase==="DRAFT") ||
       releases.every(release => release.phase==="RELEASED"))) {
    invalid(`Program ${program.program_id} ACTIVE phase must be between all-DRAFT and all-RELEASED`);
  }
  if (program.phase==="PAUSED" && !releases.some(release => release.phase==="PAUSED")) {
    invalid(`Program ${program.program_id} PAUSED phase requires a paused repository release`);
  }
  if (program.phase==="PUBLISHING" &&
      !releases.some(release => release.phase==="PUBLISHING")) {
    invalid(`Program ${program.program_id} PUBLISHING phase requires a publishing repository release`);
  }
}

function normalizeEvent(input) {
  const event=copyClosed(
    shallowExactRecord(input,EVENT_KEYS,"Repository release event"),
    "Repository release event",
  );
  if (typeof event.event!=="string") {
    invalid("Repository release event name must be a string");
  }
  if (!Object.hasOwn(TRANSITIONS,event.event)) {
    invalid(`Unknown repository release event: ${event.event}`);
  }
  parseRevision(event.expected_revision,"Repository release expected revision");
  if (!isRfc3339DateTime(event.timestamp)) {
    invalid("Repository release event timestamp must be RFC3339 date-time");
  }
  if (typeof event.source_receipt!=="string" || !RECEIPT.test(event.source_receipt)) {
    invalid("Repository release event source receipt must be canonical");
  }
  if (event.event==="ACTIVATE") {
    exactKeys(event.activation,ACTIVATION_KEYS,"Repository release activation");
  } else if (event.activation!==null) {
    invalid("Only ACTIVATE may carry repository release activation data");
  }
  return event;
}

function assertVerifiedPublication(release) {
  const evidence=release.publication_evidence;
  if (evidence===null) {
    invalid("Publication evidence is required before VERIFY_PUBLICATION");
  }
  if (evidence.github_release.draft || evidence.github_release.prerelease) {
    invalid("Publication evidence must identify a final non-draft GitHub Release");
  }
}

export function transitionRepositoryRelease(releaseInput,eventInput) {
  const release=normalizeRepositoryRelease(releaseInput);
  const event=normalizeEvent(eventInput);
  if (event.expected_revision!==release.revision) {
    throw new CoreConflictError(
      `Repository release revision changed: expected ${event.expected_revision}, observed ${release.revision}`,
    );
  }
  const targetPhase=TRANSITIONS[event.event][release.phase];
  if (targetPhase===undefined) {
    invalid(`Illegal repository release transition: ${event.event} from ${release.phase}`);
  }
  if (event.event==="VERIFY_PUBLICATION") assertVerifiedPublication(release);

  const materialized=event.event==="ACTIVATE" ? event.activation : {};
  const transition=Object.freeze({
    event:event.event,
    source_phase:release.phase,
    target_phase:targetPhase,
    timestamp:event.timestamp,
    source_receipt:event.source_receipt,
  });
  const candidate={
    ...release,
    ...materialized,
    phase:targetPhase,
    revision:incrementRevision(release.revision),
    transitions:[...release.transitions,transition],
  };
  return normalizeRepositoryRelease(candidate,"Transitioned repository release");
}

export function approveRepositoryRelease(releaseInput,eventInput,approvalInput) {
  const release=normalizeRepositoryRelease(releaseInput);
  const event=normalizeEvent(eventInput);
  if (event.event!=="APPROVE" || release.phase!=="READY_FOR_APPROVAL" ||
      event.expected_revision!==release.revision) {
    invalid("Release approval transition must target the exact Ready for approval revision");
  }
  const approval=copyClosed(approvalInput,"Release approval");
  const transition=Object.freeze({
    event:event.event,source_phase:release.phase,target_phase:"PUBLISHING",
    timestamp:event.timestamp,source_receipt:event.source_receipt,
  });
  return normalizeRepositoryRelease({
    ...release,approval,phase:"PUBLISHING",revision:incrementRevision(release.revision),
    transitions:[...release.transitions,transition],
  },"Approved repository release");
}

function assertProgramSemantics(program) {
  const repositories=new Set();
  const releaseIds=new Set();
  const releasesByRepository=new Map();
  let previousRepository;
  for (const releaseInput of program.repository_releases) {
    const release=normalizeRepositoryRelease(releaseInput,`Program ${program.program_id} repository release`);
    if (release.program_id!==program.program_id) {
      invalid(`Program ${program.program_id} contains a release owned by ${release.program_id}`);
    }
    if (repositories.has(release.repository)) {
      invalid(`Program ${program.program_id} contains more than one release for ${release.repository}`);
    }
    if (releaseIds.has(release.release_id)) {
      invalid(`Program ${program.program_id} contains duplicate release ${release.release_id}`);
    }
    if (previousRepository!==undefined &&
        compareCanonicalText(previousRepository,release.repository)>=0) {
      invalid(`Program ${program.program_id} repository releases must use stable ASCII order`);
    }
    repositories.add(release.repository);
    releaseIds.add(release.release_id);
    releasesByRepository.set(release.repository,release);
    previousRepository=release.repository;
  }
  assertProgramTrackPhaseCoherence(program,[...releasesByRepository.values()]);

  assertIdentityOrderedUnique(
    program.selected_scope,
    selected => selected.epic_id,
    `Program ${program.program_id} selected scope by epic id`,
  );
  const selectedIds=program.selected_scope.map(selected => selected.epic_id);
  const selectedIdSet=new Set(selectedIds);
  assertIdentityOrderedUnique(
    program.deferred_scope,
    deferred => deferred.epic_id,
    `Program ${program.program_id} deferred scope by epic id`,
  );
  for (const deferred of program.deferred_scope) {
    if (!DEFERRED_REASON_CODES.has(deferred.reason_code)) {
      invalid(`Program ${program.program_id} deferred scope uses an unknown Task 3 reason code`);
    }
    if (selectedIdSet.has(deferred.epic_id)) {
      invalid(`Program ${program.program_id} scope ${deferred.epic_id} cannot be both selected and deferred`);
    }
    assertAsciiOrderedUnique(
      deferred.blocking_ids,
      `Program ${program.program_id} deferred scope ${deferred.epic_id} blocking ids`,
    );
  }

  assertIdentityOrderedUnique(
    program.rationale,
    rationale => rationale.repository,
    `Program ${program.program_id} rationale by repository`,
  );
  if (program.rationale.length!==program.repository_releases.length) {
    invalid(`Program ${program.program_id} rationale must describe every repository release exactly once`);
  }
  for (const rationale of program.rationale) {
    const release=releasesByRepository.get(rationale.repository);
    if (release===undefined) {
      invalid(`Program ${program.program_id} rationale references unknown repository ${rationale.repository}`);
    }
    parseSemVer(rationale.version);
    if (release.phase!=="DRAFT" && rationale.version!==release.version) {
      invalid(`Program ${program.program_id} rationale version must equal the materialized repository release version`);
    }

    let previousReason=-1;
    const reasonScope=new Set();
    const selectedScope=new Set(release.scope);
    const selectedReasonScope=new Set();
    let firstSelectableRule;
    for (const reason of rationale.reasons) {
      const reasonOrder=VERSION_REASON_ORDER.get(reason.rule);
      if (reasonOrder<=previousReason) {
        invalid(`Program ${program.program_id} rationale reasons must use Task 2 canonical rule order`);
      }
      previousReason=reasonOrder;
      assertAsciiOrderedUnique(
        reason.scope_ids,
        `Program ${program.program_id} rationale ${rationale.repository} ${reason.rule} scope ids`,
      );
      const selectable=SELECTABLE_CHANGE_CLASS.has(reason.rule);
      if (selectable && firstSelectableRule===undefined) firstSelectableRule=reason.rule;
      for (const scopeId of reason.scope_ids) {
        if (parseWorkItemId(scopeId).repository!==rationale.repository) {
          invalid(`Program ${program.program_id} rationale scope ${scopeId} must belong to ${rationale.repository}`);
        }
        if (selectable && !selectedScope.has(scopeId)) {
          invalid(`Program ${program.program_id} rationale selectable scope ${scopeId} must belong to selected scope in ${rationale.repository}`);
        }
        if (reasonScope.has(scopeId)) {
          invalid(`Program ${program.program_id} rationale repeats scope ${scopeId}`);
        }
        reasonScope.add(scopeId);
        if (selectable) selectedReasonScope.add(scopeId);
      }
    }
    const expectedChangeClass=SELECTABLE_CHANGE_CLASS.get(firstSelectableRule) ?? null;
    if (rationale.change_class!==expectedChangeClass) {
      invalid(`Program ${program.program_id} rationale change class must preserve Task 2 selection precedence`);
    }
    if (release.scope.some(scopeId => !selectedReasonScope.has(scopeId))) {
      invalid(`Program ${program.program_id} rationale must explain every repository release scope item`);
    }
  }

  let previousStage=0;
  const stagedReleases=new Set();
  for (const stage of program.dependency_stages) {
    if (stage.stage<=previousStage) {
      invalid(`Program ${program.program_id} dependency stages must be strictly increasing`);
    }
    assertAsciiOrderedUnique(
      stage.repository_release_ids,
      `Program ${program.program_id} dependency stage ${stage.stage}`,
    );
    for (const releaseId of stage.repository_release_ids) {
      if (!releaseIds.has(releaseId) || stagedReleases.has(releaseId)) {
        invalid(`Program ${program.program_id} dependency stages must reference each release exactly once`);
      }
      stagedReleases.add(releaseId);
    }
    previousStage=stage.stage;
  }
  if (stagedReleases.size!==releaseIds.size) {
    invalid(`Program ${program.program_id} dependency stages must include every repository release`);
  }

  const scoped=new Set();
  for (const release of program.repository_releases) {
    for (const scopeId of release.scope) {
      if (scoped.has(scopeId)) invalid(`Program ${program.program_id} selects duplicate scope ${scopeId}`);
      scoped.add(scopeId);
    }
  }
  if (canonicalJson([...scoped].sort(compareCanonicalText))!==canonicalJson(selectedIds)) {
    invalid(`Program ${program.program_id} selected scope must equal its repository release scope`);
  }
}

function normalizeProgram(input,index) {
  const label=`Release program ${index}`;
  const program=copyClosed(shallowExactRecord(input,PROGRAM_KEYS,label),label);
  validateCoreDocument(program,"release-program.v1");
  parseRevision(program.revision,`Release program ${program.program_id} revision`);
  assertProgramSemantics(program);
  return program;
}

export function assertRepositoryConcurrency(programsInput) {
  const programs=shallowDenseArray(programsInput,"Release programs");
  const byProgramId=new Set();
  const activeByRepository=new Map();
  const normalizedPrograms=[];
  for (let index=0;index<programs.length;index+=1) {
    const program=normalizeProgram(programs[index],index);
    if (byProgramId.has(program.program_id)) {
      invalid(`Duplicate release program: ${program.program_id}`);
    }
    byProgramId.add(program.program_id);
    normalizedPrograms.push(program);
    for (const release of program.repository_releases) {
      if (!ACTIVE_CONCURRENCY_PHASES.has(release.phase)) continue;
      const active=activeByRepository.get(release.repository) ?? [];
      active.push(release.release_id);
      activeByRepository.set(release.repository,active);
    }
  }

  const programsById=new Map(normalizedPrograms.map(program => [program.program_id,program]));
  for (const program of normalizedPrograms) {
    if (program.interrupts===null || !["ACTIVE","PUBLISHING"].includes(program.phase)) continue;
    const interruptedProgram=programsById.get(program.interrupts.program_id);
    const interruptedRelease=interruptedProgram?.repository_releases.find(release =>
      release.release_id===program.interrupts.repository_release_id);
    const patchRelease=interruptedRelease===undefined ? undefined :
      program.repository_releases.find(release => release.repository===interruptedRelease.repository);
    if (interruptedProgram===undefined || interruptedProgram===program ||
        interruptedRelease===undefined || interruptedRelease.phase!=="PAUSED" ||
        interruptedRelease.revision!==program.interrupts.paused_release_revision ||
        patchRelease===undefined || !ACTIVE_CONCURRENCY_PHASES.has(patchRelease.phase)) {
      invalid(`Program ${program.program_id} interruption must bind the exact paused program, release, revision, and active patch track`);
    }
  }

  for (const [repository,releaseIds] of [...activeByRepository].sort(([left],[right]) =>
    compareCanonicalText(left,right))) {
    if (releaseIds.length>1) {
      const ordered=[...releaseIds].sort(compareCanonicalText);
      throw new CoreConflictError(
        `Repository ${repository} has concurrent active releases: ${ordered.join(", ")}`,
      );
    }
  }
  return true;
}
