import {types} from "node:util";

import {validateDocument} from "../contracts/validator.js";

import {CoreValidationError} from "./errors.js";
import {compareOperations} from "./operation-order.js";
import {parseReservedBranch} from "./domain/identity.js";

const MAX_CORE_CONTRACT_DEPTH=64;
const RELEASE_PRECONDITION_KINDS=Object.freeze(new Map([
  ["release-plan-precondition",{resource:"project",repository:null,
    keys:["kind","project_id","query","snapshot_sha256"]}],
  ["release-activation-precondition",{resource:"project",repository:null,
    keys:["kind","project_id","query","snapshot_sha256"]}],
  ["release-repository-precondition",{resource:"repository",
    keys:["kind","program_id","release_id","snapshot_sha256"]}],
  ["release-default-branch-precondition",{resource:"branch",
    keys:["kind","name","head_sha"]}],
  ["release-milestone-precondition",{resource:"milestone",
    keys:["kind","title","state"]}],
  ["release-branch-precondition",{resource:"branch",
    keys:["kind","name","base_branch","head_sha"]}],
  ["release-pull-request-precondition",{resource:"pull_request",
    keys:["kind","number","base_branch","head_branch","head_sha","draft"]}],
  ["release-assignment-precondition",{resource:"issue",
    keys:["kind","work_item_id","work_sha256"]}],
  ["release-epic-branch-precondition",{resource:"branch",
    keys:["kind","work_item_id","name","base_branch","head_sha"]}],
  ["release-project-item-precondition",{resource:"project",
    keys:["kind","work_item_id","project_id","item_id","fields_sha256"]}],
]));

function validationMessage(schemaId,errors) {
  const details=errors.map(error => error.message).filter(Boolean).join("; ");
  return `Invalid core contract ${schemaId}${details ? `: ${details}` : ""}`;
}

function assertUniqueOperationIds(value) {
  if (value.schema_version!=="operation-intent.v1") return;
  const operationIds=new Set();
  for (const operation of value.operations) {
    if (operationIds.has(operation.operation_id)) {
      throw new CoreValidationError(`Invalid core contract operation-intent.v1: duplicate operation_id ${operation.operation_id}`);
    }
    operationIds.add(operation.operation_id);
  }
}

function assertCanonicalOperationOrder(value) {
  if (value.schema_version!=="operation-intent.v1") return;
  let previousOperationId;
  let previousOperation;
  for (const operation of value.operations) {
    if (previousOperationId!==undefined && previousOperationId>=operation.operation_id) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: operation IDs must use strict ascending ASCII order");
    }
    if (previousOperation!==undefined && compareOperations(previousOperation,operation)>=0) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: operations must use canonical operation order");
    }
    previousOperationId=operation.operation_id;
    previousOperation=operation;
  }
}

function exactOwnKeys(value,keys,label) {
  if (!value || typeof value!=="object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort())!==JSON.stringify([...keys].sort())) {
    throw new CoreValidationError(`Invalid core contract operation-intent.v1: ${label} must use the exact closed shape`);
  }
}

function contractString(value,label,{pattern=null}={}) {
  if (typeof value!=="string" || value.length===0 || (pattern!==null && !pattern.test(value))) {
    throw new CoreValidationError(`Invalid core contract operation-intent.v1: ${label} is malformed`);
  }
}

function nestedDocument(value,schemaId,label) {
  let result;
  try { result=validateDocument(value,schemaId); } catch (error) {
    throw new CoreValidationError(`Invalid core contract operation-intent.v1: ${label} is malformed`,{cause:error});
  }
  if (!result.valid) {
    throw new CoreValidationError(`Invalid core contract operation-intent.v1: ${label} is malformed`);
  }
}

function assertCanonicalIdentities(values,label) {
  const seen=new Set();
  let previous=null;
  for (const value of values) {
    contractString(value,label);
    if (seen.has(value) || (previous!==null && previous>=value)) {
      throw new CoreValidationError(`Invalid core contract operation-intent.v1: ${label} must be unique raw-ordered identities`);
    }
    seen.add(value);
    previous=value;
  }
}

function assertAggregateQuery(payload) {
  const query=payload.query;
  if (payload.kind==="release-plan-precondition") {
    exactOwnKeys(query,["kind","control_revision","organization","repositories","programs"],"release plan query");
    if (query.kind!=="release-plan") throw new CoreValidationError("Invalid core contract operation-intent.v1: release plan query kind is malformed");
    contractString(query.control_revision,"release plan control revision");
    nestedDocument(query.organization,"organization-config.v1","release plan organization");
    if (!Array.isArray(query.repositories) || !Array.isArray(query.programs)) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release plan query collections are malformed");
    }
    for (const repository of query.repositories) nestedDocument(repository,"repository-config.v1","release plan repository");
    for (const program of query.programs) nestedDocument(program,"release-program.v1","release plan program");
    const repositories=query.repositories.map(value => value.repository);
    if (JSON.stringify(repositories)!==JSON.stringify(query.organization.repositories)) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release plan query does not bind the registered repository set");
    }
    assertCanonicalIdentities(query.programs.map(value => value.program_id),"release plan program ids");
    if (payload.project_id!==query.organization.project.node_id) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release plan query Project identity is inconsistent");
    }
    return;
  }
  exactOwnKeys(query,["kind","control_revision","program","repository","repository_configurations","project"],"release activation query");
  if (query.kind!=="release-activation") throw new CoreValidationError("Invalid core contract operation-intent.v1: release activation query kind is malformed");
  contractString(query.control_revision,"release activation control revision");
  nestedDocument(query.program,"release-program.v1","release activation program");
  exactOwnKeys(query.project,["node_id","number"],"release activation Project");
  contractString(query.project.node_id,"release activation Project identity");
  if (!Number.isSafeInteger(query.project.number) || query.project.number<1 ||
      !(query.repository===null || typeof query.repository==="string") ||
      !Array.isArray(query.repository_configurations)) {
    throw new CoreValidationError("Invalid core contract operation-intent.v1: release activation query is malformed");
  }
  for (const repository of query.repository_configurations) nestedDocument(repository,"repository-config.v1","release activation repository");
  const repositories=query.repository_configurations.map(value => value.repository);
  assertCanonicalIdentities(repositories,"release activation repositories");
  const programRepositoryList=query.program.repository_releases.map(value => value.repository);
  const programRepositories=new Set(programRepositoryList);
  if (repositories.some(repository => !programRepositories.has(repository)) ||
      (query.repository===null &&
        JSON.stringify(repositories)!==JSON.stringify(programRepositoryList)) ||
      (query.repository!==null && (repositories.length!==1 || repositories[0]!==query.repository)) ||
      payload.project_id!==query.project.node_id) {
    throw new CoreValidationError("Invalid core contract operation-intent.v1: release activation query scope is inconsistent");
  }
}

function assertReleasePreconditionPayload(operation) {
  const kind=operation.payload?.kind;
  const definition=RELEASE_PRECONDITION_KINDS.get(kind);
  if (operation.action==="verify" && definition===undefined) {
    throw new CoreValidationError("Invalid core contract operation-intent.v1: verify action requires a recognized release precondition kind");
  }
  if (definition===undefined) return;
  if (operation.action!=="verify") {
    throw new CoreValidationError("Invalid core contract operation-intent.v1: release precondition kinds require verify action");
  }
  exactOwnKeys(operation.payload,definition.keys,`${kind} payload`);
  if (operation.resource!==definition.resource ||
      (Object.hasOwn(definition,"repository") && operation.repository!==definition.repository) ||
      (!Object.hasOwn(definition,"repository") && typeof operation.repository!=="string") ||
      typeof operation.expected_revision!=="string" || operation.expected_revision.length===0) {
    throw new CoreValidationError(`Invalid core contract operation-intent.v1: ${kind} operation binding is malformed`);
  }
  const payload=operation.payload;
  for (const key of ["project_id","program_id","release_id","name","title","state",
    "base_branch","head_branch","work_item_id","item_id"]) {
    if (Object.hasOwn(payload,key)) contractString(payload[key],`${kind}.${key}`);
  }
  for (const key of ["snapshot_sha256","work_sha256","fields_sha256"]) {
    if (Object.hasOwn(payload,key)) contractString(payload[key],`${kind}.${key}`,{pattern:/^[a-f0-9]{64}$/u});
  }
  if (Object.hasOwn(payload,"head_sha")) contractString(payload.head_sha,`${kind}.head_sha`,{pattern:/^[a-f0-9]{40}$/u});
  if (Object.hasOwn(payload,"number") && (!Number.isSafeInteger(payload.number) || payload.number<1)) {
    throw new CoreValidationError(`Invalid core contract operation-intent.v1: ${kind}.number is malformed`);
  }
  if (Object.hasOwn(payload,"draft") && typeof payload.draft!=="boolean") {
    throw new CoreValidationError(`Invalid core contract operation-intent.v1: ${kind}.draft is malformed`);
  }
  if (["release-plan-precondition","release-activation-precondition"].includes(kind)) {
    assertAggregateQuery(payload);
  }
}

function assertOperationIntentSemantics(value) {
  if (value.schema_version!=="operation-intent.v1") return;
  for (const operation of value.operations) {
    assertReleasePreconditionPayload(operation);
    if (["release-plan-precondition","release-activation-precondition"].includes(
      operation.payload?.kind)) {
      if (operation.payload.query.control_revision!==value.source.revision ||
          (operation.payload.kind==="release-plan-precondition" &&
            operation.payload.query.organization.control_repository!==value.source.repository)) {
        throw new CoreValidationError("Invalid core contract operation-intent.v1: aggregate query does not bind the immutable intent source");
      }
    }
  }
}

function assertUniqueIds(values,key,label) {
  if (!Array.isArray(values)) return;
  const ids=new Set();
  for (const value of values) {
    const id=value?.[key];
    if (typeof id!=="string") continue;
    if (ids.has(id)) {
      throw new CoreValidationError(`Invalid core contract: duplicate ${label} ${id}`);
    }
    ids.add(id);
  }
}

function assertWorkItemIdentity(value) {
  if (!value || value.schema_version!=="work-item.v1" ||
      typeof value.repository!=="string" || !Number.isSafeInteger(value.issue_number) ||
      typeof value.id!=="string" || typeof value.kind!=="string" ||
      typeof value.branch!=="string") return;
  const expectedId=`${value.repository}#${value.issue_number}`;
  let branch;
  try {
    branch=parseReservedBranch(value.branch);
  } catch (error) {
    throw new CoreValidationError("Invalid core contract work-item.v1: reserved branch identity is not canonical",{cause:error});
  }
  const parentMatches=value.kind!=="issue" ||
    (typeof value.parent_id==="string" && value.parent_id.startsWith(`${value.repository}#`));
  if (value.id!==expectedId || branch.kind!==value.kind ||
      branch.issueNumber!==value.issue_number || !parentMatches) {
    throw new CoreValidationError("Invalid core contract work-item.v1: identity, repository, native issue number, and branch reservation must agree");
  }
}

function assertEpicPlanTopology(value) {
  const epic=value.epic;
  if (epic===null || typeof epic!=="object") return;
  if (epic.kind!=="epic") {
    throw new CoreValidationError("Invalid core contract epic-plan.v1: root work item must be an epic");
  }
  if (!Array.isArray(value.children) || typeof epic.id!=="string" ||
      typeof epic.repository!=="string") return;
  for (const child of value.children) {
    if (child===null || typeof child!=="object") continue;
    if (child.kind!=="issue" || child.repository!==epic.repository ||
        child.parent_id!==epic.id || child.base_branch!==epic.branch) {
      throw new CoreValidationError("Invalid core contract epic-plan.v1: children must be same-repository issues with the exact epic parent and base branch");
    }
  }
}

function assertWorkContractSemantics(value) {
  if (value===null || typeof value!=="object") return;
  assertWorkItemIdentity(value);
  if (value.schema_version==="epic-plan.v1") {
    assertUniqueIds(value.children,"id","work item id");
    assertUniqueIds(value.edges,"edge_id","dependency edge id");
    assertWorkItemIdentity(value.epic);
    if (Array.isArray(value.children)) {
      for (const child of value.children) assertWorkItemIdentity(child);
    }
    assertEpicPlanTopology(value);
  }
  if (value.schema_version==="review-result.v1") {
    assertUniqueIds(value.findings,"finding_id","review finding id");
  }
}

function assertClosedContract(value,seen=new Set(),depth=0) {
  if (depth>MAX_CORE_CONTRACT_DEPTH) {
    throw new CoreValidationError("Invalid core contract: value exceeds the maximum closed-data depth");
  }
  if (value===null || typeof value!=="object") return;
  if (types.isProxy(value)) {
    throw new CoreValidationError("Invalid core contract: proxy values are not allowed");
  }
  if (seen.has(value)) throw new CoreValidationError("Invalid core contract: cyclic values are not allowed");
  seen.add(value);
  try {
    const prototype=Object.getPrototypeOf(value);
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const keys=Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      if (prototype!==Array.prototype) throw new CoreValidationError("Invalid core contract: arrays must be plain");
      const lengthDescriptor=descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.enumerable ||
          !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value<0) {
        throw new CoreValidationError("Invalid core contract: arrays must have a valid length descriptor");
      }
      let count=0;
      for (const key of keys) {
        if (key==="length") continue;
        const descriptor=descriptors[key];
        const index=typeof key==="string" ? Number(key) : -1;
        if (typeof key!=="string" || !Number.isSafeInteger(index) || index<0 ||
            index>=lengthDescriptor.value || String(index)!==key || !("value" in descriptor) ||
            !descriptor.enumerable) {
          throw new CoreValidationError("Invalid core contract: arrays must be dense own data");
        }
        count+=1;
        assertClosedContract(descriptor.value,seen,depth+1);
      }
      if (count!==lengthDescriptor.value) throw new CoreValidationError("Invalid core contract: arrays must be dense own data");
      return;
    }
    if (![Object.prototype,null].includes(prototype)) throw new CoreValidationError("Invalid core contract: objects must be plain");
    for (const key of keys) {
      const descriptor=descriptors[key];
      if (typeof key!=="string" || !("value" in descriptor) || !descriptor.enumerable) {
        throw new CoreValidationError("Invalid core contract: objects must contain only own enumerable data");
      }
      assertClosedContract(descriptor.value,seen,depth+1);
    }
  } finally {
    seen.delete(value);
  }
}

export {CoreValidationError};

export function validateCoreDocument(value,schemaId) {
  assertClosedContract(value);
  assertWorkContractSemantics(value);
  let result;
  try {
    result=validateDocument(value,schemaId);
  } catch (error) {
    throw new CoreValidationError(`Invalid core contract ${schemaId}: ${error.message}`,{cause:error});
  }
  if (!result.valid) {
    throw new CoreValidationError(validationMessage(schemaId,result.errors));
  }
  assertOperationIntentSemantics(value);
  assertUniqueOperationIds(value);
  assertCanonicalOperationOrder(value);
  return value;
}
