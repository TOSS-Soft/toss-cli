import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {compareCanonicalText} from "../canonical-order.js";
import {validateCoreDocument} from "../contracts.js";
import {deriveWorkItemState} from "../domain/state.js";
import {CoreConflictError,CoreValidationError} from "../errors.js";
import {planReleaseProgram} from "./planner.js";
import {parseSemVer} from "./semver.js";
import {assertRepositoryConcurrency,transitionRepositoryRelease} from "./state.js";

const PLANNING_STATE_KEYS=Object.freeze([
  "revision","organization","repositories","programs","intents","receipts",
]);
const PLAN_SNAPSHOT_KEYS=Object.freeze([
  "kind","source","control_revision","candidates","completed","repositories",
]);
const ACTIVATION_SNAPSHOT_KEYS=Object.freeze([
  "kind","source","control_revision","program_id","program_revision","project",
  "repositories",
]);
const ACTIVATION_REPOSITORY_KEYS=Object.freeze([
  "repository","repository_revision","default_branch","milestone","release_branch",
  "release_pull_request","comparison","governed_children","work_items",
]);
const STATUS_SNAPSHOT_KEYS=Object.freeze([
  "kind","source","control_revision","program_revisions","project","repositories",
]);
const STATUS_REPOSITORY_KEYS=Object.freeze([
  "program_id","repository","repository_revision","release_id","release_revision",
  "milestone","branch","release_pull_request","scope","gates","checks","patch_link",
]);
const MAX_CLOSED_DATA_DEPTH=64;

function invalid(message,options={}) {
  throw new CoreValidationError(message,options);
}

export function releaseBranch(version) {
  parseSemVer(version);
  return `release/v${version}`;
}

export function releaseMilestone(version) {
  parseSemVer(version);
  return `v${version}`;
}

function clone(value,label="Release operation input",ancestors=new Set(),depth=0) {
  if (depth>MAX_CLOSED_DATA_DEPTH) invalid(`${label} exceeds the maximum closed-data depth`);
  if (value===null || ["string","boolean"].includes(typeof value)) return value;
  if (typeof value==="number") {
    if (!Number.isFinite(value)) invalid(`${label} must contain only finite JSON values`);
    return value;
  }
  if (typeof value!=="object" || types.isProxy(value) || ancestors.has(value)) {
    invalid(`${label} must contain only acyclic plain non-proxy JSON data`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value)!==Array.prototype ||
          Object.getOwnPropertySymbols(value).length!==0 ||
          Object.getOwnPropertyNames(value).length!==value.length+1) {
        invalid(`${label} must contain dense plain arrays`);
      }
      return Object.freeze(value.map((_,index) => {
        const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) invalid(`${label}[${index}] must be own enumerable data`);
        return clone(descriptor.value,`${label}[${index}]`,ancestors,depth+1);
      }));
    }
    if (![Object.prototype,null].includes(Object.getPrototypeOf(value)) ||
        Object.getOwnPropertySymbols(value).length!==0) {
      invalid(`${label} must contain only plain objects`);
    }
    const result=Object.create(null);
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if (!descriptor?.enumerable || !("value" in descriptor)) invalid(`${label}.${key} must be own enumerable data`);
      result[key]=clone(descriptor.value,`${label}.${key}`,ancestors,depth+1);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function exact(value,keys,label) {
  if (!value || typeof value!=="object" || Array.isArray(value) ||
      canonicalJson(Object.keys(value).sort())!==canonicalJson([...keys].sort())) {
    invalid(`${label} must use the exact closed shape`);
  }
}

function optionRecord(input,keys,label) {
  if (!input || typeof input!=="object" || Array.isArray(input) || types.isProxy(input) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(input))) invalid(`${label} must be a plain non-proxy object`);
  const descriptors=Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length!==keys.length || keys.some(key => !Object.hasOwn(descriptors,key))) {
    invalid(`${label} must use the exact closed shape`);
  }
  const result=Object.create(null);
  for (const key of keys) {
    const descriptor=descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor)) invalid(`${label}.${key} must be own enumerable data`);
    result[key]=descriptor.value;
  }
  return result;
}

function nextProgramId(programs) {
  let greatest=0n;
  let width=4;
  for (const program of programs) {
    const match=/^TOSS-OS-R([0-9]{4,})$/u.exec(program?.program_id);
    if (!match) invalid("Persisted release program identity is not canonical");
    let value;
    try { value=BigInt(match[1]); } catch (error) {
      invalid("Persisted release program identity cannot be incremented",{cause:error});
    }
    if (value>greatest) greatest=value;
    width=Math.max(width,match[1].length);
  }
  const next=String(greatest+1n);
  return `TOSS-OS-R${next.padStart(Math.max(width,next.length),"0")}`;
}

function compareProgramIds(left,right) {
  const leftMatch=/^TOSS-OS-R([0-9]{4,})$/u.exec(left);
  const rightMatch=/^TOSS-OS-R([0-9]{4,})$/u.exec(right);
  if (!leftMatch || !rightMatch) invalid("Release program identity is not canonical");
  const leftNumber=BigInt(leftMatch[1]);
  const rightNumber=BigInt(rightMatch[1]);
  return leftNumber<rightNumber ? -1 : leftNumber>rightNumber ? 1 : compareCanonicalText(left,right);
}

export function normalizeReleasePlanningState(input) {
  const value=clone(input,"Release planning state");
  exact(value,PLANNING_STATE_KEYS,"Release planning state");
  if (typeof value.revision!=="string" || !value.revision || !Array.isArray(value.repositories) ||
      !Array.isArray(value.programs) || !Array.isArray(value.intents) ||
      !Array.isArray(value.receipts)) invalid("Release planning state is malformed");
  if (!value.organization || typeof value.organization!=="object" ||
      typeof value.organization.control_repository!=="string" ||
      typeof value.organization.policy_revision!=="string") {
    invalid("Release planning state requires an organization control repository and policy revision");
  }
  const organization=validateCoreDocument(value.organization,"organization-config.v1");
  const repositories=value.repositories.map(repository =>
    validateCoreDocument(repository,"repository-config.v1"));
  const registered=organization.repositories;
  if (canonicalJson(repositories.map(repository => repository.repository))!==canonicalJson(registered)) {
    throw new CoreConflictError("Release planning repositories do not match the organization registry");
  }
  assertRepositoryConcurrency(value.programs);
  const intents=value.intents.map(intent => validateCoreDocument(intent,"operation-intent.v1"));
  const receipts=value.receipts.map(receipt => validateCoreDocument(receipt,"operation-receipt.v1"));
  return clone({...value,organization,repositories,intents,receipts},"Normalized release planning state");
}

function normalizedPlanSnapshot(input,state) {
  const value=clone(input,"Release plan snapshot");
  exact(value,PLAN_SNAPSHOT_KEYS,"Release plan snapshot");
  exact(value.source,["repository","revision","sha256"],"Release plan source");
  if (value.kind!=="release-plan" || value.control_revision!==state.revision ||
      value.source.repository!==state.organization.control_repository ||
      value.source.revision!==state.revision ||
      typeof value.source.sha256!=="string" || !/^[a-f0-9]{64}$/u.test(value.source.sha256)) {
    throw new CoreConflictError("Release plan snapshot does not bind the exact control revision");
  }
  const github=Object.freeze({
    kind:value.kind,
    control_revision:value.control_revision,
    candidates:value.candidates,
    completed:value.completed,
    repositories:value.repositories,
  });
  if (value.source.sha256!==sha256Canonical({control:state,github})) {
    throw new CoreConflictError("Release plan source hash does not bind its control and GitHub observations");
  }
  const registered=state.repositories.map(repository => repository.repository).sort();
  const observed=value.repositories.map(repository => repository?.repository).sort();
  if (canonicalJson(registered)!==canonicalJson(observed)) {
    throw new CoreConflictError("Release plan snapshot does not cover the exact registered repositories");
  }
  return value;
}

export function releasePlanOperations(input) {
  const {planningState,snapshot,clock}=optionRecord(
    input,["planningState","snapshot","clock"],"Release plan operation request",
  );
  if (typeof clock!=="function" || types.isProxy(clock)) invalid("Release planning clock must be a non-proxy function");
  const state=normalizeReleasePlanningState(planningState);
  const observed=normalizedPlanSnapshot(snapshot,state);
  const currentRecords=state.programs.filter(program => ["DRAFT","WAITING_FOR_EPIC"].includes(program.phase));
  if (currentRecords.length>1) {
    throw new CoreConflictError("Release planning has more than one current Draft or Waiting program");
  }
  const current=currentRecords[0] ?? null;
  const proposed=planReleaseProgram({
    programId:current?.program_id ?? nextProgramId(state.programs),
    candidates:observed.candidates,
    completed:observed.completed,
    repositories:observed.repositories,
    activePrograms:state.programs.filter(program => program.program_id!==current?.program_id),
    clock,
  });
  const comparable=program => {
    const {revision:_revision,created_at:_createdAt,updated_at:_updatedAt,...content}=program;
    return content;
  };
  if (current!==null && canonicalJson(comparable(current))===canonicalJson(comparable(proposed))) {
    return Object.freeze({source:observed.source,program:current,operations:Object.freeze([])});
  }
  const program=current===null ? proposed : clone({
    ...proposed,
    revision:incrementRevision(current.revision,"Release program revision"),
    created_at:current.created_at,
  },"Replanned release program");
  const programsForConcurrency=current===null
    ? [...state.programs,program]
    : [...state.programs.filter(value => value.program_id!==current.program_id),program];
  assertRepositoryConcurrency(programsForConcurrency);
  const operation=Object.freeze({
    resource:"repository",
    action:"commit",
    repository:state.organization.control_repository,
    expected_revision:current?.revision ?? null,
    payload:Object.freeze({
      kind:"release-program-manifest",
      expected_program_revision:current?.revision ?? null,
      program,
    }),
  });
  return Object.freeze({
    source:observed.source,
    program,
    operations:Object.freeze([operation]),
  });
}

function incrementRevision(value,label) {
  const match=/^REV-([0-9]{4,})$/u.exec(value);
  if (!match) invalid(`${label} must be a canonical revision`);
  const number=Number(match[1]);
  if (!Number.isSafeInteger(number) || number<1 || number===Number.MAX_SAFE_INTEGER) {
    invalid(`${label} cannot be incremented safely`);
  }
  const next=String(number+1);
  return `REV-${next.padStart(Math.max(4,match[1].length),"0")}`;
}

function activationBody(value) {
  return Object.freeze({
    kind:value.kind,
    control_revision:value.control_revision,
    program_id:value.program_id,
    program_revision:value.program_revision,
    project:value.project,
    repositories:value.repositories,
  });
}

function normalizedActivationSnapshot(input,state,program) {
  const value=clone(input,"Release activation snapshot");
  exact(value,ACTIVATION_SNAPSHOT_KEYS,"Release activation snapshot");
  exact(value.source,["repository","revision","sha256"],"Release activation source");
  exact(value.project,["id","revision"],"Release activation Project evidence");
  if (value.kind!=="release-activation" || value.control_revision!==state.revision ||
      value.program_id!==program.program_id || value.program_revision!==program.revision ||
      value.source.repository!==state.organization.control_repository ||
      value.source.revision!==state.revision || !/^[a-f0-9]{64}$/u.test(value.source.sha256) ||
      value.project.id!==state.organization.project.node_id ||
      typeof value.project.revision!=="string" || value.project.revision.length===0) {
    throw new CoreConflictError("Release activation snapshot does not bind the exact program and control revision");
  }
  if (value.source.sha256!==sha256Canonical({control:state,github:activationBody(value)})) {
    throw new CoreConflictError("Release activation source hash does not bind its control and GitHub observations");
  }
  if (!Array.isArray(value.repositories)) invalid("Release activation repositories must be an array");
  for (const repository of value.repositories) {
    exact(repository,ACTIVATION_REPOSITORY_KEYS,"Release activation repository evidence");
    exact(repository.default_branch,["name","revision","head_sha"],"Release activation default branch");
    exact(repository.comparison,["base_sha","head_sha","material_difference"],"Release activation comparison");
    if (typeof repository.repository!=="string" || typeof repository.repository_revision!=="string" ||
        typeof repository.default_branch.name!=="string" || typeof repository.default_branch.revision!=="string" ||
        !/^[a-f0-9]{40}$/u.test(repository.default_branch.head_sha) ||
        !/^[a-f0-9]{40}$/u.test(repository.comparison.base_sha) ||
        !/^[a-f0-9]{40}$/u.test(repository.comparison.head_sha) ||
        typeof repository.comparison.material_difference!=="boolean" ||
        !Array.isArray(repository.governed_children) || !Array.isArray(repository.work_items)) {
      invalid("Release activation repository evidence is malformed");
    }
    if (repository.default_branch.head_sha!==repository.comparison.base_sha) {
      throw new CoreConflictError("Release activation comparison does not use the verified default-branch head");
    }
    if (repository.release_branch!==null) {
      exact(repository.release_branch,["name","base_branch","head_sha","revision"],"Existing release branch");
      if (!/^[a-f0-9]{40}$/u.test(repository.release_branch.head_sha) ||
          typeof repository.release_branch.revision!=="string" || repository.release_branch.revision.length===0) {
        invalid("Existing release branch evidence is malformed");
      }
    }
    const releaseHead=repository.release_branch?.head_sha ?? repository.default_branch.head_sha;
    if (repository.comparison.head_sha!==releaseHead ||
        repository.comparison.material_difference!==(repository.comparison.base_sha!==releaseHead)) {
      throw new CoreConflictError("Release activation comparison does not bind the exact release-branch head");
    }
    if (repository.release_pull_request!==null) {
      exact(repository.release_pull_request,["number","base_branch","head_branch","head_sha","draft","revision"],"Existing release pull request");
      if (!/^[a-f0-9]{40}$/u.test(repository.release_pull_request.head_sha) ||
          typeof repository.release_pull_request.revision!=="string" || repository.release_pull_request.revision.length===0) {
        invalid("Existing release pull request evidence is malformed");
      }
    }
    const workById=new Map();
    for (const item of repository.work_items) {
      exact(item,["id","kind","revision","work"],"Release activation work item");
      if (item.id!==item.work?.item?.id || item.kind!==item.work?.item?.kind ||
          item.work?.item?.repository!==repository.repository || typeof item.revision!=="string" ||
          item.revision.length===0 || item.work?.project?.project_id!==state.organization.project.node_id) {
        throw new CoreConflictError("Release activation work item identity is inconsistent");
      }
      if (workById.has(item.id)) throw new CoreConflictError(`Duplicate activation work item: ${item.id}`);
      workById.set(item.id,item);
      deriveWorkItemState(item.work);
    }
    const governedIds=new Set();
    const governedEpics=new Set();
    for (const membership of repository.governed_children) {
      exact(membership,["epic_id","epic_revision","child_ids"],"Governed child membership");
      if (typeof membership.epic_id!=="string" || typeof membership.epic_revision!=="string" ||
          membership.epic_revision.length===0 || !Array.isArray(membership.child_ids) ||
          governedEpics.has(membership.epic_id)) {
        invalid("Governed child membership is malformed or duplicated");
      }
      governedEpics.add(membership.epic_id);
      const epic=workById.get(membership.epic_id);
      if (!epic || epic.kind!=="epic" || epic.revision!==membership.epic_revision) {
        throw new CoreConflictError("Governed child membership does not bind its exact epic revision");
      }
      if (governedIds.has(membership.epic_id)) {
        throw new CoreConflictError(`Activation work ownership is duplicated: ${membership.epic_id}`);
      }
      governedIds.add(membership.epic_id);
      for (let index=0;index<membership.child_ids.length;index+=1) {
        const childId=membership.child_ids[index];
        if (typeof childId!=="string" || (index>0 &&
            compareCanonicalText(membership.child_ids[index-1],childId)>=0)) {
          invalid("Governed child identities must be unique stable raw-order text");
        }
        const child=workById.get(childId);
        if (!child || child.work.item.parent_id!==membership.epic_id) {
          throw new CoreConflictError("Governed child membership omits or misowns native work");
        }
        if (governedIds.has(childId)) {
          throw new CoreConflictError(`Activation work ownership is duplicated: ${childId}`);
        }
        governedIds.add(childId);
      }
    }
    const actualIds=[...workById.keys()].sort(compareCanonicalText);
    const expectedIds=[...governedIds].sort(compareCanonicalText);
    if (canonicalJson(actualIds)!==canonicalJson(expectedIds)) {
      throw new CoreConflictError("Activation snapshot does not prove the exact governed-child closure");
    }
  }
  return value;
}

function eligibleReleaseIds(program) {
  const byId=new Map(program.repository_releases.map(release => [release.release_id,release]));
  const eligible=[];
  for (const stage of program.dependency_stages) {
    const earlier=program.dependency_stages.filter(value => value.stage<stage.stage)
      .flatMap(value => value.repository_release_ids)
      .map(id => byId.get(id));
    if (earlier.some(release => release.phase!=="RELEASED")) break;
    const draft=stage.repository_release_ids.filter(id => byId.get(id)?.phase==="DRAFT");
    if (draft.length>0) {
      eligible.push(...draft);
      break;
    }
    if (stage.repository_release_ids.some(id => byId.get(id)?.phase!=="RELEASED")) break;
  }
  return eligible;
}

function intentIdentity(releaseId) {
  return `RELEASE-PR-INTENT-${BigInt(`0x${sha256Canonical(releaseId)}`).toString(10)}`;
}

function projectedWork(item,release,releaseHead,now) {
  const epic=item.work.item.kind==="epic";
  const assigned={
    ...item.work,
    item:{
      ...item.work.item,
      milestone:release.milestone,
      ...(epic ? {base_branch:release.branch} : {}),
    },
    release:{
      assigned:true,active:true,id:`${release.repository}@${release.branch}`,
      repository:release.repository,branch:release.branch,milestone:release.milestone,
      revision:release.revision,
    },
    ...(epic ? {physical_branch:{exists:true,head_sha:releaseHead}} : {}),
  };
  const state=deriveWorkItemState(assigned);
  const fields={
    ...assigned.project.fields,
    Status:state.status,
    Gate:state.gate,
    milestone:release.milestone,
    base_branch:assigned.item.base_branch,
    last_reconciled_at:now,
  };
  return Object.freeze({work:clone({...assigned,item:{...assigned.item,status:state.status,gate:state.gate},project:{...assigned.project,fields}},"Release work projection"),state,fields:Object.freeze(fields)});
}

function assertExistingResources(observation,release,configuration) {
  if (observation.default_branch.name!==configuration.default_branch) {
    throw new CoreConflictError(`Repository ${release.repository} default branch drifted from its registered identity`);
  }
  if (observation.milestone!==null) {
    exact(observation.milestone,["title","state","revision"],"Existing release milestone");
    if (observation.milestone.title!==release.milestone || observation.milestone.state!=="OPEN" ||
        typeof observation.milestone.revision!=="string") {
      throw new CoreConflictError(`Existing milestone conflicts with ${release.milestone}`);
    }
  }
  if (observation.release_branch!==null) {
    exact(observation.release_branch,["name","base_branch","head_sha","revision"],"Existing release branch");
    if (observation.release_branch.name!==release.branch ||
        observation.release_branch.base_branch!==observation.default_branch.name ||
        typeof observation.release_branch.revision!=="string") {
      throw new CoreConflictError(`Existing release branch conflicts with ${release.branch}`);
    }
  }
  if (observation.release_pull_request!==null) {
    exact(observation.release_pull_request,["number","base_branch","head_branch","head_sha","draft","revision"],"Existing release pull request");
    if (!Number.isSafeInteger(observation.release_pull_request.number) ||
        observation.release_pull_request.base_branch!==observation.default_branch.name ||
        observation.release_pull_request.head_branch!==release.branch ||
        observation.release_pull_request.head_sha!==observation.comparison.head_sha ||
        observation.release_pull_request.draft!==true || typeof observation.release_pull_request.revision!=="string") {
      throw new CoreConflictError(`Existing release pull request conflicts with ${release.branch}`);
    }
  }
}

export function activationOperations(input) {
  const {planningState,programId,repository,snapshot,receiptId,clock}=optionRecord(
    input,["planningState","programId","repository","snapshot","receiptId","clock"],
    "Release activation operation request",
  );
  if (typeof programId!=="string" || !(repository===null || typeof repository==="string") ||
      typeof receiptId!=="string" || !/^RECEIPT-[0-9]{8}-[0-9]{4,}$/u.test(receiptId) ||
      typeof clock!=="function" || types.isProxy(clock)) invalid("Release activation request is malformed");
  const state=normalizeReleasePlanningState(planningState);
  const program=state.programs.find(value => value.program_id===programId);
  if (!program) throw new CoreConflictError(`Unknown release program: ${programId}`);
  const eligibleIds=eligibleReleaseIds(program);
  const eligible=program.repository_releases.filter(value => eligibleIds.includes(value.release_id));
  const selected=repository===null ? eligible : eligible.filter(value => value.repository===repository);
  if (selected.length===0 || (repository!==null && selected.length!==1)) {
    throw new CoreConflictError("Requested repository release is not currently stage-eligible Draft work");
  }
  const observed=normalizedActivationSnapshot(snapshot,state,program);
  const expectedRepositories=selected.map(value => value.repository).sort(compareCanonicalText);
  const observedRepositories=observed.repositories.map(value => value.repository).sort(compareCanonicalText);
  if (canonicalJson(expectedRepositories)!==canonicalJson(observedRepositories)) {
    throw new CoreConflictError("Release activation snapshot does not cover the exact selected repository set");
  }
  const now=clock();
  const configurations=new Map(state.repositories.map(value => [value.repository,value]));
  const observations=new Map(observed.repositories.map(value => [value.repository,value]));
  const activatedById=new Map();
  const operations=[];
  for (const draft of selected) {
    const observation=observations.get(draft.repository);
    const configuration=configurations.get(draft.repository);
    const rationale=program.rationale.find(value => value.repository===draft.repository);
    if (!observation || !configuration || !rationale) throw new CoreConflictError("Activation evidence is incomplete");
    const milestone=releaseMilestone(rationale.version);
    const branch=releaseBranch(rationale.version);
    const activated=transitionRepositoryRelease(draft,{
      event:"ACTIVATE",expected_revision:draft.revision,timestamp:now,
      source_receipt:receiptId,
      activation:{
        version:rationale.version,milestone,branch,
        release_pr_intent:{
          intent_id:intentIdentity(draft.release_id),head:branch,
          base:observation.default_branch.name,
          expected_head_revision:observation.comparison.head_sha,
          recorded_at:now,
        },
      },
    });
    assertExistingResources(observation,activated,configuration);
    activatedById.set(draft.release_id,activated);
    if (observation.milestone===null) operations.push({
      resource:"milestone",action:"create",repository:draft.repository,
      expected_revision:observation.repository_revision,
      payload:{kind:"release-milestone",program_id:program.program_id,release_id:draft.release_id,title:milestone,state:"OPEN"},
    });
    if (observation.release_branch===null) operations.push({
      resource:"branch",action:"create",repository:draft.repository,
      expected_revision:observation.default_branch.revision,
      payload:{kind:"release-branch",program_id:program.program_id,release_id:draft.release_id,name:branch,base_branch:observation.default_branch.name,head_sha:observation.default_branch.head_sha,base_revision:observation.default_branch.revision},
    });
    const selectedEpics=new Set(draft.scope);
    const governedEpics=observation.governed_children.map(value => value.epic_id)
      .sort(compareCanonicalText);
    if (canonicalJson(governedEpics)!==canonicalJson([...draft.scope].sort(compareCanonicalText))) {
      throw new CoreConflictError(`Activation snapshot does not cover the exact governed epic scope for ${draft.repository}`);
    }
    const workItems=observation.work_items.filter(item => selectedEpics.has(item.id) || selectedEpics.has(item.work.item.parent_id));
    if (draft.scope.some(id => !workItems.some(item => item.id===id && item.kind==="epic"))) {
      throw new CoreConflictError(`Activation snapshot omits selected epic scope for ${draft.repository}`);
    }
    for (const item of workItems.sort((left,right) => compareCanonicalText(left.id,right.id))) {
      const releaseHead=observation.release_branch?.head_sha ?? observation.default_branch.head_sha;
      const projection=projectedWork(item,activated,releaseHead,now);
      if (item.work.release.assigned && (
        canonicalJson(item.work.release)!==canonicalJson(projection.work.release) ||
        item.work.item.milestone!==projection.work.item.milestone ||
        item.work.item.base_branch!==projection.work.item.base_branch ||
        (item.kind==="epic" && item.work.physical_branch.exists &&
          item.work.physical_branch.head_sha!==releaseHead)
      )) {
        throw new CoreConflictError(`Work item ${item.id} release assignment drifted`);
      }
      if (!item.work.release.assigned) operations.push({
        resource:"issue",action:"update",repository:draft.repository,
        expected_revision:item.revision,
        payload:{kind:"release-assignment",program_id:program.program_id,release_id:draft.release_id,work_item_id:item.id,release:projection.work.release,item:{milestone:projection.work.item.milestone,base_branch:projection.work.item.base_branch}},
      });
      if (item.kind==="epic" && !item.work.physical_branch.exists) operations.push({
        resource:"branch",action:"create",repository:draft.repository,
        expected_revision:observation.repository_revision,
        payload:{kind:"release-epic-branch",program_id:program.program_id,release_id:draft.release_id,work_item_id:item.id,name:item.work.item.branch,base_branch:branch,head_sha:releaseHead,base_revision:activated.revision},
      });
      if (canonicalJson(item.work.project.fields)!==canonicalJson(projection.fields)) operations.push({
        resource:"project",action:"update",repository:draft.repository,
        expected_revision:item.work.project.revision,
        payload:{kind:"release-project-state",program_id:program.program_id,release_id:draft.release_id,work_item_id:item.id,project_id:item.work.project.project_id,item_id:item.work.project.item_id,fields:projection.fields},
      });
    }
    if (observation.comparison.material_difference && observation.release_pull_request===null) operations.push({
      resource:"pull_request",action:"create",repository:draft.repository,
      expected_revision:observation.repository_revision,
      payload:{kind:"release-pull-request",program_id:program.program_id,release_id:draft.release_id,head:branch,base:observation.default_branch.name,draft:true,expected_head_revision:observation.comparison.head_sha},
    });
  }
  const releases=program.repository_releases.map(value => activatedById.get(value.release_id) ?? value);
  const phase=releases.every(value => value.phase==="RELEASED") ? "RELEASED" :
    releases.some(value => value.phase==="PUBLISHING") ? "PUBLISHING" :
      releases.some(value => value.phase==="PAUSED") ? "PAUSED" : "ACTIVE";
  const updated=clone({...program,phase,revision:incrementRevision(program.revision,"Release program revision"),repository_releases:releases,updated_at:now},"Activated release program");
  assertRepositoryConcurrency([...state.programs.filter(value => value.program_id!==program.program_id),updated]);
  operations.push({
    resource:"repository",action:"commit",repository:state.organization.control_repository,
    expected_revision:program.revision,
    payload:{kind:"release-program-manifest",expected_program_revision:program.revision,program:updated},
  });
  return Object.freeze({source:observed.source,program:updated,operations:clone(operations,"Release activation operations")});
}

function selectedProgramSet(state,programId) {
  if (programId!==null) {
    const selected=state.programs.find(value => value.program_id===programId);
    if (!selected) throw new CoreConflictError(`Unknown release program: ${programId}`);
    return [selected];
  }
  const open=state.programs.filter(value => value.phase!=="RELEASED");
  if (open.length>0) return open.sort((left,right) => compareProgramIds(left.program_id,right.program_id));
  return state.programs.length===0 ? [] : [[...state.programs].sort((left,right) =>
    compareProgramIds(left.program_id,right.program_id)).at(-1)];
}

function statusBody(value) {
  return Object.freeze({
    kind:value.kind,
    control_revision:value.control_revision,
    program_revisions:value.program_revisions,
    project:value.project,
    repositories:value.repositories,
  });
}

function normalizedStatusSnapshot(input,state,programs,kind,selectedTracks=null) {
  const value=clone(input,"Release status snapshot");
  exact(value,STATUS_SNAPSHOT_KEYS,"Release status snapshot");
  exact(value.source,["repository","revision","sha256"],"Release status source");
  exact(value.project,["id","revision"],"Release status Project evidence");
  if (value.kind!==kind || value.control_revision!==state.revision ||
      value.source.repository!==state.organization.control_repository ||
      value.source.revision!==state.revision || !/^[a-f0-9]{64}$/u.test(value.source.sha256) ||
      value.project.id!==state.organization.project.node_id || typeof value.project.revision!=="string" ||
      !Array.isArray(value.program_revisions) || !Array.isArray(value.repositories)) {
    throw new CoreConflictError("Release status snapshot does not bind the exact control and Project revision");
  }
  if (value.source.sha256!==sha256Canonical({control:state,github:statusBody(value)})) {
    throw new CoreConflictError("Release status source hash does not bind its control and GitHub observations");
  }
  const revisions=programs.map(program => ({program_id:program.program_id,revision:program.revision}));
  if (canonicalJson(value.program_revisions)!==canonicalJson(revisions)) {
    throw new CoreConflictError("Release status program revisions are stale");
  }
  const expected=(selectedTracks ?? programs.flatMap(program => program.repository_releases.map(release => ({
    program_id:program.program_id,release_id:release.release_id,
  })))).map(value => `${value.program_id}:${value.release_id}`).sort(compareCanonicalText);
  const actual=[];
  for (const repository of value.repositories) {
    exact(repository,STATUS_REPOSITORY_KEYS,"Release status repository evidence");
    if (typeof repository.repository_revision!=="string" || !Array.isArray(repository.scope) ||
        !Array.isArray(repository.gates) || !Array.isArray(repository.checks) ||
        !(repository.patch_link===null || typeof repository.patch_link==="string")) {
      invalid("Release status repository evidence is malformed");
    }
    actual.push(`${repository.program_id}:${repository.release_id}`);
    const program=programs.find(candidate => candidate.program_id===repository.program_id);
    const release=program?.repository_releases.find(candidate => candidate.release_id===repository.release_id);
    if (!release || release.repository!==repository.repository || release.revision!==repository.release_revision ||
        canonicalJson(repository.scope)!==canonicalJson(program.selected_scope.filter(selected =>
          release.scope.includes(selected.epic_id)))) {
      throw new CoreConflictError("Release status repository evidence conflicts with the manifest");
    }
    if ((release.milestone===null)!==(repository.milestone===null) ||
        (release.branch===null)!==(repository.branch===null)) {
      throw new CoreConflictError("Release status resources do not match the manifest phase");
    }
    if (repository.milestone!==null) {
      exact(repository.milestone,["title","state","revision"],"Release status milestone");
      if (repository.milestone.title!==release.milestone || typeof repository.milestone.revision!=="string") {
        throw new CoreConflictError("Release status milestone identity drifted");
      }
    }
    if (repository.branch!==null) {
      exact(repository.branch,["name","base_branch","head_sha","revision"],"Release status branch");
      if (repository.branch.name!==release.branch || !/^[a-f0-9]{40}$/u.test(repository.branch.head_sha) ||
          typeof repository.branch.base_branch!=="string" || typeof repository.branch.revision!=="string") {
        throw new CoreConflictError("Release status branch identity drifted");
      }
    }
  }
  actual.sort(compareCanonicalText);
  if (canonicalJson(actual)!==canonicalJson(expected)) {
    throw new CoreConflictError("Release status snapshot does not cover every selected repository track exactly once");
  }
  return value;
}

function nextReleaseCommand(program,release) {
  if (release.phase==="DRAFT") return `toss-core release activate ${program.program_id} ${release.repository}`;
  if (release.phase==="ACTIVE") return `toss-core epic status ${release.scope[0]}`;
  if (release.phase==="READY_FOR_APPROVAL") return `toss-core release approve ${release.repository}@${release.version}`;
  if (release.phase==="PAUSED") return `toss-core sync ${release.repository}`;
  if (release.phase==="PUBLISHING") return `toss-core release status ${release.repository}`;
  return null;
}

function releaseTrack(program,release,observation) {
  return Object.freeze({
    release_id:release.release_id,
    repository:release.repository,
    revision:release.revision,
    phase:release.phase,
    version:release.version,
    milestone:release.milestone,
    branch:release.branch,
    release_pr_intent:release.release_pr_intent,
    scope:observation.scope,
    gates:observation.gates,
    checks:observation.checks,
    patch_link:observation.patch_link,
    next_command:nextReleaseCommand(program,release),
  });
}

function releasePrecedence(release) {
  return ["ACTIVE","PAUSED","READY_FOR_APPROVAL","PUBLISHING"].includes(release.phase) ? 2 :
    release.phase!=="RELEASED" ? 1 : 0;
}

export function releaseStatusResult(input) {
  const {planningState,repository,snapshot}=optionRecord(
    input,["planningState","repository","snapshot"],"Release status request",
  );
  if (typeof repository!=="string") invalid("Release status repository must be canonical text");
  const state=normalizeReleasePlanningState(planningState);
  const candidates=state.programs.flatMap(program => program.repository_releases
    .filter(release => release.repository===repository)
    .map(release => ({program,release})));
  if (candidates.length===0) throw new CoreConflictError(`No release track exists for ${repository}`);
  candidates.sort((left,right) => releasePrecedence(right.release)-releasePrecedence(left.release) ||
    compareProgramIds(right.program.program_id,left.program.program_id));
  if (candidates.length>1 && releasePrecedence(candidates[0].release)===releasePrecedence(candidates[1].release) &&
      candidates[0].program.program_id===candidates[1].program.program_id) {
    throw new CoreConflictError(`Release status is ambiguous for ${repository}`);
  }
  const selected=candidates[0];
  const observed=normalizedStatusSnapshot(snapshot,state,[selected.program],"release-status",[{
    program_id:selected.program.program_id,release_id:selected.release.release_id,
  }]);
  const repositoryEvidence=observed.repositories[0];
  const track=releaseTrack(selected.program,selected.release,repositoryEvidence);
  return clone({
    kind:"release-status",source:observed.source,
    program:{id:selected.program.program_id,revision:selected.program.revision,phase:selected.program.phase},
    track:{release_id:track.release_id,repository:track.repository,revision:track.revision,
      phase:track.phase,version:track.version,milestone:track.milestone,branch:track.branch,
      release_pr_intent:track.release_pr_intent},
    scope:track.scope,gates:track.gates,checks:track.checks,patch_link:track.patch_link,
    next_command:track.next_command,
  },"Release status result");
}

export function programStatusResult(input) {
  const {planningState,programId,snapshot}=optionRecord(
    input,["planningState","programId","snapshot"],"Program status request",
  );
  if (!(programId===null || typeof programId==="string")) invalid("Program status identity is malformed");
  const state=normalizeReleasePlanningState(planningState);
  const programs=selectedProgramSet(state,programId);
  const observed=normalizedStatusSnapshot(snapshot,state,programs,"program-status");
  const byRelease=new Map(observed.repositories.map(value => [`${value.program_id}:${value.release_id}`,value]));
  return clone({
    kind:"program-status",source:observed.source,
    programs:programs.map(program => ({
      id:program.program_id,revision:program.revision,phase:program.phase,
      dependency_stages:program.dependency_stages,
      tracks:program.repository_releases.map(release =>
        releaseTrack(program,release,byRelease.get(`${program.program_id}:${release.release_id}`))),
    })),
  },"Program status result");
}
