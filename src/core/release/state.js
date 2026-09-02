import {types} from "node:util";

import {canonicalJson} from "../../contracts/acp.js";
import {validateCoreDocument} from "../contracts.js";
import {CoreConflictError,CoreValidationError} from "../errors.js";

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
const ACTIVE_CONCURRENCY_PHASES=Object.freeze(new Set([
  "ACTIVE","READY_FOR_APPROVAL","PUBLISHING",
]));
const REVISION=/^REV-(?:000[1-9]|00[1-9][0-9]|0[1-9][0-9]{2}|[1-9][0-9]{3,})$/;
const RECEIPT=/^RECEIPT-[0-9]{8}-[0-9]{4,}$/;
const RFC3339_DATE_TIME=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

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

function copyClosed(value,label,ancestors=new Set()) {
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
        result.push(copyClosed(descriptor.value,`${label}[${index}]`,ancestors));
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
      defineData(result,key,copyClosed(descriptor.value,`${label}.${key}`,ancestors));
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

function compareText(left,right) {
  if (left===right) return 0;
  return left<right ? -1 : 1;
}

function assertAsciiOrderedUnique(values,label) {
  for (let index=1;index<values.length;index+=1) {
    if (values[index-1]>=values[index]) {
      invalid(`${label} must use unique stable ASCII order`);
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
  assertAsciiOrderedUnique(release.scope,"Repository release scope");

  const evidence=release.publication_evidence;
  if (evidence!==null) {
    if (evidence.release_id!==release.release_id ||
        evidence.repository!==release.repository ||
        evidence.version!==release.version ||
        evidence.tag.name!==`v${release.version}` ||
        evidence.package.version!==release.version ||
        evidence.github_release.tag_name!==`v${release.version}` ||
        evidence.tag.target_revision!==evidence.expected_revision ||
        evidence.github_release.target_revision!==evidence.expected_revision) {
      invalid("Publication evidence must bind the exact repository release identity and revision");
    }
  }
}

function normalizeRepositoryRelease(input,label="Repository release") {
  const release=copyClosed(input,label);
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
  return release;
}

function normalizeEvent(input) {
  const event=copyClosed(input,"Repository release event");
  exactKeys(event,EVENT_KEYS,"Repository release event");
  if (!Object.hasOwn(TRANSITIONS,event.event)) {
    invalid(`Unknown repository release event: ${String(event.event)}`);
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

function assertProgramSemantics(program) {
  const repositories=new Set();
  const releaseIds=new Set();
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
    if (previousRepository!==undefined && previousRepository>=release.repository) {
      invalid(`Program ${program.program_id} repository releases must use stable ASCII order`);
    }
    repositories.add(release.repository);
    releaseIds.add(release.release_id);
    previousRepository=release.repository;
  }

  assertAsciiOrderedUnique(program.selected_scope,`Program ${program.program_id} selected scope`);
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
  if (canonicalJson([...scoped].sort(compareText))!==canonicalJson(program.selected_scope)) {
    invalid(`Program ${program.program_id} selected scope must equal its repository release scope`);
  }
}

function normalizeProgram(input,index) {
  const program=copyClosed(input,`Release program ${index}`);
  validateCoreDocument(program,"release-program.v1");
  parseRevision(program.revision,`Release program ${program.program_id} revision`);
  assertProgramSemantics(program);
  return program;
}

export function assertRepositoryConcurrency(programsInput) {
  const programs=copyClosed(programsInput,"Release programs");
  if (!Array.isArray(programs)) invalid("Release programs must be an array");
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
    compareText(left,right))) {
    if (releaseIds.length>1) {
      const ordered=[...releaseIds].sort(compareText);
      throw new CoreConflictError(
        `Repository ${repository} has concurrent active releases: ${ordered.join(", ")}`,
      );
    }
  }
  return true;
}
