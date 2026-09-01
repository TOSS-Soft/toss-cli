import {sha256Canonical} from "../../contracts/acp.js";
import {authorityReference} from "../authority.js";
import {validateCoreDocument} from "../contracts.js";
import {CoreBlockedError,CoreConflictError,CoreRemoteError,CoreValidationError} from "../errors.js";
import {createOperationIntent,operationPreview} from "../operations/plan.js";
import {intentPath,receiptPath} from "../control/store.js";
import {closedData,exact,ownDataFunction,requireAuthority} from "./common.js";

export const DEFAULT_CONTROL_REPOSITORY="TOSS-Soft/toss-os-control";

function bootstrap(value) {
  const snapshot=closedData(value,"bootstrap snapshot");
  exact(snapshot,["kind","source","control_repository","organization"],"bootstrap snapshot");
  exact(snapshot.source,["repository","revision","sha256"],"bootstrap source");
  exact(snapshot.control_repository,["exists","revision"],"bootstrap control repository");
  exact(snapshot.organization,["organization","project","policy_revision","lifecycle_policy","release_policy"],"bootstrap organization");
  exact(snapshot.organization.project,["node_id","number"],"bootstrap project");
  if (snapshot.kind!=="bootstrap" || snapshot.source.repository!==DEFAULT_CONTROL_REPOSITORY ||
      typeof snapshot.source.revision!=="string" || !/^[a-f0-9]{64}$/u.test(snapshot.source.sha256) ||
      typeof snapshot.control_repository.exists!=="boolean" ||
      !(snapshot.control_repository.revision===null || typeof snapshot.control_repository.revision==="string") ||
      typeof snapshot.organization.organization!=="string" || !snapshot.organization.organization ||
      typeof snapshot.organization.project.node_id!=="string" || !Number.isInteger(snapshot.organization.project.number) || snapshot.organization.project.number<1 ||
      typeof snapshot.organization.policy_revision!=="string" ||
      snapshot.control_repository.exists!==(snapshot.control_repository.revision!==null) ||
      snapshot.organization.lifecycle_policy?.revision!==snapshot.organization.policy_revision ||
      snapshot.organization.release_policy?.revision!==snapshot.organization.policy_revision) throw new CoreValidationError("Bootstrap snapshot is malformed");
  return snapshot;
}

function operationsFor(snapshot) {
  const revision=snapshot.control_repository.revision;
  const repository=DEFAULT_CONTROL_REPOSITORY;
  const project=snapshot.organization.project;
  return Object.freeze([
    {resource:"repository",action:"create",repository,expected_revision:revision,payload:{kind:"create-private-control-repository",private:true}},
    {resource:"repository",action:"update",repository,expected_revision:revision,payload:{kind:"verify-default-branch-protection"}},
    {resource:"project",action:"update",repository:null,expected_revision:null,payload:{kind:"discover-project-fields",project}},
    {resource:"repository",action:"commit",repository,expected_revision:revision,payload:{kind:"organization-config"}},
    {resource:"repository",action:"commit",repository,expected_revision:revision,payload:{kind:"lifecycle-policy"}},
    {resource:"repository",action:"commit",repository,expected_revision:revision,payload:{kind:"release-policy"}},
    {resource:"repository",action:"commit",repository,expected_revision:revision,payload:{kind:"first-control-transaction"}},
  ]);
}

function configurationFiles(snapshot,intent,receipt) {
  const organization=Object.freeze({schema_version:"organization-config.v1",organization:snapshot.organization.organization,project:snapshot.organization.project,control_repository:DEFAULT_CONTROL_REPOSITORY,policy_revision:snapshot.organization.policy_revision,repositories:[]});
  validateCoreDocument(organization,"organization-config.v1");
  return Object.freeze({
    "config/organization.yaml":organization,
    "policies/lifecycle.yaml":snapshot.organization.lifecycle_policy,
    "policies/release.yaml":snapshot.organization.release_policy,
    [intentPath(intent)]:intent,
    [receiptPath(receipt)]:receipt,
  });
}

function completedReceipt(intent,id,createdAt,observed_revisions) {
  const receipt=Object.freeze({schema_version:"operation-receipt.v1",document_type:"operation-receipt",receipt_id:id,intent_id:intent.intent_id,intent_sha256:sha256Canonical(intent),created_at:createdAt,status:"completed",observed_revisions});
  validateCoreDocument(receipt,"operation-receipt.v1");
  return receipt;
}

function exactObservations(value,operations,label,{matchExpected}={}) {
  const observations=closedData(value,label);
  if (!Array.isArray(observations) || observations.length!==operations.length) throw new CoreConflictError(`${label} is incomplete`);
  const byId=new Map();
  for (const observation of observations) {
    exact(observation,["operation_id","repository","revision"],label);
    if (typeof observation.operation_id!=="string" || !(observation.repository===null || typeof observation.repository==="string") || !(observation.revision===null || typeof observation.revision==="string") || byId.has(observation.operation_id)) throw new CoreConflictError(`${label} is malformed`);
    byId.set(observation.operation_id,observation);
  }
  for (const operation of operations) {
    const observation=byId.get(operation.operation_id);
    if (!observation || observation.repository!==operation.repository || (matchExpected && observation.revision!==operation.expected_revision)) throw new CoreConflictError(`${label} is stale`);
  }
  return observations;
}

export async function runInitCommand(command,services) {
  const snapshot=bootstrap(await ownDataFunction(services.github,"snapshot","github")({kind:"bootstrap",repository:DEFAULT_CONTROL_REPOSITORY}));
  const head=await ownDataFunction(services.control,"head","control")();
  const loadOrganization=ownDataFunction(services.control,"loadOrganization","control");
  if (snapshot.control_repository.exists) {
    const organization=await loadOrganization();
    if (head===null || organization===null) throw new CoreBlockedError("Initialization is incomplete; reconciliation is required");
    const bootstrapState=await ownDataFunction(services.control,"loadBootstrapState","control")();
    if (bootstrapState===null) throw new CoreConflictError("Existing control repository has no immutable bootstrap transaction");
    if (organization.control_repository!==DEFAULT_CONTROL_REPOSITORY || organization.organization!==snapshot.organization.organization || organization.policy_revision!==snapshot.organization.policy_revision) {
      throw new CoreConflictError("Existing control repository does not match the desired bootstrap configuration");
    }
    const created=bootstrapState.intent.operations.find(operation => operation.payload?.kind==="create-private-control-repository");
    const observed=bootstrapState.receipt.observed_revisions.filter(item => item.operation_id===created?.operation_id && item.repository===DEFAULT_CONTROL_REPOSITORY);
    if (observed.length!==1 || observed[0].revision!==snapshot.control_repository.revision) throw new CoreConflictError("Existing control repository revision does not match the bootstrap receipt");
    return Object.freeze({status:"already-initialized",control_revision:head,source_revision:snapshot.source.revision});
  }
  if (head!==null || await loadOrganization()!==null) throw new CoreConflictError("Control repository already has a divergent local revision");
  const authority=await requireAuthority(command,services);
  const intent=createOperationIntent({intent_id:services.idGenerator("intent"),created_at:services.clock(),command:"init",policy_revision:snapshot.organization.policy_revision,source:snapshot.source,authority:authority===null ? null : authorityReference(authority),operations:operationsFor(snapshot)});
  const preview=operationPreview(intent);
  if (!command.options.apply || command.options.dryRun) return preview;
  if (typeof services.operations.verifyAuthorityFor!=="function") throw new CoreValidationError("Operation runner does not expose bootstrap authority verification");
  await services.operations.verifyAuthorityFor(intent,authority);
  const inspect=ownDataFunction(services.github,"inspect","github");
  const apply=ownDataFunction(services.github,"apply","github");
  const remoteOperations=intent.operations.filter(operation => !["organization-config","lifecycle-policy","release-policy","first-control-transaction"].includes(operation.payload.kind));
  const current=exactObservations(await inspect(remoteOperations),remoteOperations,"Bootstrap inspection",{matchExpected:true});
  let result;
  try { result=await apply(remoteOperations,{idempotencyKey:preview.intent_sha256}); } catch (error) { throw new CoreRemoteError("Bootstrap remote creation failed",{cause:error}); }
  const completed=closedData(result,"bootstrap apply result");
  exact(completed,["status","observed_revisions"],"bootstrap apply result");
  if (completed.status!=="completed") throw new CoreRemoteError("Bootstrap remote creation did not complete");
  let observations;
  try { observations=exactObservations(completed.observed_revisions,remoteOperations,"Bootstrap apply observation"); } catch (error) { throw new CoreRemoteError("Bootstrap remote creation did not return exact observations",{cause:error}); }
  void current;
  const receipt=completedReceipt(intent,services.idGenerator("receipt"),services.clock(),observations);
  try {
    return Object.freeze({status:"completed",control_revision:(await ownDataFunction(services.control,"commitBootstrap","control")({expectedHead:null,files:configurationFiles(snapshot,intent,receipt)})).commit_sha,preview});
  } catch (error) {
    throw new CoreBlockedError("Bootstrap remote repository exists but local initialization is incomplete; reconciliation is required",{cause:error});
  }
}
