import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {closedData,exact} from "../commands/common.js";
import {assertValidPullRequestTarget} from "../domain/branching.js";
import {dependencyReadiness,validateDependencyGraph} from "../domain/dependencies.js";
import {parseWorkItemId,reserveBranch,workItemId} from "../domain/identity.js";
import {deriveWorkItemState,projectReconciliationOperations} from "../domain/state.js";
import {validateCoreDocument} from "../contracts.js";
import {CoreBlockedError,CoreConflictError,CoreValidationError} from "../errors.js";
import {compareOperations} from "../operation-order.js";

const SEMVER=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SHA=/^[a-f0-9]{40}$/u;
const HASH=/^[a-f0-9]{64}$/u;
const RFC3339_DATE_TIME=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u;

function invalid(message,options={}) { throw new CoreValidationError(message,options); }
function conflict(message) { throw new CoreConflictError(message); }
function compare(left,right) { return left===right ? 0 : left<right ? -1 : 1; }

function text(value,label) {
  if (typeof value!=="string" || value.trim().length===0) invalid(`${label} must be nonblank text`);
  return value.trim();
}

function timestamp(value,label) {
  const match=typeof value==="string" ? RFC3339_DATE_TIME.exec(value) : null;
  if (!match) invalid(`${label} must be an RFC3339 timestamp`);
  const [,yearText,monthText,dayText,hourText,minuteText,secondText,offsetHourText,offsetMinuteText]=match;
  const year=Number(yearText); const month=Number(monthText); const day=Number(dayText);
  const leap=year%4===0 && (year%100!==0 || year%400===0);
  const days=month===2 ? (leap ? 29 : 28) : [4,6,9,11].includes(month) ? 30 : 31;
  if (month<1 || month>12 || day<1 || day>days || Number(hourText)>23 || Number(minuteText)>59 ||
      Number(secondText)>59 || (offsetHourText!==undefined && (Number(offsetHourText)>23 || Number(offsetMinuteText)>59))) {
    invalid(`${label} must be an RFC3339 timestamp`);
  }
  return value;
}

function repository(value) {
  if (typeof value!=="string") invalid("Repository must be canonical OWNER/REPO ASCII");
  try { return parseWorkItemId(`${value}#1`).repository; }
  catch (error) { invalid("Repository must be canonical OWNER/REPO ASCII",{cause:error}); }
}

function source(value,label) {
  exact(value,["repository","revision","sha256"],label);
  repository(value.repository);
  text(value.revision,`${label} revision`);
  if (typeof value.sha256!=="string" || !HASH.test(value.sha256)) invalid(`${label} sha256 must be lowercase SHA-256`);
  return value;
}

function revision(value,label) { return text(value,label); }

function operationArguments(input,keys,label) {
  const value=closedData(input,label);
  exact(value,keys,label);
  return value;
}

export function normalizeFeatureInput(input) {
  const value=closedData(input,"feature input");
  exact(value,["title","description","priority","change_class"],"feature input");
  const title=text(value.title,"Feature title");
  const description=text(value.description,"Feature description");
  if (!Number.isSafeInteger(value.priority) || value.priority<0) invalid("Feature priority must be a nonnegative safe integer");
  if (!["breaking","backward_compatible_feature"].includes(value.change_class)) invalid("Feature change_class is invalid");
  return Object.freeze({title,description,priority:value.priority,change_class:value.change_class});
}

export function featureRequestIdentity(repositoryInput,inputValue) {
  const owner=repository(repositoryInput);
  const input=normalizeFeatureInput(inputValue);
  return sha256Canonical({repository:owner,...input});
}

export function managedFeatureMarker(identity) {
  if (typeof identity!=="string" || !HASH.test(identity)) invalid("Feature request identity must be lowercase SHA-256");
  return `<!-- toss-core:feature-request:${identity} -->`;
}

export function normalizeIssueInput(input) {
  const value=closedData(input,"bounded issue input");
  exact(value,["kind","title","description","affected_version","scope"],"bounded issue input");
  if (!["bug","fix"].includes(value.kind)) invalid("Bounded issue kind must be bug or fix");
  const title=text(value.title,"Bounded issue title");
  const description=text(value.description,"Bounded issue description");
  if (typeof value.affected_version!=="string" || !SEMVER.test(value.affected_version)) invalid("affected_version must be canonical stable SemVer");
  if (!Array.isArray(value.scope) || value.scope.length===0) invalid("Bounded issue scope must be a nonempty array");
  const scope=value.scope.map((unit,index) => text(unit,`Bounded issue scope[${index}]`));
  if (new Set(scope).size!==scope.length) invalid("Bounded issue scope units must be unique");
  return Object.freeze({kind:"bug",title,description,affected_version:value.affected_version,scope:Object.freeze(scope)});
}

export function issueRequestIdentity(repositoryInput,inputValue) {
  const owner=repository(repositoryInput);
  const input=normalizeIssueInput(inputValue);
  return sha256Canonical({repository:owner,...input});
}

export function managedIssueMarker(identity) {
  if (typeof identity!=="string" || !HASH.test(identity)) invalid("Issue request identity must be lowercase SHA-256");
  return `<!-- toss-core:issue-request:${identity} -->`;
}

function validateProjectIdentity(value,label) {
  exact(value,["id","revision"],label);
  text(value.id,`${label} id`);
  revision(value.revision,`${label} revision`);
}

function validateIntakeSnapshot(input,kind,owner,requestIdentity) {
  const value=closedData(input,`${kind} snapshot`);
  exact(value,["kind","source","revision","project","next_issue_number","existing"],`${kind} snapshot`);
  if (value.kind!==kind) invalid(`${kind} snapshot kind is invalid`);
  source(value.source,`${kind} source`);
  if (value.source.repository!==owner) conflict(`${kind} snapshot source repository conflicts with the request`);
  revision(value.revision,`${kind} snapshot revision`);
  if (value.source.revision!==value.revision) conflict(`${kind} source revision does not bind the repository snapshot`);
  validateProjectIdentity(value.project,`${kind} Project`);
  if (!Number.isSafeInteger(value.next_issue_number) || value.next_issue_number<1) invalid(`${kind} reserved issue number is invalid`);
  if (value.existing!==null) {
    const keys=kind==="feature-by-marker"
      ? ["request_identity","marker","title","description","priority","change_class","labels","projected","work","revision"]
      : ["request_identity","marker","title","description","labels","affected_version","scope","projected","work","revision"];
    exact(value.existing,keys,`${kind} existing issue`);
    if (value.existing.request_identity!==requestIdentity) conflict(`${kind} marker resolves a different request identity`);
    if (value.existing.projected!==true) conflict(`${kind} existing issue is not a verified Project member`);
    revision(value.existing.revision,`${kind} existing issue revision`);
    if (!Array.isArray(value.existing.labels)) invalid(`${kind} existing labels must be an array`);
    validateCoreDocument(value.existing.work.item,"work-item.v1");
    deriveWorkItemState(value.existing.work);
    if (value.existing.work.item.issue_number!==value.next_issue_number || value.existing.work.item.repository!==owner) conflict(`${kind} existing issue number or repository conflicts with its marker`);
  }
  return value;
}

function intakeWork({owner,number,title,kind,status,gate,epicRequired,project,at}) {
  const item=Object.freeze({
    schema_version:"work-item.v1",id:workItemId(owner,number),repository:owner,
    issue_number:number,kind,parent_id:null,branch:reserveBranch({kind,number,title}),
    base_branch:null,milestone:null,status,gate,
  });
  validateCoreDocument(item,"work-item.v1");
  return Object.freeze({
    schema_version:"work-state-snapshot.v1",item,issue_state:"OPEN",drifted:false,
    epic_required:epicRequired,prepared:kind==="epic" ? false : null,
    scope_approved:kind==="epic" ? false : null,parent:null,
    release:Object.freeze({assigned:false,active:false,id:null,repository:null,branch:null,milestone:null,revision:null}),
    blocking_dependencies:Object.freeze([]),children_complete:kind==="epic" ? false : null,
    physical_branch:Object.freeze({exists:false,head_sha:null}),pull_request:null,review:null,checks:null,
    authority:Object.freeze({epic_acceptance_required:false,release_approval_required:false}),
    project:Object.freeze({project_id:project.id,item_id:`PVTI_${owner.replaceAll("/","_")}_${number}`,revision:project.revision,fields:Object.freeze({
      Status:status,Gate:gate,repository:owner,parent:null,milestone:null,
      branch:item.branch,base_branch:null,last_reconciled_at:at,
    })}),
  });
}

function projectMembership(work) {
  const visibleFields=Object.freeze({...work.project.fields});
  return Object.freeze({
    resource:"project",action:"create",repository:work.item.repository,
    expected_revision:work.project.revision,
    payload:Object.freeze({kind:"work-item-membership",project_id:work.project.project_id,
      work_item_id:work.item.id,fields:visibleFields}),
  });
}

function intakeIssueOperation({snapshot,identity,marker,input,work,labels,affectedVersion=null,scope=[],priority=null,changeClass=null}) {
  return Object.freeze({
    resource:"issue",action:"create",repository:work.item.repository,
    expected_revision:snapshot.revision,
    payload:Object.freeze({kind:"managed-work-item",request_identity:identity,marker,
      title:input.title,description:input.description,priority,change_class:changeClass,labels:Object.freeze(labels),
      affected_version:affectedVersion,scope:Object.freeze(scope),work}),
  });
}

function validateExistingFeature(existing,input,identity,work) {
  if (existing.request_identity!==identity || existing.marker!==managedFeatureMarker(identity) ||
      existing.title!==input.title || existing.description!==input.description ||
      existing.priority!==input.priority || existing.change_class!==input.change_class ||
      canonicalJson(existing.labels)!==canonicalJson(["epic"]) ||
      existing.work.item.id!==work.item.id || existing.work.item.branch!==work.item.branch ||
      existing.work.item.kind!=="epic" || existing.work.item.milestone!==null ||
      existing.work.item.base_branch!==null) conflict("Existing managed epic conflicts with the exact feature request");
}

export function featureAddOperations(optionsInput) {
  const {repository:repositoryInput,input:inputValue,snapshot:snapshotInput,reconciled_at}=operationArguments(
    optionsInput,["repository","input","snapshot","reconciled_at"],"feature add options",
  );
  const owner=repository(repositoryInput);
  const input=normalizeFeatureInput(inputValue);
  const identity=featureRequestIdentity(owner,input);
  const snapshot=validateIntakeSnapshot(snapshotInput,"feature-by-marker",owner,identity);
  const at=timestamp(reconciled_at,"Feature reconciliation time");
  const work=intakeWork({owner,number:snapshot.next_issue_number,title:input.title,kind:"epic",status:"Backlog",gate:"EPIC_PREPARATION_REQUIRED",epicRequired:false,project:snapshot.project,at});
  if (snapshot.existing!==null) {
    validateExistingFeature(snapshot.existing,input,identity,work);
    return Object.freeze({request_identity:identity,marker:managedFeatureMarker(identity),work:snapshot.existing.work,operations:Object.freeze([])});
  }
  const operations=[
    intakeIssueOperation({snapshot,identity,marker:managedFeatureMarker(identity),input,work,labels:["epic"],priority:input.priority,changeClass:input.change_class}),
    projectMembership(work),
  ].sort(compareOperations);
  return Object.freeze({request_identity:identity,marker:managedFeatureMarker(identity),work,operations:Object.freeze(operations)});
}

function validateExistingIssue(existing,input,identity,work) {
  if (existing.request_identity!==identity || existing.marker!==managedIssueMarker(identity) ||
      existing.title!==input.title || existing.description!==input.description ||
      canonicalJson(existing.labels)!==canonicalJson(["bug"]) || existing.affected_version!==input.affected_version ||
      canonicalJson(existing.scope)!==canonicalJson(input.scope) || existing.work.item.id!==work.item.id ||
      existing.work.item.branch!==work.item.branch || existing.work.item.kind!=="bug" ||
      existing.work.item.milestone!==null || existing.work.item.base_branch!==null) {
    conflict("Existing managed bounded issue conflicts with the exact intake request");
  }
}

export function issueAddOperations(optionsInput) {
  const {repository:repositoryInput,input:inputValue,snapshot:snapshotInput,reconciled_at}=operationArguments(
    optionsInput,["repository","input","snapshot","reconciled_at"],"issue add options",
  );
  const owner=repository(repositoryInput);
  const input=normalizeIssueInput(inputValue);
  const identity=issueRequestIdentity(owner,input);
  const snapshot=validateIntakeSnapshot(snapshotInput,"issue-by-marker",owner,identity);
  const expanded=input.scope.length>1;
  const work=intakeWork({owner,number:snapshot.next_issue_number,title:input.title,kind:"bug",
    status:expanded ? "Blocked" : "Backlog",gate:expanded ? "EPIC_REQUIRED" : "RELEASE_PLANNING",
    epicRequired:expanded,project:snapshot.project,at:timestamp(reconciled_at,"Issue reconciliation time")});
  if (snapshot.existing!==null) {
    validateExistingIssue(snapshot.existing,input,identity,work);
    return Object.freeze({request_identity:identity,marker:managedIssueMarker(identity),work:snapshot.existing.work,operations:Object.freeze([])});
  }
  const operations=[
    intakeIssueOperation({snapshot,identity,marker:managedIssueMarker(identity),input,work,labels:["bug"],affectedVersion:input.affected_version,scope:input.scope}),
    projectMembership(work),
  ].sort(compareOperations);
  return Object.freeze({request_identity:identity,marker:managedIssueMarker(identity),work,operations:Object.freeze(operations)});
}

function validateMutationSnapshot(input,kind,id) {
  const value=closedData(input,`${kind} snapshot`);
  exact(value,["kind","source","repository_revision","work","branch","base","pull_request","bug_lineage"],`${kind} snapshot`);
  if (value.kind!==kind) invalid(`${kind} snapshot kind is invalid`);
  const identity=parseWorkItemId(id);
  source(value.source,`${kind} source`);
  if (value.source.repository!==identity.repository || value.source.revision!==value.repository_revision) conflict(`${kind} source does not bind the governed repository revision`);
  revision(value.repository_revision,`${kind} repository revision`);
  if (value.work?.item?.id!==id) conflict(`${kind} snapshot work identity conflicts with the request`);
  validateBugLineage(value.bug_lineage,value.work,`${kind} bug lineage`);
  const state=deriveWorkItemState(value.work);
  if (!Array.isArray(value.work.blocking_dependencies)) invalid(`${kind} dependency evidence is invalid`);
  if (value.branch!==null) {
    exact(value.branch,["name","base_branch","head_sha","revision"],`${kind} branch`);
    revision(value.branch.revision,`${kind} branch revision`);
    if (!SHA.test(value.branch.head_sha)) invalid(`${kind} branch head must be a lowercase 40-character SHA`);
  }
  if ((value.branch===null)!==(value.work.physical_branch.exists===false)) conflict(`${kind} branch wrapper conflicts with Task 3 physical-branch evidence`);
  if (value.branch!==null && (value.branch.name!==value.work.item.branch || value.branch.head_sha!==value.work.physical_branch.head_sha)) conflict(`${kind} branch wrapper conflicts with Task 3 work evidence`);
  if (value.base!==null) {
    exact(value.base,["repository","branch","head_sha","revision"],`${kind} base`);
    repository(value.base.repository);
    revision(value.base.revision,`${kind} base revision`);
    if (!SHA.test(value.base.head_sha)) invalid(`${kind} base head must be a lowercase 40-character SHA`);
  }
  if (value.pull_request!==null) {
    exact(value.pull_request,["number","work_item_id","head_repository","base_repository","head","base","head_sha","state","merged_sha","revision"],`${kind} pull request`);
    if (!Number.isSafeInteger(value.pull_request.number) || value.pull_request.number<1) invalid(`${kind} pull request number is invalid`);
    repository(value.pull_request.head_repository); repository(value.pull_request.base_repository);
    parseWorkItemId(value.pull_request.work_item_id);
    if (!SHA.test(value.pull_request.head_sha) || !["DRAFT","READY","MERGED"].includes(value.pull_request.state) ||
        !(value.pull_request.merged_sha===null || SHA.test(value.pull_request.merged_sha))) invalid(`${kind} pull request revision or state is invalid`);
    revision(value.pull_request.revision,`${kind} pull request revision`);
  }
  if ((value.pull_request===null)!==(value.work.pull_request===null)) conflict(`${kind} pull request wrapper conflicts with Task 3 evidence`);
  if (value.pull_request!==null && (value.pull_request.state!==value.work.pull_request.state ||
      value.pull_request.head_sha!==value.work.pull_request.head_sha || value.pull_request.merged_sha!==value.work.pull_request.merged_sha)) conflict(`${kind} pull request wrapper conflicts with Task 3 state evidence`);
  return Object.freeze({snapshot:value,identity,state});
}

function nextPatchVersion(version,label) {
  const match=SEMVER.exec(version);
  if (!match) invalid(`${label} affected version must be canonical stable SemVer`);
  const patch=Number(match[3]);
  if (!Number.isSafeInteger(patch) || patch===Number.MAX_SAFE_INTEGER) {
    invalid(`${label} patch component cannot be incremented safely`);
  }
  return `${match[1]}.${match[2]}.${patch+1}`;
}

function validateBugLineage(input,work,label) {
  if (work.item.kind!=="bug") {
    if (input!==null) invalid(`${label} applies only to bounded bugs`);
    return null;
  }
  const value=closedData(input,label);
  exact(value,["classification","affected_version","patch_version"],label);
  if (value.classification!=="patch") invalid(`${label} classification must be patch`);
  const expected=nextPatchVersion(value.affected_version,label);
  if (value.patch_version!==expected) invalid(`${label} does not increment the affected release by one patch`);
  if (work.release.assigned) {
    const milestone=`v${expected}`;
    const branch=`release/${milestone}`;
    if (work.release.repository!==work.item.repository ||
        work.release.milestone!==milestone || work.release.branch!==branch ||
        work.release.id!==`${work.item.repository}@${branch}` ||
        work.item.milestone!==milestone || work.item.base_branch!==branch ||
        work.project.fields.milestone!==milestone ||
        work.project.fields.base_branch!==branch) {
      invalid(`${label} does not bind the exact active patch release derived from the affected version`);
    }
  }
  return value;
}

function postState(work,changes) {
  return closedData({...work,...changes},"projected work snapshot");
}

function projectOperations(work,state,at) {
  return projectReconciliationOperations(work,state,at).map(operation => Object.freeze({
    ...operation,
    payload:Object.freeze({kind:"work-state",...operation.payload}),
  }));
}

function requireTransitionState(state,label,allowed) {
  if (!allowed.some(([status,gate]) => state.status===status && state.gate===gate)) {
    throw new CoreBlockedError(`${label} cannot run while ${state.status} / ${state.gate}`);
  }
}

function validateGoverningBase(snapshot,identity,label) {
  const item=snapshot.work.item;
  const governing=item.kind==="issue" ? snapshot.work.parent : snapshot.work.release;
  if (snapshot.base===null || governing===null ||
      snapshot.base.repository!==identity.repository ||
      snapshot.base.repository!==(item.kind==="issue" ? item.repository : governing.repository) ||
      snapshot.base.branch!==item.base_branch || snapshot.base.branch!==governing.branch ||
      snapshot.base.revision!==governing.revision) {
    conflict(`${label} governing base conflicts with exact parent or patch release evidence`);
  }
}

export function issueStartOperations(optionsInput) {
  const {id,snapshot:snapshotInput,reconciled_at}=operationArguments(
    optionsInput,["id","snapshot","reconciled_at"],"issue start options",
  );
  const {snapshot,identity,state}=validateMutationSnapshot(snapshotInput,"issue-start",id);
  if (!["issue","bug"].includes(snapshot.work.item.kind)) invalid("issue start supports only child issues and bounded bugs");
  if (snapshot.work.item.repository!==identity.repository) conflict("Issue start repository identity conflicts");
  validateGoverningBase(snapshot,identity,"Issue start");
  const operations=[];
  if (snapshot.branch===null) {
    requireTransitionState(state,"Issue start",[["Ready","NONE"]]);
    operations.push(Object.freeze({resource:"branch",action:"create",repository:identity.repository,
      expected_revision:snapshot.repository_revision,payload:Object.freeze({kind:"work-branch",work_item_id:id,
        name:snapshot.work.item.branch,base_branch:snapshot.base.branch,source_sha:snapshot.base.head_sha})}));
  } else if (snapshot.branch.name!==snapshot.work.item.branch ||
      snapshot.branch.base_branch!==snapshot.base.branch || snapshot.branch.head_sha!==snapshot.base.head_sha) {
    conflict("Existing physical branch conflicts with the exact reserved branch, base, or source head");
  } else {
    requireTransitionState(state,"Issue start replay",[["In progress","NONE"]]);
  }
  const projected=snapshot.branch===null ? postState(snapshot.work,{physical_branch:{exists:true,head_sha:snapshot.base.head_sha}}) : snapshot.work;
  const projectedState=deriveWorkItemState(projected);
  operations.push(...projectOperations(projected,projectedState,timestamp(reconciled_at,"Issue start reconciliation time")));
  return Object.freeze({work:projected,state:projectedState,operations:Object.freeze(operations.sort(compareOperations))});
}

export function issueSubmitOperations(optionsInput) {
  const {id,snapshot:snapshotInput,reconciled_at}=operationArguments(
    optionsInput,["id","snapshot","reconciled_at"],"issue submit options",
  );
  const {snapshot,identity,state:currentState}=validateMutationSnapshot(snapshotInput,"issue-submit",id);
  const item=snapshot.work.item;
  if (!["issue","bug"].includes(item.kind)) invalid("issue submit supports only child issues and bounded bugs");
  if (snapshot.branch===null || !snapshot.work.physical_branch.exists || snapshot.branch.name!==item.branch ||
      snapshot.branch.base_branch!==item.base_branch || snapshot.branch.head_sha!==snapshot.work.physical_branch.head_sha) {
    conflict("Issue submit requires the exact current physical branch, base, and head");
  }
  validateGoverningBase(snapshot,identity,"Issue submit");
  requireTransitionState(currentState,"Issue submit",[["In progress","NONE"]]);
  assertValidPullRequestTarget({headRepository:identity.repository,baseRepository:identity.repository,head:item.branch,base:item.base_branch,expectedBase:item.base_branch});
  const operations=[];
  if (snapshot.pull_request===null) {
    operations.push(Object.freeze({resource:"pull_request",action:"create",repository:identity.repository,
      expected_revision:snapshot.repository_revision,payload:Object.freeze({kind:"work-pull-request",work_item_id:id,
        head:item.branch,base:item.base_branch,head_sha:snapshot.branch.head_sha,draft:true})}));
  } else {
    const pull=snapshot.pull_request;
    if (pull.work_item_id!==id || pull.head_repository!==identity.repository || pull.base_repository!==identity.repository ||
        pull.head!==item.branch || pull.base!==item.base_branch) {
      conflict("Existing pull request conflicts with the governed work identity or head");
    }
    if (pull.head_sha!==snapshot.branch.head_sha || pull.state==="MERGED") conflict("Existing pull request head or state conflicts with issue submission");
  }
  const projected=snapshot.pull_request===null ? postState(snapshot.work,{pull_request:{state:"DRAFT",head_sha:snapshot.branch.head_sha,merged_sha:null}}) : snapshot.work;
  const state=deriveWorkItemState(projected);
  operations.push(...projectOperations(projected,state,timestamp(reconciled_at,"Issue submit reconciliation time")));
  return Object.freeze({work:projected,state,operations:Object.freeze(operations.sort(compareOperations))});
}

export function normalizeDependencyAddInput(input) {
  const value=closedData(input,"dependency add input");
  exact(value,["kind","rationale","provenance"],"dependency add input");
  if (value.kind!=="requires") invalid("Dependency kind must be requires");
  const rationale=text(value.rationale,"Dependency rationale");
  exact(value.provenance,["source_revision","source_sha256","locations"],"dependency provenance");
  text(value.provenance.source_revision,"Dependency source revision");
  if (typeof value.provenance.source_sha256!=="string" || !HASH.test(value.provenance.source_sha256)) invalid("Dependency provenance hash is invalid");
  if (!Array.isArray(value.provenance.locations) || value.provenance.locations.length===0) invalid("Dependency provenance locations must be nonempty");
  const locations=value.provenance.locations.map((location,index) => text(location,`Dependency provenance location[${index}]`));
  if (new Set(locations).size!==locations.length) invalid("Dependency provenance locations must be unique");
  return Object.freeze({kind:"requires",rationale,provenance:Object.freeze({...value.provenance,locations:Object.freeze(locations)})});
}

export function normalizeDependencyRemoveInput(input) {
  const value=closedData(input,"dependency remove input");
  exact(value,["reason","expected_edge_revision"],"dependency remove input");
  return Object.freeze({reason:text(value.reason,"Dependency removal reason"),expected_edge_revision:text(value.expected_edge_revision,"Expected dependency revision")});
}

function validateDependencySnapshot(input,root) {
  const value=closedData(input,"dependency graph snapshot");
  exact(value,["kind","source","revision","root","nodes","edges","completed_ids","relationships","tombstones","next_edge_revision"],"dependency graph snapshot");
  if (value.kind!=="dependency-graph" || value.root!==root) invalid("Dependency graph snapshot query binding is invalid");
  source(value.source,"dependency graph source");
  if (value.source.revision!==value.revision) conflict("Dependency graph source does not bind the exact graph revision");
  revision(value.revision,"Dependency graph revision");
  revision(value.next_edge_revision,"Next dependency edge revision");
  const graph=validateDependencyGraph({nodes:value.nodes,edges:value.edges});
  if (!Array.isArray(value.completed_ids) || !Array.isArray(value.relationships) || !Array.isArray(value.tombstones)) invalid("Dependency graph remote evidence must be arrays");
  const nodeSet=new Set(graph.order);
  const completed=new Set();
  for (const id of value.completed_ids) {
    parseWorkItemId(id);
    if (!nodeSet.has(id) || completed.has(id)) invalid("Completed dependency evidence is unknown or duplicated");
    completed.add(id);
  }
  const relations=new Map();
  for (const relation of value.relationships) {
    exact(relation,["edge_id","source","target","revision"],"native dependency relationship");
    parseWorkItemId(relation.source); parseWorkItemId(relation.target); revision(relation.revision,"Native dependency revision");
    if (relations.has(relation.edge_id)) conflict("Native dependency relationship is duplicated");
    relations.set(relation.edge_id,relation);
  }
  const tombstones=new Map();
  for (const tombstone of value.tombstones) {
    exact(tombstone,["edge_id","source","target","kind","prior_revision","reason","removed_at"],"dependency tombstone");
    parseWorkItemId(tombstone.source); parseWorkItemId(tombstone.target);
    if (tombstone.kind!=="requires" || tombstones.has(tombstone.edge_id)) conflict("Dependency tombstone is corrupt or duplicated");
    text(tombstone.prior_revision,"Dependency tombstone prior revision"); text(tombstone.reason,"Dependency tombstone reason"); timestamp(tombstone.removed_at,"Dependency tombstone time");
    tombstones.set(tombstone.edge_id,tombstone);
  }
  const edgesById=new Map(graph.edges.map(edge => [edge.edge_id,edge]));
  for (const [edgeId,relation] of relations) {
    const edge=edgesById.get(edgeId);
    if (!edge || relation.source!==edge.source || relation.target!==edge.target || relation.revision!==edge.revision) conflict(`Native dependency relationship ${edgeId} is not exactly backed by its managed edge`);
  }
  for (const edge of graph.edges) {
    if (!relations.has(edge.edge_id)) conflict(`Managed dependency edge ${edge.edge_id} lacks its native relationship`);
    if (tombstones.has(edge.edge_id)) conflict(`Managed dependency edge ${edge.edge_id} conflicts with immutable removal history`);
  }
  return Object.freeze({snapshot:value,graph,completed:Object.freeze([...completed].sort(compare)),relations,tombstones});
}

function validateDependencyMutationSnapshot(input,sourceId,targetId) {
  const value=closedData(input,"dependency mutation snapshot");
  exact(value,["kind","source","revision","root","nodes","edges","completed_ids","relationships","tombstones","next_edge_revision","mutation"],"dependency mutation snapshot");
  if (value.kind!=="dependency-mutation" || value.root!==null) invalid("Dependency mutation snapshot kind is invalid");
  exact(value.mutation,["source","target","revision","work"],"dependency mutation source evidence");
  if (value.mutation.source!==sourceId || value.mutation.target!==targetId ||
      value.mutation.work?.item?.id!==sourceId) {
    conflict("Dependency mutation snapshot does not bind the exact source and target work");
  }
  revision(value.mutation.revision,"Dependency mutation source revision");
  const graphInput={...value};
  delete graphInput.mutation;
  graphInput.kind="dependency-graph";
  const validated=validateDependencySnapshot(graphInput,null);
  const readiness=dependencyReadiness(sourceId,validated.graph,validated.completed);
  if (canonicalJson(value.mutation.work.blocking_dependencies)!==canonicalJson(readiness.blocking)) {
    conflict("Dependency mutation source blockers do not match the exact graph snapshot");
  }
  const state=deriveWorkItemState(value.mutation.work);
  if (value.mutation.work.item.status!==state.status || value.mutation.work.item.gate!==state.gate ||
      value.mutation.work.project.fields.Status!==state.status ||
      value.mutation.work.project.fields.Gate!==state.gate) {
    conflict("Dependency mutation source machine state does not match its exact graph readiness");
  }
  return Object.freeze({...validated,mutation:value.mutation,state});
}

function dependencyStateOperations({sourceId,graph,completed,mutation,reconciledAt}) {
  const readiness=dependencyReadiness(sourceId,graph,completed);
  const evidence=structuredClone(mutation.work);
  evidence.blocking_dependencies=[...readiness.blocking];
  const state=deriveWorkItemState(evidence);
  const work=structuredClone(evidence);
  work.item.status=state.status;
  work.item.gate=state.gate;
  const operations=[];
  if (canonicalJson({blocking_dependencies:mutation.work.blocking_dependencies,status:mutation.work.item.status,gate:mutation.work.item.gate})!==
      canonicalJson({blocking_dependencies:work.blocking_dependencies,status:work.item.status,gate:work.item.gate})) {
    operations.push(Object.freeze({
      resource:"issue",action:"update",repository:work.item.repository,
      expected_revision:mutation.revision,
      payload:Object.freeze({kind:"dependency-work-state",work:closedData(work,"dependency projected work")}),
    }));
  }
  operations.push(...projectOperations(work,state,timestamp(reconciledAt,"Dependency reconciliation time")));
  return Object.freeze({work:closedData(work,"dependency projected work"),state,operations:Object.freeze(operations)});
}

export function dependencyEdgeIdentity(sourceId,targetId) {
  parseWorkItemId(sourceId); parseWorkItemId(targetId);
  return `DEP-${sha256Canonical({source:sourceId,target:targetId,kind:"requires"})}`;
}

export function dependencyAddOperations(optionsInput) {
  const {source:sourceId,target:targetId,input:inputValue,snapshot:snapshotInput,reconciled_at}=operationArguments(
    optionsInput,["source","target","input","snapshot","reconciled_at"],"dependency add options",
  );
  parseWorkItemId(sourceId); parseWorkItemId(targetId);
  const input=normalizeDependencyAddInput(inputValue);
  const {snapshot,graph,completed,relations,tombstones,mutation}=validateDependencyMutationSnapshot(snapshotInput,sourceId,targetId);
  const edgeId=dependencyEdgeIdentity(sourceId,targetId);
  if (tombstones.has(edgeId)) conflict("Removed dependency identity cannot be re-added without an explicit resurrection protocol");
  const existing=graph.edges.filter(edge => edge.source===sourceId && edge.target===targetId && edge.kind==="requires");
  const byIdentity=graph.edges.filter(edge => edge.edge_id===edgeId);
  if (existing.length>1 || byIdentity.length>1) conflict("Dependency evidence is ambiguous");
  if (existing.length===1 || byIdentity.length===1) {
    const edge=existing[0] ?? byIdentity[0];
    const relation=relations.get(edgeId);
    if (edge.edge_id!==edgeId || edge.source!==sourceId || edge.target!==targetId || edge.rationale!==input.rationale ||
        canonicalJson(edge.provenance)!==canonicalJson(input.provenance) || !relation || relation.source!==sourceId || relation.target!==targetId || relation.revision!==edge.revision) {
      conflict("Existing dependency edge or native relationship conflicts with the exact request");
    }
    const projected=dependencyStateOperations({sourceId,graph,completed,mutation,reconciledAt:reconciled_at});
    return Object.freeze({edge,work:projected.work,state:projected.state,operations:Object.freeze([...projected.operations].sort(compareOperations))});
  }
  const edge=Object.freeze({schema_version:"dependency-edge.v1",edge_id:edgeId,source:sourceId,target:targetId,kind:"requires",rationale:input.rationale,provenance:input.provenance,revision:snapshot.next_edge_revision});
  validateCoreDocument(edge,"dependency-edge.v1");
  validateDependencyGraph({nodes:graph.order,edges:[...graph.edges,edge]});
  const relationship=Object.freeze({edge_id:edgeId,source:sourceId,target:targetId,revision:edge.revision});
  const operation=Object.freeze({resource:"issue",action:"update",repository:parseWorkItemId(sourceId).repository,
    expected_revision:snapshot.revision,payload:Object.freeze({kind:"dependency-add",edge,relationship})});
  const postGraph=validateDependencyGraph({nodes:graph.order,edges:[...graph.edges,edge]});
  const projected=dependencyStateOperations({sourceId,graph:postGraph,completed,mutation,reconciledAt:reconciled_at});
  return Object.freeze({edge,work:projected.work,state:projected.state,operations:Object.freeze([operation,...projected.operations].sort(compareOperations))});
}

export function dependencyRemoveOperations(optionsInput) {
  const {source:sourceId,target:targetId,input:inputValue,snapshot:snapshotInput,removed_at,reconciled_at}=operationArguments(
    optionsInput,["source","target","input","snapshot","removed_at","reconciled_at"],"dependency remove options",
  );
  parseWorkItemId(sourceId); parseWorkItemId(targetId);
  const input=normalizeDependencyRemoveInput(inputValue);
  const {snapshot,graph,completed,relations,tombstones,mutation}=validateDependencyMutationSnapshot(snapshotInput,sourceId,targetId);
  const edgeId=dependencyEdgeIdentity(sourceId,targetId);
  const matches=graph.edges.filter(edge => edge.edge_id===edgeId && edge.source===sourceId && edge.target===targetId && edge.kind==="requires");
  if (matches.length===0) {
    const tombstone=tombstones.get(edgeId);
    if (tombstone && tombstone.source===sourceId && tombstone.target===targetId &&
        tombstone.prior_revision===input.expected_edge_revision && tombstone.reason===input.reason) {
      const projected=dependencyStateOperations({sourceId,graph,completed,mutation,reconciledAt:reconciled_at});
      return Object.freeze({tombstone,work:projected.work,state:projected.state,operations:Object.freeze([...projected.operations].sort(compareOperations))});
    }
    conflict("Managed dependency edge does not exist or removal evidence conflicts");
  }
  if (matches.length!==1) conflict("Managed dependency edge evidence is ambiguous");
  const edge=matches[0];
  const relation=relations.get(edgeId);
  if (!relation || relation.source!==sourceId || relation.target!==targetId || relation.revision!==edge.revision) conflict("Managed native dependency relationship is missing or conflicting");
  if (edge.revision!==input.expected_edge_revision) conflict("Expected dependency revision is stale");
  if (tombstones.has(edgeId)) conflict("Active dependency has a conflicting immutable tombstone");
  const tombstone=Object.freeze({edge_id:edgeId,source:sourceId,target:targetId,kind:"requires",prior_revision:edge.revision,reason:input.reason,removed_at:timestamp(removed_at,"Dependency removal time")});
  const operation=Object.freeze({resource:"issue",action:"update",repository:parseWorkItemId(sourceId).repository,
    expected_revision:snapshot.revision,payload:Object.freeze({kind:"dependency-remove",tombstone})});
  const postGraph=validateDependencyGraph({nodes:graph.order,edges:graph.edges.filter(value => value.edge_id!==edgeId)});
  const projected=dependencyStateOperations({sourceId,graph:postGraph,completed,mutation,reconciledAt:reconciled_at});
  return Object.freeze({tombstone,work:projected.work,state:projected.state,operations:Object.freeze([operation,...projected.operations].sort(compareOperations))});
}

function subgraph(graph,root) {
  if (root===null) return graph;
  parseWorkItemId(root);
  if (!graph.order.includes(root)) invalid(`Dependency graph item is unknown: ${root}`);
  const connected=new Set([root]);
  let changed=true;
  while (changed) {
    changed=false;
    for (const edge of graph.edges) {
      if (connected.has(edge.source) || connected.has(edge.target)) {
        if (!connected.has(edge.source)) { connected.add(edge.source); changed=true; }
        if (!connected.has(edge.target)) { connected.add(edge.target); changed=true; }
      }
    }
  }
  return validateDependencyGraph({nodes:[...connected],edges:graph.edges.filter(edge => connected.has(edge.source) && connected.has(edge.target))});
}

export function dependencyGraphResult(snapshotInput,root=null,optionsInput=undefined) {
  const {check}=optionsInput===undefined
    ? Object.freeze({check:false})
    : operationArguments(optionsInput,["check"],"dependency graph options");
  if (typeof check!=="boolean") invalid("dependency graph check option must be boolean");
  if (root!==null) parseWorkItemId(root);
  const {graph,completed}=validateDependencySnapshot(snapshotInput,root);
  const selected=subgraph(graph,root);
  const result={graph:selected};
  if (check) {
    result.valid=true;
    if (root!==null) result.readiness=dependencyReadiness(root,selected,completed.filter(id => selected.order.includes(id)));
  }
  return closedData(result,"dependency graph result");
}

export function workStatusResult(snapshotInput,id) {
  parseWorkItemId(id);
  const snapshot=closedData(snapshotInput,"work status snapshot");
  const hasLineage=Object.hasOwn(snapshot,"bug_lineage");
  exact(snapshot,hasLineage ? ["kind","source","work","bug_lineage"] : ["kind","source","work"],"work status snapshot");
  if (snapshot.kind!=="work-item") invalid("Work status snapshot kind is invalid");
  source(snapshot.source,"work status source");
  if (snapshot.work?.item?.id!==id) conflict("Work status snapshot identity conflicts with the request");
  const bugLineage=hasLineage
    ? validateBugLineage(snapshot.bug_lineage,snapshot.work,"work status bug lineage")
    : null;
  const state=deriveWorkItemState(snapshot.work);
  return closedData({work_item:snapshot.work.item,state,evidence:snapshot.work,source:snapshot.source,
    ...(hasLineage ? {bug_lineage:bugLineage} : {})},"work status result");
}
