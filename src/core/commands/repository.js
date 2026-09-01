import {repositoryPath} from "../control/store.js";
import {operationPreview} from "../operations/plan.js";
import {CoreBlockedError,CoreConflictError,CoreInternalError,CoreValidationError} from "../errors.js";
import {closedData,exact,ownDataFunction,requireAuthority} from "./common.js";

function canonicalRepository(value) {
  if (typeof value!=="string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) throw new CoreValidationError("Repository must be canonical OWNER/REPO");
  return value;
}

function repositoryInput(value) {
  const input=closedData(value,"repository input");
  exact(input,["default_branch","project_owner","project_number"],"repository input");
  if (typeof input.default_branch!=="string" || !/\S/u.test(input.default_branch) || typeof input.project_owner!=="string" || !/\S/u.test(input.project_owner) || !Number.isInteger(input.project_number) || input.project_number<1) throw new CoreValidationError("Repository input is malformed");
  return input;
}

function registration(value,repository) {
  const snapshot=closedData(value,"repository registration snapshot");
  exact(snapshot,["kind","source","repository","project"],"repository registration snapshot");
  exact(snapshot.source,["repository","revision","sha256"],"repository registration source");
  exact(snapshot.repository,["node_id","default_branch","revision","access","rules","project_item_id"],"repository registration repository");
  exact(snapshot.repository.access,["admin"],"repository registration access");
  exact(snapshot.repository.rules,["default_branch_protected"],"repository registration rules");
  exact(snapshot.project,["node_id","number","fields"],"repository registration project");
  exact(snapshot.project.fields,["status","gate"],"repository registration project fields");
  if (snapshot.kind!=="repository-registration" || snapshot.source.repository!==repository ||
      typeof snapshot.source.revision!=="string" || !/^[a-f0-9]{64}$/u.test(snapshot.source.sha256) || typeof snapshot.repository.node_id!=="string" || !/\S/u.test(snapshot.repository.node_id) ||
      typeof snapshot.repository.default_branch!=="string" || !/\S/u.test(snapshot.repository.default_branch) || typeof snapshot.repository.revision!=="string" || !/\S/u.test(snapshot.repository.revision) || snapshot.repository.access.admin!==true || snapshot.repository.rules.default_branch_protected!==true ||
      typeof snapshot.repository.project_item_id!=="string" || !/\S/u.test(snapshot.repository.project_item_id) || typeof snapshot.project.node_id!=="string" || !/\S/u.test(snapshot.project.node_id) || !Number.isInteger(snapshot.project.number) || snapshot.project.number<1 || typeof snapshot.project.fields.status!=="string" || !/\S/u.test(snapshot.project.fields.status) || typeof snapshot.project.fields.gate!=="string" || !/\S/u.test(snapshot.project.fields.gate)) throw new CoreValidationError("Repository registration snapshot is malformed");
  return snapshot;
}

function desiredConfig(repository,input,snapshot,clock) {
  return Object.freeze({schema_version:"repository-config.v1",repository,repository_node_id:snapshot.repository.node_id,default_branch:input.default_branch,active_release:null,project_item_id:snapshot.repository.project_item_id,project_fields:Object.freeze({status:snapshot.project.fields.status,gate:snapshot.project.fields.gate}),registered_at:clock()});
}

function sameRegistration(existing,desired) {
  return existing.repository===desired.repository && existing.repository_node_id===desired.repository_node_id && existing.default_branch===desired.default_branch && existing.active_release===desired.active_release && existing.project_item_id===desired.project_item_id && existing.project_fields.status===desired.project_fields.status && existing.project_fields.gate===desired.project_fields.gate;
}

async function add(command,services) {
  const repository=canonicalRepository(command.args[0]);
  if (command.options.from===null) throw new CoreValidationError("repo add requires --from <FILE>");
  const input=repositoryInput(await ownDataFunction(services,"readInput","services")(command.options.from));
  const registry=await ownDataFunction(services.control,"loadRegistryState","control")();
  const organization=registry.organization;
  if (organization===null) throw new CoreBlockedError("Organization initialization or reconciliation is required before repository mutation");
  if (input.project_owner!==organization.organization || input.project_number!==organization.project.number) throw new CoreValidationError("Repository input does not bind the configured organization Project");
  const snapshot=registration(await ownDataFunction(services.github,"snapshot","github")({kind:"repository-registration",repository,project:organization.project}),repository);
  if (snapshot.project.node_id!==organization.project.node_id || snapshot.project.number!==organization.project.number || snapshot.repository.default_branch!==input.default_branch) throw new CoreConflictError("Repository registration snapshot does not match the requested Project or default branch");
  const desired=desiredConfig(repository,input,snapshot,services.clock);
  const existing=registry.repositories.find(value => value.repository===repository) ?? null;
  if (existing!==null) {
    if (!sameRegistration(existing,desired)) throw new CoreConflictError("Repository identity is already registered with different node or configuration");
    return Object.freeze({status:"already-registered",repository,control_revision:registry.revision});
  }
  const pending=await ownDataFunction(services.control,"findCompletedRepositoryRegistration","control")(repository);
  if (pending!==null) {
    if (!sameRegistration(pending.configuration,desired)) throw new CoreConflictError("Completed repository registration does not match current repository snapshot");
    if (!command.options.apply || command.options.dryRun) return Object.freeze({status:"recovery-preview",repository,control_revision:registry.revision,receipt:pending.receipt,configuration:pending.configuration,preview:operationPreview(pending.intent)});
    const authority=await requireAuthority(command,services);
    await ownDataFunction(services.operations,"verifyAuthorityFor","operations")(pending.intent,authority);
    const latest=await ownDataFunction(services.control,"loadRegistryState","control")();
    const present=latest.repositories.find(value => value.repository===repository);
    if (present!==undefined) return Object.freeze({status:"already-registered",repository,control_revision:latest.revision});
    const next=Object.freeze({...latest.organization,repositories:Object.freeze([...latest.organization.repositories,repository].sort((left,right) => left===right ? 0 : left<right ? -1 : 1))});
    const recoveryPreview=Object.freeze({...operationPreview(pending.intent),receipt:pending.receipt,configuration:pending.configuration,control_revision:latest.revision,organization:next});
    if (command.interactive && await ownDataFunction(services,"confirm","services")(recoveryPreview)!==true) throw new CoreBlockedError("Interactive apply was not confirmed");
    try { const committed=await ownDataFunction(services.control,"commitConfiguration","control")({expectedHead:latest.revision,files:Object.freeze({"config/organization.yaml":next,[repositoryPath(repository)]:pending.configuration})}); return Object.freeze({status:"registered",repository,control_revision:committed.commit_sha,receipt:pending.receipt}); } catch (error) {
      if (error?.code==="CONTROL_LEDGER_CONFLICT") throw new CoreConflictError("Repository registration configuration commit conflicted",{cause:error});
      throw new CoreInternalError("Repository registration configuration commit failed",{cause:error});
    }
  }
  const authority=await requireAuthority(command,services);
  const operation=Object.freeze({resource:"repository",action:"register",repository,expected_revision:snapshot.repository.revision,payload:Object.freeze({kind:"repository-registration",repository_config:desired,access:snapshot.repository.access,rules:snapshot.repository.rules,project:snapshot.project})});
  const outcome=await ownDataFunction(services.operations,"execute","operations")({command,source:snapshot.source,operations:[operation],authority,...(command.options.apply && command.interactive ? {confirm:ownDataFunction(services,"confirm","services")} : {})});
  if (!command.options.apply || command.options.dryRun) return outcome;
  const latest=await ownDataFunction(services.control,"loadRegistryState","control")();
  const present=latest.repositories.find(value => value.repository===repository);
  if (present!==undefined) {
    if (!sameRegistration(present,desired)) throw new CoreConflictError("Repository identity is already registered with different node or configuration");
    return Object.freeze({status:"already-registered",repository,control_revision:latest.revision,receipt:outcome});
  }
  const nextOrganization=Object.freeze({...latest.organization,repositories:Object.freeze([...latest.organization.repositories,repository].sort((left,right) => left===right ? 0 : left<right ? -1 : 1))});
  let committed;
  try { committed=await ownDataFunction(services.control,"commitConfiguration","control")({expectedHead:latest.revision,files:Object.freeze({"config/organization.yaml":nextOrganization,[repositoryPath(repository)]:desired})}); } catch (error) {
    if (error?.code==="CONTROL_LEDGER_CONFLICT") throw new CoreConflictError("Repository registration configuration commit conflicted",{cause:error});
    throw new CoreInternalError("Repository registration configuration commit failed",{cause:error});
  }
  return Object.freeze({status:"registered",repository,control_revision:committed.commit_sha,receipt:outcome});
}

async function list(services) {
  const control=services.control;
  const state=await ownDataFunction(control,"loadRegistryState","control")();
  const values=closedData(state.repositories,"registered repositories"); const revision=state.revision;
  if (!Array.isArray(values)) throw new CoreValidationError("Registered repositories must be an array");
  const ordered=Object.freeze([...values].sort((left,right) => left.repository===right.repository ? 0 : left.repository<right.repository ? -1 : 1));
  const remote=closedData(await ownDataFunction(services.github,"snapshot","github")({kind:"repository-list",repositories:ordered.map(value => value.repository)}),"repository list snapshot");
  exact(remote,["kind","revisions"],"repository list snapshot");
  if (remote.kind!=="repository-list" || !Array.isArray(remote.revisions) || remote.revisions.length!==ordered.length) throw new CoreValidationError("Repository list snapshot is malformed");
  const revisions=new Map();
  for (const item of remote.revisions) {
    exact(item,["repository","revision"],"repository list revision");
    if (typeof item.repository!=="string" || !(item.revision===null || typeof item.revision==="string") || revisions.has(item.repository)) throw new CoreValidationError("Repository list snapshot has malformed revisions");
    revisions.set(item.repository,item.revision);
  }
  if (ordered.some(value => !revisions.has(value.repository))) throw new CoreValidationError("Repository list snapshot does not cover every registered repository");
  return Object.freeze({repositories:ordered,control_revision:revision,github_revisions:Object.freeze(ordered.map(value => Object.freeze({repository:value.repository,revision:revisions.get(value.repository)})))});
}

export async function runRepositoryCommand(command,services) {
  if (command.name==="repo.add") return add(command,services);
  if (command.name==="repo.list") return list(services);
  throw new CoreValidationError("Unsupported repository command");
}
