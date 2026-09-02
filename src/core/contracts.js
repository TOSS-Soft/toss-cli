import {types} from "node:util";

import {canonicalJson} from "../contracts/acp.js";
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
  ["release-patch-precondition",{resource:"project",repository:null,
    keys:["kind","project_id","query","snapshot_sha256"]}],
  ["release-patch-completion-precondition",{resource:"project",repository:null,
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
  if (payload.kind==="release-patch-precondition") {
    exactOwnKeys(query,["kind","control_revision","bug_id","feature_program",
      "patch_programs","programs","ledger_sha256","transition_evidence","organization","repositories","repository_configuration",
      "project"],"release patch query");
    if (query.kind!=="patch-interruption") {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release patch query kind is malformed");
    }
    contractString(query.control_revision,"release patch control revision");
    contractString(query.bug_id,"release patch bug identity");
    nestedDocument(query.feature_program,"release-program.v1","release patch feature program");
    nestedDocument(query.organization,"organization-config.v1","release patch organization");
    nestedDocument(query.repository_configuration,"repository-config.v1","release patch repository");
    exactOwnKeys(query.project,["node_id","number"],"release patch Project");
    contractString(query.project.node_id,"release patch Project identity");
    if (!Number.isSafeInteger(query.project.number) || query.project.number<1 ||
        !Array.isArray(query.patch_programs) || !Array.isArray(query.programs) ||
        !Array.isArray(query.repositories) || !/^[a-f0-9]{64}$/u.test(query.ledger_sha256) ||
        !(query.transition_evidence===null || typeof query.transition_evidence==="object")) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release patch query is malformed");
    }
    for (const program of query.programs) nestedDocument(program,"release-program.v1","release patch program");
    for (const repository of query.repositories) nestedDocument(repository,"repository-config.v1","release patch repository registry");
    for (const program of query.patch_programs) nestedDocument(program,"release-program.v1","release patch linked program");
    if (query.transition_evidence!==null) {
      exactOwnKeys(query.transition_evidence,["program_id","release_id","event","intent","receipt"],
        "release patch transition evidence");
      contractString(query.transition_evidence.program_id,"release patch transition program");
      contractString(query.transition_evidence.release_id,"release patch transition release");
      if (!(query.transition_evidence.event===null || typeof query.transition_evidence.event==="string") ||
          !(query.transition_evidence.intent===null || typeof query.transition_evidence.intent==="object") ||
          !(query.transition_evidence.receipt===null || typeof query.transition_evidence.receipt==="object")) {
        throw new CoreValidationError("Invalid core contract operation-intent.v1: release patch transition evidence is malformed");
      }
      if (query.transition_evidence.intent!==null) nestedDocument(query.transition_evidence.intent,
        "operation-intent.v1","release patch transition intent");
      if (query.transition_evidence.receipt!==null) nestedDocument(query.transition_evidence.receipt,
        "operation-receipt.v1","release patch transition receipt");
    }
    assertCanonicalIdentities(query.programs.map(value => value.program_id),"release patch program ids");
    assertCanonicalIdentities(query.patch_programs.map(value => value.program_id),"release patch linked program ids");
    const persisted=query.programs.find(value => value.program_id===query.feature_program.program_id);
    const patches=query.programs.filter(value => value.interrupts!==null);
    if (canonicalJson(persisted)!==canonicalJson(query.feature_program) ||
        canonicalJson(patches)!==canonicalJson(query.patch_programs) ||
        canonicalJson(query.repositories.map(value => value.repository))!==
          canonicalJson(query.organization.repositories) ||
        canonicalJson(query.repositories.find(value =>
          value.repository===query.repository_configuration.repository))!==
          canonicalJson(query.repository_configuration) ||
        query.repository_configuration.repository!==query.bug_id.split("#")[0] ||
        !query.feature_program.repository_releases.some(value =>
          value.repository===query.repository_configuration.repository) ||
        payload.project_id!==query.project.node_id ||
        canonicalJson(query.project)!==canonicalJson(query.organization.project)) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release patch query scope is inconsistent");
    }
    return;
  }
  if (payload.kind==="release-patch-completion-precondition") {
    exactOwnKeys(query,["kind","control_revision","control_repository","organization",
      "repositories","programs","ledger_sha256","patch_program","paused_program",
      "publication","repository_configuration","project"],"release patch completion query");
    if (query.kind!=="patch-completion") {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release patch completion query kind is malformed");
    }
    contractString(query.control_revision,"release patch completion control revision");
    contractString(query.control_repository,"release patch completion control repository");
    contractString(query.ledger_sha256,"release patch completion ledger digest",{pattern:/^[a-f0-9]{64}$/u});
    nestedDocument(query.organization,"organization-config.v1","release patch completion organization");
    nestedDocument(query.patch_program,"release-program.v1","release patch completion program");
    nestedDocument(query.paused_program,"release-program.v1","release patch completion paused program");
    nestedDocument(query.publication,"publication-evidence.v1","release patch completion publication");
    nestedDocument(query.repository_configuration,"repository-config.v1","release patch completion repository");
    if (!Array.isArray(query.repositories) || !Array.isArray(query.programs)) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release patch completion registry is malformed");
    }
    for (const repository of query.repositories) nestedDocument(repository,
      "repository-config.v1","release patch completion repository registry");
    for (const program of query.programs) nestedDocument(program,
      "release-program.v1","release patch completion program registry");
    assertCanonicalIdentities(query.repositories.map(value => value.repository),
      "release patch completion repositories");
    assertCanonicalIdentities(query.programs.map(value => value.program_id),
      "release patch completion program ids");
    exactOwnKeys(query.project,["node_id","number"],"release patch completion Project");
    if (query.patch_program.interrupts?.program_id!==query.paused_program.program_id ||
        query.publication.repository!==query.repository_configuration.repository ||
        query.control_repository!==query.organization.control_repository ||
        canonicalJson(query.project)!==canonicalJson(query.organization.project) ||
        canonicalJson(query.repositories.map(value => value.repository))!==canonicalJson(query.organization.repositories) ||
        canonicalJson(query.repositories.find(value =>
          value.repository===query.repository_configuration.repository))!==canonicalJson(query.repository_configuration) ||
        canonicalJson(query.programs.find(value =>
          value.program_id===query.patch_program.program_id))!==canonicalJson(query.patch_program) ||
        canonicalJson(query.programs.find(value =>
          value.program_id===query.paused_program.program_id))!==canonicalJson(query.paused_program) ||
        payload.project_id!==query.project.node_id) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release patch completion query scope is inconsistent");
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
  if (["release-plan-precondition","release-activation-precondition",
    "release-patch-precondition","release-patch-completion-precondition"].includes(kind)) {
    assertAggregateQuery(payload);
  }
}

function assertOperationIntentSemantics(value) {
  if (value.schema_version!=="operation-intent.v1") return;
  for (const operation of value.operations) {
    assertReleasePreconditionPayload(operation);
    if (["release-plan-precondition","release-activation-precondition",
      "release-patch-precondition","release-patch-completion-precondition"].includes(
      operation.payload?.kind)) {
      if (operation.payload.query.control_revision!==value.source.revision ||
          (["release-plan-precondition","release-patch-precondition"].includes(
            operation.payload.kind) &&
            operation.payload.query.organization.control_repository!==value.source.repository) ||
          (operation.payload.kind==="release-patch-completion-precondition" &&
            operation.payload.query.control_repository!==value.source.repository)) {
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
