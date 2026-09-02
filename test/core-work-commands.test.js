import assert from "node:assert/strict";
import test from "node:test";

import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {runDependencyCommand} from "../src/core/commands/dependency.js";
import {runFeatureCommand} from "../src/core/commands/feature.js";
import {runIssueCommand} from "../src/core/commands/issue.js";
import {dispatchCoreCommand,parseCoreCommand} from "../src/core/commands/router.js";
import {CoreConflictError,CoreValidationError} from "../src/core/errors.js";
import {createOperationRunner} from "../src/core/operations/runner.js";
import {
  dependencyAddOperations,
  dependencyEdgeIdentity,
  dependencyGraphResult,
  dependencyRemoveOperations,
  featureAddOperations,
  featureRequestIdentity,
  issueAddOperations,
  issueStartOperations,
  issueSubmitOperations,
  normalizeIssueInput,
} from "../src/core/work/operations.js";
import {createCoreGithubFixture} from "./support/core-github-fixture.js";

const REPOSITORY="TOSS-Soft/toss-cli";
const OTHER_REPOSITORY="TOSS-Soft/toss-console";
const NOW="2026-09-02T08:00:00.000Z";
const SHA_A="a".repeat(40);
const SHA_B="b".repeat(40);
const HASH_A="a".repeat(64);

const featureInput=Object.freeze({
  title:"Organization work lifecycle",
  description:"Manage feature, issue, dependency, branch, and pull-request work.",
  priority:1,
  change_class:"backward_compatible_feature",
});

const bugInput=Object.freeze({
  kind:"fix",
  title:"Repair published receipt",
  description:"Repair receipt verification for the published product.",
  affected_version:"2.1.2",
  scope:Object.freeze(["Correct receipt verification."]),
});

function deeplyFrozen(value,seen=new Set()) {
  if (value===null || typeof value!=="object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Reflect.ownKeys(value).every(key => deeplyFrozen(value[key],seen));
}

function memoryControl() {
  let head="control-1";
  const intents=new Map();
  const receipts=new Map();
  const events=[];
  return Object.freeze({
    events,
    async head() { return head; },
    async findIntent(value) { return intents.get(value.intent_id) ?? null; },
    async findReceipt(value) { return receipts.get(value.intent_id) ?? null; },
    async commitIntent({expectedHead,intent}) {
      assert.equal(expectedHead,head);
      if (intents.has(intent.intent_id)) { const error=new Error("intent exists"); error.code="CONTROL_LEDGER_CONFLICT"; throw error; }
      intents.set(intent.intent_id,structuredClone(intent));
      events.push({kind:"intent",value:structuredClone(intent)});
      head=`control-${events.length+1}`;
      return {commit_sha:head};
    },
    async commitReceipt({expectedHead,receipt}) {
      assert.equal(expectedHead,head);
      if (receipts.has(receipt.intent_id)) { const error=new Error("receipt exists"); error.code="CONTROL_LEDGER_CONFLICT"; throw error; }
      receipts.set(receipt.intent_id,structuredClone(receipt));
      events.push({kind:"receipt",value:structuredClone(receipt)});
      head=`control-${events.length+1}`;
      return {commit_sha:head};
    },
  });
}

function harness({inputs={"feature.json":featureInput,"bug.json":bugInput}}={}) {
  const fixture=createCoreGithubFixture();
  const control=memoryControl();
  let sequence=0;
  const clock=() => NOW;
  const runner=createOperationRunner({
    control,github:fixture.github,authorityRegistry:{keys:[]},clock,
    idGenerator:kind => {
      sequence+=1;
      const prefix=kind==="intent" ? "INTENT" : "RECEIPT";
      return `${prefix}-20260902-${String(sequence).padStart(4,"0")}`;
    },
    policyRevision:() => "POLICY-0001",
  });
  const services=Object.freeze({
    github:fixture.github,
    operations:runner,
    clock,
    async readInput(path) {
      if (!Object.hasOwn(inputs,path)) throw new Error(`missing input ${path}`);
      return structuredClone(inputs[path]);
    },
  });
  return {fixture,control,runner,services};
}

function command(argv) { return parseCoreCommand(argv); }

function activeWork(kind,{number=43,parentNumber=42}={}) {
  const branch=kind==="issue" ? `issue/${number}-command-work` : `bug/${number}-command-work`;
  const base=kind==="issue" ? `epic/${parentNumber}-parent-epic` : "release/v2.1.3";
  const id=`${REPOSITORY}#${number}`;
  return {
    schema_version:"work-state-snapshot.v1",
    item:{
      schema_version:"work-item.v1",id,repository:REPOSITORY,issue_number:number,kind,
      parent_id:kind==="issue" ? `${REPOSITORY}#${parentNumber}` : null,
      ...(kind==="issue" ? {acceptance_criteria:["The command changes only governed state."]} : {}),
      branch,base_branch:base,milestone:"v2.1.3",status:"Ready",gate:"NONE",
    },
    issue_state:"OPEN",drifted:false,epic_required:false,prepared:null,scope_approved:null,
    parent:kind==="issue" ? {id:`${REPOSITORY}#${parentNumber}`,branch:base,revision:"parent-1"} : null,
    release:{
      assigned:true,active:true,id:`${REPOSITORY}@release/v2.1.3`,repository:REPOSITORY,
      branch:"release/v2.1.3",milestone:"v2.1.3",revision:"release-1",
    },
    blocking_dependencies:[],children_complete:null,
    physical_branch:{exists:false,head_sha:null},pull_request:null,review:null,checks:null,
    authority:{epic_acceptance_required:false,release_approval_required:false},
    project:{
      project_id:"PVT_TOSS_OS_2",item_id:`PVTI_${number}`,revision:"project-1",
      fields:{Status:"Ready",Gate:"NONE",repository:REPOSITORY,
        parent:kind==="issue" ? `${REPOSITORY}#${parentNumber}` : null,milestone:"v2.1.3",
        branch,base_branch:base,last_reconciled_at:"2026-09-01T08:00:00.000Z"},
    },
  };
}

function seedBacklog(fixture,repository,number) {
  const branch=`bug/${number}-dependency-node`;
  fixture.seedWork({
    schema_version:"work-state-snapshot.v1",
    item:{schema_version:"work-item.v1",id:`${repository}#${number}`,repository,issue_number:number,kind:"bug",parent_id:null,branch,base_branch:null,milestone:null,status:"Backlog",gate:"RELEASE_PLANNING"},
    issue_state:"OPEN",drifted:false,epic_required:false,prepared:null,scope_approved:null,parent:null,
    release:{assigned:false,active:false,id:null,repository:null,branch:null,milestone:null,revision:null},
    blocking_dependencies:[],children_complete:null,physical_branch:{exists:false,head_sha:null},pull_request:null,review:null,checks:null,
    authority:{epic_acceptance_required:false,release_approval_required:false},
    project:{project_id:"PVT_TOSS_OS_2",item_id:`PVTI_${repository.replaceAll("/","_")}_${number}`,revision:"project-1",fields:{Status:"Backlog",Gate:"RELEASE_PLANNING",repository,parent:null,milestone:null,branch,base_branch:null,last_reconciled_at:"2026-09-01T08:00:00.000Z"}},
  });
}

function mutationSnapshot(kind,work,{baseRevision=null,branchBase=null}={}) {
  const governing=work.item.kind==="issue" ? work.parent : work.release;
  return {
    kind,
    source:{repository:REPOSITORY,revision:"repository-1",sha256:HASH_A},
    repository_revision:"repository-1",
    work,
    branch:work.physical_branch.exists ? {
      name:work.item.branch,
      base_branch:branchBase ?? work.item.base_branch,
      head_sha:work.physical_branch.head_sha,
      revision:"branch-1",
    } : null,
    base:{
      repository:REPOSITORY,
      branch:work.item.base_branch,
      head_sha:SHA_B,
      revision:baseRevision ?? governing.revision,
    },
    pull_request:null,
    bug_lineage:work.item.kind==="bug"
      ? {classification:"patch",affected_version:"2.1.2",patch_version:"2.1.3"}
      : null,
  };
}

function storedWork(fixture,id) {
  return fixture.view().repositories
    .flatMap(value => value.issues)
    .find(value => value.work.item.id===id).work;
}

async function removedDependencyHarness() {
  const source=`${REPOSITORY}#81`;
  const target=`${REPOSITORY}#82`;
  const add={kind:"requires",rationale:"The target must land first.",provenance:{source_revision:"request@1",source_sha256:HASH_A,locations:["dependencies[0]"]}};
  const inputs={"add.json":add};
  const state=harness({inputs});
  seedBacklog(state.fixture,REPOSITORY,81);
  seedBacklog(state.fixture,REPOSITORY,82);
  await runDependencyCommand(command(["dependency","add",source,target,"--from","add.json","--apply","--non-interactive"]),state.services);
  const edge=(await runDependencyCommand(command(["dependency","graph"]),state.services)).graph.edges[0];
  inputs["remove.json"]={reason:"The dependency was retired.",expected_edge_revision:edge.revision};
  await runDependencyCommand(command(["dependency","remove",source,target,"--from","remove.json","--apply","--non-interactive"]),state.services);
  return {...state,source,target,add,edge,inputs};
}

function opaqueWrapperCases(valid) {
  const first=Object.keys(valid)[0];
  const proxyCounter={value:0};
  const proxy=new Proxy(valid,{get(target,key,receiver) {
    proxyCounter.value+=1;
    return Reflect.get(target,key,receiver);
  }});
  const accessorCounter={value:0};
  const accessor={...valid};
  Object.defineProperty(accessor,first,{enumerable:true,get() {
    accessorCounter.value+=1;
    return valid[first];
  }});
  const symbol={...valid,[Symbol("unexpected")]:true};
  const hidden={...valid};
  Object.defineProperty(hidden,"hidden",{value:true});
  return [
    {name:"proxy",value:proxy,counter:proxyCounter},
    {name:"accessor",value:accessor,counter:accessorCounter},
    {name:"symbol",value:symbol,counter:{value:0}},
    {name:"hidden",value:hidden,counter:{value:0}},
    {name:"sparse",value:Object.assign(new Array(1),valid),counter:{value:0}},
    {name:"extra",value:{...valid,extra:true},counter:{value:0}},
  ];
}

test("feature add previews and applies one unversioned managed epic without creating a branch",async () => {
  const {fixture,control,services}=harness();
  const preview=await runFeatureCommand(command(["feature","add",REPOSITORY,"--from","feature.json"]),services);
  assert.equal(preview.schema_version,"operation-preview.v1");
  assert.equal(preview.operations.length,2);
  assert.deepEqual(preview.operations.map(value => `${value.resource}.${value.action}`),["issue.create","project.create"]);
  const membership=preview.operations.find(value => value.resource==="project");
  assert.equal(membership.payload.fields.repository,REPOSITORY);
  assert.equal(membership.payload.fields.parent,null);
  assert.equal(membership.payload.fields.milestone,null);
  assert.equal(fixture.view().repositories[1].issues.length,0);
  assert.equal(control.events.length,0);

  const receipt=await runFeatureCommand(command(["feature","add",REPOSITORY,"--from","feature.json","--apply","--non-interactive"]),services);
  assert.equal(receipt.status,"completed");
  const repository=fixture.view().repositories.find(value => value.repository===REPOSITORY);
  assert.equal(repository.issues.length,1);
  const epic=repository.issues[0];
  assert.deepEqual(epic.labels,["epic"]);
  assert.equal(epic.work.item.kind,"epic");
  assert.equal(epic.work.item.milestone,null);
  assert.equal(epic.work.item.base_branch,null);
  assert.match(epic.work.item.branch,/^epic\/1-organization-work-lifecycle$/u);
  assert.equal(epic.work.project.fields.Status,"Backlog");
  assert.equal(epic.work.project.fields.Gate,"EPIC_PREPARATION_REQUIRED");
  assert.equal(repository.branches.length,0);
  assert.deepEqual(control.events.map(value => value.kind),["intent","receipt"]);
});

test("feature replay is a detached frozen no-op and changed content gets a distinct managed identity",async () => {
  const inputs={"feature.json":featureInput,"changed.json":{...featureInput,description:"A distinct feature request."}};
  const {fixture,services}=harness({inputs});
  const apply=path => runFeatureCommand(command(["feature","add",REPOSITORY,"--from",path,"--apply","--non-interactive"]),services);
  await apply("feature.json");
  const callsBefore=fixture.view().calls.length;
  const replay=await apply("feature.json");
  assert.equal(replay.status,"already-reconciled");
  assert.ok(deeplyFrozen(replay));
  assert.equal(fixture.view().calls.length,callsBefore+1);
  await apply("changed.json");
  const issues=fixture.view().repositories.find(value => value.repository===REPOSITORY).issues;
  assert.equal(issues.length,2);
  assert.notEqual(issues[0].request_identity,issues[1].request_identity);
});

test("feature status routes through the public router and is read-only",async () => {
  const {fixture,services}=harness();
  await runFeatureCommand(command(["feature","add",REPOSITORY,"--from","feature.json","--apply","--non-interactive"]),services);
  const callsBefore=fixture.view().calls.length;
  const routed=await dispatchCoreCommand(command(["feature","status",`${REPOSITORY}#1`]),{services});
  assert.equal(routed.exitCode,0);
  assert.equal(routed.result.data.state.gate,"EPIC_PREPARATION_REQUIRED");
  assert.equal(routed.result.data.state.next_command,"toss-core epic prepare");
  assert.equal(fixture.view().calls.length,callsBefore+1);
  assert.ok(deeplyFrozen(routed));
});

test("bounded fix intake persists as bug and expanded scope blocks without inventing an epic",async () => {
  const inputs={
    "bug.json":bugInput,
    "large.json":{...bugInput,kind:"bug",scope:["Repair verifier.","Migrate old receipts."]},
  };
  const {fixture,services}=harness({inputs});
  await runIssueCommand(command(["issue","add",REPOSITORY,"--from","bug.json","--apply","--non-interactive"]),services);
  await runIssueCommand(command(["issue","add",REPOSITORY,"--from","large.json","--apply","--non-interactive"]),services);
  const issues=fixture.view().repositories.find(value => value.repository===REPOSITORY).issues;
  assert.deepEqual(issues.map(value => value.work.item.kind),["bug","bug"]);
  assert.match(issues[0].work.item.branch,/^bug\/1-/u);
  assert.equal(issues[0].work.item.gate,"RELEASE_PLANNING");
  assert.equal(issues[1].work.item.status,"Blocked");
  assert.equal(issues[1].work.item.gate,"EPIC_REQUIRED");
  assert.deepEqual(issues.flatMap(value => value.labels),["bug","bug"]);
  assert.equal(issues.some(value => value.work.item.kind==="epic"),false);
});

test("intake inputs are exact and require canonical stable SemVer and bounded unique scope",async () => {
  const invalid=[
    {...bugInput,affected_version:"v2.1.2"},
    {...bugInput,affected_version:"2.01.2"},
    {...bugInput,affected_version:"2.1.2-beta.1"},
    {...bugInput,scope:[]},
    {...bugInput,scope:["same","same"]},
    {...bugInput,extra:true},
    {...featureInput,priority:-1},
    {...featureInput,change_class:"patch"},
  ];
  for (let index=0;index<invalid.length;index+=1) {
    const path=`invalid-${index}.json`;
    const {services}=harness({inputs:{[path]:invalid[index]}});
    const handler=index<6 ? runIssueCommand : runFeatureCommand;
    const family=index<6 ? "issue" : "feature";
    await assert.rejects(
      handler(command([family,"add",REPOSITORY,"--from",path]),services),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }

  const invalidClock=harness();
  const services=Object.freeze({...invalidClock.services,clock:() => "not-a-timestamp"});
  await assert.rejects(
    runFeatureCommand(command(["feature","add",REPOSITORY,"--from","feature.json"]),services),
    error => error instanceof CoreValidationError && error.exitCode===5,
  );
});

test("issue start creates the reserved branch from the exact governing head and reconciles Project state",async () => {
  const {fixture,services}=harness();
  const work=activeWork("issue");
  fixture.seedWork(work);
  const receipt=await runIssueCommand(command(["issue","start",work.item.id,"--apply","--non-interactive"]),services);
  assert.equal(receipt.status,"completed");
  const repository=fixture.view().repositories.find(value => value.repository===REPOSITORY);
  const branch=repository.branches.find(value => value.name===work.item.branch);
  assert.equal(branch.base_branch,work.item.base_branch);
  assert.equal(branch.head_sha,"2".repeat(40));
  const record=repository.issues.find(value => value.work.item.id===work.item.id);
  assert.equal(record.work.project.fields.Status,"In progress");
  assert.equal(record.work.project.fields.Gate,"NONE");
});

test("bounded bugs start only on the exact SemVer patch lineage of their affected release",async () => {
  for (const version of ["v2.1.4","v2.2.0","v3.0.0"]) {
    const {fixture,services}=harness();
    const work=activeWork("bug");
    const branch=`release/${version}`;
    work.item.base_branch=branch;
    work.item.milestone=version;
    work.release={...work.release,id:`${REPOSITORY}@${branch}`,branch,milestone:version};
    Object.assign(work.project.fields,{base_branch:branch,milestone:version});
    fixture.seedWork(work,{affectedVersion:"2.1.2"});

    await assert.rejects(
      runIssueCommand(command(["issue","start",work.item.id,"--apply","--non-interactive"]),services),
      error => error instanceof CoreValidationError && /patch|affected|lineage/iu.test(error.message),
      version,
    );
    assert.equal(fixture.view().repositories[0].branches.some(value => value.name===work.item.branch),false);
  }

  const {fixture,services}=harness();
  const work=activeWork("bug");
  fixture.seedWork(work,{affectedVersion:"2.1.2"});
  const started=await runIssueCommand(command(["issue","start",work.item.id,"--apply","--non-interactive"]),services);
  assert.equal(started.status,"completed");
  const status=await runIssueCommand(command(["issue","status",work.item.id]),services);
  assert.equal(canonicalJson(status.bug_lineage),canonicalJson({
    classification:"patch",affected_version:"2.1.2",patch_version:"2.1.3",
  }));
});

test("issue start blocks non-ready state and conflicts on stale or different existing branch evidence",async () => {
  const first=harness();
  const blocked=activeWork("bug");
  blocked.release.active=false;
  first.fixture.seedWork(blocked);
  await assert.rejects(
    runIssueCommand(command(["issue","start",blocked.item.id,"--apply","--non-interactive"]),first.services),
    error => error.exitCode===4,
  );

  const second=harness();
  const ready=activeWork("bug");
  ready.physical_branch={exists:true,head_sha:SHA_A};
  second.fixture.seedWork(ready);
  await assert.rejects(
    runIssueCommand(command(["issue","start",ready.item.id,"--apply","--non-interactive"]),second.services),
    error => error instanceof CoreConflictError && error.exitCode===6,
  );
});

test("issue transition replays cannot bypass reconcile or dependency gates",async () => {
  const replayState=harness();
  const drifted=activeWork("bug",{number:57});
  drifted.physical_branch={exists:true,head_sha:"1".repeat(40)};
  drifted.drifted=true;
  drifted.item.status="Blocked";
  drifted.item.gate="RECONCILE_REQUIRED";
  Object.assign(drifted.project.fields,{Status:"Blocked",Gate:"RECONCILE_REQUIRED",last_reconciled_at:NOW});
  replayState.fixture.seedWork(drifted);

  await assert.rejects(
    runIssueCommand(command(["issue","start",drifted.item.id,"--apply","--non-interactive"]),replayState.services),
    error => error.exitCode===4 && /RECONCILE_REQUIRED/u.test(error.message),
  );

  const submitState=harness();
  const blocked=activeWork("issue",{number:58});
  blocked.physical_branch={exists:true,head_sha:SHA_A};
  blocked.blocking_dependencies=[`${REPOSITORY}#59`];
  blocked.item.status="Blocked";
  blocked.item.gate="DEPENDENCY_REQUIRED";
  Object.assign(blocked.project.fields,{Status:"Blocked",Gate:"DEPENDENCY_REQUIRED"});
  submitState.fixture.seedWork(blocked);

  await assert.rejects(
    runIssueCommand(command(["issue","submit",blocked.item.id,"--apply","--non-interactive"]),submitState.services),
    error => error.exitCode===4 && /DEPENDENCY_REQUIRED/u.test(error.message),
  );
  assert.equal(submitState.fixture.view().repositories.find(value => value.repository===REPOSITORY).pull_requests.length,0);
});

test("issue start exact existing branch and reconciled fields is a deterministic no-op",async () => {
  const {fixture,services}=harness();
  const work=activeWork("bug");
  work.physical_branch={exists:true,head_sha:"1".repeat(40)};
  work.project.fields={...work.project.fields,Status:"In progress",Gate:"NONE",last_reconciled_at:NOW};
  fixture.seedWork(work);
  const result=await runIssueCommand(command(["issue","start",work.item.id,"--apply","--non-interactive"]),services);
  assert.equal(result.status,"already-reconciled");
  assert.equal(fixture.view().repositories.find(value => value.repository===REPOSITORY).branches.filter(value => value.name===work.item.branch).length,1);
});

test("issue submit creates child and bug PRs against only their exact governed bases",async () => {
  for (const kind of ["issue","bug"]) {
    const {fixture,services}=harness();
    const work=activeWork(kind);
    fixture.seedWork(work);
    await runIssueCommand(command(["issue","start",work.item.id,"--apply","--non-interactive"]),services);
    fixture.setBranchHead(REPOSITORY,work.item.branch,SHA_A);
    const receipt=await runIssueCommand(command(["issue","submit",work.item.id,"--apply","--non-interactive"]),services);
    assert.equal(receipt.status,"completed");
    const prs=fixture.view().repositories.find(value => value.repository===REPOSITORY).pull_requests;
    assert.equal(prs.length,1);
    assert.equal(prs[0].head,work.item.branch);
    assert.equal(prs[0].head_sha,SHA_A);
    assert.equal(prs[0].base,work.item.base_branch);
    assert.notEqual(prs[0].base,"main");
  }
});

test("public issue status composes authoritative branch and PR evidence immediately after start and submit",async () => {
  const {fixture,services}=harness();
  const work=activeWork("issue",{number:46});
  fixture.seedWork(work);

  await runIssueCommand(command(["issue","start",work.item.id,"--apply","--non-interactive"]),services);
  const started=await dispatchCoreCommand(command(["issue","status",work.item.id]),{services});
  assert.equal(started.exitCode,0,started.result.error?.message);
  assert.equal(started.result.data.evidence.physical_branch.exists,true);
  assert.equal(started.result.data.state.status,"In progress");

  fixture.setBranchHead(REPOSITORY,work.item.branch,SHA_A);
  await runIssueCommand(command(["issue","submit",work.item.id,"--apply","--non-interactive"]),services);
  const submitted=await dispatchCoreCommand(command(["issue","status",work.item.id]),{services});
  assert.equal(submitted.exitCode,0,submitted.result.error?.message);
  assert.equal(submitted.result.data.evidence.physical_branch.head_sha,SHA_A);
  assert.equal(submitted.result.data.evidence.pull_request.state,"DRAFT");
  assert.equal(submitted.result.data.evidence.pull_request.head_sha,SHA_A);
  assert.equal(submitted.result.data.state.status,"In progress");
});

test("issue submit exact replay is a no-op while a different existing base is a conflict",async () => {
  const {fixture,services}=harness();
  const work=activeWork("issue");
  fixture.seedWork(work);
  await runIssueCommand(command(["issue","start",work.item.id,"--apply","--non-interactive"]),services);
  await runIssueCommand(command(["issue","submit",work.item.id,"--apply","--non-interactive"]),services);
  const replay=await runIssueCommand(command(["issue","submit",work.item.id,"--apply","--non-interactive"]),services);
  assert.equal(replay.status,"already-reconciled");
  const view=fixture.view();
  assert.equal(view.repositories.find(value => value.repository===REPOSITORY).pull_requests.length,1);
});

test("issue submit classifies an existing cross-repository PR target as a conflict",() => {
  const work=activeWork("issue");
  work.physical_branch={exists:true,head_sha:SHA_A};
  work.pull_request={state:"DRAFT",head_sha:SHA_A,merged_sha:null};
  assert.throws(() => issueSubmitOperations({
    id:work.item.id,reconciled_at:NOW,
    snapshot:{
      kind:"issue-submit",source:{repository:REPOSITORY,revision:"repository-1",sha256:HASH_A},
      repository_revision:"repository-1",work,
      branch:{name:work.item.branch,base_branch:work.item.base_branch,head_sha:SHA_A,revision:"branch-1"},
      base:{repository:REPOSITORY,branch:work.item.base_branch,head_sha:SHA_B,revision:"parent-1"},
      pull_request:{number:1,work_item_id:work.item.id,head_repository:REPOSITORY,
        base_repository:OTHER_REPOSITORY,head:work.item.branch,base:work.item.base_branch,
        head_sha:SHA_A,state:"DRAFT",merged_sha:null,revision:"pull-request-1"},
      bug_lineage:null,
    },
  }),error => error instanceof CoreConflictError && error.exitCode===6);
});

test("issue submit rejects a remote PR wrapper that disagrees with Task 3 state evidence",() => {
  const work=activeWork("bug");
  work.physical_branch={exists:true,head_sha:SHA_A};
  work.pull_request={state:"DRAFT",head_sha:SHA_A,merged_sha:null};
  assert.throws(() => issueSubmitOperations({
    id:work.item.id,reconciled_at:NOW,
    snapshot:{kind:"issue-submit",source:{repository:REPOSITORY,revision:"repository-1",sha256:HASH_A},
      repository_revision:"repository-1",work,
      branch:{name:work.item.branch,base_branch:work.item.base_branch,head_sha:SHA_A,revision:"branch-1"},
      base:{repository:REPOSITORY,branch:work.item.base_branch,head_sha:SHA_B,revision:"release-1"},
      pull_request:{number:1,work_item_id:work.item.id,head_repository:REPOSITORY,
        base_repository:REPOSITORY,head:work.item.branch,base:work.item.base_branch,
        head_sha:SHA_A,state:"READY",merged_sha:null,revision:"pull-request-1"},
      bug_lineage:{classification:"patch",affected_version:"2.1.2",patch_version:"2.1.3"}},
  }),error => error instanceof CoreConflictError && error.exitCode===6);
});

test("dependency add validates graph semantics, records immutable edge data, and supports cross-repository scheduling",async () => {
  const sourceId=`${REPOSITORY}#51`;
  const targetId=`${OTHER_REPOSITORY}#7`;
  const input={kind:"requires",rationale:"Console contract must land first.",provenance:{source_revision:"request@1",source_sha256:HASH_A,locations:["dependencies[0]"]}};
  const {fixture,control,services}=harness({inputs:{"edge.json":input}});
  seedBacklog(fixture,REPOSITORY,51);
  seedBacklog(fixture,OTHER_REPOSITORY,7);
  await runDependencyCommand(command(["dependency","add",sourceId,targetId,"--from","edge.json","--apply","--non-interactive"]),services);
  const graph=await runDependencyCommand(command(["dependency","graph",sourceId]),services);
  assert.deepEqual(graph.graph.order,[targetId,sourceId]);
  assert.equal(graph.graph.edges.length,1);
  const edge=graph.graph.edges[0];
  assert.equal(edge.edge_id,`DEP-${sha256Canonical({source:sourceId,target:targetId,kind:"requires"})}`);
  assert.equal(edge.rationale,input.rationale);
  assert.equal(Object.hasOwn(edge,"base_branch"),false);
  const persisted=control.events.find(value => value.kind==="intent").value.operations.find(value => value.payload.kind==="dependency-add");
  assert.equal(JSON.stringify(persisted.payload.edge),JSON.stringify(edge));
});

test("dependency add and remove reconcile the exact source work and Project readiness in the same intent",async () => {
  const sourceId=`${REPOSITORY}#53`;
  const targetId=`${REPOSITORY}#54`;
  const input={kind:"requires",rationale:"The target must land first.",provenance:{source_revision:"request@1",source_sha256:HASH_A,locations:["dependencies[0]"]}};
  const inputs={"add.json":input};
  const {fixture,control,services}=harness({inputs});
  fixture.seedWork(activeWork("bug",{number:53}));
  seedBacklog(fixture,REPOSITORY,54);

  await runDependencyCommand(command(["dependency","add",sourceId,targetId,"--from","add.json","--apply","--non-interactive"]),services);

  let record=fixture.view().repositories.find(value => value.repository===REPOSITORY).issues
    .find(value => value.work.item.id===sourceId);
  assert.deepEqual(record.work.blocking_dependencies,[targetId]);
  assert.equal(record.work.item.status,"Blocked");
  assert.equal(record.work.item.gate,"DEPENDENCY_REQUIRED");
  assert.equal(record.work.project.fields.Status,"Blocked");
  assert.equal(record.work.project.fields.Gate,"DEPENDENCY_REQUIRED");
  const addIntent=control.events.find(value => value.kind==="intent").value;
  assert.deepEqual(addIntent.operations.map(value => value.payload.kind),[
    "dependency-add","dependency-work-state","work-state",
  ]);
  const mutationQuery=fixture.view().calls.find(value =>
    value.method==="snapshot" && value.query.kind==="dependency-mutation").query;
  assert.equal(mutationQuery.kind,"dependency-mutation");
  assert.equal(mutationQuery.source,sourceId);
  assert.equal(mutationQuery.target,targetId);

  const edge=fixture.view().dependency.edges[0];
  inputs["remove.json"]={reason:"The dependency is no longer required.",expected_edge_revision:edge.revision};
  await runDependencyCommand(command(["dependency","remove",sourceId,targetId,"--from","remove.json","--apply","--non-interactive"]),services);

  record=fixture.view().repositories.find(value => value.repository===REPOSITORY).issues
    .find(value => value.work.item.id===sourceId);
  assert.deepEqual(record.work.blocking_dependencies,[]);
  assert.equal(record.work.item.status,"Ready");
  assert.equal(record.work.item.gate,"NONE");
  assert.equal(record.work.project.fields.Status,"Ready");
  assert.equal(record.work.project.fields.Gate,"NONE");
});

test("fake dependency apply preflights the complete post-operation DAG before any mutation",async () => {
  const first=`${REPOSITORY}#55`;
  const second=`${REPOSITORY}#56`;
  const missing=`${REPOSITORY}#999`;
  const makeEdge=(sourceId,targetId,suffix) => ({
    schema_version:"dependency-edge.v1",
    edge_id:dependencyEdgeIdentity(sourceId,targetId),
    source:sourceId,target:targetId,kind:"requires",rationale:"Preflight the complete result.",
    provenance:{source_revision:`request@${suffix}`,source_sha256:HASH_A,locations:[`dependencies[${suffix}]`]},
    revision:`edge-${suffix}`,
  });
  const makeOperation=(edge,index) => ({
    operation_id:`OP-000${index+1}`,resource:"issue",action:"update",repository:REPOSITORY,
    expected_revision:"dependency-1",
    payload:{kind:"dependency-add",edge,relationship:{edge_id:edge.edge_id,source:edge.source,target:edge.target,revision:edge.revision}},
  });

  for (const mode of ["cycle","dangling target"]) {
    const {fixture}=harness();
    seedBacklog(fixture,REPOSITORY,55);
    seedBacklog(fixture,REPOSITORY,56);
    const edges=mode==="cycle"
      ? [makeEdge(first,second,1),makeEdge(second,first,2)]
      : [makeEdge(first,missing,1)];

    await assert.rejects(
      fixture.github.apply(edges.map(makeOperation),{idempotencyKey:(mode==="cycle" ? "c" : "d").repeat(64)}),
      error => error instanceof CoreValidationError,
      mode,
    );
    assert.deepEqual(fixture.view().dependency.edges,[],`${mode} mutated dependency state`);
    assert.deepEqual(fixture.view().dependency.relationships,[],`${mode} mutated native relationships`);
  }
});

test("dependency readiness, cycle rejection, revision-bound removal, tombstone history, and replay are deterministic",async () => {
  const a=`${REPOSITORY}#61`; const b=`${REPOSITORY}#62`; const c=`${REPOSITORY}#63`;
  const add={kind:"requires",rationale:"ordered work",provenance:{source_revision:"request@1",source_sha256:HASH_A,locations:["dependency"]}};
  const inputs={"add.json":add};
  const {fixture,services}=harness({inputs});
  for (const number of [61,62,63]) seedBacklog(fixture,REPOSITORY,number);
  await runDependencyCommand(command(["dependency","add",a,b,"--from","add.json","--apply","--non-interactive"]),services);
  await runDependencyCommand(command(["dependency","add",b,c,"--from","add.json","--apply","--non-interactive"]),services);
  const check=await runDependencyCommand(command(["dependency","check",a]),services);
  assert.equal(JSON.stringify(check.readiness),JSON.stringify({ready:false,blocking:[b]}));
  await assert.rejects(
    runDependencyCommand(command(["dependency","add",c,a,"--from","add.json"]),services),
    error => error instanceof CoreValidationError && /cycle/i.test(error.message),
  );
  const current=(await runDependencyCommand(command(["dependency","graph"]),services)).graph.edges.find(value => value.source===a);
  inputs["remove.json"]={reason:"Dependency was delivered independently.",expected_edge_revision:current.revision};
  await runDependencyCommand(command(["dependency","remove",a,b,"--from","remove.json","--apply","--non-interactive"]),services);
  const replay=await runDependencyCommand(command(["dependency","remove",a,b,"--from","remove.json","--apply","--non-interactive"]),services);
  assert.equal(replay.status,"already-reconciled");
  const state=fixture.view().dependency;
  assert.equal(state.edges.some(value => value.source===a && value.target===b),false);
  assert.equal(state.tombstones.length,1);
  assert.equal(state.tombstones[0].reason,inputs["remove.json"].reason);
});

test("dependency reads reject native relationship evidence that is not exactly backed by one managed edge",async () => {
  const {fixture}=harness();
  seedBacklog(fixture,REPOSITORY,71);
  seedBacklog(fixture,REPOSITORY,72);
  const snapshot=structuredClone(await fixture.github.snapshot({kind:"dependency-graph",root:null}));
  snapshot.relationships.push({edge_id:"DEP-orphan",source:`${REPOSITORY}#71`,target:`${REPOSITORY}#72`,revision:"edge-orphan"});
  assert.throws(
    () => dependencyGraphResult(snapshot,null),
    error => error instanceof CoreConflictError && error.exitCode===6,
  );
});

test("tombstoned dependency identity conflicts in pure planning and the public runner path",async () => {
  const {fixture,services,source,target,add,inputs}=await removedDependencyHarness();
  const snapshot=await fixture.github.snapshot({kind:"dependency-mutation",source,target});
  const changed={kind:"requires",rationale:"A different rationale cannot resurrect it.",provenance:{source_revision:"request@2",source_sha256:"b".repeat(64),locations:["dependencies[1]"]}};
  for (const input of [add,changed]) {
    assert.throws(
      () => dependencyAddOperations({source,target,input,snapshot,reconciled_at:NOW}),
      error => error instanceof CoreConflictError && error.exitCode===6,
    );
  }
  inputs["add.json"]=changed;
  await assert.rejects(
    runDependencyCommand(command(["dependency","add",source,target,"--from","add.json","--apply","--non-interactive"]),services),
    error => error instanceof CoreConflictError && error.exitCode===6,
  );
  const graph=await runDependencyCommand(command(["dependency","graph"]),services);
  const check=await runDependencyCommand(command(["dependency","check",source]),services);
  assert.equal(graph.graph.edges.length,0);
  assert.equal(JSON.stringify(check.readiness),JSON.stringify({ready:true,blocking:[]}));
});

test("tombstoned dependency identity is independently rejected by fake apply",async () => {
  const {fixture,control,source}=await removedDependencyHarness();
  const original=control.events
    .filter(value => value.kind==="intent")
    .flatMap(value => value.value.operations)
    .find(value => value.payload.kind==="dependency-add");
  const operation={...original,expected_revision:fixture.view().dependency.revision};
  await assert.rejects(
    fixture.github.apply([operation],{idempotencyKey:"c".repeat(64)}),
    error => error instanceof CoreConflictError && error.exitCode===6,
  );
  const check=dependencyGraphResult(await fixture.github.snapshot({kind:"dependency-graph",root:source}),source,{check:true});
  assert.equal(JSON.stringify(check.readiness),JSON.stringify({ready:true,blocking:[]}));
});

test("snapshot purity preserves stored work during issue start preview and dry-run",async () => {
  for (const suffix of [[],["--dry-run"]]) {
    const {fixture,services}=harness();
    const work=activeWork("issue");
    fixture.seedWork(work);
    await runIssueCommand(command(["issue","start",work.item.id,"--apply","--non-interactive"]),services);
    const before=storedWork(fixture,work.item.id);
    await runIssueCommand(command(["issue","start",work.item.id,...suffix]),services);
    assert.deepEqual(storedWork(fixture,work.item.id),before);
  }
});

test("snapshot purity preserves stored work during issue submit preview and dry-run",async () => {
  for (const suffix of [[],["--dry-run"]]) {
    const {fixture,services}=harness();
    const work=activeWork("bug");
    fixture.seedWork(work);
    await runIssueCommand(command(["issue","start",work.item.id,"--apply","--non-interactive"]),services);
    await runIssueCommand(command(["issue","submit",work.item.id,"--apply","--non-interactive"]),services);
    const before=storedWork(fixture,work.item.id);
    await runIssueCommand(command(["issue","submit",work.item.id,...suffix]),services);
    assert.deepEqual(storedWork(fixture,work.item.id),before);
  }
});

test("governing provenance binds issue start base revision to parent or release evidence",() => {
  for (const kind of ["issue","bug"]) {
    const work=activeWork(kind);
    assert.throws(
      () => issueStartOperations({
        id:work.item.id,
        snapshot:mutationSnapshot("issue-start",work,{baseRevision:"wrong-governing-revision"}),
        reconciled_at:NOW,
      }),
      error => error instanceof CoreConflictError && error.exitCode===6,
    );
  }
});

test("governing provenance binds issue submit base revision and physical branch base",() => {
  for (const kind of ["issue","bug"]) {
    const work=activeWork(kind);
    work.physical_branch={exists:true,head_sha:SHA_A};
    assert.throws(
      () => issueSubmitOperations({
        id:work.item.id,
        snapshot:mutationSnapshot("issue-submit",work,{baseRevision:"wrong-governing-revision"}),
        reconciled_at:NOW,
      }),
      error => error instanceof CoreConflictError && error.exitCode===6,
    );
  }
  const work=activeWork("bug");
  work.physical_branch={exists:true,head_sha:SHA_A};
  assert.throws(
    () => issueSubmitOperations({
      id:work.item.id,
      snapshot:mutationSnapshot("issue-submit",work,{branchBase:"release/v9.9.9"}),
      reconciled_at:NOW,
    }),
    error => error instanceof CoreConflictError && error.exitCode===6,
  );
});

test("operation option wrappers reject proxy accessor symbol hidden sparse and extra data without traps",async () => {
  const state=harness();
  const featureIdentity=featureRequestIdentity(REPOSITORY,featureInput);
  const featureSnapshot=await state.fixture.github.snapshot({kind:"feature-by-marker",repository:REPOSITORY,request_identity:featureIdentity});
  const issueIdentity=sha256Canonical({repository:REPOSITORY,...normalizeIssueInput(bugInput)});
  const issueSnapshot=await state.fixture.github.snapshot({kind:"issue-by-marker",repository:REPOSITORY,request_identity:issueIdentity});
  const startWork=activeWork("issue");
  const submitWork=activeWork("bug");
  submitWork.physical_branch={exists:true,head_sha:SHA_A};

  const dependencyInput={kind:"requires",rationale:"Wrapper validation target.",provenance:{source_revision:"request@1",source_sha256:HASH_A,locations:["dependency"]}};
  const dependencyState=harness({inputs:{"edge.json":dependencyInput}});
  const source=`${REPOSITORY}#91`; const target=`${REPOSITORY}#92`;
  seedBacklog(dependencyState.fixture,REPOSITORY,91);
  seedBacklog(dependencyState.fixture,REPOSITORY,92);
  await runDependencyCommand(command(["dependency","add",source,target,"--from","edge.json","--apply","--non-interactive"]),dependencyState.services);
  const dependencySnapshot=await dependencyState.fixture.github.snapshot({kind:"dependency-graph",root:null});
  const edge=dependencySnapshot.edges[0];

  const entries=[
    {label:"feature add",valid:{repository:REPOSITORY,input:featureInput,snapshot:featureSnapshot,reconciled_at:NOW},invoke:value => featureAddOperations(value)},
    {label:"issue add",valid:{repository:REPOSITORY,input:bugInput,snapshot:issueSnapshot,reconciled_at:NOW},invoke:value => issueAddOperations(value)},
    {label:"issue start",valid:{id:startWork.item.id,snapshot:mutationSnapshot("issue-start",startWork),reconciled_at:NOW},invoke:value => issueStartOperations(value)},
    {label:"issue submit",valid:{id:submitWork.item.id,snapshot:mutationSnapshot("issue-submit",submitWork),reconciled_at:NOW},invoke:value => issueSubmitOperations(value)},
    {label:"dependency add",valid:{source,target,input:dependencyInput,snapshot:dependencySnapshot},invoke:value => dependencyAddOperations(value)},
    {label:"dependency remove",valid:{source,target,input:{reason:"Wrapper validation.",expected_edge_revision:edge.revision},snapshot:dependencySnapshot,removed_at:NOW},invoke:value => dependencyRemoveOperations(value)},
    {label:"dependency graph options",valid:{check:false},invoke:value => dependencyGraphResult(dependencySnapshot,null,value)},
  ];
  for (const entry of entries) {
    for (const variant of opaqueWrapperCases(entry.valid)) {
      const before=variant.counter.value;
      assert.throws(
        () => entry.invoke(variant.value),
        error => error instanceof CoreValidationError && error.exitCode===5,
        `${entry.label} accepted ${variant.name}`,
      );
      assert.equal(variant.counter.value,before,`${entry.label} invoked ${variant.name}`);
    }
  }
});

test("Task 4 service ports reject accessor and proxy-backed github and operations without traps",async () => {
  const cases=[
    {key:"github",argv:["feature","status",`${REPOSITORY}#1`]},
    {key:"operations",argv:["feature","add",REPOSITORY,"--from","feature.json"]},
  ];
  for (const item of cases) {
    for (const kind of ["accessor","proxy"]) {
      const state=harness();
      if (item.key==="github") {
        await runFeatureCommand(command(["feature","add",REPOSITORY,"--from","feature.json","--apply","--non-interactive"]),state.services);
      }
      let traps=0;
      const services={...state.services};
      if (kind==="accessor") {
        Object.defineProperty(services,item.key,{enumerable:true,get() {
          traps+=1;
          return state.services[item.key];
        }});
      } else {
        services[item.key]=new Proxy(state.services[item.key],{get(target,key,receiver) {
          traps+=1;
          return Reflect.get(target,key,receiver);
        }});
      }
      const result=await dispatchCoreCommand(command([...item.argv,"--json"]),{services});
      assert.equal(result.exitCode,5,`${item.key} ${kind}`);
      assert.equal(traps,0,`${item.key} ${kind}`);
    }
  }
});

test("runner preview purity, confirmation, stale revisions, and failed observation receipts remain enforced",async () => {
  const {fixture,control,services,runner}=harness();
  const preview=await runFeatureCommand(command(["feature","add",REPOSITORY,"--from","feature.json","--dry-run"]),services);
  assert.equal(preview.schema_version,"operation-preview.v1");
  assert.equal(control.events.length,0);
  assert.equal(fixture.view().calls.filter(value => value.method!=="snapshot").length,0);

  await assert.rejects(
    runFeatureCommand(command(["feature","add",REPOSITORY,"--from","feature.json","--apply"]),services),
    error => error.exitCode===4,
  );

  const snapshot=await fixture.github.snapshot({kind:"feature-by-marker",repository:REPOSITORY,request_identity:"f".repeat(64)});
  fixture.setRepositoryRevision(REPOSITORY,"repository-99");
  await assert.rejects(runner.execute({
    command:command(["feature","add",REPOSITORY,"--from","feature.json","--apply","--non-interactive"]),
    source:snapshot.source,authority:null,
    operations:[{resource:"issue",action:"create",repository:REPOSITORY,expected_revision:snapshot.revision,payload:{kind:"unreachable"}}],
  }),error => error.exitCode===6);
  assert.equal(control.events.at(-1).value.status,"failed");
});

test("stateful fake exposes incomplete apply observations as one immutable failed runner receipt",async () => {
  const {fixture,control,services}=harness();
  fixture.setFailureMode("missing-apply-observation");
  await assert.rejects(
    runFeatureCommand(command(["feature","add",REPOSITORY,"--from","feature.json","--apply","--non-interactive"]),services),
    error => error.exitCode===70 && error.code==="CORE_REMOTE_FAILURE",
  );
  assert.deepEqual(control.events.map(value => value.kind),["intent","receipt"]);
  assert.equal(control.events[1].value.status,"failed");
});

test("hostile input and snapshot boundaries reject accessors and proxies without invoking traps",async () => {
  let reads=0;
  const accessor={title:"safe",description:"safe",priority:1};
  Object.defineProperty(accessor,"change_class",{enumerable:true,get() { reads+=1; return "backward_compatible_feature"; }});
  const first=harness({inputs:{"hostile.json":featureInput}});
  const firstServices=Object.freeze({...first.services,async readInput() { return accessor; }});
  await assert.rejects(
    runFeatureCommand(command(["feature","add",REPOSITORY,"--from","hostile.json"]),firstServices),
    error => error instanceof CoreValidationError,
  );
  assert.equal(reads,0);

  const proxy=new Proxy({}, {
    get() { reads+=1; throw new Error("get trap"); },
    getPrototypeOf() { reads+=1; throw new Error("prototype trap"); },
    ownKeys() { reads+=1; throw new Error("keys trap"); },
  });
  assert.throws(() => normalizeIssueInput(proxy),CoreValidationError);
  assert.equal(reads,0);

  assert.throws(() => featureRequestIdentity(proxy,featureInput),CoreValidationError);
  assert.equal(reads,0);
});

test("Task 4 command families preserve JSON result envelopes and typed exit mappings",async () => {
  const {services}=harness();
  const success=await dispatchCoreCommand(command(["feature","add",REPOSITORY,"--from","feature.json","--json"]),{services});
  assert.equal(success.exitCode,0);
  assert.equal(success.result.schema_version,"command-result.v1");
  assert.equal(success.result.ok,true);
  const failure=await dispatchCoreCommand(command(["feature","status","not-an-id","--json"]),{services});
  assert.equal(failure.exitCode,5);
  assert.equal(failure.result.ok,false);
  assert.equal(failure.result.error.code,"CORE_CONTRACT_INVALID");
});
