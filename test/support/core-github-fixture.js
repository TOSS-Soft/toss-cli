import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../src/contracts/acp.js";
import {closedData,exact} from "../../src/core/commands/common.js";
import {validateDependencyGraph} from "../../src/core/domain/dependencies.js";
import {parseWorkItemId} from "../../src/core/domain/identity.js";
import {CoreConflictError,CoreValidationError} from "../../src/core/errors.js";

const SHA=/^[a-f0-9]{40}$/u;
const PROJECT_ID="PVT_TOSS_OS_2";
const SOURCE_SHA="a".repeat(64);

function copy(value,label="fixture value") {
  return closedData(value,label);
}

function compare(left,right) {
  return left===right ? 0 : left<right ? -1 : 1;
}

function bump(prefix,current) {
  const match=new RegExp(`^${prefix}-(\\d+)$`,'u').exec(current);
  return `${prefix}-${Number(match?.[1] ?? 0)+1}`;
}

function source(repository,revision) {
  return Object.freeze({repository,revision,sha256:sha256Canonical({repository,revision})});
}

function repositoryState(repository) {
  return {
    repository,
    revision:"repository-1",
    nextIssueNumber:1,
    issues:new Map(),
    branches:new Map(),
    pullRequests:new Map(),
    reviewFollowUps:new Map(),
    reviewReservations:new Set(),
    nextPullRequestNumber:1,
  };
}

function unassignedRelease() {
  return {
    assigned:false,active:false,id:null,repository:null,branch:null,
    milestone:null,revision:null,
  };
}

function blankAuthority() {
  return {epic_acceptance_required:false,release_approval_required:false};
}

function projectFields(item,at) {
  return {
    Status:item.status,
    Gate:item.gate,
    branch:item.branch,
    base_branch:item.base_branch,
    last_reconciled_at:at,
  };
}

function initialWork(item,projectItemId,projectRevision,at,epicRequired=false) {
  return {
    schema_version:"work-state-snapshot.v1",
    item,
    issue_state:"OPEN",
    drifted:false,
    epic_required:epicRequired,
    prepared:item.kind==="epic" ? false : null,
    scope_approved:item.kind==="epic" ? false : null,
    parent:null,
    release:unassignedRelease(),
    blocking_dependencies:[],
    children_complete:item.kind==="epic" ? false : null,
    physical_branch:{exists:false,head_sha:null},
    pull_request:null,
    review:null,
    checks:null,
    authority:blankAuthority(),
    project:{
      project_id:PROJECT_ID,
      item_id:projectItemId,
      revision:projectRevision,
      fields:projectFields(item,at),
    },
  };
}

function assertPortOperation(operation) {
  const value=copy(operation,"fake GitHub operation");
  exact(value,["operation_id","resource","action","repository","expected_revision","payload"],"fake GitHub operation");
  return value;
}

export function createCoreGithubFixture(options={}) {
  if (!options || typeof options!=="object" || Array.isArray(options) || types.isProxy(options)) {
    throw new TypeError("core GitHub fixture options must be a plain non-proxy object");
  }
  const repositoryNames=options.repositories ?? ["TOSS-Soft/toss-cli","TOSS-Soft/toss-console"];
  const repositories=new Map(repositoryNames.map(name => [name,repositoryState(name)]));
  const project={id:PROJECT_ID,revision:"project-1"};
  const dependency={revision:"dependency-1",edges:new Map(),relationships:new Map(),tombstones:new Map()};
  const reviewProjects=new Map();
  const calls=[];
  const appliedKeys=new Map();
  let failureMode=null;

  function repo(repository) {
    const found=repositories.get(repository);
    if (!found) throw new CoreValidationError(`Unknown fake repository ${repository}`);
    return found;
  }

  function issue(id) {
    const identity=parseWorkItemId(id);
    return repo(identity.repository).issues.get(identity.issueNumber) ?? null;
  }

  function allNodes() {
    return [...repositories.values()].flatMap(value => [...value.issues.values()].map(record => record.work.item.id)).sort(compare);
  }

  function graphSnapshot(root=null) {
    const nodes=allNodes();
    const edges=[...dependency.edges.values()].sort((left,right) => compare(left.edge_id,right.edge_id));
    validateDependencyGraph({nodes,edges});
    const completed_ids=[...repositories.values()].flatMap(value => [...value.issues.values()]
      .filter(record => record.work.issue_state==="CLOSED")
      .map(record => record.work.item.id)).sort(compare);
    const relationships=[...dependency.relationships.values()].sort((left,right) => compare(left.edge_id,right.edge_id));
    const tombstones=[...dependency.tombstones.values()].sort((left,right) => compare(left.edge_id,right.edge_id));
    return copy({
      kind:"dependency-graph",source:source("TOSS-Soft/toss-os-control",dependency.revision),
      revision:dependency.revision,root,nodes,edges,completed_ids,relationships,tombstones,
      next_edge_revision:bump("edge",dependency.revision.replace("dependency","edge")),
    },"dependency graph snapshot");
  }

  function workSnapshot(kind,id) {
    const record=issue(id);
    if (!record) throw new CoreConflictError(`Unknown governed work item ${id}`);
    const identity=parseWorkItemId(id);
    const repository=repo(identity.repository);
    const branch=repository.branches.get(record.work.item.branch) ?? null;
    const pullRequest=[...repository.pullRequests.values()].find(value => value.work_item_id===id) ?? null;
    const work=structuredClone(record.work);
    work.physical_branch=branch===null
      ? {exists:false,head_sha:null}
      : {exists:true,head_sha:branch.head_sha};
    work.pull_request=pullRequest===null ? null : {
      state:pullRequest.state,head_sha:pullRequest.head_sha,merged_sha:pullRequest.merged_sha,
    };
    const base=work.item.kind==="issue"
      ? work.parent===null ? null : {
        repository:work.item.repository,
        branch:work.parent.branch,
        head_sha:repo(work.item.repository).branches.get(work.parent.branch)?.head_sha ?? null,
        revision:work.parent.revision,
      }
      : work.release.assigned ? {
        repository:work.release.repository,
        branch:work.release.branch,
        head_sha:repo(work.item.repository).branches.get(work.release.branch)?.head_sha ?? null,
        revision:work.release.revision,
      } : null;
    return copy({
      kind,source:source(identity.repository,repository.revision),
      repository_revision:repository.revision,work,
      branch:branch===null ? null : {
        name:branch.name,base_branch:branch.base_branch,head_sha:branch.head_sha,revision:branch.revision,
      },
      base,
      pull_request:pullRequest===null ? null : copy(pullRequest,"fake pull request"),
    },`${kind} snapshot`);
  }

  async function snapshot(queryInput) {
    const query=copy(queryInput,"fake GitHub snapshot query");
    if (!query || typeof query!=="object" || Array.isArray(query) || typeof query.kind!=="string") {
      throw new CoreValidationError("Fake GitHub snapshot query must be a closed record with a string kind");
    }
    calls.push(copy({method:"snapshot",query},"fake GitHub call"));
    if (query.kind==="feature-by-marker") {
      exact(query,["kind","repository","request_identity"],"feature snapshot query");
      const repository=repo(query.repository);
      const existing=[...repository.issues.values()].find(value => value.request_identity===query.request_identity) ?? null;
      return copy({
        kind:query.kind,source:source(query.repository,repository.revision),
        revision:repository.revision,project:{id:project.id,revision:project.revision},
        next_issue_number:existing?.work.item.issue_number ?? repository.nextIssueNumber,
        existing:existing===null ? null : {
          request_identity:existing.request_identity,marker:existing.marker,
          title:existing.title,description:existing.description,priority:existing.priority,
          change_class:existing.change_class,labels:existing.labels,projected:existing.projected,
          work:existing.work,revision:existing.revision,
        },
      },"feature snapshot");
    }
    if (query.kind==="issue-by-marker") {
      exact(query,["kind","repository","request_identity"],"issue snapshot query");
      const repository=repo(query.repository);
      const existing=[...repository.issues.values()].find(value => value.request_identity===query.request_identity) ?? null;
      return copy({
        kind:query.kind,source:source(query.repository,repository.revision),
        revision:repository.revision,project:{id:project.id,revision:project.revision},
        next_issue_number:existing?.work.item.issue_number ?? repository.nextIssueNumber,
        existing:existing===null ? null : {
          request_identity:existing.request_identity,marker:existing.marker,
          title:existing.title,description:existing.description,labels:existing.labels,
          affected_version:existing.affected_version,scope:existing.scope,
          projected:existing.projected,work:existing.work,revision:existing.revision,
        },
      },"issue intake snapshot");
    }
    if (query.kind==="work-item") {
      exact(query,["kind","id"],"work snapshot query");
      const record=issue(query.id);
      if (!record) throw new CoreConflictError(`Unknown governed work item ${query.id}`);
      const identity=parseWorkItemId(query.id);
      return copy({kind:query.kind,source:source(identity.repository,repo(identity.repository).revision),work:record.work},"work snapshot");
    }
    if (query.kind==="issue-start" || query.kind==="issue-submit") {
      exact(query,["kind","id"],"work mutation snapshot query");
      return workSnapshot(query.kind,query.id);
    }
    if (query.kind==="dependency-graph") {
      exact(query,["kind","root"],"dependency snapshot query");
      return graphSnapshot(query.root);
    }
    if (query.kind==="review") {
      exact(query,["kind","repository","number"],"review snapshot query");
      const repository=repo(query.repository);
      const pullRequest=repository.pullRequests.get(query.number);
      if (!pullRequest || pullRequest.review_snapshot!==true) {
        throw new CoreConflictError(`Unknown governed pull request ${query.repository}#${query.number}`);
      }
      const record=issue(pullRequest.work_item_id);
      if (!record) throw new CoreConflictError("Review pull request has no governed work item");
      const work=structuredClone(record.work);
      const branch=repository.branches.get(pullRequest.head);
      work.physical_branch={exists:true,head_sha:branch.head_sha};
      work.pull_request={state:"READY",head_sha:pullRequest.head_sha,merged_sha:null};
      work.review=pullRequest.recorded_result===null ? null : {
        verdict:pullRequest.recorded_result.verdict,
        reviewed_revision:pullRequest.recorded_result.reviewed_revision,
      };
      work.checks=structuredClone(pullRequest.checks);
      const projectEvidence=reviewProjects.get(`${query.repository}#${query.number}`);
      return copy({
        kind:"review",source:source(query.repository,pullRequest.revision),
        pullRequest:{
          repository:query.repository,number:pullRequest.number,revision:pullRequest.revision,
          head_repository:pullRequest.head_repository,base_repository:pullRequest.base_repository,
          head:pullRequest.head,base:pullRequest.base,head_sha:pullRequest.head_sha,
          body:pullRequest.body,formal_review:pullRequest.formal_review,
          recorded_result:pullRequest.recorded_result,checks:pullRequest.checks,work,
        },
        implementationIdentity:pullRequest.implementation_identity,
        project:projectEvidence,
      },"review snapshot");
    }
    throw new CoreValidationError(`Unknown fake GitHub snapshot query ${String(query.kind)}`);
  }

  function currentRevision(operation) {
    if (operation.resource==="project") return project.revision;
    if (operation.resource==="branch") return repo(operation.repository).revision;
    if (operation.resource==="pull_request") {
      const existing=operation.payload.kind==="review-record"
        ? repo(operation.repository).pullRequests.get(operation.payload.pull_request_number)
        : [...repo(operation.repository).pullRequests.values()].find(value =>
          value.work_item_id===operation.payload.work_item_id);
      return existing?.revision ?? repo(operation.repository).revision;
    }
    if (operation.resource==="issue" && ["dependency-add","dependency-remove"].includes(operation.payload.kind)) {
      return dependency.revision;
    }
    return repo(operation.repository).revision;
  }

  async function inspect(operationsInput) {
    const operations=copy(operationsInput,"fake GitHub inspected operations");
    if (!Array.isArray(operations)) throw new CoreValidationError("Fake GitHub inspect requires operations");
    calls.push(copy({method:"inspect",operations},"fake GitHub call"));
    const observations=operations.map(operationInput => {
      const operation=assertPortOperation(operationInput);
      return {
        operation_id:operation.operation_id,
        repository:operation.repository,
        revision:currentRevision(operation),
      };
    });
    if (failureMode==="missing-inspection") observations.pop();
    if (failureMode==="duplicate-inspection" && observations.length>0) observations.push(observations[0]);
    return copy(observations,"fake GitHub inspection observations");
  }

  function applyIssueCreate(operation) {
    const repository=repo(operation.repository);
    const payload=operation.payload;
    exact(payload,["kind","request_identity","marker","title","description","priority","change_class","labels","affected_version","scope","work"],"managed work issue payload");
    const number=payload.work.item.issue_number;
    if (number!==repository.nextIssueNumber || repository.issues.has(number)) {
      throw new CoreConflictError("Reserved issue number conflicts with current repository state");
    }
    if ([...repository.issues.values()].some(value => value.marker===payload.marker || value.request_identity===payload.request_identity)) {
      throw new CoreConflictError("Managed request identity or marker already exists");
    }
    const record={
      request_identity:payload.request_identity,marker:payload.marker,title:payload.title,
      description:payload.description,priority:payload.priority,change_class:payload.change_class,
      labels:payload.labels,affected_version:payload.affected_version,
      scope:payload.scope,work:structuredClone(payload.work),revision:`issue-${number}-1`,projected:false,
    };
    repository.issues.set(number,record);
    repository.nextIssueNumber+=1;
    repository.revision=bump("repository",repository.revision);
    return repository.revision;
  }

  function applyReviewFollowUp(operation) {
    const repository=repo(operation.repository);
    const payload=operation.payload;
    exact(payload,[
      "kind","issue_id","review_id","finding_id","marker","title","summary",
      "reserved_branch","work_item","source_pull_request","source_revision","review_context",
    ],"review follow-up issue payload");
    const identity=parseWorkItemId(payload.issue_id);
    if (identity.repository!==operation.repository ||
        identity.issueNumber!==payload.work_item.issue_number ||
        !repository.reviewReservations.has(identity.issueNumber) ||
        repository.reviewFollowUps.has(identity.issueNumber)) {
      throw new CoreConflictError("Review follow-up reservation conflicts with repository state");
    }
    repository.reviewFollowUps.set(identity.issueNumber,{
      issue_id:payload.issue_id,review_id:payload.review_id,finding_id:payload.finding_id,
      marker:payload.marker,title:payload.title,summary:payload.summary,
      reserved_branch:payload.reserved_branch,work_item:structuredClone(payload.work_item),
      revision:`issue-${identity.issueNumber}-1`,projected:false,
    });
    repository.reviewReservations.delete(identity.issueNumber);
    repository.nextIssueNumber=Math.max(repository.nextIssueNumber,identity.issueNumber+1);
    repository.revision=bump("repository",repository.revision);
    return repository.revision;
  }

  function applyProject(operation) {
    const payload=operation.payload;
    if (payload.kind==="work-item-membership") {
      exact(payload,["kind","project_id","work_item_id","fields"],"Project membership payload");
      const record=issue(payload.work_item_id);
      if (!record) throw new CoreConflictError("Project membership references a missing issue");
      if (record.projected) throw new CoreConflictError("Project membership already exists");
      record.projected=true;
      record.visible_project_fields=structuredClone(payload.fields);
      record.work.project.fields=Object.fromEntries(
        ["Status","Gate","branch","base_branch","last_reconciled_at"].map(key => [key,payload.fields[key]]),
      );
    } else if (payload.kind==="work-state" || payload.kind==="review-work-state") {
      if (payload.kind==="review-work-state") {
        exact(payload,["kind","project_id","item_id","fields","review_context"],"Review Project state payload");
      } else {
        exact(payload,["kind","project_id","item_id","fields"],"Project state payload");
      }
      const record=[...repositories.values()].flatMap(value => [...value.issues.values()])
        .find(value => value.work.project.item_id===payload.item_id);
      if (!record) throw new CoreConflictError("Project update references a missing item");
      Object.assign(record.work.project.fields,structuredClone(payload.fields));
      Object.assign(record.visible_project_fields ??= {},structuredClone(payload.fields));
    } else if (payload.kind==="review-follow-up-membership") {
      exact(payload,[
        "kind","project_id","issue_id","review_id","finding_id","marker","reserved_branch",
        "fields","review_context",
      ],"Review follow-up Project membership payload");
      const identity=parseWorkItemId(payload.issue_id);
      const followUp=repo(identity.repository).reviewFollowUps.get(identity.issueNumber);
      if (!followUp || followUp.projected || followUp.marker!==payload.marker ||
          payload.project_id!==project.id) {
        throw new CoreConflictError("Review follow-up Project membership conflicts");
      }
      followUp.projected=true;
      followUp.project_fields=structuredClone(payload.fields);
      const projectEvidence=reviewProjects.get(payload.review_context.review_result.repository+
        `#${payload.review_context.review_result.pull_request_number}`);
      if (!projectEvidence) throw new CoreConflictError("Review follow-up has no Project evidence owner");
      projectEvidence.follow_up_mappings.push({
        review_id:payload.review_id,finding_id:payload.finding_id,issue_id:payload.issue_id,
        repository:identity.repository,project_id:payload.project_id,
        project_item_id:`PVTI_REVIEW_${identity.issueNumber}`,
        issue_revision:followUp.revision,project_revision:project.revision,marker:payload.marker,
      });
      projectEvidence.reservations=projectEvidence.reservations.filter(value =>
        value.finding_id!==payload.finding_id);
    } else {
      throw new CoreValidationError("Unsupported fake Project operation");
    }
    project.revision=bump("project",project.revision);
    for (const repository of repositories.values()) {
      for (const record of repository.issues.values()) record.work.project.revision=project.revision;
    }
    return project.revision;
  }

  function applyReviewPullRequest(operation) {
    const repository=repo(operation.repository);
    const payload=operation.payload;
    exact(payload,[
      "kind","pull_request_number","head_sha","body","formal_review","review_result",
      "implementation_identity","checks",
    ],"review pull request payload");
    const pullRequest=repository.pullRequests.get(payload.pull_request_number);
    if (!pullRequest || !pullRequest.review_snapshot || pullRequest.head_sha!==payload.head_sha) {
      throw new CoreConflictError("Review pull request head is stale or unmanaged");
    }
    if (!new Set(["APPROVE","REQUEST_CHANGES"]).has(payload.formal_review.action)) {
      throw new CoreValidationError("Formal review action is invalid");
    }
    pullRequest.body=payload.body;
    pullRequest.formal_review={
      state:payload.formal_review.action==="APPROVE" ? "APPROVED" : "CHANGES_REQUESTED",
      review_id:payload.formal_review.review_id,
      reviewed_revision:payload.formal_review.reviewed_revision,
    };
    pullRequest.recorded_result=structuredClone(payload.review_result);
    pullRequest.implementation_identity=structuredClone(payload.implementation_identity);
    pullRequest.checks=structuredClone(payload.checks);
    pullRequest.revision=bump("pull-request",pullRequest.revision);
    const record=issue(pullRequest.work_item_id);
    record.work.review={
      verdict:payload.review_result.verdict,
      reviewed_revision:payload.review_result.reviewed_revision,
    };
    record.work.checks=structuredClone(payload.checks);
    return pullRequest.revision;
  }

  function applyBranch(operation) {
    const repository=repo(operation.repository);
    const payload=operation.payload;
    exact(payload,["kind","work_item_id","name","base_branch","source_sha"],"work branch payload");
    const existing=repository.branches.get(payload.name);
    if (existing) {
      if (existing.base_branch!==payload.base_branch || existing.head_sha!==payload.source_sha) {
        throw new CoreConflictError("Existing branch conflicts with requested base or source head");
      }
      return existing.revision;
    }
    const base=repository.branches.get(payload.base_branch);
    if (!base || base.head_sha!==payload.source_sha) throw new CoreConflictError("Branch base head is stale");
    const record=issue(payload.work_item_id);
    if (!record || record.work.item.branch!==payload.name || record.work.item.base_branch!==payload.base_branch) {
      throw new CoreConflictError("Branch identity conflicts with governed work evidence");
    }
    const branch={name:payload.name,base_branch:payload.base_branch,head_sha:payload.source_sha,revision:"branch-1"};
    repository.branches.set(payload.name,branch);
    repository.revision=bump("repository",repository.revision);
    return repository.revision;
  }

  function applyPullRequest(operation) {
    const repository=repo(operation.repository);
    const payload=operation.payload;
    exact(payload,["kind","work_item_id","head","base","head_sha","draft"],"work pull request payload");
    const branch=repository.branches.get(payload.head);
    if (!branch || branch.head_sha!==payload.head_sha) throw new CoreConflictError("Pull request head is stale");
    const existing=[...repository.pullRequests.values()].find(value => value.work_item_id===payload.work_item_id);
    if (existing) {
      if (existing.base!==payload.base || existing.head!==payload.head) throw new CoreConflictError("Existing pull request base or head conflicts");
      existing.head_sha=payload.head_sha;
      existing.revision=bump("pull-request",existing.revision);
      return existing.revision;
    }
    const number=repository.nextPullRequestNumber++;
    repository.pullRequests.set(number,{
      number,work_item_id:payload.work_item_id,head_repository:operation.repository,
      base_repository:operation.repository,head:payload.head,base:payload.base,
      head_sha:payload.head_sha,state:payload.draft ? "DRAFT" : "READY",
      merged_sha:null,revision:"pull-request-1",
    });
    repository.revision=bump("repository",repository.revision);
    return repository.revision;
  }

  function applyDependency(operation) {
    const payload=operation.payload;
    if (payload.kind==="dependency-add") {
      exact(payload,["kind","edge","relationship"],"dependency add payload");
      if (dependency.tombstones.has(payload.edge.edge_id)) {
        throw new CoreConflictError("Removed dependency identity cannot be re-added");
      }
      if (dependency.edges.has(payload.edge.edge_id) || dependency.relationships.has(payload.edge.edge_id)) {
        throw new CoreConflictError("Dependency already exists");
      }
      dependency.edges.set(payload.edge.edge_id,structuredClone(payload.edge));
      dependency.relationships.set(payload.edge.edge_id,structuredClone(payload.relationship));
    } else if (payload.kind==="dependency-remove") {
      exact(payload,["kind","tombstone"],"dependency remove payload");
      const edge=dependency.edges.get(payload.tombstone.edge_id);
      if (!edge || edge.revision!==payload.tombstone.prior_revision) throw new CoreConflictError("Dependency removal is stale");
      dependency.edges.delete(edge.edge_id);
      dependency.relationships.delete(edge.edge_id);
      dependency.tombstones.set(edge.edge_id,structuredClone(payload.tombstone));
    } else throw new CoreValidationError("Unsupported fake dependency operation");
    dependency.revision=bump("dependency",dependency.revision);
    return dependency.revision;
  }

  async function apply(operationsInput,applyOptions) {
    const operations=copy(operationsInput,"fake GitHub applied operations");
    if (!Array.isArray(operations)) throw new CoreValidationError("Fake GitHub apply requires operations");
    const optionsValue=copy(applyOptions,"fake GitHub apply options");
    exact(optionsValue,["idempotencyKey"],"fake GitHub apply options");
    if (typeof optionsValue.idempotencyKey!=="string" || !/^[a-f0-9]{64}$/u.test(optionsValue.idempotencyKey)) {
      throw new CoreValidationError("Fake GitHub idempotency key must be a SHA-256 digest");
    }
    calls.push(copy({method:"apply",operations,idempotencyKey:optionsValue.idempotencyKey},"fake GitHub call"));
    if (appliedKeys.has(optionsValue.idempotencyKey)) return appliedKeys.get(optionsValue.idempotencyKey);
    const values=operations.map(assertPortOperation);
    for (const operation of values) {
      if (currentRevision(operation)!==operation.expected_revision) {
        throw new CoreConflictError(`Fake GitHub stale expected revision for ${operation.operation_id}`);
      }
    }
    if (failureMode==="throw-apply") throw new Error("injected fake GitHub apply failure");
    const observations=[];
    for (const operation of values) {
      let revision;
      if (operation.resource==="issue" && operation.action==="create" &&
          operation.payload.kind==="review-minor-follow-up") revision=applyReviewFollowUp(operation);
      else if (operation.resource==="issue" && operation.action==="create") revision=applyIssueCreate(operation);
      else if (operation.resource==="project") revision=applyProject(operation);
      else if (operation.resource==="branch" && operation.action==="create") revision=applyBranch(operation);
      else if (operation.resource==="pull_request" && operation.action==="update" &&
          operation.payload.kind==="review-record") revision=applyReviewPullRequest(operation);
      else if (operation.resource==="pull_request" && ["create","update"].includes(operation.action)) revision=applyPullRequest(operation);
      else if (operation.resource==="issue" && operation.action==="update") revision=applyDependency(operation);
      else throw new CoreValidationError(`Unsupported fake GitHub operation ${operation.resource}.${operation.action}`);
      observations.push({operation_id:operation.operation_id,repository:operation.repository,revision});
    }
    for (const evidence of reviewProjects.values()) {
      evidence.revision=project.revision;
      for (const mapping of evidence.follow_up_mappings) mapping.project_revision=project.revision;
      for (const reservation of evidence.reservations) reservation.project_revision=project.revision;
    }
    if (failureMode==="missing-apply-observation") observations.pop();
    if (failureMode==="duplicate-apply-observation" && observations.length>0) observations.push(observations[0]);
    const result=copy({status:"completed",observed_revisions:observations},"fake GitHub apply result");
    appliedKeys.set(optionsValue.idempotencyKey,result);
    return result;
  }

  function seedWork(snapshotInput,{title="Seeded work",description="Seeded work description",marker=null}={}) {
    const work=structuredClone(copy(snapshotInput,"seeded work snapshot"));
    const identity=parseWorkItemId(work.item.id);
    const repository=repo(identity.repository);
    const number=identity.issueNumber;
    repository.nextIssueNumber=Math.max(repository.nextIssueNumber,number+1);
    repository.issues.set(number,{
      request_identity:`seed-${work.item.id}`,marker:marker ?? `<!-- toss-core:seed:${sha256Canonical(work.item.id)} -->`,
      title,description,labels:work.item.kind==="epic" ? ["epic"] : [work.item.kind],
      priority:null,change_class:null,affected_version:null,scope:[],work,
      revision:`issue-${number}-1`,projected:true,visible_project_fields:{
        ...work.project.fields,repository:work.item.repository,parent:work.item.parent_id,milestone:work.item.milestone,
      },
    });
    if (work.release.assigned && work.release.branch) {
      repository.branches.set(work.release.branch,{name:work.release.branch,base_branch:"main",head_sha:"1".repeat(40),revision:work.release.revision});
    }
    if (work.parent) {
      repository.branches.set(work.parent.branch,{name:work.parent.branch,base_branch:"release/v2.2.0",head_sha:"2".repeat(40),revision:work.parent.revision});
    }
    if (work.physical_branch.exists) {
      repository.branches.set(work.item.branch,{name:work.item.branch,base_branch:work.item.base_branch,head_sha:work.physical_branch.head_sha,revision:"branch-1"});
    }
    return work.item.id;
  }

  function seedReviewPullRequest(input) {
    const value=copy(input,"seeded review pull request");
    exact(value,["pullRequest","result","implementationIdentity","project"],"seeded review pull request");
    const pullRequest=value.pullRequest;
    seedWork(pullRequest.work);
    const repository=repo(pullRequest.repository);
    repository.pullRequests.set(pullRequest.number,{
      number:pullRequest.number,work_item_id:pullRequest.work.item.id,
      head_repository:pullRequest.head_repository,base_repository:pullRequest.base_repository,
      head:pullRequest.head,base:pullRequest.base,head_sha:pullRequest.head_sha,
      state:"READY",merged_sha:null,revision:pullRequest.revision,
      body:pullRequest.body,formal_review:structuredClone(pullRequest.formal_review),
      recorded_result:structuredClone(pullRequest.recorded_result),
      checks:structuredClone(pullRequest.checks),
      implementation_identity:structuredClone(value.implementationIdentity),review_snapshot:true,
    });
    repository.nextPullRequestNumber=Math.max(repository.nextPullRequestNumber,pullRequest.number+1);
    reviewProjects.set(`${pullRequest.repository}#${pullRequest.number}`,structuredClone(value.project));
    const reservedNumbers=value.project.reservations
      .filter(candidate => candidate.repository===pullRequest.repository)
      .map(candidate => candidate.issue_number);
    for (const number of reservedNumbers) repository.reviewReservations.add(number);
    return `${pullRequest.repository}#${pullRequest.number}`;
  }

  function setFailureMode(mode) { failureMode=mode; }
  function setRepositoryRevision(repository,revision) { repo(repository).revision=revision; }
  function setBranchHead(repository,name,headSha) {
    if (!SHA.test(headSha)) throw new TypeError("head must be a lowercase 40-character SHA");
    const branch=repo(repository).branches.get(name);
    if (!branch) throw new TypeError("branch does not exist");
    branch.head_sha=headSha;
    branch.revision=bump("branch",branch.revision);
  }
  function setPullRequestHead(repositoryName,number,headSha,{checks="PENDING",reconcileProject=false}={}) {
    if (!SHA.test(headSha) || !new Set(["PENDING","PASSED","FAILED"]).has(checks)) {
      throw new TypeError("review pull request head/checks are invalid");
    }
    const repository=repo(repositoryName);
    const pullRequest=repository.pullRequests.get(number);
    if (!pullRequest?.review_snapshot) throw new TypeError("review pull request does not exist");
    const branch=repository.branches.get(pullRequest.head);
    branch.head_sha=headSha;
    branch.revision=bump("branch",branch.revision);
    pullRequest.head_sha=headSha;
    pullRequest.checks={state:checks,revision:headSha};
    pullRequest.revision=bump("pull-request",pullRequest.revision);
    pullRequest.implementation_identity.revision=headSha;
    if (!pullRequest.implementation_identity.commits.some(value => value.revision===headSha)) {
      pullRequest.implementation_identity.commits.push({
        revision:headSha,author:pullRequest.implementation_identity.pull_request_author,
        committer:pullRequest.implementation_identity.pull_request_author,
      });
    }
    const record=issue(pullRequest.work_item_id);
    record.work.physical_branch={exists:true,head_sha:headSha};
    record.work.pull_request={state:"READY",head_sha:headSha,merged_sha:null};
    record.work.checks={state:checks,revision:headSha};
    if (reconcileProject) {
      record.work.project.fields.Status="In review";
      record.work.project.fields.Gate="REVIEW_REQUIRED";
      project.revision=bump("project",project.revision);
      for (const repositoryValue of repositories.values()) {
        for (const issueRecord of repositoryValue.issues.values()) {
          issueRecord.work.project.revision=project.revision;
        }
      }
      for (const evidence of reviewProjects.values()) {
        evidence.revision=project.revision;
        for (const mapping of evidence.follow_up_mappings) mapping.project_revision=project.revision;
        for (const reserved of evidence.reservations) reserved.project_revision=project.revision;
      }
    }
  }
  function view() {
    return copy({
      project,
      repositories:[...repositories.values()].map(value => ({
        repository:value.repository,revision:value.revision,next_issue_number:value.nextIssueNumber,
        issues:[...value.issues.values()],branches:[...value.branches.values()],
        pull_requests:[...value.pullRequests.values()],
        review_follow_ups:[...value.reviewFollowUps.values()],
      })).sort((left,right) => compare(left.repository,right.repository)),
      dependency:{revision:dependency.revision,edges:[...dependency.edges.values()],relationships:[...dependency.relationships.values()],tombstones:[...dependency.tombstones.values()]},
      review_projects:[...reviewProjects.entries()].map(([pull_request,value]) => ({pull_request,...value})),
      calls,
    },"fake GitHub fixture view");
  }

  const github=Object.freeze({snapshot,inspect,apply});
  return Object.freeze({
    github,seedWork,seedReviewPullRequest,setFailureMode,setRepositoryRevision,setBranchHead,
    setPullRequestHead,view,
  });
}

export const CORE_GITHUB_FIXTURE_SOURCE_SHA=SOURCE_SHA;
