import {createHash} from "node:crypto";
import {types} from "node:util";

import {compareCanonicalText} from "../canonical-order.js";
import {validateDependencyGraph} from "../domain/dependencies.js";
import {parseWorkItemId} from "../domain/identity.js";
import {CoreValidationError} from "../errors.js";
import {parseSemVer,selectRepositoryVersion} from "./semver.js";
import {assertRepositoryConcurrency} from "./state.js";

const CANDIDATE_KEYS=Object.freeze([
  "id","repository","approved","version","decomposed","priority","risk","outcome",
  "change_class","dependencies",
]);
const ELIGIBILITY_CONTEXT_KEYS=Object.freeze(["epic_ids","repositories"]);
const PLANNER_KEYS=Object.freeze([
  "programId","candidates","completed","repositories","activePrograms","clock",
]);
const REPOSITORY_KEYS=Object.freeze(["repository","latest_published_version"]);
const PROGRAM_KEYS=Object.freeze([
  "schema_version","program_id","phase","revision","repository_releases",
  "dependency_stages","selected_scope","deferred_scope","rationale","interrupts",
  "created_at","updated_at",
]);
const RISKS=Object.freeze(new Map([["low",0],["medium",1],["high",2]]));
const CHANGE_CLASSES=Object.freeze(["breaking","backward_compatible_feature"]);
const RESERVING_PROGRAM_PHASES=Object.freeze(new Set([
  "DRAFT","ACTIVE","PAUSED","PUBLISHING",
]));
const PROGRAM_ID=/^TOSS-OS-R[0-9]{4,}$/;

function invalid(message,options={}) {
  throw new CoreValidationError(message,options);
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

function canonicalRepository(value,label) {
  if (typeof value!=="string") invalid(`${label} must be a canonical repository`);
  let parsed;
  try {
    parsed=parseWorkItemId(`${value}#1`);
  } catch (error) {
    invalid(`${label} must be canonical OWNER/REPO ASCII`,{cause:error});
  }
  if (parsed.repository!==value) invalid(`${label} must be canonical OWNER/REPO ASCII`);
  return value;
}

function canonicalWorkItemId(value,label) {
  try {
    parseWorkItemId(value);
  } catch (error) {
    invalid(`${label} must be a canonical work-item ID`,{cause:error});
  }
  return value;
}

function canonicalOrderedUnique(values,label,identity=value => value) {
  for (let index=1;index<values.length;index+=1) {
    if (compareCanonicalText(identity(values[index-1]),identity(values[index]))>=0) {
      invalid(`${label} must use unique raw code-point order`);
    }
  }
}

function sortedUniqueWorkIds(value,label,{canonicalOrder=false}={}) {
  const values=shallowDenseArray(value,label).map((entry,index) =>
    canonicalWorkItemId(entry,`${label}[${index}]`));
  const ordered=[...values].sort(compareCanonicalText);
  if (new Set(values).size!==values.length) invalid(`${label} must contain unique IDs`);
  if (canonicalOrder) canonicalOrderedUnique(values,label);
  return Object.freeze(ordered);
}

function normalizeCandidate(input,label="Release candidate") {
  const value=shallowExactRecord(input,CANDIDATE_KEYS,label);
  const identity=parseWorkItemId(canonicalWorkItemId(value.id,`${label}.id`));
  const repository=canonicalRepository(value.repository,`${label}.repository`);
  if (identity.repository!==repository) {
    invalid(`${label}.id must bind its exact repository`);
  }
  if (typeof value.approved!=="boolean") invalid(`${label}.approved must be boolean`);
  if (value.version!==null) parseSemVer(value.version);
  if (typeof value.decomposed!=="boolean") invalid(`${label}.decomposed must be boolean`);
  if (!Number.isSafeInteger(value.priority) || value.priority<0) {
    invalid(`${label}.priority must be a nonnegative safe integer`);
  }
  if (!RISKS.has(value.risk)) invalid(`${label}.risk must be low, medium, or high`);
  if (typeof value.outcome!=="string" || value.outcome.trim().length===0) {
    invalid(`${label}.outcome must be a nonblank string`);
  }
  if (!CHANGE_CLASSES.includes(value.change_class)) {
    invalid(`${label}.change_class must be a selectable epic change class`);
  }
  const dependencies=sortedUniqueWorkIds(value.dependencies,`${label}.dependencies`);
  if (dependencies.includes(value.id)) invalid(`${label} cannot depend on itself`);
  return Object.freeze({
    id:value.id,
    repository,
    approved:value.approved,
    version:value.version,
    decomposed:value.decomposed,
    priority:value.priority,
    risk:value.risk,
    outcome:value.outcome,
    change_class:value.change_class,
    dependencies,
  });
}

function normalizeEligibilityContext(input) {
  const value=shallowExactRecord(
    input,ELIGIBILITY_CONTEXT_KEYS,"Epic eligibility context",
  );
  const epicIds=sortedUniqueWorkIds(
    value.epic_ids,"Epic eligibility context.epic_ids",{canonicalOrder:true},
  );
  const repositories=shallowDenseArray(
    value.repositories,"Epic eligibility context.repositories",
  ).map((repository,index) => canonicalRepository(
    repository,`Epic eligibility context.repositories[${index}]`,
  ));
  canonicalOrderedUnique(repositories,"Epic eligibility context.repositories");
  return Object.freeze({
    epic_ids:epicIds,
    repositories:Object.freeze(repositories),
  });
}

function reason(reasonCode,explanation,blockingIds=[]) {
  return Object.freeze({
    reason_code:reasonCode,
    explanation,
    blocking_ids:Object.freeze([...blockingIds].sort(compareCanonicalText)),
  });
}

function eligibilityFor(epic,context) {
  const reasons=[];
  if (!epic.approved) {
    reasons.push(reason(
      "EPIC_UNAPPROVED",`Epic ${epic.id} is not explicitly approved.`,
    ));
  }
  if (epic.version!==null) {
    reasons.push(reason(
      "EPIC_ALREADY_VERSIONED",`Epic ${epic.id} already has release version ${epic.version}.`,
    ));
  }
  if (!epic.decomposed) {
    reasons.push(reason(
      "EPIC_NOT_DECOMPOSED",`Epic ${epic.id} is not sufficiently decomposed.`,
    ));
  }
  if (!context.repositories.includes(epic.repository)) {
    reasons.push(reason(
      "REPOSITORY_UNREGISTERED",`Repository ${epic.repository} is not registered.`,
    ));
  }
  if (context.epic_ids.includes(epic.id)) {
    reasons.push(reason(
      "ACTIVE_PROGRAM_ASSIGNMENT",
      `Epic ${epic.id} is assigned to another active release program.`,
      [epic.id],
    ));
  }
  return Object.freeze({eligible:reasons.length===0,reasons:Object.freeze(reasons)});
}

export function eligibleEpic(epicInput,activeAssignmentsInput) {
  return eligibilityFor(
    normalizeCandidate(epicInput),
    normalizeEligibilityContext(activeAssignmentsInput),
  );
}

export function candidateOrder(left,right) {
  if (left.priority!==right.priority) return left.priority>right.priority ? -1 : 1;
  if (left.dependency_fanout!==right.dependency_fanout) {
    return left.dependency_fanout>right.dependency_fanout ? -1 : 1;
  }
  const riskComparison=RISKS.get(left.risk)-RISKS.get(right.risk);
  return riskComparison || compareCanonicalText(left.id,right.id);
}

function releaseDependencyEdge(source,target,prefix="candidate") {
  const identity=createHash("sha256").update(`${source}\u0000${target}`,"utf8").digest("hex");
  return Object.freeze({
    schema_version:"dependency-edge.v1",
    edge_id:`DEP-RELEASE-${identity}`,
    source,
    target,
    kind:"requires",
    rationale:`Release ${prefix} ${source} requires ${target}.`,
    provenance:Object.freeze({
      source_revision:"release-planner@1",
      source_sha256:identity,
      locations:Object.freeze([`${prefix}.${source}.dependencies.${target}`]),
    }),
    revision:`release-planner@${identity}`,
  });
}

function normalizePlannerInput(input) {
  const value=shallowExactRecord(input,PLANNER_KEYS,"Release planner input");
  if (typeof value.programId!=="string" || !PROGRAM_ID.test(value.programId)) {
    invalid("Release planner programId must be canonical");
  }
  if (typeof value.clock!=="function" || types.isProxy(value.clock)) {
    invalid("Release planner clock must be a non-proxy function");
  }

  const candidates=shallowDenseArray(value.candidates,"Release planner candidates")
    .map((candidate,index) => normalizeCandidate(candidate,`Release planner candidate[${index}]`));
  const candidateIds=new Set();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) invalid(`Duplicate release candidate: ${candidate.id}`);
    candidateIds.add(candidate.id);
  }
  candidates.sort((left,right) => compareCanonicalText(left.id,right.id));

  const completed=sortedUniqueWorkIds(
    value.completed,"Release planner completed",{canonicalOrder:true},
  );
  if (completed.some(id => candidateIds.has(id))) {
    invalid("Release planner candidates and completed dependencies must not overlap");
  }

  const repositories=shallowDenseArray(value.repositories,"Release planner repositories")
    .map((entry,index) => {
      const repositoryInput=shallowExactRecord(
        entry,REPOSITORY_KEYS,`Release planner repository[${index}]`,
      );
      const name=canonicalRepository(
        repositoryInput.repository,`Release planner repository[${index}].repository`,
      );
      parseSemVer(repositoryInput.latest_published_version);
      return Object.freeze({
        repository:name,
        latest_published_version:repositoryInput.latest_published_version,
      });
    });
  repositories.sort((left,right) => compareCanonicalText(left.repository,right.repository));
  canonicalOrderedUnique(
    repositories,"Release planner repositories",entry => entry.repository,
  );

  const activePrograms=shallowDenseArray(
    value.activePrograms,"Release planner activePrograms",
  ).map((program,index) => shallowExactRecord(
    program,PROGRAM_KEYS,`Release planner activePrograms[${index}]`,
  ));
  assertRepositoryConcurrency(activePrograms);
  if (activePrograms.some(program => program.program_id===value.programId)) {
    invalid(`Release planner programId is already present: ${value.programId}`);
  }

  return Object.freeze({
    programId:value.programId,
    candidates:Object.freeze(candidates),
    completed,
    repositories:Object.freeze(repositories),
    activePrograms:Object.freeze(activePrograms),
    clock:value.clock,
  });
}

function validatedCandidateGraph(candidates,completed) {
  const nodes=new Set(completed);
  const edges=[];
  for (const candidate of candidates) {
    nodes.add(candidate.id);
    for (const dependency of candidate.dependencies) {
      nodes.add(dependency);
      edges.push(releaseDependencyEdge(candidate.id,dependency));
    }
  }
  return validateDependencyGraph({nodes:[...nodes],edges});
}

function dependencyFanout(candidates,graph) {
  const candidateIds=new Set(candidates.map(candidate => candidate.id));
  const fanout=new Map(candidates.map(candidate => [candidate.id,0]));
  for (const edge of graph.edges) {
    if (candidateIds.has(edge.source) && candidateIds.has(edge.target)) {
      fanout.set(edge.target,fanout.get(edge.target)+1);
    }
  }
  return fanout;
}

function closureFor(seeds,byId,completed,reports) {
  const selected=new Set(seeds.map(candidate => candidate.id));
  const pending=[...selected].sort(compareCanonicalText);
  const missing=new Set();
  const ineligible=new Set();
  while (pending.length>0) {
    const id=pending.shift();
    const candidate=byId.get(id);
    for (const dependency of candidate.dependencies) {
      if (completed.has(dependency)) continue;
      const required=byId.get(dependency);
      if (required===undefined) {
        missing.add(dependency);
      } else if (!reports.get(dependency).eligible) {
        ineligible.add(dependency);
      } else if (!selected.has(dependency)) {
        selected.add(dependency);
        pending.push(dependency);
        pending.sort(compareCanonicalText);
      }
    }
  }
  return Object.freeze({
    selected:Object.freeze([...selected].sort(compareCanonicalText)),
    missing:Object.freeze([...missing].sort(compareCanonicalText)),
    ineligible:Object.freeze([...ineligible].sort(compareCanonicalText)),
  });
}

function outcomeOptions(candidates,byId,completed,reports,fanout) {
  const groups=new Map();
  for (const candidate of candidates) {
    if (!reports.get(candidate.id).eligible) continue;
    const group=groups.get(candidate.outcome) ?? [];
    group.push(candidate);
    groups.set(candidate.outcome,group);
  }
  return [...groups].map(([outcome,seeds]) => {
    const ranked=seeds.map(candidate => Object.freeze({
      ...candidate,
      dependency_fanout:fanout.get(candidate.id),
    })).sort(candidateOrder);
    const closure=closureFor(seeds,byId,completed,reports);
    return Object.freeze({outcome,best:ranked[0],...closure});
  }).sort((left,right) =>
    candidateOrder(left.best,right.best) || compareCanonicalText(left.outcome,right.outcome));
}

function deferredFor(candidate,report,option,selectedIds,programId) {
  if (selectedIds.has(candidate.id)) return null;
  if (!report.eligible) {
    const primary=report.reasons[0];
    const blockingIds=[...new Set(report.reasons.flatMap(entry => entry.blocking_ids))]
      .sort(compareCanonicalText);
    return reason(
      primary.reason_code,
      report.reasons.map(entry => entry.explanation).join(" "),
      blockingIds,
    );
  }
  if (option.missing.length>0) {
    return reason(
      "DEPENDENCY_MISSING",
      `Epic ${candidate.id} has missing mandatory dependencies: ${option.missing.join(", ")}.`,
      option.missing,
    );
  }
  if (option.ineligible.length>0) {
    return reason(
      "DEPENDENCY_INELIGIBLE",
      `Epic ${candidate.id} has ineligible mandatory dependencies: ${option.ineligible.join(", ")}.`,
      option.ineligible,
    );
  }
  return reason(
    "OUTCOME_NOT_SELECTED",
    `Outcome ${JSON.stringify(candidate.outcome)} was not selected for ${programId}.`,
  );
}

function releaseId(programId,repository) {
  const digest=createHash("sha256").update(repository,"utf8").digest("hex");
  return `REL-${programId}-${digest}`;
}

function repositoryStages(selected,releaseIds,graph) {
  const selectedIds=new Set(selected.map(candidate => candidate.id));
  const repositoryIds=new Map();
  for (const candidate of selected) repositoryIds.set(candidate.repository,`${candidate.repository}#1`);
  const semanticEdges=new Set();
  const edges=[];
  for (const edge of graph.edges) {
    if (!selectedIds.has(edge.source) || !selectedIds.has(edge.target)) continue;
    const source=selected.find(candidate => candidate.id===edge.source);
    const target=selected.find(candidate => candidate.id===edge.target);
    if (source.repository===target.repository) continue;
    const semantic=`${source.repository}\u0000${target.repository}`;
    if (semanticEdges.has(semantic)) continue;
    semanticEdges.add(semantic);
    edges.push(releaseDependencyEdge(
      repositoryIds.get(source.repository),repositoryIds.get(target.repository),"repository",
    ));
  }
  const repositoryGraph=validateDependencyGraph({
    nodes:[...repositoryIds.values()],
    edges,
  });
  return Object.freeze(repositoryGraph.stages.map((stage,index) => Object.freeze({
    stage:index+1,
    repository_release_ids:Object.freeze(stage.map(id => {
      const repository=parseWorkItemId(id).repository;
      return releaseIds.get(repository);
    }).sort(compareCanonicalText)),
  })));
}

function deepFreeze(value,seen=new Set()) {
  if (value===null || typeof value!=="object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key],seen);
  return Object.freeze(value);
}

export function planReleaseProgram(input) {
  const value=normalizePlannerInput(input);
  const byId=new Map(value.candidates.map(candidate => [candidate.id,candidate]));
  const completed=new Set(value.completed);
  const graph=validatedCandidateGraph(value.candidates,value.completed);
  const fanout=dependencyFanout(value.candidates,graph);
  const activeIds=[...new Set(value.activePrograms
    .filter(program => RESERVING_PROGRAM_PHASES.has(program.phase))
    .flatMap(program => program.selected_scope.map(selected => selected.epic_id)))]
    .sort(compareCanonicalText);
  const repositoryNames=value.repositories.map(entry => entry.repository);
  const context=Object.freeze({
    epic_ids:Object.freeze(activeIds),
    repositories:Object.freeze(repositoryNames),
  });
  const reports=new Map(value.candidates.map(candidate => [
    candidate.id,eligibilityFor(candidate,context),
  ]));
  const options=outcomeOptions(value.candidates,byId,completed,reports,fanout);
  const chosen=options.find(option => option.missing.length===0 && option.ineligible.length===0);
  const selectedIds=new Set(chosen?.selected ?? []);
  const optionByOutcome=new Map(options.map(option => [option.outcome,option]));
  const deferred=value.candidates.flatMap(candidate => {
    const deferral=deferredFor(
      candidate,reports.get(candidate.id),optionByOutcome.get(candidate.outcome),
      selectedIds,value.programId,
    );
    return deferral===null ? [] : [{epic_id:candidate.id,...deferral}];
  });
  const timestamp=value.clock();

  if (chosen===undefined) {
    const waiting={
      schema_version:"release-program.v1",
      program_id:value.programId,
      phase:"WAITING_FOR_EPIC",
      revision:"REV-0001",
      repository_releases:[],
      dependency_stages:[],
      selected_scope:[],
      deferred_scope:deferred,
      rationale:[],
      interrupts:null,
      created_at:timestamp,
      updated_at:timestamp,
    };
    assertRepositoryConcurrency([waiting]);
    return deepFreeze(waiting);
  }

  const selected=chosen.selected.map(id => byId.get(id));
  const selectedByRepository=new Map();
  for (const candidate of selected) {
    const scope=selectedByRepository.get(candidate.repository) ?? [];
    scope.push(candidate);
    selectedByRepository.set(candidate.repository,scope);
  }
  const releaseIds=new Map([...selectedByRepository].map(([repository]) => [
    repository,releaseId(value.programId,repository),
  ]));
  const repositoryReleases=[];
  const rationale=[];
  for (const repositoryInput of value.repositories) {
    const scope=selectedByRepository.get(repositoryInput.repository);
    if (scope===undefined) continue;
    scope.sort((left,right) => compareCanonicalText(left.id,right.id));
    const version=selectRepositoryVersion({
      latestPublishedVersion:repositoryInput.latest_published_version,
      epics:scope.map(candidate => ({id:candidate.id,change_class:candidate.change_class})),
      bugs:[],
    });
    repositoryReleases.push({
      schema_version:"repository-release.v1",
      release_id:releaseIds.get(repositoryInput.repository),
      program_id:value.programId,
      repository:repositoryInput.repository,
      phase:"DRAFT",
      revision:"REV-0001",
      version:null,
      milestone:null,
      branch:null,
      release_pr_intent:null,
      scope:scope.map(candidate => candidate.id),
      publication_evidence:null,
      transitions:[],
    });
    rationale.push({
      repository:repositoryInput.repository,
      version:version.version,
      change_class:version.change_class,
      reasons:version.rationale,
    });
  }
  const planned={
    schema_version:"release-program.v1",
    program_id:value.programId,
    phase:"DRAFT",
    revision:"REV-0001",
    repository_releases:repositoryReleases,
    dependency_stages:repositoryStages(selected,releaseIds,graph),
    selected_scope:selected.map(candidate => ({
      epic_id:candidate.id,
      outcome:candidate.outcome,
      eligibility:{
        approved:true,
        unversioned:true,
        decomposed:true,
        registered_repository:true,
        unassigned:true,
      },
    })),
    deferred_scope:deferred,
    rationale,
    interrupts:null,
    created_at:timestamp,
    updated_at:timestamp,
  };
  assertRepositoryConcurrency([planned]);
  return deepFreeze(planned);
}
