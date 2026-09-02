import {canonicalJson} from "../../contracts/acp.js";
import {parseWorkItemId} from "../domain/identity.js";
import {CoreConflictError,CoreValidationError} from "../errors.js";
import {epicPreparationOperations,normalizeEpicPlan} from "../work/epic-plan.js";
import {dependencyGraphResult,workStatusResult} from "../work/operations.js";
import {closedData,exact,ownDataFunction,ownDataValue,requireAuthority} from "./common.js";

function preparedWork(work) {
  const next=structuredClone(work);
  next.prepared=true;
  next.scope_approved=false;
  next.item.status="Backlog";
  next.item.gate="EPIC_APPROVAL_REQUIRED";
  next.project.fields.Status="Backlog";
  next.project.fields.Gate="EPIC_APPROVAL_REQUIRED";
  return closedData(next,"prepared epic work");
}

function approvedWork(work) {
  const next=structuredClone(work);
  next.prepared=true;
  next.scope_approved=true;
  next.item.status="Backlog";
  next.item.gate="RELEASE_PLANNING";
  next.item.milestone=null;
  next.item.base_branch=null;
  next.release={assigned:false,active:false,id:null,repository:null,branch:null,milestone:null,revision:null};
  next.project.fields.Status="Backlog";
  next.project.fields.Gate="RELEASE_PLANNING";
  next.project.fields.base_branch=null;
  return closedData(next,"approved epic work");
}

function acceptedWork(work,headSha) {
  const next=structuredClone(work);
  next.issue_state="CLOSED";
  next.item.status="Done";
  next.item.gate="NONE";
  next.pull_request={state:"MERGED",head_sha:headSha,merged_sha:headSha};
  next.project.fields.Status="Done";
  next.project.fields.Gate="NONE";
  return closedData(next,"accepted epic work");
}

function assertEpic(snapshot,id,label) {
  const work=closedData(snapshot.epic,label);
  if (work.item?.id!==id || work.item?.kind!=="epic") throw new CoreValidationError(`${label} does not bind the requested epic`);
  return work;
}

function dependencyPreparationOperations(plan,snapshot) {
  const graph=dependencyGraphResult(snapshot,null).graph;
  const activeById=new Map(snapshot.edges.map(edge => [edge.edge_id,edge]));
  const relationships=new Map(snapshot.relationships.map(edge => [edge.edge_id,edge]));
  const tombstones=new Map(snapshot.tombstones.map(edge => [edge.edge_id,edge]));
  const desiredIds=new Set(plan.edges.map(edge => edge.edge_id));
  const governedChildren=new Set(plan.children.map(child => child.id));
  for (const edge of graph.edges) {
    if (governedChildren.has(edge.source) && !desiredIds.has(edge.edge_id)) {
      throw new CoreConflictError(`Prepared epic plan would drop governed dependency ${edge.edge_id}`);
    }
  }
  const operations=[];
  for (const edge of plan.edges) {
    if (tombstones.has(edge.edge_id)) {
      throw new CoreConflictError(`Prepared epic plan conflicts with removed dependency ${edge.edge_id}`);
    }
    const active=activeById.get(edge.edge_id);
    const relationship=relationships.get(edge.edge_id);
    const desiredRelationship={edge_id:edge.edge_id,source:edge.source,target:edge.target,revision:edge.revision};
    if (active || relationship) {
      if (canonicalJson(active)!==canonicalJson(edge) ||
          canonicalJson(relationship)!==canonicalJson(desiredRelationship)) {
        throw new CoreConflictError(`Prepared epic dependency ${edge.edge_id} conflicts with native evidence`);
      }
      continue;
    }
    operations.push(Object.freeze({
      resource:"issue",action:"update",repository:parseWorkItemId(edge.source).repository,
      expected_revision:snapshot.revision,
      payload:Object.freeze({kind:"dependency-add",edge,relationship:Object.freeze(desiredRelationship)}),
    }));
  }
  return operations;
}

function storedPlan(input) {
  const normalized=normalizeEpicPlan({
    plan_id:input.plan_id,created_at:input.created_at,source:input.source,
    epic:input.epic,children:input.children,dependencies:input.edges,
  });
  if (canonicalJson(normalized)!==canonicalJson(input)) {
    throw new CoreConflictError("Stored epic plan hash or canonical content has drifted");
  }
  return normalized;
}

function immutableChild(item) {
  return {
    schema_version:item.schema_version,id:item.id,repository:item.repository,
    issue_number:item.issue_number,kind:item.kind,parent_id:item.parent_id,
    acceptance_criteria:item.acceptance_criteria,branch:item.branch,base_branch:item.base_branch,
  };
}

function assertApprovedScope(snapshot,work,services,{complete}) {
  const plan=storedPlan(snapshot.plan);
  const approval=snapshot.epic_approval;
  const children=[...snapshot.children].sort((left,right) => left.id.localeCompare(right.id));
  const edges=[...snapshot.edges].sort((left,right) => left.edge_id.localeCompare(right.edge_id));
  if (!approval || work.scope_approved!==true || plan.epic.id!==work.item.id ||
      approval.epic?.id!==work.item.id ||
      canonicalJson(approval.plan)!==canonicalJson({plan_id:plan.plan_id,content_sha256:plan.content_sha256}) ||
      canonicalJson(approval.children?.map(value => value.id))!==canonicalJson(plan.children.map(value => value.id)) ||
      canonicalJson(approval.edges)!==canonicalJson(plan.edges.map(value => ({edge_id:value.edge_id,revision:value.revision}))) ||
      approval.project?.id!==snapshot.project.id ||
      approval.policy_revision!==ownDataFunction(services,"policyRevision","services")() ||
      children.length!==plan.children.length || edges.length!==plan.edges.length) {
    throw new CoreConflictError("Epic scope no longer matches its exact approval");
  }
  for (let index=0;index<plan.children.length;index+=1) {
    const planned=plan.children[index]; const observed=children[index];
    exact(observed,["id","state","revision","item","native_parent_id","project_id","projected"],"approved epic child evidence");
    if (observed.id!==planned.id || canonicalJson(immutableChild(observed.item))!==canonicalJson(immutableChild(planned)) ||
        observed.native_parent_id!==work.item.id || observed.project_id!==snapshot.project.id ||
        observed.projected!==true || (complete && observed.state!=="CLOSED")) {
      throw new CoreConflictError("Epic child evidence no longer matches approved scope");
    }
  }
  for (let index=0;index<plan.edges.length;index+=1) {
    const planned=plan.edges[index]; const observed=edges[index];
    exact(observed,["edge_id","revision","edge","relationship","target_state"],"approved epic dependency evidence");
    const relationship={edge_id:planned.edge_id,source:planned.source,target:planned.target,revision:planned.revision};
    if (observed.edge_id!==planned.edge_id || observed.revision!==planned.revision ||
        canonicalJson(observed.edge)!==canonicalJson(planned) ||
        canonicalJson(observed.relationship)!==canonicalJson(relationship) ||
        (complete && observed.target_state!=="CLOSED")) {
      throw new CoreConflictError("Epic dependency evidence no longer matches approved scope");
    }
  }
  return {plan,children,edges,approval};
}

async function prepare(command,services) {
  if (command.options.authority!==null) throw new CoreValidationError("epic prepare does not accept authority");
  if (command.options.from===null) throw new CoreValidationError("epic prepare requires --from <FILE>");
  const id=command.args[0]; parseWorkItemId(id);
  const plan=normalizeEpicPlan(await ownDataFunction(services,"readInput","services")(command.options.from));
  if (plan.epic.id!==id) throw new CoreValidationError("Epic plan does not bind the requested epic");
  const github=ownDataValue(services,"github","services");
  const snapshot=closedData(await ownDataFunction(github,"snapshot","github")({kind:"epic-prepare",id}),"epic preparation snapshot");
  exact(snapshot,["kind","source","epic","epic_plan","epic_approval","preparation","dependency"],"epic preparation snapshot");
  if (snapshot.kind!=="epic-prepare") throw new CoreValidationError("Epic preparation snapshot kind is invalid");
  const work=assertEpic(snapshot,id,"epic preparation snapshot");
  const childOperations=epicPreparationOperations(plan,snapshot.preparation);
  const dependencyOperations=dependencyPreparationOperations(plan,snapshot.dependency);
  const desiredWork=preparedWork(work);
  if (snapshot.epic_approval!==null) {
    if (canonicalJson(snapshot.epic_plan)!==canonicalJson(plan) ||
        childOperations.length!==0 || dependencyOperations.length!==0) {
      throw new CoreConflictError("Approved epic scope cannot be replaced or reconciled by prepare");
    }
    return closedData({status:"already-reconciled",plan},"approved epic preparation replay result");
  }
  if (childOperations.length===0 && dependencyOperations.length===0 &&
      canonicalJson(snapshot.epic_plan)===canonicalJson(plan) &&
      canonicalJson(work)===canonicalJson(desiredWork)) {
    return closedData({status:"already-reconciled",plan},"epic preparation replay result");
  }
  const operations=[...childOperations,...dependencyOperations,Object.freeze({
    resource:"issue",action:"update",repository:plan.epic.repository,expected_revision:snapshot.preparation.revision,
    payload:Object.freeze({kind:"epic-prepare",plan,work:desiredWork}),
  }),Object.freeze({
    resource:"project",action:"update",repository:plan.epic.repository,
    expected_revision:work.project.revision,
    payload:Object.freeze({kind:"work-state",project_id:work.project.project_id,
      item_id:work.project.item_id,fields:Object.freeze(desiredWork.project.fields)}),
  })];
  return ownDataFunction(ownDataValue(services,"operations","services"),"execute","operations")({command,source:snapshot.source,operations,authority:null});
}

async function approve(command,services) {
  if (command.options.from!==null) throw new CoreValidationError("epic approve does not consume a plan file");
  const id=command.args[0]; parseWorkItemId(id);
  const authority=await requireAuthority(command,services);
  const github=ownDataValue(services,"github","services");
  const snapshot=closedData(await ownDataFunction(github,"snapshot","github")({kind:"epic-approval",id}),"epic approval snapshot");
  exact(snapshot,["kind","source","epic","epic_revision","plan","epic_approval","children","edges","project"],"epic approval snapshot");
  if (snapshot.kind!=="epic-approval" || typeof snapshot.epic_revision!=="string") throw new CoreValidationError("Epic approval snapshot is invalid");
  const work=assertEpic(snapshot,id,"epic approval snapshot");
  const plan=storedPlan(snapshot.plan);
  if (plan.epic.id!==id) throw new CoreValidationError("Stored epic plan does not bind requested epic");
  const children=[...snapshot.children].sort((a,b) => a.id.localeCompare(b.id));
  const edges=[...snapshot.edges].sort((a,b) => a.edge_id.localeCompare(b.edge_id));
  const policyRevision=ownDataFunction(services,"policyRevision","services")();
  const planBinding=Object.freeze({plan_id:plan.plan_id,content_sha256:plan.content_sha256});
  if (snapshot.epic_approval!==null) {
    const stored=snapshot.epic_approval;
    if (stored.epic?.id!==id || canonicalJson(stored.plan)!==canonicalJson(planBinding) ||
        canonicalJson(stored.children?.map(value => value.id))!==canonicalJson(children.map(value => value.id)) ||
        canonicalJson(stored.edges)!==canonicalJson(edges) ||
        stored.project?.id!==snapshot.project.id || stored.policy_revision!==policyRevision ||
        work.prepared!==true || work.scope_approved!==true) {
      throw new CoreConflictError("Stored epic approval conflicts with the current prepared scope");
    }
    return closedData({status:"already-reconciled",approval:stored},"epic approval replay result");
  }
  const authority_binding=Object.freeze({epic:Object.freeze({id,revision:snapshot.epic_revision}),plan:planBinding,children:Object.freeze(children),edges:Object.freeze(edges),project:Object.freeze(snapshot.project),policy_revision:policyRevision});
  const nextWork=approvedWork(work);
  const operations=[
    Object.freeze({resource:"issue",action:"update",repository:plan.epic.repository,expected_revision:snapshot.epic_revision,payload:Object.freeze({kind:"epic-approve",authority_binding,plan,work:nextWork})}),
    Object.freeze({resource:"project",action:"update",repository:plan.epic.repository,expected_revision:snapshot.project.revision,payload:Object.freeze({kind:"work-state",project_id:snapshot.project.id,item_id:work.project.item_id,fields:Object.freeze(nextWork.project.fields)})}),
  ];
  return ownDataFunction(ownDataValue(services,"operations","services"),"execute","operations")({command,source:snapshot.source,operations,authority});
}

async function submit(command,services) {
  if (command.options.from!==null || command.options.authority!==null) throw new CoreValidationError("epic submit does not consume plan input or authority");
  const id=command.args[0]; parseWorkItemId(id);
  const snapshot=closedData(await ownDataFunction(ownDataValue(services,"github","services"),"snapshot","github")({kind:"epic-submit",id}),"epic submit snapshot");
  exact(snapshot,["kind","source","epic","epic_revision","plan","epic_approval","children","edges","release","branch","pull_request","project"],"epic submit snapshot");
  const work=assertEpic(snapshot,id,"epic submit snapshot");
  if (snapshot.kind!=="epic-submit" || !Array.isArray(snapshot.children) || !Array.isArray(snapshot.edges)) throw new CoreValidationError("Epic submit snapshot is invalid");
  assertApprovedScope(snapshot,work,services,{complete:true});
  const release=snapshot.release;
  if (!release?.active || !release.assigned || release.repository!==work.item.repository || release.id!==`${release.repository}@${release.branch}` || work.item.base_branch!==release.branch || snapshot.branch?.base_branch!==release.branch || snapshot.branch?.name!==work.item.branch) throw new CoreValidationError("Epic submit requires the active same-repository release branch");
  const pull=snapshot.pull_request;
  if (pull!==null && (pull.work_item_id!==id || pull.head_repository!==work.item.repository ||
      pull.base_repository!==work.item.repository || pull.head!==work.item.branch || pull.base!==release.branch)) {
    throw new CoreConflictError("Existing epic pull request conflicts with approved release scope");
  }
  if (pull!==null && pull.head_sha===snapshot.branch.head_sha && pull.state==="READY") {
    return closedData({status:"already-reconciled",pull_request:pull},"epic submit replay result");
  }
  const operation=Object.freeze({resource:"pull_request",action:pull===null ? "create" : "update",repository:work.item.repository,expected_revision:pull?.revision ?? snapshot.source.revision,payload:Object.freeze({kind:"work-pull-request",work_item_id:id,head:work.item.branch,base:release.branch,head_sha:snapshot.branch.head_sha,draft:false})});
  return ownDataFunction(ownDataValue(services,"operations","services"),"execute","operations")({command,source:snapshot.source,operations:[operation],authority:null});
}

async function accept(command,services) {
  if (command.options.from!==null) throw new CoreValidationError("epic accept does not consume a plan file");
  const id=command.args[0]; parseWorkItemId(id);
  const authority=await requireAuthority(command,services);
  const snapshot=closedData(await ownDataFunction(ownDataValue(services,"github","services"),"snapshot","github")({kind:"epic-accept",id}),"epic acceptance snapshot");
  exact(snapshot,["kind","source","epic","epic_revision","plan","epic_approval","children","edges","release","pull_request","review","checks","project"],"epic acceptance snapshot");
  const work=assertEpic(snapshot,id,"epic acceptance snapshot");
  if (snapshot.kind!=="epic-accept" || !Array.isArray(snapshot.children) || !Array.isArray(snapshot.edges)) throw new CoreValidationError("Epic acceptance snapshot is invalid");
  const scope=assertApprovedScope(snapshot,work,services,{complete:true});
  const pull=snapshot.pull_request; const review=snapshot.review; const checks=snapshot.checks;
  if (pull?.state==="MERGED" && pull.merged_sha===pull.head_sha && work.issue_state==="CLOSED" &&
      work.project.fields.Status==="Done" && work.project.fields.Gate==="NONE") {
    return closedData({status:"already-reconciled",pull_request:pull},"epic acceptance replay result");
  }
  const release=snapshot.release;
  if (!release?.active || !release.assigned || release.repository!==work.item.repository ||
      release.id!==`${release.repository}@${release.branch}` || work.item.base_branch!==release.branch ||
      !pull || pull.head_repository!==work.item.repository || pull.base_repository!==work.item.repository ||
      pull.head!==work.item.branch || pull.base!==release.branch || pull.state!=="READY" ||
      !review || review.reviewed_revision!==pull.head_sha || review.verdict!=="APPROVED" ||
      review.independent!==true || review.formal!==true || !checks || checks.state!=="PASSED" ||
      checks.revision!==pull.head_sha) {
    throw new CoreValidationError("Epic acceptance requires current independent approval and passed checks at the exact pull request head");
  }
  const authority_binding=Object.freeze({
    epic:Object.freeze({id,revision:snapshot.epic_revision}),
    plan:Object.freeze({plan_id:scope.plan.plan_id,content_sha256:scope.plan.content_sha256}),
    children:Object.freeze(scope.children.map(value => Object.freeze({id:value.id,revision:value.revision}))),
    edges:Object.freeze(scope.edges.map(value => Object.freeze({edge_id:value.edge_id,revision:value.revision}))),
    release:Object.freeze(release),pull_request:Object.freeze(pull),review:Object.freeze(review),
    checks:Object.freeze(checks),project:Object.freeze(snapshot.project),
    policy_revision:ownDataFunction(services,"policyRevision","services")(),
  });
  const nextWork=acceptedWork(work,pull.head_sha);
  const operations=[
    Object.freeze({resource:"pull_request",action:"update",repository:work.item.repository,expected_revision:pull.revision,payload:Object.freeze({kind:"epic-accept",epic_id:id,head_sha:pull.head_sha,authority_binding,work:nextWork})}),
    Object.freeze({resource:"project",action:"update",repository:work.item.repository,expected_revision:snapshot.project.revision,payload:Object.freeze({kind:"work-state",project_id:snapshot.project.id,item_id:work.project.item_id,fields:Object.freeze(nextWork.project.fields)})}),
  ];
  return ownDataFunction(ownDataValue(services,"operations","services"),"execute","operations")({command,source:snapshot.source,operations,authority});
}

async function status(command,services) {
  if (command.options.from!==null || command.options.authority!==null) {
    throw new CoreValidationError("epic status does not consume input or authority files");
  }
  const id=command.args[0];
  parseWorkItemId(id);
  const github=ownDataValue(services,"github","services");
  const snapshot=closedData(await ownDataFunction(github,"snapshot","github")({kind:"epic-status",id}),"epic status snapshot");
  exact(snapshot,["kind","source","epic","epic_revision","plan","epic_approval","children","edges","release","branch","pull_request","review","checks","project"],"epic status snapshot");
  if (snapshot.kind!=="epic-status") throw new CoreValidationError("Epic status snapshot kind is invalid");
  const work=assertEpic(snapshot,id,"epic status snapshot");
  if (snapshot.plan!==null && snapshot.epic_approval!==null) {
    assertApprovedScope(snapshot,work,services,{complete:false});
  } else if (snapshot.plan===null ? (work.prepared || snapshot.children.length!==0 || snapshot.edges.length!==0) : !work.prepared) {
    throw new CoreConflictError("Epic status plan evidence conflicts with lifecycle state");
  }
  if (canonicalJson(snapshot.release)!==canonicalJson(work.release) ||
      snapshot.project.id!==work.project.project_id || snapshot.project.revision!==work.project.revision ||
      (snapshot.branch===null)!==(work.physical_branch.exists===false) ||
      (snapshot.branch!==null && (snapshot.branch.name!==work.item.branch || snapshot.branch.head_sha!==work.physical_branch.head_sha)) ||
      (snapshot.pull_request===null)!==(work.pull_request===null) ||
      (snapshot.pull_request!==null && (snapshot.pull_request.state!==work.pull_request.state ||
        snapshot.pull_request.head_sha!==work.pull_request.head_sha || snapshot.pull_request.merged_sha!==work.pull_request.merged_sha))) {
    throw new CoreConflictError("Epic status cross-surface evidence has drifted");
  }
  const state=workStatusResult({kind:"work-item",source:snapshot.source,work},id).state;
  return closedData({
    epic_id:id,revision:snapshot.epic_revision,source:snapshot.source,
    plan:snapshot.plan,approval:snapshot.epic_approval,children:snapshot.children,
    graph:{edges:snapshot.edges},physical_branch:snapshot.branch,pull_request:snapshot.pull_request,
    review:snapshot.review,checks:snapshot.checks,release_assignment:snapshot.release,
    project:snapshot.project,state,next_command:state.next_command,
  },"epic status result");
}

export async function runEpicCommand(command,services) {
  if (command.name==="epic.prepare") return prepare(command,services);
  if (command.name==="epic.approve") return approve(command,services);
  if (command.name==="epic.submit") return submit(command,services);
  if (command.name==="epic.accept") return accept(command,services);
  if (command.name==="epic.status") return status(command,services);
  throw new CoreValidationError("Unsupported epic command");
}
