import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {validateCoreDocument} from "../contracts.js";
import {validateDependencyGraph} from "../domain/dependencies.js";
import {parseWorkItemId} from "../domain/identity.js";
import {CoreConflictError,CoreValidationError} from "../errors.js";
import {compareOperations} from "../operation-order.js";

const INPUT_KEYS=Object.freeze(["plan_id","created_at","epic","children","dependencies","source"]);
const SNAPSHOT_KEYS=Object.freeze(["revision","children","relationships"]);
const CHILD_KEYS=Object.freeze([
  "marker","id","repository","acceptance_criteria","branch","project_fields","revision",
]);
const RELATIONSHIP_KEYS=Object.freeze(["child_id","parent_id","revision"]);
const PROJECT_FIELD_KEYS=Object.freeze([
  "status","gate","repository","parent","branch","base_branch","milestone",
]);
const MANAGED_MARKER=/^<!-- toss-core:managed-child:[a-f0-9]{64} -->$/;
const REPOSITORY=/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

function invalid(message,options={}) {
  throw new CoreValidationError(message,options);
}

function conflict(message) {
  throw new CoreConflictError(message);
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
    if (prototype!==Object.prototype && prototype!==null) invalid(`${label} objects must be plain`);
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
  if (canonicalJson(Object.keys(value).sort())!==canonicalJson([...expected].sort())) {
    invalid(`${label} must use the exact closed shape`);
  }
}

function text(value,label) {
  if (typeof value!=="string" || value.trim().length===0) invalid(`${label} must be non-empty text`);
  return value;
}

function workId(value,label) {
  try {
    return parseWorkItemId(value);
  } catch (error) {
    invalid(`${label} must be a canonical work-item ID`,{cause:error});
  }
}

function compareText(left,right) {
  if (left===right) return 0;
  return left<right ? -1 : 1;
}

function compareEdges(left,right) {
  for (const key of ["source","target","kind","edge_id"]) {
    const comparison=compareText(left[key],right[key]);
    if (comparison!==0) return comparison;
  }
  return compareText(canonicalJson(left),canonicalJson(right));
}

function desiredFields(child) {
  return Object.freeze({
    status:child.status,
    gate:child.gate,
    repository:child.repository,
    parent:child.parent_id,
    branch:child.branch,
    base_branch:child.base_branch,
    milestone:child.milestone,
  });
}

export function managedChildMarker(itemId) {
  workId(itemId,"Managed child identity");
  return `<!-- toss-core:managed-child:${sha256Canonical({schema_version:"managed-child-marker.v1",work_item_id:itemId})} -->`;
}

export function normalizeEpicPlan(input) {
  const value=copyClosed(input,"Epic plan input");
  exactKeys(value,INPUT_KEYS,"Epic plan input");
  if (!Array.isArray(value.children) || !Array.isArray(value.dependencies)) {
    invalid("Epic plan children and dependencies must be arrays");
  }
  validateCoreDocument(value.epic,"work-item.v1");
  if (value.epic.kind!=="epic" || value.epic.parent_id!==null) {
    invalid("Epic plan root must be a top-level epic");
  }
  exactKeys(value.source,["repository","revision","sha256"],"Epic plan source");
  if (value.source.repository!==value.epic.repository) {
    invalid("Epic plan source repository must match the epic repository");
  }

  const children=[...value.children].sort((left,right) => compareText(left.id,right.id));
  const childIds=new Set();
  for (const child of children) {
    validateCoreDocument(child,"work-item.v1");
    if (child.kind!=="issue" || child.repository!==value.epic.repository ||
        child.parent_id!==value.epic.id || child.milestone!==null) {
      invalid("Epic plan children must be unversioned same-repository issues with the exact native epic parent");
    }
    if (childIds.has(child.id)) invalid(`Epic plan has duplicate child ${child.id}`);
    childIds.add(child.id);
  }

  const dependencies=[...value.dependencies].sort(compareEdges);
  const graphNodes=new Set(childIds);
  for (const dependency of dependencies) {
    validateCoreDocument(dependency,"dependency-edge.v1");
    if (!childIds.has(dependency.source)) {
      invalid(`Epic plan dependency source must be a governed child: ${dependency.source}`);
    }
    graphNodes.add(dependency.target);
  }
  validateDependencyGraph({nodes:[...graphNodes],edges:dependencies});

  const hashInput=Object.freeze({
    schema_version:"epic-plan.v1",
    plan_id:value.plan_id,
    source:value.source,
    epic:value.epic,
    children:Object.freeze(children),
    edges:Object.freeze(dependencies),
    created_at:value.created_at,
  });
  const plan=Object.freeze({
    ...hashInput,
    content_sha256:sha256Canonical(hashInput),
  });
  validateCoreDocument(plan,"epic-plan.v1");
  return plan;
}

function validatePlan(input) {
  const plan=copyClosed(input,"Epic plan");
  validateCoreDocument(plan,"epic-plan.v1");
  const normalized=normalizeEpicPlan({
    plan_id:plan.plan_id,
    created_at:plan.created_at,
    epic:plan.epic,
    children:plan.children,
    dependencies:plan.edges,
    source:plan.source,
  });
  if (canonicalJson(plan)!==canonicalJson(normalized)) {
    invalid("Epic plan content hash or canonical order is invalid");
  }
  return normalized;
}

function validateSnapshot(input) {
  const snapshot=copyClosed(input,"Epic preparation snapshot");
  exactKeys(snapshot,SNAPSHOT_KEYS,"Epic preparation snapshot");
  text(snapshot.revision,"Epic preparation snapshot revision");
  if (!Array.isArray(snapshot.children) || !Array.isArray(snapshot.relationships)) {
    invalid("Epic preparation snapshot evidence must be arrays");
  }
  const childIds=new Set();
  const markers=new Set();
  for (const child of snapshot.children) {
    exactKeys(child,CHILD_KEYS,"Existing native child");
    workId(child.id,"Existing native child identity");
    if (typeof child.repository!=="string" || !REPOSITORY.test(child.repository)) {
      invalid("Existing native child repository must be canonical OWNER/REPO ASCII");
    }
    text(child.marker,"Existing native child marker");
    text(child.revision,"Existing native child revision");
    if (!Array.isArray(child.acceptance_criteria) ||
        child.acceptance_criteria.some(item => typeof item!=="string" || item.trim().length===0)) {
      invalid("Existing native child acceptance criteria must be text");
    }
    text(child.branch,"Existing native child branch");
    exactKeys(child.project_fields,PROJECT_FIELD_KEYS,"Existing native child Project fields");
    if (childIds.has(child.id) || markers.has(child.marker)) {
      conflict("Epic preparation snapshot has duplicate child identity or managed marker");
    }
    childIds.add(child.id);
    markers.add(child.marker);
  }
  const relationshipChildren=new Set();
  for (const relationship of snapshot.relationships) {
    exactKeys(relationship,RELATIONSHIP_KEYS,"Native parent relationship");
    workId(relationship.child_id,"Native relationship child");
    workId(relationship.parent_id,"Native relationship parent");
    text(relationship.revision,"Native relationship revision");
    if (relationshipChildren.has(relationship.child_id)) {
      conflict(`Native child ${relationship.child_id} has duplicate parent relationships`);
    }
    relationshipChildren.add(relationship.child_id);
  }
  return snapshot;
}

function operationPayload(plan,child) {
  return Object.freeze({
    marker:managedChildMarker(child.id),
    work_item_id:child.id,
    native_issue_number:child.issue_number,
    native_parent_id:plan.epic.id,
    acceptance_criteria:child.acceptance_criteria,
    reserved_branch:child.branch,
    project:Object.freeze({
      membership:"TOSS OS",
      fields:desiredFields(child),
    }),
  });
}

function existingMatches(existing,payload) {
  return existing.marker===payload.marker &&
    existing.id===payload.work_item_id &&
    existing.repository===payload.project.fields.repository &&
    existing.branch===payload.reserved_branch &&
    canonicalJson(existing.acceptance_criteria)===canonicalJson(payload.acceptance_criteria) &&
    canonicalJson(existing.project_fields)===canonicalJson(payload.project.fields);
}

export function epicPreparationOperations(planInput,snapshotInput) {
  const plan=validatePlan(planInput);
  const snapshot=validateSnapshot(snapshotInput);
  const desiredIds=new Set(plan.children.map(child => child.id));
  const desiredMarkers=new Map(plan.children.map(child => [managedChildMarker(child.id),child.id]));
  const byId=new Map(snapshot.children.map(child => [child.id,child]));
  const byMarker=new Map(snapshot.children.map(child => [child.marker,child]));
  const relationships=new Map(snapshot.relationships.map(value => [value.child_id,value]));

  for (const existing of snapshot.children) {
    const related=relationships.get(existing.id);
    const governedByEpic=related?.parent_id===plan.epic.id || MANAGED_MARKER.test(existing.marker);
    if (governedByEpic && !desiredIds.has(existing.id)) {
      conflict(`Prepared epic plan would drop governed child ${existing.id}`);
    }
  }
  for (const relationship of snapshot.relationships) {
    if (relationship.parent_id===plan.epic.id && !desiredIds.has(relationship.child_id)) {
      conflict(`Prepared epic plan would drop native child relationship ${relationship.child_id}`);
    }
  }

  const operations=[];
  for (const child of plan.children) {
    const marker=managedChildMarker(child.id);
    const existingById=byId.get(child.id);
    const existingByMarker=byMarker.get(marker);
    if (existingById && existingById.marker!==marker) {
      conflict(`Native child ${child.id} has a conflicting managed marker`);
    }
    if (existingByMarker && existingByMarker.id!==child.id) {
      conflict(`Managed marker for ${child.id} identifies a different native child`);
    }
    for (const [observedMarker,observed] of byMarker) {
      if (desiredMarkers.get(observedMarker)===child.id && observed.id!==child.id) {
        conflict(`Managed marker for ${child.id} conflicts with native identity`);
      }
    }
    const existing=existingById ?? existingByMarker;
    const relationship=relationships.get(child.id);
    if (relationship && relationship.parent_id!==plan.epic.id) {
      conflict(`Native child ${child.id} has conflicting parent ${relationship.parent_id}`);
    }
    if (existing && existing.repository!==child.repository) {
      conflict(`Native child ${child.id} has a conflicting repository`);
    }

    const payload=operationPayload(plan,child);
    if (!existing) {
      if (relationship) conflict(`Native relationship for ${child.id} has no matching child evidence`);
      operations.push(Object.freeze({
        resource:"issue",
        action:"create",
        repository:child.repository,
        expected_revision:snapshot.revision,
        payload,
      }));
      continue;
    }
    if (!relationship || !existingMatches(existing,payload)) {
      operations.push(Object.freeze({
        resource:"issue",
        action:"update",
        repository:child.repository,
        expected_revision:existing.revision,
        payload,
      }));
    }
  }

  return Object.freeze(operations.sort(compareOperations));
}
