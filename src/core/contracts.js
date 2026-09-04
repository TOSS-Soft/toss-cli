import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";

import {CoreValidationError} from "./errors.js";
import {compareOperations} from "./operation-order.js";
import {parseReservedBranch} from "./domain/identity.js";
import {releaseApprovalEnvelopeSha256} from "./release/approval-envelope.js";

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
  ["release-approval-precondition",{resource:"project",repository:null,
    keys:["kind","project_id","query","snapshot_sha256","authority_binding"]}],
  ["release-approval-base-precondition",{resource:"branch",
    keys:["kind","program_id","release_id","name","head_sha","authority_binding"]}],
  ["release-publication-precondition",{resource:"repository",
    keys:["kind","query","descriptor","snapshot_sha256"]}],
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
  assertRepositoryConfigSemantics(value);
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
  if (payload.kind==="release-approval-precondition") {
    exactOwnKeys(query,["kind","control_revision","organization","programs","program","release",
      "repository_configuration","project"],"release approval query");
    if (query.kind!=="release-approval") throw new CoreValidationError("Invalid core contract operation-intent.v1: release approval query kind is malformed");
    contractString(query.control_revision,"release approval control revision");
    nestedDocument(query.organization,"organization-config.v1","release approval organization");
    nestedDocument(query.program,"release-program.v1","release approval program");
    nestedDocument(query.release,"repository-release.v1","release approval release");
    nestedDocument(query.repository_configuration,"repository-config.v1","release approval repository");
    if (!Array.isArray(query.programs)) throw new CoreValidationError("Invalid core contract operation-intent.v1: release approval programs are malformed");
    for (const program of query.programs) nestedDocument(program,"release-program.v1","release approval persisted program");
    assertCanonicalIdentities(query.programs.map(value => value.program_id),"release approval program ids");
    exactOwnKeys(query.project,["node_id","number"],"release approval Project");
    const persisted=query.programs.find(value => value.program_id===query.program.program_id);
    const selected=query.program.repository_releases.find(value => value.release_id===query.release.release_id);
    if (canonicalJson(persisted)!==canonicalJson(query.program) ||
        canonicalJson(selected)!==canonicalJson(query.release) ||
        query.release.repository!==query.repository_configuration.repository ||
        payload.project_id!==query.project.node_id ||
        canonicalJson(query.project)!==canonicalJson(query.organization.project)) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release approval query scope is inconsistent");
    }
    return;
  }
  if (payload.kind==="release-publication-precondition") {
    exactOwnKeys(query,["kind","control_revision","control_repository","organization",
      "programs","program","release","repository_configuration","project",
      "approval_evidence"],"release publication query");
    if (query.kind!=="release-publication") throw new CoreValidationError("Invalid core contract operation-intent.v1: release publication query kind is malformed");
    contractString(query.control_revision,"release publication control revision");
    contractString(query.control_repository,"release publication control repository");
    nestedDocument(query.organization,"organization-config.v1","release publication organization");
    nestedDocument(query.program,"release-program.v1","release publication program");
    nestedDocument(query.release,"repository-release.v1","release publication release");
    nestedDocument(query.repository_configuration,"repository-config.v1","release publication repository");
    if (!Array.isArray(query.programs)) throw new CoreValidationError("Invalid core contract operation-intent.v1: release publication programs are malformed");
    for (const program of query.programs) nestedDocument(program,"release-program.v1","release publication persisted program");
    assertCanonicalIdentities(query.programs.map(value => value.program_id),"release publication program ids");
    exactOwnKeys(query.project,["node_id","number"],"release publication Project");
    exactOwnKeys(query.approval_evidence,["intent","receipt"],"release publication approval evidence");
    nestedDocument(query.approval_evidence.intent,"operation-intent.v1","release publication approval intent");
    nestedDocument(query.approval_evidence.receipt,"operation-receipt.v1","release publication approval receipt");
    const persisted=query.programs.find(value => value.program_id===query.program.program_id);
    const selected=query.program.repository_releases.find(value => value.release_id===query.release.release_id);
    if (canonicalJson(persisted)!==canonicalJson(query.program) ||
        canonicalJson(selected)!==canonicalJson(query.release) ||
        query.release.repository!==query.repository_configuration.repository ||
        query.control_repository!==query.organization.control_repository ||
        canonicalJson(query.project)!==canonicalJson(query.organization.project)) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release publication query scope is inconsistent");
    }
    return;
  }
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
      "publication","repository_configuration","project","phase_evidence"],
    "release patch completion query");
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
    exactOwnKeys(query.phase_evidence,["reconciliation","review_gate"],
      "release patch completion phase evidence");
    if (Object.hasOwn(payload,"descriptor")) {
      exactOwnKeys(payload.descriptor,["observation","receipt_id","timestamp"],
        "release patch completion descriptor");
      exactOwnKeys(payload.descriptor.observation,["kind","control_revision","project","patch",
        "feature","repository","assigned_work","checks"],
      "release patch completion descriptor observation");
      contractString(payload.descriptor.receipt_id,
        "release patch completion descriptor receipt",{
          pattern:/^RECEIPT-[0-9]{8}-[0-9]{4,}$/u,
        });
      contractString(payload.descriptor.timestamp,
        "release patch completion descriptor timestamp");
    }
    for (const [phase,evidence] of Object.entries(query.phase_evidence)) {
      if (evidence===null) continue;
      exactOwnKeys(evidence,["intent","receipt"],`release patch completion ${phase} evidence`);
      nestedDocument(evidence.intent,"operation-intent.v1",
        `release patch completion ${phase} intent`);
      nestedDocument(evidence.receipt,"operation-receipt.v1",
        `release patch completion ${phase} receipt`);
    }
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
  const keys=kind==="release-patch-completion-precondition" &&
      Object.hasOwn(operation.payload,"descriptor")
    ? [...definition.keys,"descriptor"] : definition.keys;
  exactOwnKeys(operation.payload,keys,`${kind} payload`);
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
    "release-patch-precondition","release-patch-completion-precondition",
    "release-approval-precondition","release-publication-precondition"].includes(kind)) {
    assertAggregateQuery(payload);
  }
}

function assertReleaseManifestPayload(operation,source) {
  const payload=operation.payload;
  if (payload?.kind==="release-program-manifest") {
    const keys=["kind","expected_program_revision","program",
      ...(Object.hasOwn(payload,"expected_program_sha256")
        ? ["expected_program_sha256"] : []),
      ...(Object.hasOwn(payload,"authority_binding") ? ["authority_binding"] : [])];
    exactOwnKeys(payload,keys,"release-program-manifest payload");
    nestedDocument(payload.program,"release-program.v1","release program manifest");
    if (operation.resource!=="repository" || operation.action!=="commit" ||
        operation.repository!==source.repository ||
        operation.expected_revision!==payload.expected_program_revision ||
        !(payload.expected_program_revision===null ||
          /^REV-[0-9]{4,}$/u.test(payload.expected_program_revision))) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release program manifest binding is malformed");
    }
    if (Object.hasOwn(payload,"expected_program_sha256") &&
        !/^[a-f0-9]{64}$/u.test(payload.expected_program_sha256)) {
      throw new CoreValidationError(
        "Invalid core contract operation-intent.v1: release program manifest byte CAS is malformed",
      );
    }
    return;
  }
  if (payload?.kind!=="release-program-manifest-set") return;
  exactOwnKeys(payload,["kind","expected_set_sha256","resulting_set_sha256","entries"],
    "release-program-manifest-set payload");
  if (operation.resource!=="repository" || operation.action!=="commit" ||
      operation.repository!==source.repository ||
      operation.expected_revision!==payload.expected_set_sha256 ||
      !/^[a-f0-9]{64}$/u.test(payload.expected_set_sha256) ||
      !/^[a-f0-9]{64}$/u.test(payload.resulting_set_sha256) ||
      !Array.isArray(payload.entries) || payload.entries.length===0) {
    throw new CoreValidationError("Invalid core contract operation-intent.v1: release program manifest-set binding is malformed");
  }
  const programs=[];
  let additions=0;
  let previous=null;
  for (const entry of payload.entries) {
    exactOwnKeys(entry,["program_id","expected_program_revision","program"],
      "release-program-manifest-set entry");
    nestedDocument(entry.program,"release-program.v1","release program manifest-set entry");
    if (entry.program_id!==entry.program.program_id ||
        (previous!==null && previous>=entry.program_id) ||
        !(entry.expected_program_revision===null ||
          /^REV-[0-9]{4,}$/u.test(entry.expected_program_revision)) ||
        (entry.expected_program_revision===null && entry.program.revision!=="REV-0001")) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release program manifest-set entry binding is malformed");
    }
    previous=entry.program_id;
    if (entry.expected_program_revision===null) additions+=1;
    programs.push(entry.program);
  }
  if (additions!==1 || payload.resulting_set_sha256!==sha256Canonical(programs)) {
    throw new CoreValidationError("Invalid core contract operation-intent.v1: release program manifest-set resulting digest is inconsistent");
  }
}

function assertApprovalAuthorityBinding(binding) {
  exactOwnKeys(binding,["program_id","release_id","manifest_revision","manifest_sha256",
    "pull_request","review","checks","rules_revision","version","policy_revision",
    "publication","scope","repository","project","workflow","operation_intent_sha256"],
  "release approval authority binding");
  exactOwnKeys(binding.pull_request,["number","revision","head","head_sha","base","base_sha",
    "base_revision"],"release approval authority pull request");
  exactOwnKeys(binding.review,["revision","result","formal_review","implementation_identity"],
    "release approval authority review");
  exactOwnKeys(binding.repository,["node_id","revision"],"release approval authority repository");
  exactOwnKeys(binding.project,["node_id","revision"],"release approval authority Project");
  exactOwnKeys(binding.workflow,["name","revision"],"release approval authority workflow");
  contractString(binding.operation_intent_sha256,
    "release approval authority operation intent digest",{pattern:/^[a-f0-9]{64}$/u});
}

function assertReleaseApprovalOperation(operation) {
  const kind=operation.payload?.kind;
  if (kind==="release-approval-base-precondition") {
    const binding=operation.payload.authority_binding;
    if (operation.expected_revision!==binding?.pull_request?.base_revision ||
        operation.payload.name!==binding.pull_request.base ||
        operation.payload.head_sha!==binding.pull_request.base_sha ||
        operation.payload.program_id!==binding.program_id ||
        operation.payload.release_id!==binding.release_id) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release approval base binding is malformed");
    }
  } else if (kind==="release-pull-request-merge") {
    exactOwnKeys(operation.payload,["kind","program_id","release_id","number","head_branch",
      "head_sha","base_branch","base_sha","base_revision","merge_mode",
      "merge_result_revision","authority_binding"],`${kind} payload`);
    if (operation.resource!=="pull_request" || operation.action!=="merge" ||
        typeof operation.repository!=="string" ||
        operation.expected_revision!==operation.payload.authority_binding?.pull_request?.revision ||
        operation.payload.merge_mode!=="FAST_FORWARD_ONLY" ||
        operation.payload.merge_result_revision!==operation.payload.head_sha ||
        operation.payload.base_sha!==operation.payload.authority_binding.pull_request.base_sha ||
        operation.payload.base_revision!==operation.payload.authority_binding.pull_request.base_revision) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release pull request merge binding is malformed");
    }
  } else if (kind==="release-publication-workflow") {
    exactOwnKeys(operation.payload,["kind","program_id","release_id","workflow","version","tag",
      "expected_revision","authority_binding"],`${kind} payload`);
    if (operation.resource!=="workflow" || operation.action!=="create" ||
        typeof operation.repository!=="string" ||
        operation.expected_revision!==operation.payload.authority_binding?.workflow?.revision ||
        operation.payload.workflow!==operation.payload.authority_binding.workflow.name ||
        operation.payload.expected_revision!==operation.payload.authority_binding.pull_request.head_sha ||
        operation.payload.tag!==`v${operation.payload.version}`) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release publication workflow binding is malformed");
    }
  } else {
    return;
  }
  assertApprovalAuthorityBinding(operation.payload.authority_binding);
}

function assertOperationIntentSemantics(value) {
  if (value.schema_version!=="operation-intent.v1") return;
  for (const operation of value.operations) {
    assertReleasePreconditionPayload(operation);
    assertReleaseManifestPayload(operation,value.source);
    assertReleaseApprovalOperation(operation);
    if (["release-plan-precondition","release-activation-precondition",
      "release-patch-precondition","release-patch-completion-precondition",
      "release-approval-precondition","release-publication-precondition"].includes(
      operation.payload?.kind)) {
      if (operation.payload.query.control_revision!==value.source.revision ||
          (["release-plan-precondition","release-patch-precondition","release-approval-precondition"].includes(
            operation.payload.kind) &&
            operation.payload.query.organization.control_repository!==value.source.repository) ||
          (["release-patch-completion-precondition","release-publication-precondition"].includes(operation.payload.kind) &&
            operation.payload.query.control_repository!==value.source.repository)) {
        throw new CoreValidationError("Invalid core contract operation-intent.v1: aggregate query does not bind the immutable intent source");
      }
    }
  }
  const approvalKinds=["release-approval-precondition","release-approval-base-precondition",
    "release-pull-request-merge",
    "release-publication-workflow","release-program-manifest"];
  if (value.operations.some(operation => operation.payload?.kind==="release-approval-precondition")) {
    if (value.authority===null || value.operations.length!==approvalKinds.length ||
        approvalKinds.some(kind => value.operations.filter(operation =>
          operation.payload?.kind===kind).length!==1)) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release approval must be one exact authority-backed transaction");
    }
    const bindings=value.operations.map(operation => operation.payload?.authority_binding);
    if (bindings.some(binding => binding===undefined) || bindings.some(binding =>
      canonicalJson(binding)!==canonicalJson(bindings[0]))) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release approval operations must share one exact authority binding");
    }
    assertApprovalAuthorityBinding(bindings[0]);
    const binding=bindings[0];
    const aggregate=value.operations.find(operation =>
      operation.payload?.kind==="release-approval-precondition");
    const base=value.operations.find(operation =>
      operation.payload?.kind==="release-approval-base-precondition");
    const merge=value.operations.find(operation =>
      operation.payload?.kind==="release-pull-request-merge");
    const workflow=value.operations.find(operation =>
      operation.payload?.kind==="release-publication-workflow");
    const manifest=value.operations.find(operation =>
      operation.payload?.kind==="release-program-manifest");
    const approved=manifest?.payload.program.repository_releases.find(release =>
      release.program_id===binding.program_id &&
      release.release_id===binding.release_id) ?? null;
    const query=aggregate.payload.query;
    const sourceRelease=query.release;
    const approval=approved?.approval ?? null;
    const scopeIds=binding.scope.map(item => item?.id);
    if (approval===null || canonicalJson(approval.authority)!==canonicalJson(value.authority) ||
        value.command!=="release.approve" || value.policy_revision!==binding.policy_revision ||
        value.planned_receipt_id!==approval.source_receipt ||
        query.program.program_id!==binding.program_id ||
        sourceRelease.program_id!==binding.program_id || sourceRelease.release_id!==binding.release_id ||
        sourceRelease.repository!==merge.repository || sourceRelease.repository!==workflow.repository ||
        sourceRelease.repository!==base.repository || sourceRelease.version!==binding.version ||
        query.program.revision!==binding.manifest_revision ||
        sha256Canonical(query.program)!==binding.manifest_sha256 ||
        query.repository_configuration.repository_node_id!==binding.repository.node_id ||
        canonicalJson(query.repository_configuration.publication)!==canonicalJson(binding.publication) ||
        canonicalJson(query.project)!==canonicalJson({node_id:binding.project.node_id,
          number:query.project.number}) || aggregate.expected_revision!==binding.project.revision ||
        canonicalJson(scopeIds)!==canonicalJson(sourceRelease.scope) ||
        manifest.expected_revision!==binding.manifest_revision ||
        manifest.payload.expected_program_revision!==binding.manifest_revision ||
        manifest.payload.program.program_id!==binding.program_id ||
        manifest.payload.program.phase!=="PUBLISHING" || approved.phase!=="PUBLISHING" ||
        merge.payload.program_id!==binding.program_id || merge.payload.release_id!==binding.release_id ||
        merge.repository!==sourceRelease.repository ||
        workflow.payload.program_id!==binding.program_id ||
        workflow.payload.release_id!==binding.release_id || workflow.repository!==sourceRelease.repository ||
        workflow.payload.version!==binding.version || workflow.payload.tag!==`v${binding.version}` ||
        base.payload.program_id!==binding.program_id || base.payload.release_id!==binding.release_id ||
        base.repository!==sourceRelease.repository ||
        canonicalJson(approval.pull_request)!==canonicalJson(binding.pull_request) ||
        canonicalJson(approval.review)!==canonicalJson(binding.review) ||
        canonicalJson(approval.scope)!==canonicalJson(binding.scope) ||
        canonicalJson(approval.checks)!==canonicalJson(binding.checks) ||
        canonicalJson(approval.required_checks)!==
          canonicalJson(binding.checks.map(check => check.name)) ||
        approval.rules_revision!==binding.rules_revision ||
        approval.policy_revision!==binding.policy_revision ||
        canonicalJson(approval.publication)!==canonicalJson(binding.publication) ||
        approval.manifest_revision!==binding.manifest_revision ||
        approval.manifest_sha256!==binding.manifest_sha256 ||
        approval.merge_result_revision!==binding.pull_request.head_sha) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release approval transaction identities are inconsistent");
    }
    if (binding.operation_intent_sha256!==releaseApprovalEnvelopeSha256({
      command:value.command,policy_revision:value.policy_revision,source:value.source,
      operations:value.operations,
    })) {
      throw new CoreValidationError("Invalid core contract operation-intent.v1: release approval operation envelope digest is inconsistent");
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

function assertRepositoryConfigSemantics(value) {
  if (!value || value.schema_version!=="repository-config.v1") return;
  const publication=value.publication;
  if (!publication || publication.package_name.trim()!==publication.package_name ||
      publication.workflow.trim()!==publication.workflow ||
      publication.required_assets.some(asset => asset.trim()!==asset)) {
    throw new CoreValidationError("Invalid core contract repository-config.v1: publication identities must be canonical nonblank strings");
  }
  assertCanonicalIdentities(publication.required_assets,
    "repository publication required asset identities");
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
  assertRepositoryConfigSemantics(value);
  assertOperationIntentSemantics(value);
  assertUniqueOperationIds(value);
  assertCanonicalOperationOrder(value);
  return value;
}
