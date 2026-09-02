import {types} from "node:util";

import {canonicalJson} from "../../contracts/acp.js";
import {validateCoreDocument} from "../contracts.js";
import {CoreValidationError} from "../errors.js";
import {requiredBaseBranch} from "./branching.js";
import {parseWorkItemId} from "./identity.js";

const SNAPSHOT_KEYS=Object.freeze([
  "schema_version","item","issue_state","drifted","epic_required","prepared",
  "scope_approved","parent","release","blocking_dependencies","children_complete",
  "physical_branch","pull_request","review","checks","authority","project",
]);
const PROJECT_FIELD_KEYS=Object.freeze([
  "Status","Gate","repository","parent","milestone","branch","base_branch",
  "last_reconciled_at",
]);
const STATE_KEYS=Object.freeze(["status","gate","reason","next_command"]);
const STATUSES=Object.freeze([
  "Backlog","Blocked","Done","In progress","In review","Ready",
]);
const GATES=Object.freeze([
  "CHANGES_REQUESTED","DEPENDENCY_REQUIRED","EPIC_ACCEPTANCE_REQUIRED",
  "EPIC_APPROVAL_REQUIRED","EPIC_PREPARATION_REQUIRED","EPIC_REQUIRED","NONE",
  "RECONCILE_REQUIRED","RELEASE_APPROVAL_REQUIRED","RELEASE_PLANNING",
  "REVIEW_REQUIRED",
]);
const NEXT_COMMANDS=Object.freeze([
  "toss-core sync","toss-core feature add","toss-core epic prepare",
  "toss-core epic approve","toss-core release plan","toss-core dependency check",
  "toss-core issue start","toss-core issue submit","toss-core epic submit",
  "toss-core review record","toss-core review status","toss-core epic accept",
  "toss-core release approve",
]);
const SHA=/^[a-f0-9]{40}$/;
const RELEASE_BRANCH=/^release\/(v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/;
const RFC3339_DATE_TIME=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function invalid(message,options={}) {
  throw new CoreValidationError(message,options);
}

function copyClosed(value,label,ancestors=new Set()) {
  if (value===null || ["string","boolean"].includes(typeof value)) return value;
  if (typeof value==="number") {
    if (!Number.isFinite(value)) invalid(`${label} must contain only finite JSON values`);
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
      const length=descriptors.length?.value;
      const dataKeys=keys.filter(key => key!=="length");
      if (!Number.isSafeInteger(length) || length<0 || dataKeys.length!==length) {
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
    const result=Object.create(null);
    for (const key of keys) {
      const descriptor=descriptors[key];
      if (typeof key!=="string" || !descriptor.enumerable || !("value" in descriptor)) {
        invalid(`${label} objects must contain only own enumerable data`);
      }
      result[key]=copyClosed(descriptor.value,`${label}.${key}`,ancestors);
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

function nonEmptyText(value,label) {
  if (typeof value!=="string" || value.trim().length===0) {
    invalid(`${label} must be non-empty text`);
  }
  return value;
}

function boolean(value,label) {
  if (typeof value!=="boolean") invalid(`${label} must be Boolean`);
  return value;
}

function sha(value,label) {
  if (typeof value!=="string" || !SHA.test(value)) {
    invalid(`${label} must be a lowercase 40-character commit SHA`);
  }
  return value;
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

function timestamp(value,label) {
  if (!isRfc3339DateTime(value)) invalid(`${label} must be an RFC3339 timestamp`);
  return value;
}

function validateWorkId(value,label) {
  try {
    return parseWorkItemId(value);
  } catch (error) {
    invalid(`${label} must be a canonical work-item ID`,{cause:error});
  }
}

function validateProject(project,item) {
  exactKeys(project,["project_id","item_id","revision","fields"],"Work state Project evidence");
  nonEmptyText(project.project_id,"Work state Project identity");
  nonEmptyText(project.item_id,"Work state Project item identity");
  nonEmptyText(project.revision,"Work state Project revision");
  exactKeys(project.fields,PROJECT_FIELD_KEYS,"Work state Project fields");
  if (!STATUSES.includes(project.fields.Status)) invalid("Observed Project Status is not approved");
  if (!GATES.includes(project.fields.Gate)) invalid("Observed Project Gate is not approved");
  try { parseWorkItemId(`${project.fields.repository}#1`); }
  catch (error) { invalid("Observed Project repository must be canonical OWNER/REPO ASCII",{cause:error}); }
  if (project.fields.parent!==null) validateWorkId(project.fields.parent,"Observed Project parent");
  if (project.fields.milestone!==null) nonEmptyText(project.fields.milestone,"Observed Project milestone");
  for (const key of ["branch","base_branch"]) {
    const observed=project.fields[key];
    if (observed!==null && (typeof observed!=="string" || observed.trim().length===0)) {
      invalid(`Observed Project ${key} must be non-empty text or null`);
    }
  }
  timestamp(project.fields.last_reconciled_at,"Observed Project reconciliation time");
  if (item.repository.length===0) invalid("Work state item repository must be non-empty");
}

function validateParentEvidence(item,parent) {
  if (item.kind!=="issue") {
    if (parent!==null) invalid("Only a child issue may carry governing parent evidence");
    return;
  }
  exactKeys(parent,["id","branch","revision"],"Governing parent evidence");
  const parentId=validateWorkId(parent.id,"Governing parent identity");
  nonEmptyText(parent.revision,"Governing parent revision");
  if (parent.id!==item.parent_id) {
    invalid("Governing parent identity must equal the child parent identity");
  }
  const expectedBase=requiredBaseBranch(item,{
    parent:Object.freeze({
      id:parent.id,
      repository:item.repository,
      branch:parent.branch,
    }),
  });
  if (parentId.repository!==item.repository || item.base_branch!==expectedBase) {
    invalid("Child issue base must equal the exact revision-bound parent branch");
  }
}

function validateReleaseEvidence(item,release) {
  exactKeys(release,[
    "assigned","active","id","repository","branch","milestone","revision",
  ],"Work state release evidence");
  boolean(release.assigned,"Release assigned flag");
  boolean(release.active,"Release active flag");
  if (release.active && !release.assigned) invalid("An active release must be assigned");
  if (!release.assigned) {
    if ([release.id,release.repository,release.branch,release.milestone,release.revision]
      .some(field => field!==null)) {
      invalid("An unassigned release cannot carry identity, branch, milestone, or revision evidence");
    }
    if (item.milestone!==null || (item.kind!=="issue" && item.base_branch!==null)) {
      invalid("Unassigned work cannot retain release base or milestone assignment");
    }
    return;
  }
  const match=typeof release.branch==="string" ? RELEASE_BRANCH.exec(release.branch) : null;
  if (!match || release.milestone!==match[1]) {
    invalid("Assigned release branch and milestone must identify the same exact version");
  }
  if (release.repository!==item.repository ||
      release.id!==`${release.repository}@${release.branch}`) {
    invalid("Assigned release identity must bind the exact work repository and release branch");
  }
  nonEmptyText(release.revision,"Assigned release revision");
  if (item.milestone!==release.milestone) {
    invalid("Assigned work milestone must equal the exact release milestone");
  }
  if (item.kind!=="issue") {
    const relation=Object.freeze({
      id:release.id,
      repository:release.repository,
      branch:release.branch,
    });
    const expectedBase=requiredBaseBranch(item,item.kind==="epic"
      ? {release:relation}
      : {patch_release:relation});
    if (item.base_branch!==expectedBase) {
      invalid("Epic and bounded bug base must equal the exact revision-bound release branch");
    }
  }
}

function validateSnapshot(input) {
  const value=copyClosed(input,"Work state snapshot");
  exactKeys(value,SNAPSHOT_KEYS,"Work state snapshot");
  if (value.schema_version!=="work-state-snapshot.v1") {
    invalid("Work state snapshot schema_version must be work-state-snapshot.v1");
  }
  validateCoreDocument(value.item,"work-item.v1");
  if (!["OPEN","CLOSED"].includes(value.issue_state)) {
    invalid("Native issue state must be OPEN or CLOSED");
  }
  boolean(value.drifted,"Work state drift flag");
  boolean(value.epic_required,"Work state epic-required flag");
  if (value.item.kind!=="bug" && value.epic_required) {
    invalid("Only a bounded bug may require decomposition into an epic");
  }

  if (value.item.kind==="epic") {
    boolean(value.prepared,"Epic prepared flag");
    boolean(value.scope_approved,"Epic scope-approved flag");
    boolean(value.children_complete,"Epic children-complete flag");
    if (!value.prepared && value.scope_approved) {
      invalid("An unprepared epic cannot have approved scope");
    }
  } else if (value.prepared!==null || value.scope_approved!==null ||
      value.children_complete!==null) {
    invalid("Only epic snapshots may carry preparation, approval, or child completion evidence");
  }

  validateParentEvidence(value.item,value.parent);
  validateReleaseEvidence(value.item,value.release);

  if (!Array.isArray(value.blocking_dependencies)) {
    invalid("Blocking dependencies must be an array");
  }
  const blockers=new Set();
  for (const blocker of value.blocking_dependencies) {
    validateWorkId(blocker,"Blocking dependency");
    if (blockers.has(blocker)) invalid(`Duplicate blocking dependency ${blocker}`);
    blockers.add(blocker);
  }

  exactKeys(value.physical_branch,["exists","head_sha"],"Physical branch evidence");
  boolean(value.physical_branch.exists,"Physical branch existence");
  if (value.physical_branch.exists) sha(value.physical_branch.head_sha,"Physical branch head");
  else if (value.physical_branch.head_sha!==null) {
    invalid("A reserved-only branch cannot have a physical head");
  }

  if (value.pull_request!==null) {
    exactKeys(value.pull_request,["state","head_sha","merged_sha"],"Pull request evidence");
    if (!["DRAFT","READY","MERGED"].includes(value.pull_request.state)) {
      invalid("Pull request state must be DRAFT, READY, or MERGED");
    }
    sha(value.pull_request.head_sha,"Pull request head");
    if (!value.physical_branch.exists ||
        value.pull_request.head_sha!==value.physical_branch.head_sha) {
      invalid("Pull request head must equal the physical branch head");
    }
    if (value.pull_request.state==="MERGED") {
      sha(value.pull_request.merged_sha,"Merged pull request revision");
      if (value.pull_request.merged_sha!==value.pull_request.head_sha ||
          value.issue_state!=="CLOSED") {
        invalid("Merged pull request, head revision, and closed native issue must agree");
      }
    } else if (value.pull_request.merged_sha!==null || value.issue_state!=="OPEN") {
      invalid("An unmerged pull request must have an open native issue and no merged revision");
    }
  } else if (value.issue_state!=="OPEN") {
    invalid("A closed native issue must have consistent merged pull request evidence");
  }

  if (value.review!==null) {
    exactKeys(value.review,["verdict","reviewed_revision"],"Review evidence");
    if (!["APPROVED","BLOCKED","CHANGES_REQUESTED"].includes(value.review.verdict)) {
      invalid("Review verdict is not approved");
    }
    sha(value.review.reviewed_revision,"Reviewed revision");
    if (value.pull_request===null) invalid("Review evidence requires a pull request");
  }

  if (value.checks!==null) {
    exactKeys(value.checks,["state","revision"],"Check evidence");
    if (!["PENDING","PASSED","FAILED"].includes(value.checks.state)) {
      invalid("Check state must be PENDING, PASSED, or FAILED");
    }
    sha(value.checks.revision,"Check revision");
    if (value.pull_request===null) invalid("Check evidence requires a pull request");
  }

  exactKeys(value.authority,[
    "epic_acceptance_required","release_approval_required",
  ],"Work state authority evidence");
  boolean(value.authority.epic_acceptance_required,"Epic acceptance requirement");
  boolean(value.authority.release_approval_required,"Release approval requirement");
  if (value.authority.epic_acceptance_required && value.authority.release_approval_required) {
    invalid("Epic acceptance and release approval cannot govern the same pull request");
  }
  if (value.authority.epic_acceptance_required && value.item.kind!=="epic") {
    invalid("Epic acceptance authority applies only to an epic");
  }
  if ((value.authority.epic_acceptance_required ||
      value.authority.release_approval_required) && value.pull_request?.state!=="READY") {
    invalid("Merge authority requirements apply only to a ready pull request");
  }
  if (value.item.kind==="epic" && value.pull_request?.state==="READY" &&
      value.children_complete && !value.authority.epic_acceptance_required &&
      !value.authority.release_approval_required) {
    invalid("A complete ready epic pull request requires exactly one governing authority");
  }

  validateProject(value.project,value.item);
  return Object.freeze({
    ...value,
    blocking_dependencies:Object.freeze([...blockers].sort()),
  });
}

function state(status,gate,reason,nextCommand) {
  return Object.freeze({status,gate,reason,next_command:nextCommand});
}

const RULES=Object.freeze([
  Object.freeze({
    matches:snapshot => snapshot.drifted,
    result:() => state("Blocked","RECONCILE_REQUIRED",
      "Machine-owned lifecycle evidence has drifted and must be reconciled.","toss-core sync"),
  }),
  Object.freeze({
    matches:snapshot => snapshot.pull_request?.state==="MERGED",
    result:() => state("Done","NONE",
      "The governing pull request is merged at the recorded head and the native issue is closed.",null),
  }),
  Object.freeze({
    matches:snapshot => snapshot.item.kind==="bug" && snapshot.epic_required,
    result:() => state("Blocked","EPIC_REQUIRED",
      "The bounded bug expanded into independently deliverable work and requires a user-provided epic.",
      "toss-core feature add"),
  }),
  Object.freeze({
    matches:snapshot => snapshot.item.kind==="epic" && !snapshot.prepared,
    result:() => state("Backlog","EPIC_PREPARATION_REQUIRED",
      "The epic needs an exact native-child and dependency plan.","toss-core epic prepare"),
  }),
  Object.freeze({
    matches:snapshot => snapshot.item.kind==="epic" && !snapshot.scope_approved,
    result:() => state("Backlog","EPIC_APPROVAL_REQUIRED",
      "The prepared epic scope and dependency plan require approval.","toss-core epic approve"),
  }),
  Object.freeze({
    matches:snapshot => !snapshot.release.assigned || !snapshot.release.active,
    result:() => state("Backlog","RELEASE_PLANNING",
      "No assigned active repository release currently owns this work item.","toss-core release plan"),
  }),
  Object.freeze({
    matches:snapshot => snapshot.blocking_dependencies.length>0,
    result:snapshot => state("Blocked","DEPENDENCY_REQUIRED",
      `Mandatory dependencies are incomplete: ${snapshot.blocking_dependencies.join(", ")}.`,
      "toss-core dependency check"),
  }),
  Object.freeze({
    matches:snapshot => snapshot.item.kind==="epic" &&
      snapshot.physical_branch.exists && !snapshot.children_complete,
    result:() => state("Blocked","DEPENDENCY_REQUIRED",
      "Every governed epic child must be Done before epic submission or acceptance.",
      "toss-core dependency check"),
  }),
  Object.freeze({
    matches:snapshot => !snapshot.physical_branch.exists,
    result:snapshot => state("Ready","NONE",
      "The reserved branch is ready to be created from its exact parent head.",
      snapshot.item.kind==="epic" ? "toss-core sync" : "toss-core issue start"),
  }),
  Object.freeze({
    matches:snapshot => snapshot.pull_request===null,
    result:snapshot => state("In progress","NONE",
      "The physical work branch exists and has no governing pull request.",
      snapshot.item.kind==="epic" ? "toss-core epic submit" : "toss-core issue submit"),
  }),
  Object.freeze({
    matches:snapshot => snapshot.pull_request.state==="DRAFT",
    result:snapshot => state("In progress","NONE",
      "The governing pull request remains a draft.",
      snapshot.item.kind==="epic" ? "toss-core epic submit" : "toss-core issue submit"),
  }),
  Object.freeze({
    matches:snapshot => snapshot.review?.reviewed_revision===snapshot.pull_request.head_sha &&
      snapshot.review.verdict==="CHANGES_REQUESTED",
    result:() => state("Blocked","CHANGES_REQUESTED",
      "The current pull request revision has unresolved requested changes.",
      "toss-core review status"),
  }),
  Object.freeze({
    matches:snapshot => snapshot.review===null ||
      snapshot.review.reviewed_revision!==snapshot.pull_request.head_sha,
    result:() => state("In review","REVIEW_REQUIRED",
      "The ready pull request needs an independent review of its current head revision.",
      "toss-core review record"),
  }),
  Object.freeze({
    matches:snapshot => snapshot.review.verdict!=="APPROVED",
    result:() => state("Blocked","CHANGES_REQUESTED",
      "The current independent review requests changes before the pull request may merge.",
      "toss-core review status"),
  }),
  Object.freeze({
    matches:snapshot => snapshot.checks===null ||
      snapshot.checks.revision!==snapshot.pull_request.head_sha ||
      snapshot.checks.state!=="PASSED",
    result:() => state("In review","REVIEW_REQUIRED",
      "Required checks are missing, stale, pending, or failed for the current reviewed head.",
      "toss-core review status"),
  }),
  Object.freeze({
    matches:snapshot => snapshot.authority.epic_acceptance_required,
    result:() => state("In review","EPIC_ACCEPTANCE_REQUIRED",
      "The current reviewed epic revision requires implementation acceptance authority.",
      "toss-core epic accept"),
  }),
  Object.freeze({
    matches:snapshot => snapshot.authority.release_approval_required,
    result:() => state("In review","RELEASE_APPROVAL_REQUIRED",
      "The current reviewed governing release revision requires release approval authority.",
      "toss-core release approve"),
  }),
  Object.freeze({
    matches:() => true,
    result:() => state("In review","NONE",
      "The current pull request revision is reviewed and required checks pass.",
      "toss-core review status"),
  }),
]);

function decide(snapshot) {
  for (const rule of RULES) {
    if (rule.matches(snapshot)) return rule.result(snapshot);
  }
  invalid("Work state decision table is incomplete");
}

function validateDerivedState(input) {
  const value=copyClosed(input,"Derived work state");
  exactKeys(value,STATE_KEYS,"Derived work state");
  if (!STATUSES.includes(value.status)) invalid("Derived work status is not approved");
  if (!GATES.includes(value.gate)) invalid("Derived work gate is not approved");
  nonEmptyText(value.reason,"Derived work state reason");
  if (value.next_command===null) {
    if (value.gate!=="NONE") invalid("Only Gate=NONE may omit a next command");
  } else if (!NEXT_COMMANDS.includes(value.next_command)) {
    invalid("Derived work state next command is not in the public grammar");
  }
  return value;
}

export function deriveWorkItemState(snapshotInput) {
  return decide(validateSnapshot(snapshotInput));
}

export function projectReconciliationOperations(snapshotInput,stateInput,reconciledAtInput) {
  const snapshot=validateSnapshot(snapshotInput);
  const observedState=validateDerivedState(stateInput);
  const expectedState=decide(snapshot);
  if (canonicalJson(observedState)!==canonicalJson(expectedState)) {
    invalid("Project reconciliation state must equal the exact derived snapshot state");
  }
  const reconciledAt=timestamp(reconciledAtInput,"Project reconciliation time");
  const observed=snapshot.project.fields;
  const desired=Object.freeze({
    Status:expectedState.status,
    Gate:expectedState.gate,
    repository:snapshot.item.repository,
    parent:snapshot.item.parent_id,
    milestone:snapshot.item.milestone,
    branch:snapshot.item.branch,
    base_branch:snapshot.item.base_branch,
    last_reconciled_at:reconciledAt,
  });
  const fields={};
  for (const key of PROJECT_FIELD_KEYS) {
    if (observed[key]!==desired[key]) fields[key]=desired[key];
  }
  if (Object.keys(fields).length===0) return Object.freeze([]);
  return Object.freeze([Object.freeze({
    resource:"project",
    action:"update",
    repository:snapshot.item.repository,
    expected_revision:snapshot.project.revision,
    payload:Object.freeze({
      project_id:snapshot.project.project_id,
      item_id:snapshot.project.item_id,
      fields:Object.freeze(fields),
    }),
  })]);
}
