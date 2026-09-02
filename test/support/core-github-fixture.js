import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../src/contracts/acp.js";
import {closedData,exact} from "../../src/core/commands/common.js";
import {validateCoreDocument} from "../../src/core/contracts.js";
import {dependencyReadiness,validateDependencyGraph} from "../../src/core/domain/dependencies.js";
import {parseWorkItemId,workItemId} from "../../src/core/domain/identity.js";
import {deriveWorkItemState} from "../../src/core/domain/state.js";
import {CoreConflictError,CoreValidationError} from "../../src/core/errors.js";
import {reviewObservationRevision} from "../../src/core/review/recorder.js";

const SHA=/^[a-f0-9]{40}$/u;
const STABLE_VERSION=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const PROJECT_ID="PVT_TOSS_OS_2";
const SOURCE_SHA="a".repeat(64);
const REVIEW_RESERVATION_KEYS=Object.freeze([
  "review_id","finding_id","source_pull_request_repository","source_pull_request_number",
  "source_pull_request_revision","source_pull_request_head","reviewed_repository",
  "project_id","project_item_id","project_revision","issue_number","repository",
  "repository_revision",
]);

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
    repository:item.repository,
    parent:item.parent_id,
    milestone:item.milestone,
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
  const reviewReservationOwners=new Map();
  const calls=[];
  const appliedKeys=new Map();
  let failureMode=null;

  function reservationOwner(input) {
    const binding=copy(input,"review reservation owner");
    exact(binding,REVIEW_RESERVATION_KEYS,"review reservation owner");
    const nativeIssueId=workItemId(binding.repository,binding.issue_number);
    return Object.freeze({
      nativeIssueId,binding,digest:sha256Canonical(binding),
    });
  }

  function assertReservationOwners(reservations,{allocate=false,requireExisting=false}={}) {
    const pending=new Map();
    for (const reservation of reservations) {
      const owner=reservationOwner(reservation);
      const existing=pending.get(owner.nativeIssueId) ??
        reviewReservationOwners.get(owner.nativeIssueId);
      if (requireExisting && !existing) {
        throw new CoreConflictError("Review issue reservation has no native owner");
      }
      if (existing && (existing.digest!==owner.digest ||
          canonicalJson(existing.binding)!==canonicalJson(owner.binding))) {
        throw new CoreConflictError("Review issue reservation has a different native owner");
      }
      pending.set(owner.nativeIssueId,owner);
    }
    if (allocate) {
      for (const [nativeIssueId,owner] of pending) reviewReservationOwners.set(nativeIssueId,owner);
    }
  }

  function refreshReservationOwners() {
    const reservations=[...reviewProjects.values()].flatMap(value => value.reservations);
    const next=new Map();
    for (const reservation of reservations) {
      const owner=reservationOwner(reservation);
      const existing=next.get(owner.nativeIssueId);
      if (existing && (existing.digest!==owner.digest ||
          canonicalJson(existing.binding)!==canonicalJson(owner.binding))) {
        throw new CoreConflictError("Review issue reservation has a different native owner");
      }
      next.set(owner.nativeIssueId,owner);
    }
    reviewReservationOwners.clear();
    for (const [nativeIssueId,owner] of next) reviewReservationOwners.set(nativeIssueId,owner);
  }

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

  function bugLineage(record) {
    if (record.work.item.kind!=="bug") return null;
    const match=STABLE_VERSION.exec(record.affected_version ?? "");
    if (!match) throw new CoreConflictError("Governed bug is missing its canonical affected version");
    const patch=Number(match[3]);
    if (!Number.isSafeInteger(patch) || patch===Number.MAX_SAFE_INTEGER) {
      throw new CoreConflictError("Governed bug affected version has no safe patch successor");
    }
    return {classification:"patch",affected_version:record.affected_version,
      patch_version:`${match[1]}.${match[2]}.${patch+1}`};
  }

  function composeWork(record) {
    const identity=parseWorkItemId(record.work.item.id);
    const repository=repo(identity.repository);
    const branch=repository.branches.get(record.work.item.branch) ?? null;
    const pullRequest=[...repository.pullRequests.values()]
      .find(value => value.work_item_id===record.work.item.id) ?? null;
    const work=structuredClone(record.work);
    work.physical_branch=branch===null
      ? {exists:false,head_sha:null}
      : {exists:true,head_sha:branch.head_sha};
    work.pull_request=pullRequest===null ? null : {
      state:pullRequest.state,head_sha:pullRequest.head_sha,merged_sha:pullRequest.merged_sha,
    };
    return work;
  }

  function workSnapshot(kind,id) {
    const record=issue(id);
    if (!record) throw new CoreConflictError(`Unknown governed work item ${id}`);
    const identity=parseWorkItemId(id);
    const repository=repo(identity.repository);
    const branch=repository.branches.get(record.work.item.branch) ?? null;
    const pullRequest=[...repository.pullRequests.values()].find(value => value.work_item_id===id) ?? null;
    const work=composeWork(record);
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
      bug_lineage:bugLineage(record),
    },`${kind} snapshot`);
  }

  function governedWorkEvidence(record) {
    const identity=parseWorkItemId(record.work.item.id);
    const observedWork=composeWork(record);
    return {
      id:record.work.item.id,revision:record.revision,
      source:source(identity.repository,record.revision),work:observedWork,
      native_parent_id:record.native_parent_id ?? null,projected:record.projected===true,
    };
  }

  function epicPullEvidence(repository,nativePull) {
    return nativePull===null ? null : {
      id:`${repository.repository}#${nativePull.number}`,number:nativePull.number,
      revision:nativePull.revision,head_sha:nativePull.head_sha,head:nativePull.head,
      base:nativePull.base,head_repository:nativePull.head_repository,
      base_repository:nativePull.base_repository,state:nativePull.state,merged_sha:nativePull.merged_sha,
    };
  }

  function epicReviewEvidence(nativePull) {
    const result=nativePull?.recorded_result ?? null;
    if (result===null) return null;
    const identities=new Set([
      nativePull.implementation_identity.pull_request_author,
      ...nativePull.implementation_identity.commits.flatMap(commit => [commit.author,commit.committer]),
    ]);
    return {
      id:result.review_id,
      record_revision:reviewObservationRevision({
        native_revision:nativePull.revision,checks:nativePull.checks,
        implementation_identity:nativePull.implementation_identity,
      }),
      reviewed_revision:result.reviewed_revision,verdict:result.verdict,
      independent:result.reviewer.role==="independent-reviewer" && !identities.has(result.reviewer.identity),
      formal:nativePull.formal_review?.state==="APPROVED" &&
        nativePull.formal_review.reviewed_revision===nativePull.head_sha,
      reviewer:result.reviewer.identity,
    };
  }

  function epicChecksEvidence(nativePull) {
    return nativePull?.checks
      ? {...nativePull.checks,observation:sha256Canonical(nativePull.checks)}
      : null;
  }

  function liveAcceptanceBinding(record,nativePull) {
    const repository=repo(record.work.item.repository);
    return {
      epic:{id:record.work.item.id,revision:record.revision},
      plan:{plan_id:record.epic_plan.plan_id,content_sha256:record.epic_plan.content_sha256},
      children:record.epic_plan.children.map(child => ({id:child.id,revision:issue(child.id)?.revision})),
      edges:record.epic_plan.edges.map(edge => ({edge_id:edge.edge_id,revision:dependency.edges.get(edge.edge_id)?.revision})),
      release:record.work.release,pull_request:epicPullEvidence(repository,nativePull),
      review:epicReviewEvidence(nativePull),checks:epicChecksEvidence(nativePull),
      project:{id:project.id,revision:project.revision},policy_revision:"POLICY-0001",
    };
  }

  function recordSemanticallyDone(record) {
    return record?.work.issue_state==="CLOSED" && record.work.item.status==="Done" &&
      record.work.item.gate==="NONE" && record.work.pull_request?.state==="MERGED" &&
      record.work.pull_request.head_sha===record.work.pull_request.merged_sha &&
      record.work.project.fields.Status==="Done" && record.work.project.fields.Gate==="NONE";
  }

  function epicBlockingDependencies(record) {
    return [...new Set(record.epic_plan.edges
      .filter(edge => !recordSemanticallyDone(issue(edge.target)))
      .map(edge => edge.target))].sort(compare);
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
    if (query.kind==="epic-prepare") {
      exact(query,["kind","id"],"epic preparation snapshot query");
      const epicRecord=issue(query.id);
      if (!epicRecord || epicRecord.work.item.kind!=="epic") {
        throw new CoreConflictError(`Unknown governed epic ${query.id}`);
      }
      const repository=repo(epicRecord.work.item.repository);
      const governed=[...repository.issues.values()]
        .filter(record => {
          if (record.native_parent_id===query.id) return true;
          if (!/^<!-- toss-core:managed-child:[a-f0-9]{64} -->$/u.test(record.marker)) return false;
          const nativeParent=record.native_parent_id ?? null;
          const projectParent=record.managed_project_fields?.parent ?? null;
          if (projectParent===query.id) return true;
          if (nativeParent!==null && projectParent!==null && nativeParent===projectParent) return false;
          return true;
        })
        .sort((left,right) => compare(left.work.item.id,right.work.item.id));
      return copy({
        kind:query.kind,source:source(repository.repository,repository.revision),
        epic:composeWork(epicRecord),epic_plan:epicRecord.epic_plan ?? null,
        epic_approval:epicRecord.epic_approval ?? null,
        preparation:{
          revision:repository.revision,
          children:governed.map(record => ({
            marker:record.marker,id:record.work.item.id,repository:record.work.item.repository,
            acceptance_criteria:record.work.item.acceptance_criteria,
            branch:record.work.item.branch,project_fields:record.managed_project_fields,
            revision:record.revision,
          })),
          relationships:governed
            .filter(record => record.native_parent_id!==undefined)
            .map(record => ({child_id:record.work.item.id,parent_id:record.native_parent_id,revision:record.native_parent_revision})),
        },
        dependency:graphSnapshot(null),
      },"epic preparation snapshot");
    }
    if (query.kind==="epic-approval") {
      exact(query,["kind","id"],"epic approval snapshot query");
      const epicRecord=issue(query.id);
      if (!epicRecord || epicRecord.work.item.kind!=="epic" || !epicRecord.epic_plan) {
        throw new CoreConflictError(`Epic ${query.id} has no prepared plan`);
      }
      const repository=repo(epicRecord.work.item.repository);
      const children=epicRecord.epic_plan.children.map(planned => {
        const record=issue(planned.id);
        if (!record || record.native_parent_id!==query.id || record.projected!==true) {
          throw new CoreConflictError(`Prepared epic child ${planned.id} is missing`);
        }
        return governedWorkEvidence(record);
      });
      const edges=epicRecord.epic_plan.edges.map(planned => {
        const edge=dependency.edges.get(planned.edge_id);
        const relationship=dependency.relationships.get(planned.edge_id);
        const target=issue(planned.target);
        if (!edge || !relationship || canonicalJson(edge)!==canonicalJson(planned) ||
            relationship.revision!==planned.revision || !target) {
          throw new CoreConflictError(`Prepared epic dependency ${planned.edge_id} is missing`);
        }
        return {edge_id:planned.edge_id,revision:planned.revision,edge,relationship,target:governedWorkEvidence(target)};
      });
      return copy({
        kind:query.kind,source:source(repository.repository,repository.revision),
        epic:composeWork(epicRecord),epic_revision:epicRecord.revision,
        plan:epicRecord.epic_plan,epic_approval:epicRecord.epic_approval ?? null,
        children,edges,project:{id:project.id,revision:project.revision},
      },"epic approval snapshot");
    }
    if (query.kind==="epic-submit") {
      exact(query,["kind","id"],"epic submit snapshot query");
      const epicRecord=issue(query.id);
      if (!epicRecord || epicRecord.work.item.kind!=="epic" || !epicRecord.epic_plan) {
        throw new CoreConflictError(`Epic ${query.id} has no prepared scope`);
      }
      const repository=repo(epicRecord.work.item.repository);
      const branch=repository.branches.get(epicRecord.work.item.branch) ?? null;
      const pullRequest=[...repository.pullRequests.values()].find(value => value.work_item_id===query.id) ?? null;
      const children=epicRecord.epic_plan.children.flatMap(planned => {
        const record=issue(planned.id);
        return record ? [governedWorkEvidence(record)] : [];
      });
      const edges=epicRecord.epic_plan.edges.flatMap(planned => {
        const edge=dependency.edges.get(planned.edge_id);
        const relationship=dependency.relationships.get(planned.edge_id);
        const target=issue(planned.target);
        return edge && relationship && target
          ? [{edge_id:edge.edge_id,revision:edge.revision,edge,relationship,target:governedWorkEvidence(target)}]
          : [];
      });
      return copy({
        kind:query.kind,source:source(repository.repository,repository.revision),
        epic:composeWork(epicRecord),epic_revision:epicRecord.revision,
        plan:epicRecord.epic_plan,epic_approval:epicRecord.epic_approval ?? null,
        children,edges,release:epicRecord.work.release,
        branch:branch===null ? null : {...branch},
        pull_request:pullRequest===null ? null : {...pullRequest},
        project:{id:project.id,revision:project.revision},
      },"epic submit snapshot");
    }
    if (query.kind==="epic-accept") {
      exact(query,["kind","id"],"epic acceptance snapshot query");
      const epicRecord=issue(query.id);
      if (!epicRecord || epicRecord.work.item.kind!=="epic" || !epicRecord.epic_plan) {
        throw new CoreConflictError(`Epic ${query.id} has no prepared scope`);
      }
      const repository=repo(epicRecord.work.item.repository);
      const nativePull=[...repository.pullRequests.values()].find(value => value.work_item_id===query.id) ?? null;
      const nativeBranch=repository.branches.get(epicRecord.work.item.branch) ?? null;
      const children=epicRecord.epic_plan.children.flatMap(planned => {
        const record=issue(planned.id);
        return record ? [governedWorkEvidence(record)] : [];
      });
      const edges=epicRecord.epic_plan.edges.flatMap(planned => {
        const edge=dependency.edges.get(planned.edge_id);
        const relationship=dependency.relationships.get(planned.edge_id);
        const target=issue(planned.target);
        return edge && relationship && target
          ? [{edge_id:edge.edge_id,revision:edge.revision,edge,relationship,target:governedWorkEvidence(target)}]
          : [];
      });
      const pullRequest=nativePull===null ? null : {
        id:`${repository.repository}#${nativePull.number}`,number:nativePull.number,
        revision:nativePull.revision,head_sha:nativePull.head_sha,head:nativePull.head,
        base:nativePull.base,head_repository:nativePull.head_repository,
        base_repository:nativePull.base_repository,state:nativePull.state,merged_sha:nativePull.merged_sha,
      };
      const result=nativePull?.recorded_result ?? null;
      const identities=new Set(nativePull ? [
        nativePull.implementation_identity.pull_request_author,
        ...nativePull.implementation_identity.commits.flatMap(commit => [commit.author,commit.committer]),
      ] : []);
      const review=result===null ? null : {
        id:result.review_id,
        record_revision:reviewObservationRevision({native_revision:nativePull.revision,checks:nativePull.checks,implementation_identity:nativePull.implementation_identity}),
        reviewed_revision:result.reviewed_revision,verdict:result.verdict,
        independent:result.reviewer.role==="independent-reviewer" && !identities.has(result.reviewer.identity),
        formal:nativePull.formal_review?.state==="APPROVED" && nativePull.formal_review.reviewed_revision===nativePull.head_sha,
        reviewer:result.reviewer.identity,
      };
      const checks=nativePull?.checks ? {...nativePull.checks,observation:sha256Canonical(nativePull.checks)} : null;
      return copy({
        kind:query.kind,source:source(repository.repository,repository.revision),
        epic:composeWork(epicRecord),epic_revision:epicRecord.revision,
        plan:epicRecord.epic_plan,epic_approval:epicRecord.epic_approval ?? null,
        children,edges,release:epicRecord.work.release,
        branch:nativeBranch===null ? null : {...nativeBranch},pull_request:pullRequest,
        review,checks,project:{id:project.id,revision:project.revision},
      },"epic acceptance snapshot");
    }
    if (query.kind==="epic-status") {
      exact(query,["kind","id"],"epic status snapshot query");
      const epicRecord=issue(query.id);
      if (!epicRecord || epicRecord.work.item.kind!=="epic") {
        throw new CoreConflictError(`Unknown governed epic ${query.id}`);
      }
      const repository=repo(epicRecord.work.item.repository);
      const nativePull=[...repository.pullRequests.values()].find(value => value.work_item_id===query.id) ?? null;
      const nativeBranch=repository.branches.get(epicRecord.work.item.branch) ?? null;
      const plan=epicRecord.epic_plan ?? null;
      const children=plan===null ? [] : plan.children.flatMap(planned => {
        const record=issue(planned.id);
        return record ? [governedWorkEvidence(record)] : [];
      });
      const edges=plan===null ? [] : plan.edges.flatMap(planned => {
        const edge=dependency.edges.get(planned.edge_id);
        const relationship=dependency.relationships.get(planned.edge_id);
        const target=issue(planned.target);
        return edge && relationship && target
          ? [{edge_id:edge.edge_id,revision:edge.revision,edge,relationship,target:governedWorkEvidence(target)}]
          : [];
      });
      const pullRequest=nativePull===null ? null : {id:`${repository.repository}#${nativePull.number}`,number:nativePull.number,revision:nativePull.revision,head_sha:nativePull.head_sha,head:nativePull.head,base:nativePull.base,head_repository:nativePull.head_repository,base_repository:nativePull.base_repository,state:nativePull.state,merged_sha:nativePull.merged_sha};
      const result=nativePull?.recorded_result ?? null;
      const identities=new Set(nativePull?.implementation_identity ? [nativePull.implementation_identity.pull_request_author,...nativePull.implementation_identity.commits.flatMap(commit => [commit.author,commit.committer])] : []);
      const review=result===null ? null : {id:result.review_id,record_revision:reviewObservationRevision({native_revision:nativePull.revision,checks:nativePull.checks,implementation_identity:nativePull.implementation_identity}),reviewed_revision:result.reviewed_revision,verdict:result.verdict,independent:result.reviewer.role==="independent-reviewer" && !identities.has(result.reviewer.identity),formal:nativePull.formal_review?.state==="APPROVED" && nativePull.formal_review.reviewed_revision===nativePull.head_sha,reviewer:result.reviewer.identity};
      const checks=nativePull?.checks ? {...nativePull.checks,observation:sha256Canonical(nativePull.checks)} : null;
      return copy({kind:query.kind,source:source(repository.repository,repository.revision),epic:composeWork(epicRecord),epic_revision:epicRecord.revision,plan,epic_approval:epicRecord.epic_approval ?? null,children,edges,release:epicRecord.work.release,branch:nativeBranch===null ? null : {...nativeBranch},pull_request:pullRequest,review,checks,project:{id:project.id,revision:project.revision}},"epic status snapshot");
    }
    if (query.kind==="work-item") {
      exact(query,["kind","id"],"work snapshot query");
      const record=issue(query.id);
      if (!record) throw new CoreConflictError(`Unknown governed work item ${query.id}`);
      const identity=parseWorkItemId(query.id);
      return copy({kind:query.kind,source:source(identity.repository,repo(identity.repository).revision),
        work:composeWork(record),bug_lineage:bugLineage(record)},"work snapshot");
    }
    if (query.kind==="issue-start" || query.kind==="issue-submit") {
      exact(query,["kind","id"],"work mutation snapshot query");
      return workSnapshot(query.kind,query.id);
    }
    if (query.kind==="dependency-mutation") {
      exact(query,["kind","source","target"],"dependency mutation snapshot query");
      const sourceRecord=issue(query.source);
      const targetRecord=issue(query.target);
      if (!sourceRecord || !targetRecord) {
        throw new CoreConflictError("Dependency mutation requires exact existing source and target work");
      }
      const graph=graphSnapshot(null);
      return copy({...graph,kind:query.kind,mutation:{
        source:query.source,target:query.target,revision:sourceRecord.revision,
        work:governedWorkEvidence(sourceRecord).work,
      }},"dependency mutation snapshot");
    }
    if (query.kind==="dependency-graph") {
      exact(query,["kind","root"],"dependency snapshot query");
      return graphSnapshot(query.root);
    }
    if (query.kind==="review") {
      const requestsReservations=Object.hasOwn(query,"review_id") ||
        Object.hasOwn(query,"unresolved_minor_finding_ids");
      exact(query,requestsReservations
        ? ["kind","repository","number","review_id","unresolved_minor_finding_ids"]
        : ["kind","repository","number"],"review snapshot query");
      if (requestsReservations &&
          (!Array.isArray(query.unresolved_minor_finding_ids) ||
           query.unresolved_minor_finding_ids.some((value,index,values) =>
             typeof value!=="string" || (index>0 && values[index-1]>=value)))) {
        throw new CoreValidationError("Review reservation query findings must be unique canonical order");
      }
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
      const storedProjectEvidence=reviewProjects.get(`${query.repository}#${query.number}`);
      if (requestsReservations) {
        assertReservationOwners(storedProjectEvidence.reservations,{requireExisting:true});
        const requested=storedProjectEvidence.reservations.filter(value =>
          value.review_id===query.review_id &&
          query.unresolved_minor_finding_ids.includes(value.finding_id));
        const allReservations=[...reviewProjects.values()]
          .flatMap(value => value.reservations);
        if (requested.some(candidate => allReservations.some(other =>
          other.repository===candidate.repository &&
          other.issue_number===candidate.issue_number &&
          other.review_id!==candidate.review_id))) {
          throw new CoreConflictError("Review issue reservation is shared across review identities");
        }
      }
      const projectEvidence=requestsReservations ? {
        ...storedProjectEvidence,
        reservations:storedProjectEvidence.reservations.filter(value =>
          value.review_id===query.review_id &&
          query.unresolved_minor_finding_ids.includes(value.finding_id)),
      } : {...storedProjectEvidence,reservations:[]};
      const observationRevision=reviewObservationRevision({
        native_revision:pullRequest.revision,checks:pullRequest.checks,
        implementation_identity:pullRequest.implementation_identity,
      });
      const pullRequestEvidence={
        repository:query.repository,number:pullRequest.number,
        native_revision:pullRequest.revision,revision:observationRevision,
        head_repository:pullRequest.head_repository,base_repository:pullRequest.base_repository,
        head:pullRequest.head,base:pullRequest.base,head_sha:pullRequest.head_sha,
        body:pullRequest.body,formal_review:pullRequest.formal_review,
        recorded_result:pullRequest.recorded_result,checks:pullRequest.checks,work,
      };
      const semantic={
        kind:"review",pullRequest:pullRequestEvidence,
        implementationIdentity:pullRequest.implementation_identity,project:projectEvidence,
      };
      return copy({
        kind:"review",source:{
          repository:query.repository,revision:observationRevision,
          sha256:sha256Canonical(semantic),
        },
        pullRequest:pullRequestEvidence,
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
        : operation.payload.kind==="epic-accept"
          ? [...repo(operation.repository).pullRequests.values()].find(value =>
            value.work_item_id===operation.payload.epic_id)
        : [...repo(operation.repository).pullRequests.values()].find(value =>
          value.work_item_id===operation.payload.work_item_id);
      if (operation.payload.kind==="review-record" && existing) {
        return reviewObservationRevision({
          native_revision:existing.revision,checks:existing.checks,
          implementation_identity:existing.implementation_identity,
        });
      }
      return existing?.revision ?? repo(operation.repository).revision;
    }
    if (operation.resource==="issue" && ["dependency-add","dependency-remove"].includes(operation.payload.kind)) {
      return dependency.revision;
    }
    if (operation.resource==="issue" && operation.payload.kind==="dependency-work-state") {
      return issue(operation.payload.work.item.id)?.revision ?? repo(operation.repository).revision;
    }
    if (operation.resource==="issue" && Object.hasOwn(operation.payload,"native_parent_id")) {
      return operation.action==="create"
        ? repo(operation.repository).revision
        : issue(operation.payload.work_item_id)?.revision ?? repo(operation.repository).revision;
    }
    if (operation.resource==="issue" && operation.payload.kind==="epic-approve") {
      return issue(operation.payload.work.item.id)?.revision ?? repo(operation.repository).revision;
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

  function applyManagedChild(operation) {
    const repository=repo(operation.repository);
    const payload=operation.payload;
    exact(payload,[
      "marker","work_item_id","native_issue_number","native_parent_id",
      "acceptance_criteria","reserved_branch","project",
    ],"managed epic child payload");
    exact(payload.project,["membership","fields"],"managed epic child Project payload");
    exact(payload.project.fields,[
      "status","gate","repository","parent","branch","base_branch","milestone",
    ],"managed epic child Project fields");
    const identity=parseWorkItemId(payload.work_item_id);
    const parent=issue(payload.native_parent_id);
    if (payload.project.membership!=="TOSS OS" || identity.repository!==operation.repository ||
        identity.issueNumber!==payload.native_issue_number || !parent ||
        parent.work.item.kind!=="epic" || parent.work.item.id!==payload.native_parent_id ||
        payload.project.fields.repository!==operation.repository ||
        payload.project.fields.parent!==payload.native_parent_id ||
        payload.project.fields.branch!==payload.reserved_branch ||
        payload.project.fields.base_branch!==parent.work.item.branch ||
        payload.project.fields.milestone!==null) {
      throw new CoreConflictError("Managed epic child identity or governing evidence conflicts");
    }
    const item={
      schema_version:"work-item.v1",id:payload.work_item_id,repository:operation.repository,
      issue_number:payload.native_issue_number,kind:"issue",parent_id:payload.native_parent_id,
      acceptance_criteria:structuredClone(payload.acceptance_criteria),branch:payload.reserved_branch,
      base_branch:payload.project.fields.base_branch,milestone:null,
      status:payload.project.fields.status,gate:payload.project.fields.gate,
    };
    validateCoreDocument(item,"work-item.v1");
    const existing=repository.issues.get(identity.issueNumber);
    if (operation.action==="create") {
      if (existing ||
          [...repository.issues.values()].some(record => record.marker===payload.marker)) {
        throw new CoreConflictError("Managed epic child reservation conflicts with repository state");
      }
      const at=parent.work.project.fields.last_reconciled_at;
      const childWork=initialWork(item,`PVTI_MANAGED_${identity.issueNumber}`,project.revision,at);
      childWork.parent={id:parent.work.item.id,branch:parent.work.item.branch,revision:parent.revision};
      repository.issues.set(identity.issueNumber,{
        request_identity:`managed-${sha256Canonical({work_item_id:item.id})}`,marker:payload.marker,
        title:`Managed child ${item.id}`,description:item.acceptance_criteria.join("\n"),
        priority:null,change_class:null,labels:["issue"],affected_version:null,scope:[],work:childWork,
        revision:`issue-${identity.issueNumber}-1`,projected:true,
      });
      repository.nextIssueNumber=Math.max(repository.nextIssueNumber,identity.issueNumber+1);
    } else if (operation.action==="update") {
      if (!existing || existing.marker!==payload.marker || existing.native_parent_id!==payload.native_parent_id) {
        throw new CoreConflictError("Managed epic child update conflicts with native identity");
      }
      existing.work.item=structuredClone(item);
      existing.work.parent={id:parent.work.item.id,branch:parent.work.item.branch,revision:parent.revision};
      existing.revision=bump(`issue-${identity.issueNumber}`,existing.revision);
    } else {
      throw new CoreValidationError("Unsupported managed epic child operation");
    }
    const record=repository.issues.get(identity.issueNumber);
    record.native_parent_id=payload.native_parent_id;
    record.native_parent_revision=record.revision;
    record.managed_project_fields=structuredClone(payload.project.fields);
    record.visible_project_fields={
      Status:item.status,Gate:item.gate,repository:item.repository,parent:item.parent_id,
      branch:item.branch,base_branch:item.base_branch,milestone:item.milestone,
      last_reconciled_at:record.work.project.fields.last_reconciled_at,
    };
    repository.revision=bump("repository",repository.revision);
    project.revision=bump("project",project.revision);
    for (const repositoryValue of repositories.values()) {
      for (const issueRecord of repositoryValue.issues.values()) issueRecord.work.project.revision=project.revision;
    }
    return repository.revision;
  }

  function applyEpicPrepare(operation) {
    const payload=operation.payload;
    exact(payload,["kind","plan","work"],"epic preparation payload");
    if (failureMode==="fail-epic-prepare-after-child") {
      throw new Error("injected epic preparation failure after managed child creation");
    }
    const record=issue(payload.plan.epic.id);
    if (!record || record.work.item.kind!=="epic" ||
        record.work.item.id!==payload.work.item.id ||
        payload.plan.epic.id!==payload.work.item.id) {
      throw new CoreConflictError("Epic preparation payload conflicts with native epic identity");
    }
    for (const plannedChild of payload.plan.children) {
      const childRecord=issue(plannedChild.id);
      if (!childRecord || childRecord.native_parent_id!==record.work.item.id ||
          canonicalJson(childRecord.work.item)!==canonicalJson(plannedChild) ||
          childRecord.projected!==true) {
        throw new CoreConflictError("Epic preparation has missing or conflicting governed child evidence");
      }
    }
    for (const plannedEdge of payload.plan.edges) {
      const edge=dependency.edges.get(plannedEdge.edge_id);
      const relationship=dependency.relationships.get(plannedEdge.edge_id);
      if (!edge || !relationship || canonicalJson(edge)!==canonicalJson(plannedEdge) ||
          relationship.source!==plannedEdge.source || relationship.target!==plannedEdge.target ||
          relationship.revision!==plannedEdge.revision) {
        throw new CoreConflictError("Epic preparation has missing or conflicting dependency evidence");
      }
    }
    record.epic_plan=structuredClone(payload.plan);
    record.work=structuredClone(payload.work);
    Object.assign(record.visible_project_fields ??= {},{
      Status:payload.work.item.status,Gate:payload.work.item.gate,
      branch:payload.work.item.branch,base_branch:payload.work.item.base_branch,
      last_reconciled_at:payload.work.project.fields.last_reconciled_at,
    });
    record.revision=bump(`issue-${record.work.item.issue_number}`,record.revision);
    const repository=repo(operation.repository);
    repository.revision=bump("repository",repository.revision);
    return repository.revision;
  }

  function applyEpicApprove(operation) {
    const payload=operation.payload;
    exact(payload,["kind","authority_binding","plan","work"],"epic approval payload");
    const record=issue(payload.work.item.id);
    const expectedChildren=record?.epic_plan?.children.map(child => ({id:child.id,revision:issue(child.id)?.revision}));
    const expectedEdges=record?.epic_plan?.edges.map(edge => ({edge_id:edge.edge_id,revision:dependency.edges.get(edge.edge_id)?.revision}));
    if (!record || !record.epic_plan || record.epic_approval ||
        canonicalJson(record.epic_plan)!==canonicalJson(payload.plan) ||
        payload.authority_binding.epic.id!==record.work.item.id ||
        payload.authority_binding.epic.revision!==record.revision ||
        payload.authority_binding.plan.plan_id!==record.epic_plan.plan_id ||
        payload.authority_binding.plan.content_sha256!==record.epic_plan.content_sha256 ||
        canonicalJson(payload.authority_binding.children)!==canonicalJson(expectedChildren) ||
        canonicalJson(payload.authority_binding.edges)!==canonicalJson(expectedEdges) ||
        payload.authority_binding.project.id!==project.id ||
        payload.authority_binding.project.revision!==project.revision) {
      throw new CoreConflictError("Epic approval conflicts with the exact prepared scope");
    }
    record.epic_approval=structuredClone(payload.authority_binding);
    record.work=structuredClone(payload.work);
    record.revision=bump(`issue-${record.work.item.issue_number}`,record.revision);
    const repository=repo(operation.repository);
    repository.revision=bump("repository",repository.revision);
    return record.revision;
  }

  function applyReviewFollowUp(operation) {
    const repository=repo(operation.repository);
    const payload=operation.payload;
    exact(payload,[
      "kind","issue_id","review_id","finding_id","marker","title","summary",
      "reserved_branch","work_item","source_pull_request","source_revision","review_context",
    ],"review follow-up issue payload");
    const identity=parseWorkItemId(payload.issue_id);
    validateCoreDocument(payload.work_item,"work-item.v1");
    const reservationKey=workItemId(identity.repository,identity.issueNumber);
    const reservationOwner=reviewReservationOwners.get(reservationKey);
    if (identity.repository!==operation.repository ||
        identity.issueNumber!==payload.work_item.issue_number ||
        payload.work_item.id!==payload.issue_id ||
        payload.work_item.repository!==operation.repository ||
        payload.work_item.branch!==payload.reserved_branch ||
        identity.issueNumber!==repository.nextIssueNumber ||
        !reservationOwner ||
        reservationOwner.binding.review_id!==payload.review_id ||
        reservationOwner.binding.finding_id!==payload.finding_id ||
        reservationOwner.binding.source_pull_request_repository!==operation.repository ||
        reservationOwner.binding.source_pull_request_number!==
          parseWorkItemId(payload.source_pull_request).issueNumber ||
        reservationOwner.binding.source_pull_request_head!==payload.source_revision ||
        repository.issues.has(identity.issueNumber) ||
        [...repository.issues.values()].some(value => value.marker===payload.marker)) {
      throw new CoreConflictError("Review follow-up reservation conflicts with repository state");
    }
    const sourceIdentity=parseWorkItemId(payload.source_pull_request);
    if (sourceIdentity.repository!==operation.repository) {
      throw new CoreConflictError("Review follow-up source pull request belongs to another repository");
    }
    const sourcePullRequest=repository.pullRequests.get(sourceIdentity.issueNumber);
    const sourceRecord=sourcePullRequest ? issue(sourcePullRequest.work_item_id) : null;
    if (!sourceRecord) throw new CoreConflictError("Review follow-up source pull request is missing");
    const work=initialWork(
      structuredClone(payload.work_item),`PVTI_REVIEW_${identity.issueNumber}`,
      project.revision,payload.review_context.review_result.recorded_at,
    );
    if (work.item.kind==="issue") {
      work.parent=sourceRecord.work.item.kind==="epic" ? {
        id:sourceRecord.work.item.id,branch:sourceRecord.work.item.branch,
        revision:sourceRecord.revision,
      } : structuredClone(sourceRecord.work.parent);
    }
    repository.issues.set(identity.issueNumber,{
      request_identity:`review-${payload.review_id}-${payload.finding_id}`,
      marker:payload.marker,title:payload.title,description:payload.summary,
      priority:null,change_class:null,labels:[payload.work_item.kind],
      affected_version:null,scope:[],work,
      revision:`issue-${identity.issueNumber}-1`,projected:false,
      review_follow_up:{
        issue_id:payload.issue_id,review_id:payload.review_id,finding_id:payload.finding_id,
        summary:payload.summary,reserved_branch:payload.reserved_branch,
      },
    });
    reviewReservationOwners.delete(reservationKey);
    repository.nextIssueNumber+=1;
    repository.revision=bump("repository",repository.revision);
    return repository.revision;
  }

  function applyProject(operation) {
    const payload=operation.payload;
    if (failureMode==="fail-epic-project" && payload.kind==="work-state" && payload.fields.Status==="Done") {
      throw new Error("injected epic Project completion failure");
    }
    if (payload.kind==="work-item-membership") {
      exact(payload,["kind","project_id","work_item_id","fields"],"Project membership payload");
      const record=issue(payload.work_item_id);
      if (!record) throw new CoreConflictError("Project membership references a missing issue");
      if (record.projected) throw new CoreConflictError("Project membership already exists");
      record.projected=true;
      record.visible_project_fields=structuredClone(payload.fields);
      record.work.project.fields=structuredClone(payload.fields);
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
      const followUp=repo(identity.repository).issues.get(identity.issueNumber);
      if (!followUp?.review_follow_up || followUp.projected || followUp.marker!==payload.marker ||
          payload.project_id!==project.id) {
        throw new CoreConflictError("Review follow-up Project membership conflicts");
      }
      followUp.projected=true;
      followUp.project_fields=structuredClone(payload.fields);
      Object.assign(followUp.work.project.fields,structuredClone(payload.fields));
      followUp.visible_project_fields=structuredClone(payload.fields);
      const projectEvidence=reviewProjects.get(payload.review_context.review_result.repository+
        `#${payload.review_context.review_result.pull_request_number}`);
      if (!projectEvidence) throw new CoreConflictError("Review follow-up has no Project evidence owner");
      projectEvidence.follow_up_mappings.push({
        review_id:payload.review_id,finding_id:payload.finding_id,issue_id:payload.issue_id,
        repository:identity.repository,project_id:payload.project_id,
        project_item_id:followUp.work.project.item_id,
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
    if (canonicalJson(payload.checks)!==canonicalJson(pullRequest.checks) ||
        canonicalJson(payload.implementation_identity)!==canonicalJson(pullRequest.implementation_identity)) {
      throw new CoreConflictError("Review operation evidence does not match authoritative checks or implementation identity");
    }
    pullRequest.body=payload.body;
    pullRequest.formal_review={
      state:payload.formal_review.action==="APPROVE" ? "APPROVED" : "CHANGES_REQUESTED",
      review_id:payload.formal_review.review_id,
      reviewed_revision:payload.formal_review.reviewed_revision,
    };
    pullRequest.recorded_result=structuredClone(payload.review_result);
    pullRequest.revision=bump("pull-request",pullRequest.revision);
    const record=issue(pullRequest.work_item_id);
    record.work.review={
      verdict:payload.review_result.verdict,
      reviewed_revision:payload.review_result.reviewed_revision,
    };
    record.work.checks=structuredClone(payload.checks);
    return reviewObservationRevision({
      native_revision:pullRequest.revision,checks:pullRequest.checks,
      implementation_identity:pullRequest.implementation_identity,
    });
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
    const projectsWork=Object.hasOwn(payload,"work");
    exact(payload,projectsWork
      ? ["kind","work_item_id","head","base","head_sha","draft","work"]
      : ["kind","work_item_id","head","base","head_sha","draft"],"work pull request payload");
    const branch=repository.branches.get(payload.head);
    if (!branch || branch.head_sha!==payload.head_sha) throw new CoreConflictError("Pull request head is stale");
    const record=issue(payload.work_item_id);
    if (!record || record.work.item.repository!==operation.repository) {
      throw new CoreConflictError("Pull request work identity is not governed");
    }
    if (projectsWork) {
      deriveWorkItemState(payload.work);
      if (record.work.item.kind!=="epic" || payload.work.item.id!==payload.work_item_id ||
          payload.work.physical_branch.exists!==true ||
          payload.work.physical_branch.head_sha!==payload.head_sha ||
          payload.work.pull_request?.state!=="READY" ||
          payload.work.pull_request.head_sha!==payload.head_sha ||
          payload.work.pull_request.merged_sha!==null ||
          payload.work.authority.epic_acceptance_required!==true) {
        throw new CoreConflictError("Projected epic pull request work is incomplete");
      }
    }
    const existing=[...repository.pullRequests.values()].find(value => value.work_item_id===payload.work_item_id);
    let revision;
    if (existing) {
      if (existing.base!==payload.base || existing.head!==payload.head) throw new CoreConflictError("Existing pull request base or head conflicts");
      existing.head_sha=payload.head_sha;
      existing.state=payload.draft ? "DRAFT" : "READY";
      existing.revision=bump("pull-request",existing.revision);
      revision=existing.revision;
    } else {
      const number=repository.nextPullRequestNumber++;
      repository.pullRequests.set(number,{
        number,work_item_id:payload.work_item_id,head_repository:operation.repository,
        base_repository:operation.repository,head:payload.head,base:payload.base,
        head_sha:payload.head_sha,state:payload.draft ? "DRAFT" : "READY",
        merged_sha:null,revision:"pull-request-1",
      });
      repository.revision=bump("repository",repository.revision);
      revision="pull-request-1";
    }
    if (projectsWork) {
      const projectEvidence=record.work.project;
      record.work=structuredClone(payload.work);
      record.work.project=projectEvidence;
      record.revision=bump(`issue-${record.work.item.issue_number}`,record.revision);
    }
    return revision;
  }

  function applyEpicAccept(operation) {
    const payload=operation.payload;
    exact(payload,["kind","epic_id","head_sha","authority_binding","work"],"epic acceptance payload");
    const repository=repo(operation.repository);
    const record=issue(payload.epic_id);
    const pullRequest=[...repository.pullRequests.values()].find(value => value.work_item_id===payload.epic_id);
    const releaseBranch=record ? repository.branches.get(record.work.release.branch) : null;
    if (!record || record.work.item.kind!=="epic" || !record.epic_approval || !pullRequest ||
        pullRequest.state!=="READY" || pullRequest.head_sha!==payload.head_sha ||
        canonicalJson(payload.authority_binding)!==canonicalJson(liveAcceptanceBinding(record,pullRequest)) ||
        !releaseBranch || pullRequest.base!==releaseBranch.name) {
      throw new CoreConflictError("Epic acceptance conflicts with exact current merge evidence");
    }
    if (failureMode==="fail-epic-merge") throw new Error("injected epic merge failure");
    releaseBranch.head_sha=pullRequest.head_sha;
    releaseBranch.revision=bump("release",releaseBranch.revision);
    pullRequest.state="MERGED";
    pullRequest.merged_sha=pullRequest.head_sha;
    pullRequest.revision=bump("pull-request",pullRequest.revision);
    const priorProject=structuredClone(record.work.project);
    record.work=structuredClone(payload.work);
    record.work.project=priorProject;
    record.work.issue_state="CLOSED";
    record.work.pull_request={state:"MERGED",head_sha:pullRequest.head_sha,merged_sha:pullRequest.head_sha};
    record.revision=bump(`issue-${record.work.item.issue_number}`,record.revision);
    repository.revision=bump("repository",repository.revision);
    return pullRequest.revision;
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

  function applyDependencyWork(operation) {
    const payload=operation.payload;
    exact(payload,["kind","work"],"dependency work-state payload");
    const record=issue(payload.work.item.id);
    if (!record || record.work.item.repository!==operation.repository) {
      throw new CoreConflictError("Dependency work-state references missing source work");
    }
    const graph=graphSnapshot(null);
    const readiness=dependencyReadiness(payload.work.item.id,
      validateDependencyGraph({nodes:graph.nodes,edges:graph.edges}),graph.completed_ids);
    const state=deriveWorkItemState(payload.work);
    if (canonicalJson(payload.work.blocking_dependencies)!==canonicalJson(readiness.blocking) ||
        payload.work.item.status!==state.status || payload.work.item.gate!==state.gate) {
      throw new CoreConflictError("Dependency work-state does not match the complete graph readiness");
    }
    const priorProject=structuredClone(record.work.project);
    record.work=structuredClone(payload.work);
    record.work.project=priorProject;
    record.revision=bump(`issue-${record.work.item.issue_number}`,record.revision);
    const repository=repo(operation.repository);
    repository.revision=bump("repository",repository.revision);
    return record.revision;
  }

  function preflightDependencyResult(values) {
    const dependencyOperations=values.filter(operation => operation.resource==="issue" &&
      ["dependency-add","dependency-remove"].includes(operation.payload.kind));
    if (dependencyOperations.length===0) return;
    const nodes=new Set(allNodes());
    for (const operation of values) {
      if (operation.resource!=="issue" || operation.action!=="create") continue;
      const id=operation.payload.work_item_id ?? operation.payload.work?.item?.id ??
        operation.payload.work_item?.id;
      if (typeof id==="string") nodes.add(id);
    }
    const edges=new Map([...dependency.edges.entries()].map(([id,edge]) => [id,structuredClone(edge)]));
    const relationships=new Map([...dependency.relationships.entries()]
      .map(([id,relationship]) => [id,structuredClone(relationship)]));
    const tombstones=new Map([...dependency.tombstones.entries()]
      .map(([id,tombstone]) => [id,structuredClone(tombstone)]));
    for (const operation of dependencyOperations) {
      if (operation.payload.kind==="dependency-add") {
        exact(operation.payload,["kind","edge","relationship"],"dependency add preflight payload");
        const {edge,relationship}=operation.payload;
        validateCoreDocument(edge,"dependency-edge.v1");
        exact(relationship,["edge_id","source","target","revision"],"dependency relationship preflight");
        if (relationship.edge_id!==edge.edge_id || relationship.source!==edge.source ||
            relationship.target!==edge.target || relationship.revision!==edge.revision) {
          throw new CoreConflictError("Dependency add relationship does not bind its exact edge");
        }
        if (edges.has(edge.edge_id) || relationships.has(edge.edge_id) || tombstones.has(edge.edge_id)) {
          throw new CoreConflictError("Dependency add preflight conflicts with existing immutable evidence");
        }
        edges.set(edge.edge_id,structuredClone(edge));
        relationships.set(edge.edge_id,structuredClone(relationship));
      } else {
        exact(operation.payload,["kind","tombstone"],"dependency remove preflight payload");
        const {tombstone}=operation.payload;
        exact(tombstone,["edge_id","source","target","kind","prior_revision","reason","removed_at"],"dependency tombstone preflight");
        const edge=edges.get(tombstone.edge_id);
        const relationship=relationships.get(tombstone.edge_id);
        if (!edge || !relationship || tombstones.has(tombstone.edge_id) ||
            tombstone.kind!=="requires" || tombstone.source!==edge.source ||
            tombstone.target!==edge.target || tombstone.prior_revision!==edge.revision ||
            relationship.source!==edge.source || relationship.target!==edge.target ||
            relationship.revision!==edge.revision) {
          throw new CoreConflictError("Dependency remove preflight conflicts with active immutable evidence");
        }
        edges.delete(tombstone.edge_id);
        relationships.delete(tombstone.edge_id);
        tombstones.set(tombstone.edge_id,structuredClone(tombstone));
      }
    }
    validateDependencyGraph({nodes:[...nodes],edges:[...edges.values()]});
    if (relationships.size!==edges.size || [...edges.values()].some(edge => {
      const relationship=relationships.get(edge.edge_id);
      return !relationship || relationship.source!==edge.source || relationship.target!==edge.target ||
        relationship.revision!==edge.revision;
    })) {
      throw new CoreConflictError("Dependency preflight result has conflicting native relationships");
    }
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
    preflightDependencyResult(values);
    for (const repository of repositories.values()) {
      const reserved=values
        .filter(operation => operation.repository===repository.repository && operation.resource==="issue" &&
          operation.action==="create" && Object.hasOwn(operation.payload,"native_parent_id"))
        .map(operation => operation.payload.native_issue_number)
        .sort((left,right) => left-right);
      if (reserved.some((number,index) => number!==repository.nextIssueNumber+index)) {
        throw new CoreConflictError("Managed epic child reservations are not a contiguous native issue range");
      }
    }
    for (const operation of values) {
      if (currentRevision(operation)!==operation.expected_revision) {
        throw new CoreConflictError(`Fake GitHub stale expected revision for ${operation.operation_id}`);
      }
    }
    if (failureMode==="throw-apply") throw new Error("injected fake GitHub apply failure");
    const observations=[];
    const acceptance=values.find(operation => operation.resource==="pull_request" && operation.payload.kind==="epic-accept");
    const epicSubmission=values.find(operation => operation.resource==="pull_request" &&
      operation.payload.kind==="work-pull-request" && operation.payload.work?.item?.kind==="epic");
    if (acceptance!==undefined && failureMode?.startsWith("drift-epic-")) {
      const record=issue(acceptance.payload.epic_id);
      const nativePull=[...repo(acceptance.repository).pullRequests.values()]
        .find(value => value.work_item_id===acceptance.payload.epic_id);
      if (failureMode==="drift-epic-child-binding") {
        const childRecord=issue(record.epic_plan.children[0].id);
        childRecord.revision=bump(`issue-${childRecord.work.item.issue_number}`,childRecord.revision);
      } else if (failureMode==="drift-epic-edge-binding") {
        const edge=dependency.edges.get(record.epic_plan.edges[0].edge_id);
        edge.revision=`${edge.revision}-drift`;
      } else if (failureMode==="drift-epic-release-binding") {
        record.work.release.revision=`${record.work.release.revision}-drift`;
      } else if (failureMode==="drift-epic-review-binding") {
        nativePull.recorded_result.reviewed_revision="0".repeat(40);
      } else if (failureMode==="drift-epic-checks-binding") {
        nativePull.checks.state="FAILED";
      } else if (failureMode==="drift-epic-project-binding") {
        project.revision=bump("project",project.revision);
      }
    }
    const first=acceptance ?? epicSubmission;
    const executionValues=first===undefined
      ? values
      : [first,...values.filter(operation => operation!==first)];
    try {
      for (const operation of executionValues) {
        let revision;
        if (operation.resource==="issue" && operation.action==="create" &&
            operation.payload.kind==="review-minor-follow-up") revision=applyReviewFollowUp(operation);
        else if (operation.resource==="issue" && Object.hasOwn(operation.payload,"native_parent_id")) revision=applyManagedChild(operation);
        else if (operation.resource==="issue" && operation.action==="create") revision=applyIssueCreate(operation);
        else if (operation.resource==="project") revision=applyProject(operation);
        else if (operation.resource==="branch" && operation.action==="create") revision=applyBranch(operation);
        else if (operation.resource==="pull_request" && operation.action==="update" &&
            operation.payload.kind==="review-record") revision=applyReviewPullRequest(operation);
        else if (operation.resource==="pull_request" && operation.action==="update" &&
            operation.payload.kind==="epic-accept") revision=applyEpicAccept(operation);
        else if (operation.resource==="pull_request" && ["create","update"].includes(operation.action)) revision=applyPullRequest(operation);
        else if (operation.resource==="issue" && operation.action==="update" && operation.payload.kind==="epic-prepare") revision=applyEpicPrepare(operation);
        else if (operation.resource==="issue" && operation.action==="update" && operation.payload.kind==="epic-approve") revision=applyEpicApprove(operation);
        else if (operation.resource==="issue" && operation.action==="update" && operation.payload.kind==="dependency-work-state") revision=applyDependencyWork(operation);
        else if (operation.resource==="issue" && operation.action==="update") revision=applyDependency(operation);
        else throw new CoreValidationError(`Unsupported fake GitHub operation ${operation.resource}.${operation.action}`);
        observations.push({operation_id:operation.operation_id,repository:operation.repository,revision});
      }
    } catch (error) {
      if (observations.length===0) throw error;
      const failed=copy({status:"failed",observed_revisions:observations},"fake GitHub partial apply result");
      appliedKeys.set(optionsValue.idempotencyKey,failed);
      return failed;
    }
    for (const evidence of reviewProjects.values()) {
      evidence.revision=project.revision;
      for (const mapping of evidence.follow_up_mappings) mapping.project_revision=project.revision;
      for (const reservation of evidence.reservations) reservation.project_revision=project.revision;
    }
    refreshReservationOwners();
    if (failureMode==="missing-apply-observation") observations.pop();
    if (failureMode==="duplicate-apply-observation" && observations.length>0) observations.push(observations[0]);
    const result=copy({status:"completed",observed_revisions:observations},"fake GitHub apply result");
    appliedKeys.set(optionsValue.idempotencyKey,result);
    return result;
  }

  function seedWork(snapshotInput,{title="Seeded work",description="Seeded work description",marker=null,affectedVersion=null}={}) {
    const work=structuredClone(copy(snapshotInput,"seeded work snapshot"));
    const identity=parseWorkItemId(work.item.id);
    const repository=repo(identity.repository);
    const number=identity.issueNumber;
    repository.nextIssueNumber=Math.max(repository.nextIssueNumber,number+1);
    if (work.item.kind!=="bug" && affectedVersion!==null) {
      throw new TypeError("Only a bounded bug can carry an affected version");
    }
    let governedAffectedVersion=affectedVersion;
    if (work.item.kind==="bug" && governedAffectedVersion===null) {
      const match=/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u
        .exec(work.item.milestone ?? "");
      const patch=Number(match?.[3]);
      governedAffectedVersion=match && patch>0 ? `${match[1]}.${match[2]}.${patch-1}` : null;
    }
    repository.issues.set(number,{
      request_identity:`seed-${work.item.id}`,marker:marker ?? `<!-- toss-core:seed:${sha256Canonical(work.item.id)} -->`,
      title,description,labels:work.item.kind==="epic" ? ["epic"] : [work.item.kind],
      priority:null,change_class:null,affected_version:governedAffectedVersion,scope:[],work,
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
    assertReservationOwners(value.project.reservations);
    seedWork(pullRequest.work);
    const repository=repo(pullRequest.repository);
    repository.pullRequests.set(pullRequest.number,{
      number:pullRequest.number,work_item_id:pullRequest.work.item.id,
      head_repository:pullRequest.head_repository,base_repository:pullRequest.base_repository,
      head:pullRequest.head,base:pullRequest.base,head_sha:pullRequest.head_sha,
      state:"READY",merged_sha:null,revision:pullRequest.native_revision,
      body:pullRequest.body,formal_review:structuredClone(pullRequest.formal_review),
      recorded_result:structuredClone(pullRequest.recorded_result),
      checks:structuredClone(pullRequest.checks),
      implementation_identity:structuredClone(value.implementationIdentity),review_snapshot:true,
    });
    repository.nextPullRequestNumber=Math.max(repository.nextPullRequestNumber,pullRequest.number+1);
    reviewProjects.set(`${pullRequest.repository}#${pullRequest.number}`,structuredClone(value.project));
    assertReservationOwners(value.project.reservations,{allocate:true});
    return `${pullRequest.repository}#${pullRequest.number}`;
  }

  function setFailureMode(mode) { failureMode=mode; }
  function assignActiveRelease(id,version) {
    const record=issue(id);
    if (!record || record.work.item.kind!=="epic" || !record.epic_plan || !record.epic_approval ||
        typeof version!=="string" || !/^v\d+\.\d+\.\d+$/u.test(version)) {
      throw new TypeError("active release assignment requires a governed epic and canonical version");
    }
    const repository=repo(record.work.item.repository);
    const branch=`release/${version}`;
    const release={assigned:true,active:true,id:`${record.work.item.repository}@${branch}`,repository:record.work.item.repository,branch,milestone:version,revision:"release-1"};
    const releaseHead="1".repeat(40);
    repository.branches.set(branch,{name:branch,base_branch:"main",head_sha:releaseHead,revision:"release-1"});
    repository.branches.set(record.work.item.branch,{name:record.work.item.branch,base_branch:branch,head_sha:releaseHead,revision:"branch-1"});
    record.work.release=structuredClone(release);
    record.work.item.base_branch=branch;
    record.work.item.milestone=version;
    record.work.item.status="Blocked";
    record.work.item.gate="DEPENDENCY_REQUIRED";
    record.work.physical_branch={exists:true,head_sha:releaseHead};
    record.work.project.fields.base_branch=branch;
    record.work.project.fields.repository=record.work.item.repository;
    record.work.project.fields.parent=record.work.item.parent_id;
    record.work.project.fields.milestone=version;
    record.work.project.fields.Status="Blocked";
    record.work.project.fields.Gate="DEPENDENCY_REQUIRED";
    record.work.blocking_dependencies=epicBlockingDependencies(record);
    record.revision=bump(`issue-${record.work.item.issue_number}`,record.revision);
    for (const planned of record.epic_plan.children) {
      const childRecord=issue(planned.id);
      const blocking=record.epic_plan.edges
        .filter(edge => edge.source===planned.id && issue(edge.target)?.work.issue_state!=="CLOSED")
        .map(edge => edge.target).sort(compare);
      childRecord.work.release=structuredClone(release);
      childRecord.work.item.milestone=version;
      childRecord.work.item.status=blocking.length===0 ? "Ready" : "Blocked";
      childRecord.work.item.gate=blocking.length===0 ? "NONE" : "DEPENDENCY_REQUIRED";
      childRecord.work.blocking_dependencies=blocking;
      childRecord.work.parent.revision=record.revision;
      childRecord.work.project.fields.Status=childRecord.work.item.status;
      childRecord.work.project.fields.Gate=childRecord.work.item.gate;
      childRecord.work.project.fields.repository=childRecord.work.item.repository;
      childRecord.work.project.fields.parent=childRecord.work.item.parent_id;
      childRecord.work.project.fields.milestone=version;
      childRecord.revision=bump(`issue-${childRecord.work.item.issue_number}`,childRecord.revision);
      Object.assign(childRecord.visible_project_fields,{Status:childRecord.work.item.status,Gate:childRecord.work.item.gate,milestone:version});
    }
    repository.revision=bump("repository",repository.revision);
    project.revision=bump("project",project.revision);
    for (const repositoryValue of repositories.values()) {
      for (const issueRecord of repositoryValue.issues.values()) issueRecord.work.project.revision=project.revision;
    }
  }
  function mergeWorkPullRequest(id) {
    const record=issue(id);
    if (!record || !["issue","bug"].includes(record.work.item.kind)) {
      throw new TypeError("work pull request merge requires a governed child or bounded issue");
    }
    const repository=repo(record.work.item.repository);
    const pullRequest=[...repository.pullRequests.values()].find(value => value.work_item_id===id);
    const branch=repository.branches.get(record.work.item.branch);
    const base=repository.branches.get(record.work.item.base_branch);
    if (!pullRequest || pullRequest.state==="MERGED" || !branch || !base ||
        pullRequest.head!==branch.name || pullRequest.base!==base.name ||
        pullRequest.head_sha!==branch.head_sha) {
      throw new TypeError("work pull request merge requires the exact current governed head and base");
    }
    base.head_sha=pullRequest.head_sha;
    base.revision=bump("branch",base.revision);
    pullRequest.state="MERGED";
    pullRequest.merged_sha=pullRequest.head_sha;
    pullRequest.revision=bump("pull-request",pullRequest.revision);
    record.work.issue_state="CLOSED";
    record.work.pull_request={state:"MERGED",head_sha:pullRequest.head_sha,merged_sha:pullRequest.head_sha};
    record.work.item.status="Done";
    record.work.item.gate="NONE";
    record.work.project.fields.Status="Done";
    record.work.project.fields.Gate="NONE";
    Object.assign(record.visible_project_fields ??= {},{Status:"Done",Gate:"NONE"});
    record.revision=bump(`issue-${record.work.item.issue_number}`,record.revision);
    for (const candidate of repository.issues.values()) {
      if (candidate.work.issue_state==="CLOSED" || candidate.work.item.kind!=="issue") continue;
      const blocking=[...dependency.edges.values()]
        .filter(edge => edge.source===candidate.work.item.id && issue(edge.target)?.work.issue_state!=="CLOSED")
        .map(edge => edge.target).sort(compare);
      candidate.work.blocking_dependencies=blocking;
      if (candidate.work.release.assigned && !candidate.work.physical_branch.exists) {
        candidate.work.item.status=blocking.length===0 ? "Ready" : "Blocked";
        candidate.work.item.gate=blocking.length===0 ? "NONE" : "DEPENDENCY_REQUIRED";
        candidate.work.project.fields.Status=candidate.work.item.status;
        candidate.work.project.fields.Gate=candidate.work.item.gate;
      }
    }
    if (record.work.parent) {
      const parent=issue(record.work.parent.id);
      parent.work.physical_branch={exists:true,head_sha:base.head_sha};
      parent.work.children_complete=parent.epic_plan.children.every(child => recordSemanticallyDone(issue(child.id)));
      parent.work.blocking_dependencies=epicBlockingDependencies(parent);
      parent.work.item.status=parent.work.children_complete ? "In progress" : "Blocked";
      parent.work.item.gate=parent.work.children_complete ? "NONE" : "DEPENDENCY_REQUIRED";
      parent.work.project.fields.Status=parent.work.item.status;
      parent.work.project.fields.Gate=parent.work.item.gate;
      Object.assign(parent.visible_project_fields ??= {},{Status:parent.work.item.status,Gate:parent.work.item.gate});
      parent.revision=bump(`issue-${parent.work.item.issue_number}`,parent.revision);
    }
    repository.revision=bump("repository",repository.revision);
    project.revision=bump("project",project.revision);
    for (const repositoryValue of repositories.values()) {
      for (const issueRecord of repositoryValue.issues.values()) issueRecord.work.project.revision=project.revision;
    }
  }
  function enableReviewPullRequest(repositoryName,number,evidenceInput) {
    const evidence=copy(evidenceInput,"review enablement evidence");
    exact(evidence,["checks","implementationIdentity"],"review enablement evidence");
    const repository=repo(repositoryName);
    const pullRequest=repository.pullRequests.get(number);
    const record=pullRequest ? issue(pullRequest.work_item_id) : null;
    if (!pullRequest || pullRequest.state!=="READY" || !record ||
        evidence.checks.revision!==pullRequest.head_sha ||
        evidence.implementationIdentity.revision!==pullRequest.head_sha) {
      throw new TypeError("review enablement requires a ready governed pull request at the exact head");
    }
    pullRequest.body="";
    pullRequest.formal_review={state:"NONE",review_id:null,reviewed_revision:null};
    pullRequest.recorded_result=null;
    pullRequest.checks=structuredClone(evidence.checks);
    pullRequest.implementation_identity=structuredClone(evidence.implementationIdentity);
    pullRequest.review_snapshot=true;
    record.work.pull_request={state:"READY",head_sha:pullRequest.head_sha,merged_sha:null};
    record.work.checks=structuredClone(evidence.checks);
    record.work.authority.epic_acceptance_required=record.work.item.kind==="epic";
    record.work.item.status="In review";
    record.work.item.gate="REVIEW_REQUIRED";
    record.work.project.fields.Status="In review";
    record.work.project.fields.Gate="REVIEW_REQUIRED";
    reviewProjects.set(`${repositoryName}#${number}`,{
      project_id:project.id,item_id:record.work.project.item_id,revision:project.revision,
      follow_up_mappings:[],reservations:[],
    });
  }
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
    pullRequest.implementation_identity.commits.sort((left,right) => compare(left.revision,right.revision));
    pullRequest.implementation_identity.commit_count=pullRequest.implementation_identity.commits.length;
    pullRequest.implementation_identity.commits_sha256=sha256Canonical(
      pullRequest.implementation_identity.commits,
    );
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
      refreshReservationOwners();
    }
  }
  function setReviewChecks(repositoryName,number,checks) {
    const value=copy(checks,"review check mutation");
    exact(value,["state","revision"],"review check mutation");
    const pullRequest=repo(repositoryName).pullRequests.get(number);
    if (!pullRequest?.review_snapshot) throw new TypeError("review pull request does not exist");
    pullRequest.checks=structuredClone(value);
    pullRequest.revision=bump("pull-request",pullRequest.revision);
    issue(pullRequest.work_item_id).work.checks=structuredClone(value);
  }
  function setReviewImplementationIdentity(repositoryName,number,evidence) {
    const pullRequest=repo(repositoryName).pullRequests.get(number);
    if (!pullRequest?.review_snapshot) throw new TypeError("review pull request does not exist");
    pullRequest.implementation_identity=structuredClone(copy(evidence,"review identity mutation"));
  }
  function view() {
    return copy({
      project,
      repositories:[...repositories.values()].map(value => ({
        repository:value.repository,revision:value.revision,next_issue_number:value.nextIssueNumber,
        issues:[...value.issues.values()],branches:[...value.branches.values()],
        pull_requests:[...value.pullRequests.values()],
        review_follow_ups:[...value.issues.values()].filter(record => record.review_follow_up)
          .map(record => ({...record.review_follow_up,marker:record.marker,title:record.title,
            work_item:record.work.item,revision:record.revision,projected:record.projected})),
      })).sort((left,right) => compare(left.repository,right.repository)),
      dependency:{revision:dependency.revision,edges:[...dependency.edges.values()],relationships:[...dependency.relationships.values()],tombstones:[...dependency.tombstones.values()]},
      review_projects:[...reviewProjects.entries()].map(([pull_request,value]) => ({pull_request,...value})),
      calls,
    },"fake GitHub fixture view");
  }

  const github=Object.freeze({snapshot,inspect,apply});
  return Object.freeze({
    github,seedWork,seedReviewPullRequest,setFailureMode,assignActiveRelease,mergeWorkPullRequest,enableReviewPullRequest,setRepositoryRevision,setBranchHead,
    setPullRequestHead,setReviewChecks,setReviewImplementationIdentity,view,
  });
}

export const CORE_GITHUB_FIXTURE_SOURCE_SHA=SOURCE_SHA;
