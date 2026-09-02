import assert from "node:assert/strict";
import {generateKeyPairSync,sign} from "node:crypto";
import test from "node:test";

import {dispatchCoreCommand,parseCoreCommand} from "../src/core/commands/router.js";
import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {createOperationIntent} from "../src/core/operations/plan.js";
import {createOperationRunner} from "../src/core/operations/runner.js";
import {createCoreGithubFixture} from "./support/core-github-fixture.js";

const EPIC="TOSS-Soft/toss-cli#42";
const child=Object.freeze({schema_version:"work-item.v1",id:"TOSS-Soft/toss-cli#43",repository:"TOSS-Soft/toss-cli",issue_number:43,kind:"issue",parent_id:EPIC,acceptance_criteria:["The governed child is reconciled."],branch:"issue/43-governed-child",base_branch:"epic/42-organizational-lifecycle",milestone:null,status:"Backlog",gate:"RELEASE_PLANNING"});
const dependentChild=Object.freeze({...child,id:"TOSS-Soft/toss-cli#44",issue_number:44,acceptance_criteria:Object.freeze(["The dependency is complete."]),branch:"issue/44-dependent-child"});
const dependencyEdge=Object.freeze({schema_version:"dependency-edge.v1",edge_id:"DEP-0044-0043",source:dependentChild.id,target:child.id,kind:"requires",rationale:"The governed child must land first.",provenance:Object.freeze({source_revision:"feature-request@42",source_sha256:"a".repeat(64),locations:Object.freeze(["dependencies[0]"])}),revision:"EDGE-0044-0043@1"});
const work=Object.freeze({
  schema_version:"work-state-snapshot.v1",
  item:Object.freeze({schema_version:"work-item.v1",id:EPIC,repository:"TOSS-Soft/toss-cli",
    issue_number:42,kind:"epic",parent_id:null,branch:"epic/42-organizational-lifecycle",
    base_branch:null,milestone:null,status:"Backlog",gate:"EPIC_PREPARATION_REQUIRED"}),
  issue_state:"OPEN",drifted:false,epic_required:false,prepared:false,scope_approved:false,
  parent:null,release:Object.freeze({assigned:false,active:false,id:null,repository:null,branch:null,milestone:null,revision:null}),
  blocking_dependencies:Object.freeze([]),children_complete:false,
  physical_branch:Object.freeze({exists:false,head_sha:null}),pull_request:null,review:null,checks:null,
  authority:Object.freeze({epic_acceptance_required:false,release_approval_required:false}),
  project:Object.freeze({project_id:"PVT_TOSS_OS_2",item_id:"PVTI_42",revision:"project-1",
    fields:Object.freeze({Status:"Backlog",Gate:"EPIC_PREPARATION_REQUIRED",repository:"TOSS-Soft/toss-cli",parent:null,milestone:null,branch:"epic/42-organizational-lifecycle",base_branch:null,last_reconciled_at:"2026-09-02T08:00:00.000Z"})}),
});
const emptyDependency=Object.freeze({kind:"dependency-graph",source:Object.freeze({repository:"TOSS-Soft/toss-os-control",revision:"dependency-1",sha256:"b".repeat(64)}),revision:"dependency-1",root:null,nodes:Object.freeze([EPIC]),edges:Object.freeze([]),completed_ids:Object.freeze([]),relationships:Object.freeze([]),tombstones:Object.freeze([]),next_edge_revision:"edge-2"});

function completedChildEvidence({revision,projectRevision,head,release}) {
  const item={...child,milestone:release.milestone,status:"Done",gate:"NONE"};
  return {
    id:child.id,revision,
    source:{repository:child.repository,revision,sha256:"c".repeat(64)},
    work:{
      schema_version:"work-state-snapshot.v1",item,issue_state:"CLOSED",drifted:false,
      epic_required:false,prepared:null,scope_approved:null,
      parent:{id:EPIC,branch:work.item.branch,revision:"issue-42-2"},release,
      blocking_dependencies:[],children_complete:null,
      physical_branch:{exists:true,head_sha:head},
      pull_request:{state:"MERGED",head_sha:head,merged_sha:head},review:null,checks:null,
      authority:{epic_acceptance_required:false,release_approval_required:false},
      project:{project_id:"PVT_TOSS_OS_2",item_id:"PVTI_43",revision:projectRevision,
        fields:{Status:"Done",Gate:"NONE",repository:child.repository,parent:child.parent_id,milestone:item.milestone,branch:child.branch,base_branch:child.base_branch,last_reconciled_at:"2026-09-02T08:00:00.000Z"}},
    },
    native_parent_id:EPIC,projected:true,
  };
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
    async loadOperationState() {
      return {revision:head,intents:[...intents.values()].map(value => structuredClone(value)),receipts:[...receipts.values()].map(value => structuredClone(value))};
    },
    async commitIntent({expectedHead,intent}) {
      assert.equal(expectedHead,head);
      intents.set(intent.intent_id,structuredClone(intent));
      events.push({kind:"intent",value:structuredClone(intent)});
      head=`control-${events.length+1}`;
      return {commit_sha:head};
    },
    async commitReceipt({expectedHead,receipt}) {
      assert.equal(expectedHead,head);
      receipts.set(receipt.intent_id,structuredClone(receipt));
      events.push({kind:"receipt",value:structuredClone(receipt)});
      head=`control-${events.length+1}`;
      return {commit_sha:head};
    },
  });
}

function immutableApprovalControl(binding,id) {
  const intent=createOperationIntent({
    intent_id:"INTENT-20260902-0998",created_at:"2026-09-02T07:00:00.000Z",
    command:"epic.approve",policy_revision:"POLICY-0001",
    source:{repository:"TOSS-Soft/toss-cli",revision:"repository-approval",sha256:"9".repeat(64)},
    authority:{record_id:"AUTH-20260902-0998",sha256:"8".repeat(64)},
    operations:[{resource:"issue",action:"update",repository:"TOSS-Soft/toss-cli",
      expected_revision:binding.epic.revision,
      payload:{kind:"epic-approve",authority_binding:binding,work:{item:{id}}}}],
  });
  const receipt={
    schema_version:"operation-receipt.v1",document_type:"operation-receipt",
    receipt_id:"RECEIPT-20260902-0998",intent_id:intent.intent_id,
    intent_sha256:sha256Canonical(intent),created_at:"2026-09-02T07:01:00.000Z",
    status:"completed",observed_revisions:[{operation_id:intent.operations[0].operation_id,
      repository:"TOSS-Soft/toss-cli",revision:"issue-approval-complete"}],
  };
  return {async loadOperationState() {
    return {revision:"control-approval",intents:[intent],receipts:[receipt]};
  }};
}

function fakeHarness(inputs,{authorityRegistry={keys:[]},authorities={}}={}) {
  const fixture=createCoreGithubFixture();
  const control=memoryControl();
  let sequence=0;
  const runner=createOperationRunner({
    control,github:fixture.github,authorityRegistry,
    clock:() => "2026-09-02T08:00:00.000Z",
    idGenerator:kind => `${kind==="intent" ? "INTENT" : "RECEIPT"}-20260902-${String(++sequence).padStart(4,"0")}`,
    policyRevision:() => "POLICY-0001",
  });
  const services=Object.freeze({
    control,github:fixture.github,operations:runner,clock:() => "2026-09-02T08:00:00.000Z",
    policyRevision:() => "POLICY-0001",
    async readInput(path) { return structuredClone(inputs[path]); },
    async readAuthority(path) { return structuredClone(authorities[path]); },
  });
  return {fixture,control,services};
}

function signedAuthority(privateKey,{record_id,command,targets,expected_revisions,actor="independent-approver"}) {
  const unsigned={
    schema_version:"authority-record.v1",document_type:"authority-record",record_id,
    actor,command,targets:[...targets].sort(),
    expected_revisions:[...expected_revisions].sort((left,right) => canonicalJson(left).localeCompare(canonicalJson(right))),
    policy_revision:"POLICY-0001",issued_at:"2026-09-02T07:00:00.000Z",
    expires_at:"2026-09-02T09:00:00.000Z",
  };
  return {...unsigned,signature:{algorithm:"ed25519",key_id:"approver",value:sign(null,Buffer.from(canonicalJson(unsigned)),privateKey).toString("base64")}};
}

async function approvedFakeHarness({children=[child],dependencies=[],approvalConfirmation=null}={}) {
  const plan={plan_id:"EPIC-PLAN-0042",created_at:"2026-09-01T10:00:00.000Z",source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@42",sha256:"a".repeat(64)},epic:work.item,children,dependencies};
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  const authorities={};
  const inputs={"plan.json":plan};
  const state=fakeHarness(inputs,{
    authorityRegistry:{keys:[{key_id:"approver",actor:"independent-approver",public_key:publicKey.export({format:"pem",type:"spki"}).toString()}]},
    authorities,
  });
  state.fixture.seedWork(work);
  await dispatchCoreCommand(parseCoreCommand(["epic","prepare",EPIC,"--from","plan.json","--apply","--non-interactive"]),{services:state.services});
  const preparedView=state.fixture.view();
  const repository=preparedView.repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
  const epic=repository.issues.find(value => value.work.item.id===EPIC);
  const binding={
    epic:{id:EPIC,revision:epic.revision},
    plan:{plan_id:epic.epic_plan.plan_id,content_sha256:epic.epic_plan.content_sha256},
    children:children.map(planned => ({id:planned.id,revision:repository.issues.find(value => value.work.item.id===planned.id).revision})).sort((left,right) => left.id.localeCompare(right.id)),
    edges:epic.epic_plan.edges.map(edge => ({edge_id:edge.edge_id,revision:edge.revision})),
    project:{id:preparedView.project.id,revision:preparedView.project.revision},policy_revision:"POLICY-0001",
  };
  authorities["approve.json"]=signedAuthority(privateKey,{
    record_id:"AUTH-20260902-0001",command:"epic.approve",
    targets:["TOSS-Soft/toss-cli",preparedView.project.id,`binding:${sha256Canonical(binding)}`],
    expected_revisions:[{repository:"TOSS-Soft/toss-cli",revision:epic.revision},{repository:null,revision:preparedView.project.revision}],
  });
  const approvalArgv=["epic","approve",EPIC,"--authority","approve.json","--apply",
    ...(approvalConfirmation===null ? ["--non-interactive"] : [])];
  const approvalResult=await dispatchCoreCommand(parseCoreCommand(approvalArgv),{
    services:state.services,...(approvalConfirmation===null ? {} : {confirm:approvalConfirmation}),
  });
  return {...state,plan,privateKey,authorities,inputs,approvalResult};
}

async function reviewedEpicHarness({children=[child],dependencies=[],completionOrder=children}={}) {
  const state=await approvedFakeHarness({children,dependencies});
  state.fixture.assignActiveRelease(EPIC,"v2.1.2");
  for (let index=0;index<completionOrder.length;index+=1) {
    const planned=completionOrder[index];
    await dispatchCoreCommand(parseCoreCommand(["issue","start",planned.id,"--apply","--non-interactive"]),{services:state.services});
    state.fixture.setBranchHead("TOSS-Soft/toss-cli",planned.branch,String.fromCharCode("e".charCodeAt(0)+index).repeat(40));
    await dispatchCoreCommand(parseCoreCommand(["issue","submit",planned.id,"--apply","--non-interactive"]),{services:state.services});
    state.fixture.mergeWorkPullRequest(planned.id);
  }
  await dispatchCoreCommand(parseCoreCommand(["epic","submit",EPIC,"--apply","--non-interactive"]),{services:state.services});
  const repository=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
  const pull=repository.pull_requests.find(value => value.work_item_id===EPIC);
  const commits=[{revision:pull.head_sha,author:"implementation-author",committer:"implementation-author"}];
  state.fixture.enableReviewPullRequest("TOSS-Soft/toss-cli",pull.number,{
    checks:{state:"PASSED",revision:pull.head_sha},
    implementationIdentity:{base_revision:"1".repeat(40),revision:pull.head_sha,pull_request_author:"implementation-author",commit_count:1,commits_sha256:sha256Canonical(commits),commits},
  });
  state.inputs["review.json"]={
    schema_version:"review-result.v1",review_id:"REVIEW-20260902-0001",
    repository:"TOSS-Soft/toss-cli",pull_request_number:pull.number,
    reviewed_revision:pull.head_sha,reviewer:{identity:"independent-reviewer",role:"independent-reviewer"},
    verdict:"APPROVED",freshness:"CURRENT",findings:[],unresolved:[],
    verification_evidence:["node --test test/core-epic-lifecycle.test.js"],follow_up_issues:[],
    reviewed_at:"2026-09-02T07:30:00.000Z",recorded_at:"2026-09-02T07:45:00.000Z",
  };
  await dispatchCoreCommand(parseCoreCommand(["review","record",`TOSS-Soft/toss-cli#${pull.number}`,"--from","review.json","--apply","--non-interactive"]),{services:state.services});
  return {...state,pull};
}

function acceptanceBinding(snapshot) {
  return {
    epic:{id:EPIC,revision:snapshot.epic_revision},
    plan:{plan_id:snapshot.plan.plan_id,content_sha256:snapshot.plan.content_sha256},
    children:snapshot.children.map(value => ({id:value.id,revision:value.revision})),
    edges:snapshot.edges.map(value => ({edge_id:value.edge_id,revision:value.revision})),
    release:snapshot.release,pull_request:snapshot.pull_request,review:snapshot.review,
    checks:snapshot.checks,project:snapshot.project,policy_revision:"POLICY-0001",
  };
}

function authorizeAccept(state,snapshot,recordId="AUTH-20260902-0099") {
  const binding=acceptanceBinding(snapshot);
  state.authorities["accept.json"]=signedAuthority(state.privateKey,{
    record_id:recordId,command:"epic.accept",
    targets:["TOSS-Soft/toss-cli",snapshot.project.id,`binding:${sha256Canonical(binding)}`],
    expected_revisions:[{repository:"TOSS-Soft/toss-cli",revision:snapshot.pull_request.revision},{repository:null,revision:snapshot.project.revision}],
  });
  return binding;
}

function withSnapshotMutation(state,kind,mutate) {
  const github=Object.freeze({async snapshot(query) {
    const observed=await state.fixture.github.snapshot(query);
    if (query.kind!==kind) return observed;
    const changed=structuredClone(observed);
    mutate(changed);
    return changed;
  }});
  return Object.freeze({...state.services,github});
}

test("fake acceptance and status snapshots expose full scope and physical branch evidence",async () => {
  const state=await reviewedEpicHarness();

  const acceptance=await state.fixture.github.snapshot({kind:"epic-accept",id:EPIC});
  const status=await state.fixture.github.snapshot({kind:"epic-status",id:EPIC});

  assert.ok(acceptance.children[0].work,"acceptance child evidence must include full work state");
  assert.equal(acceptance.children[0].work.pull_request.state,"MERGED");
  assert.equal(acceptance.branch.name,work.item.branch);
  assert.ok(status.children[0].work,"status child evidence must include full work state");
  assert.equal(status.children[0].work.project.fields.Status,"Done");
});

// This fails if the public router leaves an implemented epic command on the
// declared-but-unimplemented path.
test("epic status is handled by the public core router",async () => {
  const result=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{
    services:Object.freeze({github:Object.freeze({
      async snapshot(query) {
        assert.deepEqual(query,{kind:"epic-status",id:EPIC});
        return {kind:"epic-status",source:{repository:"TOSS-Soft/toss-cli",revision:"repository-1",sha256:"a".repeat(64)},epic:work,epic_revision:"issue-42-1",plan:null,epic_approval:null,children:[],edges:[],release:work.release,branch:null,pull_request:null,review:null,checks:null,project:{id:"PVT_TOSS_OS_2",revision:"project-1"}};
      },
    })}),
  });

  assert.equal(result.exitCode,0,result.result.data?.message ?? result.result.error?.message);
  assert.equal(result.result.data.state.gate,"EPIC_PREPARATION_REQUIRED");
});

test("epic prepare normalizes the exact plan and persists a preparation intent",async () => {
  const plan={plan_id:"EPIC-PLAN-0042",created_at:"2026-09-01T10:00:00.000Z",source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@42",sha256:"a".repeat(64)},epic:work.item,children:[child],dependencies:[]};
  const calls=[];
  const services={
    async readInput() { return plan; }, clock:() => "2026-09-02T08:00:00.000Z",
    github:{async snapshot(query) { calls.push(query); return {kind:"epic-prepare",source:{repository:"TOSS-Soft/toss-cli",revision:"repository-1",sha256:"b".repeat(64)},epic:work,epic_plan:null,epic_approval:null,preparation:{revision:"repository-1",children:[],relationships:[]},dependency:emptyDependency}; }},
    operations:{async execute(input) { calls.push(input); return {status:"completed",operations:input.operations}; }},
  };
  const result=await dispatchCoreCommand(parseCoreCommand(["epic","prepare",EPIC,"--from","plan.json","--apply","--non-interactive"]),{services});
  assert.equal(result.exitCode,0,result.result.data?.message ?? result.result.error?.message);
  const intent=calls.at(-1);
  const preparation=intent.operations.find(value => value.payload.kind==="epic-prepare");
  assert.equal(preparation.payload.plan.content_sha256,sha256Canonical({schema_version:"epic-plan.v1",plan_id:plan.plan_id,source:plan.source,epic:plan.epic,children:[child],edges:[],created_at:plan.created_at}));
  assert.equal(preparation.payload.work.item.gate,"EPIC_APPROVAL_REQUIRED");
});

test("epic prepare validates the complete post-intent organization DAG and existing external targets",async () => {
  const external=`TOSS-Soft/toss-cli#99`;
  const edge=(source,target,suffix) => ({
    schema_version:"dependency-edge.v1",edge_id:`DEP-${suffix}`,source,target,kind:"requires",
    rationale:"The complete organization graph must remain acyclic.",
    provenance:{source_revision:"feature-request@42",source_sha256:"a".repeat(64),locations:[`dependencies[${suffix}]`]},
    revision:`EDGE-${suffix}@1`,
  });
  const cases=[
    {
      label:"combined cycle",
      desired:edge(child.id,external,"child-external"),
      dependency:{...structuredClone(emptyDependency),nodes:[EPIC,child.id,external],
        edges:[edge(external,child.id,"external-child")],
        relationships:[{edge_id:"DEP-external-child",source:external,target:child.id,revision:"EDGE-external-child@1"}]},
    },
    {
      label:"dangling external target",
      desired:edge(child.id,external,"missing-external"),
      dependency:{...structuredClone(emptyDependency),nodes:[EPIC]},
    },
  ];

  for (const item of cases) {
    const plan={plan_id:"EPIC-PLAN-0042",created_at:"2026-09-01T10:00:00.000Z",
      source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@42",sha256:"a".repeat(64)},
      epic:work.item,children:[child],dependencies:[item.desired]};
    let executed=false;
    const services={
      async readInput() { return plan; },
      github:{async snapshot() { return {kind:"epic-prepare",source:{repository:"TOSS-Soft/toss-cli",revision:"repository-1",sha256:"b".repeat(64)},epic:work,epic_plan:null,epic_approval:null,preparation:{revision:"repository-1",children:[],relationships:[]},dependency:item.dependency}; }},
      operations:{async execute() { executed=true; return {status:"completed"}; }},
    };

    const result=await dispatchCoreCommand(parseCoreCommand(["epic","prepare",EPIC,"--from","plan.json"]),{services});

    assert.equal(result.exitCode,5,item.label);
    assert.equal(executed,false,item.label);
  }
});

test("epic prepare replaces stale completion and blocker caches with the exact prepared scope",async () => {
  const stale=structuredClone(work);
  stale.children_complete=true;
  stale.blocking_dependencies=[`${EPIC.slice(0,EPIC.lastIndexOf("#"))}#99`];
  const plan={plan_id:"EPIC-PLAN-0042",created_at:"2026-09-01T10:00:00.000Z",
    source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@42",sha256:"a".repeat(64)},
    epic:work.item,children:[child],dependencies:[]};
  let request;
  const services={
    async readInput() { return plan; },
    github:{async snapshot() { return {kind:"epic-prepare",source:{repository:"TOSS-Soft/toss-cli",revision:"repository-1",sha256:"b".repeat(64)},epic:stale,epic_plan:null,epic_approval:null,preparation:{revision:"repository-1",children:[],relationships:[]},dependency:{...structuredClone(emptyDependency),nodes:[EPIC,child.id]}}; }},
    operations:{async execute(input) { request=input; return {status:"completed"}; }},
  };

  const result=await dispatchCoreCommand(parseCoreCommand(["epic","prepare",EPIC,"--from","plan.json"]),{services});

  assert.equal(result.exitCode,0,result.result.error?.message);
  const projected=request.operations.find(value => value.payload.kind==="epic-prepare").payload.work;
  assert.equal(projected.children_complete,false);
  assert.deepEqual(projected.blocking_dependencies,[]);
});

test("epic preparation scopes managed markers to their exact verified parent",async () => {
  const state=await approvedFakeHarness();
  const secondId="TOSS-Soft/toss-cli#50";
  const second=structuredClone(work);
  second.item.id=secondId;
  second.item.issue_number=50;
  second.item.branch="epic/50-second-parent";
  second.project.item_id="PVTI_50";
  second.project.revision=state.fixture.view().project.revision;
  second.project.fields.branch=second.item.branch;
  state.fixture.seedWork(second);
  const secondChild={...child,id:"TOSS-Soft/toss-cli#51",issue_number:51,
    parent_id:secondId,branch:"issue/51-second-parent-child",base_branch:second.item.branch};
  state.inputs["second-plan.json"]={
    plan_id:"EPIC-PLAN-0050",created_at:"2026-09-02T09:00:00.000Z",
    source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@50",sha256:"5".repeat(64)},
    epic:second.item,children:[secondChild],dependencies:[],
  };

  const snapshot=await state.fixture.github.snapshot({kind:"epic-prepare",id:secondId});
  assert.deepEqual(snapshot.preparation.children,[]);
  assert.deepEqual(snapshot.preparation.relationships,[]);
  const result=await dispatchCoreCommand(
    parseCoreCommand(["epic","prepare",secondId,"--from","second-plan.json","--apply","--non-interactive"]),
    {services:state.services},
  );
  assert.equal(result.exitCode,0,result.result.error?.message);
});

test("epic approve rejects unprepared work and missing prepared-scope evidence",async () => {
  const plan={schema_version:"epic-plan.v1",plan_id:"EPIC-PLAN-0042",created_at:"2026-09-01T10:00:00.000Z",source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@42",sha256:"a".repeat(64)},epic:work.item,children:[child],edges:[]};
  plan.content_sha256=sha256Canonical({...plan});
  const calls=[];
  let observedWork=work;
  const services={
    async readAuthority() { return {record_id:"AUTH-1",sha256:"b".repeat(64)}; },
    github:{async snapshot() { return {kind:"epic-approval",source:{repository:"TOSS-Soft/toss-cli",revision:"repository-2",sha256:"c".repeat(64)},epic:observedWork,epic_revision:"issue-42-1",plan,epic_approval:null,children:[],edges:[],project:{id:"PVT_TOSS_OS_2",revision:"project-1"}}; }},
    operations:{async execute(input) { calls.push(input); return {status:"completed"}; }}, policyRevision:() => "POLICY-0001",
  };
  const argv=["epic","approve",EPIC,"--authority","authority.json","--apply","--non-interactive"];
  const unprepared=await dispatchCoreCommand(parseCoreCommand(argv),{services});
  observedWork=structuredClone(work);
  observedWork.prepared=true;
  observedWork.item.gate="EPIC_APPROVAL_REQUIRED";
  observedWork.project.fields.Gate="EPIC_APPROVAL_REQUIRED";
  const missingScope=await dispatchCoreCommand(parseCoreCommand(argv),{services});
  assert.equal(unprepared.exitCode,6);
  assert.equal(missingScope.exitCode,6);
  assert.equal(calls.length,0);
});

test("epic approval keys valid multi-edge evidence independently of plan sort order",async () => {
  const third={...child,id:"TOSS-Soft/toss-cli#45",issue_number:45,
    branch:"issue/45-third-child",acceptance_criteria:["The shared target is governed."]};
  const edges=[
    {...dependencyEdge,edge_id:"DEP-Z-FIRST-SOURCE",source:child.id,target:third.id,
      revision:"EDGE-Z@1",provenance:{...dependencyEdge.provenance,locations:["dependencies[0]"]}},
    {...dependencyEdge,edge_id:"DEP-A-SECOND-SOURCE",source:dependentChild.id,target:third.id,
      revision:"EDGE-A@1",provenance:{...dependencyEdge.provenance,locations:["dependencies[1]"]}},
  ];
  const state=await approvedFakeHarness({children:[child,dependentChild,third],dependencies:edges});

  const result=await dispatchCoreCommand(
    parseCoreCommand(["epic","approve",EPIC,"--authority","approve.json","--apply","--non-interactive"]),
    {services:state.services},
  );
  assert.equal(result.exitCode,0,result.result.error?.message);
  const epic=state.fixture.view().repositories[0].issues.find(value => value.work.item.id===EPIC);
  assert.equal(epic.work.scope_approved,true);
});

test("epic approval routes its interactive final preview through the shared confirmation bridge",async () => {
  const previews=[];
  const state=await approvedFakeHarness({approvalConfirmation:async preview => {
    previews.push(preview);
    return true;
  }});
  assert.equal(state.approvalResult.exitCode,0,state.approvalResult.result.error?.message);
  assert.equal(previews.length,1);
  assert.equal(previews[0].command,"epic.approve");
});

test("epic submit targets only the active same-repository release branch after all children complete",async () => {
  const approved=structuredClone(work); approved.prepared=true; approved.scope_approved=true; approved.children_complete=true;
  approved.item.status="Ready"; approved.item.gate="NONE"; approved.item.base_branch="release/v2.1.2"; approved.item.milestone="v2.1.2";
  approved.release={assigned:true,active:true,id:"TOSS-Soft/toss-cli@release/v2.1.2",repository:"TOSS-Soft/toss-cli",branch:"release/v2.1.2",milestone:"v2.1.2",revision:"release-1"};
  approved.physical_branch={exists:true,head_sha:"d".repeat(40)};
  approved.project.revision="project-2";
  Object.assign(approved.project.fields,{Status:"Ready",Gate:"NONE",base_branch:"release/v2.1.2"});
  const plan={schema_version:"epic-plan.v1",plan_id:"EPIC-PLAN-0042",created_at:"2026-09-01T10:00:00.000Z",source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@42",sha256:"a".repeat(64)},epic:work.item,children:[child],edges:[]};
  plan.content_sha256=sha256Canonical({...plan});
  const approval={epic:{id:EPIC,revision:"issue-42-2"},plan:{plan_id:plan.plan_id,content_sha256:plan.content_sha256},children:[{id:child.id,revision:"issue-43-1"}],edges:[],project:{id:"PVT_TOSS_OS_2",revision:"project-1"},policy_revision:"POLICY-0001"};
  const calls=[];
  const services={control:immutableApprovalControl(approval,EPIC),policyRevision:() => "POLICY-0001",github:{async snapshot() { return {kind:"epic-submit",source:{repository:"TOSS-Soft/toss-cli",revision:"repository-3",sha256:"d".repeat(64)},epic:approved,epic_revision:"issue-42-3",plan,epic_approval:approval,children:[completedChildEvidence({revision:"issue-43-3",projectRevision:"project-2",head:"c".repeat(40),release:approved.release})],edges:[],release:approved.release,branch:{name:approved.item.branch,base_branch:"release/v2.1.2",head_sha:"d".repeat(40),revision:"branch-1"},pull_request:null,project:{id:"PVT_TOSS_OS_2",revision:"project-2"}}; }},operations:{async execute(input) { calls.push(input); return {status:"completed"}; }}};
  const result=await dispatchCoreCommand(parseCoreCommand(["epic","submit",EPIC,"--apply","--non-interactive"]),{services});
  assert.equal(result.exitCode,0,result.result.data?.message ?? result.result.error?.message);
  assert.equal(calls[0].operations[0].payload.base,"release/v2.1.2");
});

test("epic accept binds the current reviewed passing pull request before completion",async () => {
  const accepted=structuredClone(work); accepted.prepared=true; accepted.scope_approved=true; accepted.children_complete=true;
  accepted.item.status="In review"; accepted.item.gate="EPIC_ACCEPTANCE_REQUIRED"; accepted.item.base_branch="release/v2.1.2"; accepted.item.milestone="v2.1.2";
  accepted.release={assigned:true,active:true,id:"TOSS-Soft/toss-cli@release/v2.1.2",repository:"TOSS-Soft/toss-cli",branch:"release/v2.1.2",milestone:"v2.1.2",revision:"release-1"};
  const plan={schema_version:"epic-plan.v1",plan_id:"EPIC-PLAN-0042",created_at:"2026-09-01T10:00:00.000Z",source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@42",sha256:"a".repeat(64)},epic:work.item,children:[child],edges:[]};
  plan.content_sha256=sha256Canonical({...plan});
  const approval={epic:{id:EPIC,revision:"issue-42-2"},plan:{plan_id:plan.plan_id,content_sha256:plan.content_sha256},children:[{id:child.id,revision:"issue-43-1"}],edges:[],project:{id:"PVT_TOSS_OS_2",revision:"project-1"},policy_revision:"POLICY-0001"};
  const head="f".repeat(40); const calls=[];
  accepted.physical_branch={exists:true,head_sha:head};
  accepted.pull_request={state:"READY",head_sha:head,merged_sha:null};
  accepted.review={verdict:"APPROVED",reviewed_revision:head};
  accepted.checks={state:"PASSED",revision:head};
  accepted.authority.epic_acceptance_required=true;
  accepted.project.revision="project-3";
  Object.assign(accepted.project.fields,{Status:"In review",Gate:"EPIC_ACCEPTANCE_REQUIRED",base_branch:"release/v2.1.2"});
  const services={control:immutableApprovalControl(approval,EPIC),async readAuthority() { return {record_id:"AUTH-2",sha256:"a".repeat(64)}; },policyRevision:() => "POLICY-0001",github:{async snapshot() { return {kind:"epic-accept",source:{repository:"TOSS-Soft/toss-cli",revision:"repository-4",sha256:"f".repeat(64)},epic:accepted,epic_revision:"issue-42-4",plan,epic_approval:approval,children:[completedChildEvidence({revision:"issue-43-3",projectRevision:"project-3",head:"e".repeat(40),release:accepted.release})],edges:[],release:accepted.release,branch:{name:accepted.item.branch,base_branch:"release/v2.1.2",head_sha:head,revision:"branch-2"},pull_request:{id:"TOSS-Soft/toss-cli#42",number:42,revision:"pr-1",head_sha:head,head:work.item.branch,base:"release/v2.1.2",head_repository:"TOSS-Soft/toss-cli",base_repository:"TOSS-Soft/toss-cli",state:"READY",merged_sha:null},review:{id:"REVIEW-1",record_revision:"review-1",reviewed_revision:head,verdict:"APPROVED",independent:true,formal:true,reviewer:"reviewer"},checks:{state:"PASSED",revision:head,observation:"checks-1"},project:{id:"PVT_TOSS_OS_2",revision:"project-3"}}; }},operations:{async execute(input) { calls.push(input); return {status:"completed"}; }}};
  const result=await dispatchCoreCommand(parseCoreCommand(["epic","accept",EPIC,"--authority","authority.json","--apply","--non-interactive"]),{services});
  assert.equal(result.exitCode,0,result.result.data?.message ?? result.result.error?.message);
  assert.equal(calls[0].operations[0].payload.kind,"epic-accept");
  assert.equal(calls[0].operations[0].payload.authority_binding.pull_request.head_sha,head);
});

test("fake assigns an active same-repository release without mutating snapshots",async () => {
  const {fixture}=await approvedFakeHarness();
  const before=await fixture.github.snapshot({kind:"work-item",id:EPIC});
  fixture.assignActiveRelease(EPIC,"v2.1.2");
  const after=await fixture.github.snapshot({kind:"work-item",id:EPIC});
  assert.equal(before.work.release.assigned,false);
  assert.equal(after.work.release.branch,"release/v2.1.2");
  assert.equal(after.work.item.base_branch,"release/v2.1.2");
});

test("public epic prepare persists exact plan and native governed scope through the real fake runner",async () => {
  const plan={plan_id:"EPIC-PLAN-0042",created_at:"2026-09-01T10:00:00.000Z",source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@42",sha256:"a".repeat(64)},epic:work.item,children:[child],dependencies:[]};
  const {fixture,control,services}=fakeHarness({"plan.json":plan});
  fixture.seedWork(work);

  const result=await dispatchCoreCommand(parseCoreCommand([
    "epic","prepare",EPIC,"--from","plan.json","--apply","--non-interactive",
  ]),{services});

  assert.equal(result.exitCode,0,result.result.error?.message);
  const repository=fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
  const epic=repository.issues.find(value => value.work.item.id===EPIC);
  const governed=repository.issues.find(value => value.work.item.id===child.id);
  assert.equal(epic.epic_plan.content_sha256,sha256Canonical({schema_version:"epic-plan.v1",plan_id:plan.plan_id,source:plan.source,epic:plan.epic,children:[child],edges:[],created_at:plan.created_at}));
  assert.equal(epic.work.item.gate,"EPIC_APPROVAL_REQUIRED");
  assert.equal(governed.native_parent_id,EPIC);
  assert.equal(JSON.stringify(governed.work.item),JSON.stringify(child));
  assert.equal(governed.projected,true);
  const projectOperation=control.events[0].value.operations.find(value => value.resource==="project" && value.payload.item_id===work.project.item_id);
  assert.equal(projectOperation.payload.fields.Gate,"EPIC_APPROVAL_REQUIRED");
  assert.equal(control.events.length,2);
});

test("unresolved partial Epic preparation blocks a public apply before another intent or remote write",async () => {
  const plan={plan_id:"EPIC-PLAN-0042",created_at:"2026-09-01T10:00:00.000Z",source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@42",sha256:"a".repeat(64)},epic:work.item,children:[child],dependencies:[]};
  const state=fakeHarness({"plan.json":plan});
  state.fixture.seedWork(work);
  state.fixture.setFailureMode("fail-epic-prepare-after-child");
  const argv=["epic","prepare",EPIC,"--from","plan.json","--apply","--non-interactive"];

  const failed=await dispatchCoreCommand(parseCoreCommand(argv),{services:state.services});

  assert.equal(failed.exitCode,70);
  const intent=state.control.events.at(-2).value;
  const receipt=state.control.events.at(-1).value;
  assert.equal(receipt.status,"failed");
  assert.equal(receipt.observed_revisions.length,1);
  const completed=intent.operations.find(value => value.operation_id===receipt.observed_revisions[0].operation_id);
  assert.equal(Object.hasOwn(completed.payload,"native_parent_id"),true);
  assert.equal(state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli").issues.some(value => value.work.item.id===child.id),true);

  const status=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{services:state.services});
  assert.equal(status.exitCode,0,status.result.error?.message);
  assert.equal(status.result.data.state.status,"Blocked");
  assert.equal(status.result.data.state.gate,"RECONCILE_REQUIRED");
  assert.equal(status.result.data.reconciliation.required,true);
  assert.deepEqual(status.result.data.reconciliation.receipts[0].completed_operation_ids,[completed.operation_id]);

  state.fixture.setFailureMode(null);
  const eventCount=state.control.events.length;
  const mutationCallCount=state.fixture.view().calls.filter(value => ["inspect","apply"].includes(value.method)).length;
  const retry=await dispatchCoreCommand(parseCoreCommand(argv),{services:state.services});

  assert.equal(retry.exitCode,4,retry.result.data?.status ?? retry.result.error?.message);
  assert.match(retry.result.error.message,/Blocked \/ RECONCILE_REQUIRED/u);
  assert.equal(state.control.events.length,eventCount);
  assert.equal(state.fixture.view().calls.filter(value => ["inspect","apply"].includes(value.method)).length,mutationCallCount);
});

test("epic prepare reconciles exact dependency evidence and replays without another intent",async () => {
  const plan={plan_id:"EPIC-PLAN-0042",created_at:"2026-09-01T10:00:00.000Z",source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@42",sha256:"a".repeat(64)},epic:work.item,children:[dependentChild,child],dependencies:[dependencyEdge]};
  const {fixture,control,services}=fakeHarness({"plan.json":plan});
  fixture.seedWork(work);
  const argv=["epic","prepare",EPIC,"--from","plan.json","--apply","--non-interactive"];

  const first=await dispatchCoreCommand(parseCoreCommand(argv),{services});
  assert.equal(first.exitCode,0,first.result.error?.message);
  assert.equal(JSON.stringify(fixture.view().dependency.edges),JSON.stringify([dependencyEdge]));
  assert.equal(JSON.stringify(fixture.view().dependency.relationships),JSON.stringify([{edge_id:dependencyEdge.edge_id,source:dependencyEdge.source,target:dependencyEdge.target,revision:dependencyEdge.revision}]));

  const replay=await dispatchCoreCommand(parseCoreCommand(argv),{services});
  assert.equal(replay.exitCode,0,replay.result.error?.message);
  assert.equal(replay.result.data.status,"already-reconciled");
  assert.equal(control.events.length,2);
});

test("fake approval snapshot exposes full native child, dependency, and Project evidence",async () => {
  const plan={plan_id:"EPIC-PLAN-0042",created_at:"2026-09-01T10:00:00.000Z",source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@42",sha256:"a".repeat(64)},epic:work.item,children:[dependentChild,child],dependencies:[dependencyEdge]};
  const {fixture,services}=fakeHarness({"plan.json":plan});
  fixture.seedWork(work);
  const prepared=await dispatchCoreCommand(parseCoreCommand(["epic","prepare",EPIC,"--from","plan.json","--apply","--non-interactive"]),{services});
  assert.equal(prepared.exitCode,0,prepared.result.error?.message);

  const snapshot=await fixture.github.snapshot({kind:"epic-approval",id:EPIC});

  assert.equal(snapshot.children.length,2);
  assert.ok(snapshot.children[0].work,"approval child evidence must include the full work snapshot");
  assert.equal(snapshot.children[0].work.item.id,child.id);
  assert.equal(snapshot.children[0].native_parent_id,EPIC);
  assert.equal(snapshot.children[0].work.project.project_id,snapshot.project.id);
  assert.equal(snapshot.children[0].work.project.revision,snapshot.project.revision);
  assert.equal(snapshot.edges.length,1);
  assert.equal(canonicalJson(snapshot.edges[0].edge),canonicalJson(dependencyEdge));
  assert.equal(canonicalJson(snapshot.edges[0].relationship),canonicalJson({edge_id:dependencyEdge.edge_id,source:dependencyEdge.source,target:dependencyEdge.target,revision:dependencyEdge.revision}));
  assert.equal(snapshot.edges[0].target.work.item.id,child.id);
});

test("public epic approve verifies signed exact scope and persists an unversioned replay-safe approval",async () => {
  const plan={plan_id:"EPIC-PLAN-0042",created_at:"2026-09-01T10:00:00.000Z",source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@42",sha256:"a".repeat(64)},epic:work.item,children:[child],dependencies:[]};
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  const authorities={};
  const {fixture,control,services}=fakeHarness({"plan.json":plan},{
    authorityRegistry:{keys:[{key_id:"approver",actor:"independent-approver",public_key:publicKey.export({format:"pem",type:"spki"}).toString()}]},
    authorities,
  });
  fixture.seedWork(work);
  const prepared=await dispatchCoreCommand(parseCoreCommand(["epic","prepare",EPIC,"--from","plan.json","--apply","--non-interactive"]),{services});
  assert.equal(prepared.exitCode,0,prepared.result.error?.message);
  const preparedView=fixture.view();
  const repository=preparedView.repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
  const epic=repository.issues.find(value => value.work.item.id===EPIC);
  const governed=repository.issues.find(value => value.work.item.id===child.id);
  const binding={
    epic:{id:EPIC,revision:epic.revision},
    plan:{plan_id:epic.epic_plan.plan_id,content_sha256:epic.epic_plan.content_sha256},
    children:[{id:child.id,revision:governed.revision}],edges:[],
    project:{id:preparedView.project.id,revision:preparedView.project.revision},
    policy_revision:"POLICY-0001",
  };
  authorities["approve.json"]=signedAuthority(privateKey,{
    record_id:"AUTH-20260902-0001",command:"epic.approve",
    targets:["TOSS-Soft/toss-cli",preparedView.project.id,`binding:${sha256Canonical(binding)}`],
    expected_revisions:[
      {repository:"TOSS-Soft/toss-cli",revision:epic.revision},
      {repository:null,revision:preparedView.project.revision},
    ],
  });
  const argv=["epic","approve",EPIC,"--authority","approve.json","--apply","--non-interactive"];

  const approved=await dispatchCoreCommand(parseCoreCommand(argv),{services});
  assert.equal(approved.exitCode,0,approved.result.error?.message);
  const approvedEpic=fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli").issues.find(value => value.work.item.id===EPIC);
  assert.equal(JSON.stringify(approvedEpic.epic_approval),JSON.stringify(binding));
  assert.equal(approvedEpic.work.item.gate,"RELEASE_PLANNING");
  assert.equal(approvedEpic.work.item.milestone,null);
  assert.equal(approvedEpic.work.item.base_branch,null);
  const eventCount=control.events.length;

  const replay=await dispatchCoreCommand(parseCoreCommand(argv),{services});
  assert.equal(replay.exitCode,0,replay.result.error?.message);
  assert.equal(replay.result.data.status,"already-reconciled");
  assert.equal(control.events.length,eventCount);
  const prepareReplay=await dispatchCoreCommand(parseCoreCommand(["epic","prepare",EPIC,"--from","plan.json","--apply","--non-interactive"]),{services});
  assert.equal(prepareReplay.exitCode,0,prepareReplay.result.error?.message);
  assert.equal(prepareReplay.result.data.status,"already-reconciled");
  assert.equal(control.events.length,eventCount);
});

test("fake release assignment activates the approved epic hierarchy on one same-repository release",async () => {
  const {fixture,services}=await approvedFakeHarness();
  fixture.assignActiveRelease(EPIC,"v2.1.2");

  const epicSnapshot=await fixture.github.snapshot({kind:"work-item",id:EPIC});
  const childSnapshot=await fixture.github.snapshot({kind:"work-item",id:child.id});
  const repository=fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
  const epicBranch=repository.branches.find(value => value.name===work.item.branch);
  assert.equal(epicSnapshot.work.release.id,"TOSS-Soft/toss-cli@release/v2.1.2");
  assert.equal(epicSnapshot.work.item.base_branch,"release/v2.1.2");
  assert.equal(epicSnapshot.work.item.milestone,"v2.1.2");
  assert.equal(epicBranch.base_branch,"release/v2.1.2");
  assert.equal(childSnapshot.work.release.id,epicSnapshot.work.release.id);
  assert.equal(childSnapshot.work.item.base_branch,work.item.branch);
  assert.equal(childSnapshot.work.item.milestone,"v2.1.2");
  assert.equal(childSnapshot.work.item.status,"Ready");
  assert.equal(childSnapshot.work.item.gate,"NONE");
  const approvalReplay=await dispatchCoreCommand(parseCoreCommand(["epic","approve",EPIC,"--authority","approve.json","--apply","--non-interactive"]),{services});
  assert.equal(approvalReplay.exitCode,4);
  assert.match(approvalReplay.result.error.message,/DEPENDENCY_REQUIRED/u);
});

test("fake child completion merges the exact governed PR into its epic and closes native work",async () => {
  const {fixture,services}=await approvedFakeHarness();
  fixture.assignActiveRelease(EPIC,"v2.1.2");
  const start=await dispatchCoreCommand(parseCoreCommand(["issue","start",child.id,"--apply","--non-interactive"]),{services});
  assert.equal(start.exitCode,0,start.result.error?.message);
  const head="c".repeat(40);
  fixture.setBranchHead("TOSS-Soft/toss-cli",child.branch,head);
  const submit=await dispatchCoreCommand(parseCoreCommand(["issue","submit",child.id,"--apply","--non-interactive"]),{services});
  assert.equal(submit.exitCode,0,submit.result.error?.message);

  fixture.mergeWorkPullRequest(child.id);

  const childSnapshot=await fixture.github.snapshot({kind:"work-item",id:child.id});
  const epicSnapshot=await fixture.github.snapshot({kind:"work-item",id:EPIC});
  const submitSnapshot=await fixture.github.snapshot({kind:"epic-submit",id:EPIC});
  const epicBranch=fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli").branches.find(value => value.name===work.item.branch);
  assert.equal(childSnapshot.work.issue_state,"CLOSED");
  assert.equal(childSnapshot.work.pull_request.state,"MERGED");
  assert.equal(childSnapshot.work.project.fields.Status,"Done");
  assert.equal(epicSnapshot.work.children_complete,true);
  assert.equal(epicBranch.head_sha,head);
  assert.ok(submitSnapshot.children[0].work,"submit child evidence must include its full work snapshot");
  assert.equal(submitSnapshot.children[0].work.pull_request.state,"MERGED");
  assert.equal(submitSnapshot.children[0].work.pull_request.head_sha,head);
  assert.equal(submitSnapshot.children[0].work.project.fields.Status,"Done");
});

test("public epic submit creates one replay-safe PR only against the active release branch",async () => {
  const {fixture,control,services}=await approvedFakeHarness();
  fixture.assignActiveRelease(EPIC,"v2.1.2");
  await dispatchCoreCommand(parseCoreCommand(["issue","start",child.id,"--apply","--non-interactive"]),{services});
  fixture.setBranchHead("TOSS-Soft/toss-cli",child.branch,"d".repeat(40));
  await dispatchCoreCommand(parseCoreCommand(["issue","submit",child.id,"--apply","--non-interactive"]),{services});
  fixture.mergeWorkPullRequest(child.id);
  const argv=["epic","submit",EPIC,"--apply","--non-interactive"];

  const submitted=await dispatchCoreCommand(parseCoreCommand(argv),{services});
  assert.equal(submitted.exitCode,0,submitted.result.error?.message);
  const repository=fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
  const epicPull=repository.pull_requests.find(value => value.work_item_id===EPIC);
  assert.equal(epicPull.head,work.item.branch);
  assert.equal(epicPull.base,"release/v2.1.2");
  assert.notEqual(epicPull.base,"main");
  assert.equal(epicPull.head_repository,epicPull.base_repository);
  const eventCount=control.events.length;

  const replay=await dispatchCoreCommand(parseCoreCommand(argv),{services});
  assert.equal(replay.exitCode,0,replay.result.error?.message);
  assert.equal(replay.result.data.status,"already-reconciled");
  assert.equal(control.events.length,eventCount);
  assert.equal(fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli").pull_requests.filter(value => value.work_item_id===EPIC).length,1);
});

test("public epic submit promotes an exact existing DRAFT pull request and status immediately composes READY",async () => {
  const state=await approvedFakeHarness();
  state.fixture.assignActiveRelease(EPIC,"v2.1.2");
  await dispatchCoreCommand(parseCoreCommand(["issue","start",child.id,"--apply","--non-interactive"]),{services:state.services});
  state.fixture.setBranchHead("TOSS-Soft/toss-cli",child.branch,"d".repeat(40));
  await dispatchCoreCommand(parseCoreCommand(["issue","submit",child.id,"--apply","--non-interactive"]),{services:state.services});
  state.fixture.mergeWorkPullRequest(child.id);
  const before=await state.fixture.github.snapshot({kind:"epic-submit",id:EPIC});
  const draftIntent=createOperationIntent({
    intent_id:"INTENT-20260902-0900",created_at:"2026-09-02T07:55:00.000Z",
    command:"epic.submit",policy_revision:"POLICY-0001",source:before.source,authority:null,
    operations:[{resource:"pull_request",action:"create",repository:work.item.repository,
      expected_revision:before.source.revision,payload:{kind:"work-pull-request",work_item_id:EPIC,
        head:work.item.branch,base:before.release.branch,head_sha:before.branch.head_sha,draft:true}}],
  });
  await state.fixture.github.apply(draftIntent.operations,{idempotencyKey:sha256Canonical(draftIntent)});
  const draft=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli").pull_requests.find(value => value.work_item_id===EPIC);
  assert.equal(draft.state,"DRAFT");

  const argv=["epic","submit",EPIC,"--apply","--non-interactive"];
  const submitted=await dispatchCoreCommand(parseCoreCommand(argv),{services:state.services});

  assert.equal(submitted.exitCode,0,submitted.result.error?.message);
  const ready=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli").pull_requests.find(value => value.work_item_id===EPIC);
  assert.equal(ready.state,"READY");
  assert.notEqual(ready.revision,draft.revision);
  const status=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{services:state.services});
  assert.equal(status.exitCode,0,status.result.error?.message);
  assert.equal(status.result.data.pull_request.state,"READY");
  assert.equal(status.result.data.state.status,"In review");
  assert.equal(status.result.data.state.gate,"REVIEW_REQUIRED");
  assert.equal(status.result.data.project.id,"PVT_TOSS_OS_2");
  const composed=await state.fixture.github.snapshot({kind:"work-item",id:EPIC});
  assert.equal(composed.work.pull_request.state,"READY");
  assert.equal(composed.work.item.status,"In review");
  assert.equal(composed.work.item.gate,"REVIEW_REQUIRED");
  assert.equal(composed.work.project.fields.Status,"In review");
  assert.equal(composed.work.project.fields.Gate,"REVIEW_REQUIRED");
  assert.equal(composed.work.authority.epic_acceptance_required,true);

  const eventCount=state.control.events.length;
  const applyCount=state.fixture.view().calls.filter(value => value.method==="apply").length;
  const replay=await dispatchCoreCommand(parseCoreCommand(argv),{services:state.services});
  assert.equal(replay.exitCode,0,replay.result.error?.message);
  assert.equal(replay.result.data.status,"already-reconciled");
  assert.equal(state.control.events.length,eventCount);
  assert.equal(state.fixture.view().calls.filter(value => value.method==="apply").length,applyCount);
});

test("existing Epic pull request updates preserve exact base and current head checks",async () => {
  const state=await approvedFakeHarness();
  state.fixture.assignActiveRelease(EPIC,"v2.1.2");
  await dispatchCoreCommand(parseCoreCommand(["issue","start",child.id,"--apply","--non-interactive"]),{services:state.services});
  state.fixture.setBranchHead("TOSS-Soft/toss-cli",child.branch,"d".repeat(40));
  await dispatchCoreCommand(parseCoreCommand(["issue","submit",child.id,"--apply","--non-interactive"]),{services:state.services});
  state.fixture.mergeWorkPullRequest(child.id);
  await dispatchCoreCommand(parseCoreCommand(["epic","submit",EPIC,"--apply","--non-interactive"]),{services:state.services});
  const snapshot=await state.fixture.github.snapshot({kind:"epic-submit",id:EPIC});
  const cases=[
    ["wrong base","release/v9.9.9",snapshot.branch.head_sha,/base or head conflicts/u],
    ["stale head",snapshot.release.branch,"0".repeat(40),/head is stale/u],
  ];

  for (let index=0;index<cases.length;index+=1) {
    const [label,base,headSha,message]=cases[index];
    const intent=createOperationIntent({
      intent_id:`INTENT-20260902-09${String(index+1).padStart(2,"0")}`,
      created_at:`2026-09-02T07:${String(56+index).padStart(2,"0")}:00.000Z`,
      command:"epic.submit",policy_revision:"POLICY-0001",source:snapshot.source,authority:null,
      operations:[{resource:"pull_request",action:"update",repository:work.item.repository,
        expected_revision:snapshot.pull_request.revision,payload:{kind:"work-pull-request",work_item_id:EPIC,
          head:work.item.branch,base,head_sha:headSha,draft:false}}],
    });
    await assert.rejects(
      state.fixture.github.apply(intent.operations,{idempotencyKey:sha256Canonical(intent)}),
      error => message.test(error.message),label,
    );
  }
  const unchanged=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli").pull_requests.find(value => value.work_item_id===EPIC);
  assert.equal(unchanged.state,"READY");
  assert.equal(unchanged.revision,snapshot.pull_request.revision);
});

test("epic submit atomically projects its ready PR acceptance authority and Project review state",async () => {
  const {fixture,services}=await approvedFakeHarness();
  fixture.assignActiveRelease(EPIC,"v2.1.2");
  await dispatchCoreCommand(parseCoreCommand(["issue","start",child.id,"--apply","--non-interactive"]),{services});
  fixture.setBranchHead("TOSS-Soft/toss-cli",child.branch,"d".repeat(40));
  await dispatchCoreCommand(parseCoreCommand(["issue","submit",child.id,"--apply","--non-interactive"]),{services});
  fixture.mergeWorkPullRequest(child.id);

  const submitted=await dispatchCoreCommand(parseCoreCommand(["epic","submit",EPIC,"--apply","--non-interactive"]),{services});
  assert.equal(submitted.exitCode,0,submitted.result.error?.message);
  const snapshot=await fixture.github.snapshot({kind:"work-item",id:EPIC});
  assert.equal(snapshot.work.pull_request.state,"READY");
  assert.equal(snapshot.work.pull_request.head_sha,snapshot.work.physical_branch.head_sha);
  assert.equal(snapshot.work.authority.epic_acceptance_required,true);
  assert.equal(snapshot.work.authority.release_approval_required,false);
  assert.equal(snapshot.work.item.status,"In review");
  assert.equal(snapshot.work.item.gate,"REVIEW_REQUIRED");
  assert.equal(snapshot.work.project.fields.Status,"In review");
  assert.equal(snapshot.work.project.fields.Gate,"REVIEW_REQUIRED");
});

test("epic submit requires each closed child to be semantically Done at its exact merged head and Project state",async () => {
  const mutations=[
    ["derived status",evidence => { evidence.work.item.status="In progress"; }],
    ["derived gate",evidence => { evidence.work.item.gate="REVIEW_REQUIRED"; }],
    ["merged pull request",evidence => { evidence.work.pull_request={state:"READY",head_sha:evidence.work.pull_request.head_sha,merged_sha:null}; }],
    ["Project Done",evidence => { evidence.work.project.fields.Status="In progress"; }],
  ];
  for (const [label,mutate] of mutations) {
    const state=await approvedFakeHarness();
    state.fixture.assignActiveRelease(EPIC,"v2.1.2");
    await dispatchCoreCommand(parseCoreCommand(["issue","start",child.id,"--apply","--non-interactive"]),{services:state.services});
    state.fixture.setBranchHead("TOSS-Soft/toss-cli",child.branch,"5".repeat(40));
    await dispatchCoreCommand(parseCoreCommand(["issue","submit",child.id,"--apply","--non-interactive"]),{services:state.services});
    state.fixture.mergeWorkPullRequest(child.id);
    const eventCount=state.control.events.length;
    const services=withSnapshotMutation(state,"epic-submit",snapshot => mutate(snapshot.children[0]));

    const result=await dispatchCoreCommand(parseCoreCommand(["epic","submit",EPIC,"--apply","--non-interactive"]),{services});

    assert.notEqual(result.exitCode,0,label);
    assert.equal(state.control.events.length,eventCount,label);
  }
});

test("epic submit requires dependency targets to be semantically Done, not merely closed",async () => {
  const state=await approvedFakeHarness({children:[child,dependentChild],dependencies:[dependencyEdge]});
  state.fixture.assignActiveRelease(EPIC,"v2.1.2");
  for (const [planned,head] of [[child,"6".repeat(40)],[dependentChild,"7".repeat(40)]]) {
    await dispatchCoreCommand(parseCoreCommand(["issue","start",planned.id,"--apply","--non-interactive"]),{services:state.services});
    state.fixture.setBranchHead("TOSS-Soft/toss-cli",planned.branch,head);
    await dispatchCoreCommand(parseCoreCommand(["issue","submit",planned.id,"--apply","--non-interactive"]),{services:state.services});
    state.fixture.mergeWorkPullRequest(planned.id);
  }
  const eventCount=state.control.events.length;
  const services=withSnapshotMutation(state,"epic-submit",snapshot => {
    snapshot.edges[0].target.work.project.fields.Status="In progress";
  });

  const result=await dispatchCoreCommand(parseCoreCommand(["epic","submit",EPIC,"--apply","--non-interactive"]),{services});

  assert.notEqual(result.exitCode,0);
  assert.equal(state.control.events.length,eventCount);
});

test("epic submit rejects noncanonical or cross-surface release and branch evidence",async () => {
  const mutations=[
    ["noncanonical release",snapshot => {
      snapshot.release.branch="release/2.1.2";
      snapshot.release.milestone="2.1.2";
      snapshot.release.id="TOSS-Soft/toss-cli@release/2.1.2";
      snapshot.epic.release=structuredClone(snapshot.release);
      snapshot.epic.item.base_branch="release/2.1.2";
      snapshot.epic.item.milestone="2.1.2";
      snapshot.branch.base_branch="release/2.1.2";
    }],
    ["release revision drift",snapshot => { snapshot.release.revision="release-9"; }],
    ["milestone drift",snapshot => { snapshot.release.milestone="v9.9.9"; }],
    ["empty branch revision",snapshot => { snapshot.branch.revision=""; }],
  ];
  for (const [label,mutate] of mutations) {
    const state=await approvedFakeHarness();
    state.fixture.assignActiveRelease(EPIC,"v2.1.2");
    await dispatchCoreCommand(parseCoreCommand(["issue","start",child.id,"--apply","--non-interactive"]),{services:state.services});
    state.fixture.setBranchHead("TOSS-Soft/toss-cli",child.branch,"8".repeat(40));
    await dispatchCoreCommand(parseCoreCommand(["issue","submit",child.id,"--apply","--non-interactive"]),{services:state.services});
    state.fixture.mergeWorkPullRequest(child.id);
    const eventCount=state.control.events.length;
    const services=withSnapshotMutation(state,"epic-submit",mutate);

    const result=await dispatchCoreCommand(parseCoreCommand(["epic","submit",EPIC,"--apply","--non-interactive"]),{services});

    assert.notEqual(result.exitCode,0,label);
    assert.equal(state.control.events.length,eventCount,label);
  }
});

test("epic accept rejects signed noncanonical or cross-surface release and branch evidence before execution",async () => {
  const mutations=[
    ["noncanonical release",snapshot => {
      snapshot.release.branch="release/2.1.2";
      snapshot.release.milestone="2.1.2";
      snapshot.release.id="TOSS-Soft/toss-cli@release/2.1.2";
      snapshot.epic.release=structuredClone(snapshot.release);
      snapshot.epic.item.base_branch="release/2.1.2";
      snapshot.epic.item.milestone="2.1.2";
      snapshot.branch.base_branch="release/2.1.2";
      snapshot.pull_request.base="release/2.1.2";
    }],
    ["release revision drift",snapshot => { snapshot.release.revision="release-9"; }],
    ["milestone drift",snapshot => { snapshot.release.milestone="v9.9.9"; }],
    ["empty branch revision",snapshot => { snapshot.branch.revision=""; }],
  ];
  for (let index=0;index<mutations.length;index+=1) {
    const [label,mutate]=mutations[index];
    const state=await reviewedEpicHarness();
    const changed=structuredClone(await state.fixture.github.snapshot({kind:"epic-accept",id:EPIC}));
    mutate(changed);
    const binding=acceptanceBinding(changed);
    state.authorities["accept.json"]=signedAuthority(state.privateKey,{
      record_id:`AUTH-20260902-${String(400+index).padStart(4,"0")}`,command:"epic.accept",
      targets:["TOSS-Soft/toss-cli",changed.project.id,`binding:${sha256Canonical(binding)}`],
      expected_revisions:[{repository:"TOSS-Soft/toss-cli",revision:changed.pull_request.revision},{repository:null,revision:changed.project.revision}],
    });
    const eventCount=state.control.events.length;
    const services=withSnapshotMutation(state,"epic-accept",mutate);

    const result=await dispatchCoreCommand(parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--non-interactive"]),{services});

    assert.notEqual(result.exitCode,0,label);
    assert.equal(state.control.events.length,eventCount,label);
  }
});

test("signed public lifecycle reviews and accepts the exact epic head before closing it",async () => {
  const {fixture,control,services,inputs,authorities,privateKey}=await approvedFakeHarness();
  fixture.assignActiveRelease(EPIC,"v2.1.2");
  await dispatchCoreCommand(parseCoreCommand(["issue","start",child.id,"--apply","--non-interactive"]),{services});
  fixture.setBranchHead("TOSS-Soft/toss-cli",child.branch,"e".repeat(40));
  await dispatchCoreCommand(parseCoreCommand(["issue","submit",child.id,"--apply","--non-interactive"]),{services});
  fixture.mergeWorkPullRequest(child.id);
  await dispatchCoreCommand(parseCoreCommand(["epic","submit",EPIC,"--apply","--non-interactive"]),{services});
  const pendingReview=await fixture.github.snapshot({kind:"work-item",id:EPIC});
  assert.equal(pendingReview.work.item.status,"In review");
  assert.equal(pendingReview.work.item.gate,"REVIEW_REQUIRED");
  assert.equal(pendingReview.work.project.fields.Status,"In review");
  assert.equal(pendingReview.work.project.fields.Gate,"REVIEW_REQUIRED");
  assert.equal(pendingReview.work.authority.epic_acceptance_required,true);
  const pendingStatus=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{services});
  assert.equal(pendingStatus.exitCode,0,pendingStatus.result.error?.message);
  assert.equal(pendingStatus.result.data.state.status,"In review");
  assert.equal(pendingStatus.result.data.state.gate,"REVIEW_REQUIRED");
  const repository=fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
  const pull=repository.pull_requests.find(value => value.work_item_id===EPIC);
  const commits=[{revision:pull.head_sha,author:"implementation-author",committer:"implementation-author"}];
  fixture.enableReviewPullRequest("TOSS-Soft/toss-cli",pull.number,{
    checks:{state:"PASSED",revision:pull.head_sha},
    implementationIdentity:{base_revision:"1".repeat(40),revision:pull.head_sha,pull_request_author:"implementation-author",commit_count:1,commits_sha256:sha256Canonical(commits),commits},
  });
  inputs["review.json"]={
    schema_version:"review-result.v1",review_id:"REVIEW-20260902-0001",
    repository:"TOSS-Soft/toss-cli",pull_request_number:pull.number,
    reviewed_revision:pull.head_sha,reviewer:{identity:"independent-reviewer",role:"independent-reviewer"},
    verdict:"APPROVED",freshness:"CURRENT",findings:[],unresolved:[],
    verification_evidence:["node --test test/core-epic-lifecycle.test.js"],follow_up_issues:[],
    reviewed_at:"2026-09-02T07:30:00.000Z",recorded_at:"2026-09-02T07:45:00.000Z",
  };
  const reviewed=await dispatchCoreCommand(parseCoreCommand(["review","record",`TOSS-Soft/toss-cli#${pull.number}`,"--from","review.json","--apply","--non-interactive"]),{services});
  assert.equal(reviewed.exitCode,0,reviewed.result.error?.message);
  const reviewedWork=await fixture.github.snapshot({kind:"work-item",id:EPIC});
  assert.equal(reviewedWork.work.item.status,"In review");
  assert.equal(reviewedWork.work.item.gate,"EPIC_ACCEPTANCE_REQUIRED");
  assert.equal(reviewedWork.work.project.fields.Status,"In review");
  assert.equal(reviewedWork.work.project.fields.Gate,"EPIC_ACCEPTANCE_REQUIRED");
  assert.equal(reviewedWork.work.authority.epic_acceptance_required,true);
  const reviewedStatus=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{services});
  assert.equal(reviewedStatus.exitCode,0,reviewedStatus.result.error?.message);
  assert.equal(reviewedStatus.result.data.state.status,"In review");
  assert.equal(reviewedStatus.result.data.state.gate,"EPIC_ACCEPTANCE_REQUIRED");
  const snapshot=await fixture.github.snapshot({kind:"epic-accept",id:EPIC});
  const binding={
    epic:{id:EPIC,revision:snapshot.epic_revision},
    plan:{plan_id:snapshot.plan.plan_id,content_sha256:snapshot.plan.content_sha256},
    children:snapshot.children.map(value => ({id:value.id,revision:value.revision})),
    edges:snapshot.edges.map(value => ({edge_id:value.edge_id,revision:value.revision})),
    release:snapshot.release,pull_request:snapshot.pull_request,review:snapshot.review,
    checks:snapshot.checks,project:snapshot.project,policy_revision:"POLICY-0001",
  };
  authorities["accept.json"]=signedAuthority(privateKey,{
    record_id:"AUTH-20260902-0002",command:"epic.accept",
    targets:["TOSS-Soft/toss-cli",snapshot.project.id,`binding:${sha256Canonical(binding)}`],
    expected_revisions:[{repository:"TOSS-Soft/toss-cli",revision:snapshot.pull_request.revision},{repository:null,revision:snapshot.project.revision}],
  });

  const accepted=await dispatchCoreCommand(parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--non-interactive"]),{services});
  assert.equal(accepted.exitCode,0,accepted.result.error?.message);
  const acceptedView=fixture.view();
  const acceptedRepository=acceptedView.repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
  const acceptedEpic=acceptedRepository.issues.find(value => value.work.item.id===EPIC);
  const acceptedPull=acceptedRepository.pull_requests.find(value => value.work_item_id===EPIC);
  assert.equal(acceptedPull.state,"MERGED");
  assert.equal(acceptedPull.merged_sha,pull.head_sha);
  assert.equal(acceptedEpic.work.issue_state,"CLOSED");
  assert.equal(acceptedEpic.work.project.fields.Status,"Done");
  assert.equal(acceptedEpic.work.project.fields.Gate,"NONE");
  assert.equal(acceptedEpic.work.authority.epic_acceptance_required,false);
  const acceptedStatus=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{services});
  assert.equal(acceptedStatus.exitCode,0,acceptedStatus.result.error?.message);
  assert.equal(acceptedStatus.result.data.state.status,"Done");
  assert.equal(acceptedStatus.result.data.state.gate,"NONE");
  const eventCount=control.events.length;
  const replay=await dispatchCoreCommand(parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--non-interactive"]),{services});
  assert.equal(replay.exitCode,0,replay.result.error?.message);
  assert.equal(replay.result.data.status,"already-reconciled");
  assert.equal(control.events.length,eventCount);
});

test("epic acceptance replay revalidates release, base, review, and checks proof",async () => {
  const state=await reviewedEpicHarness();
  const snapshot=await state.fixture.github.snapshot({kind:"epic-accept",id:EPIC});
  authorizeAccept(state,snapshot,"AUTH-20260902-0500");
  const accepted=await dispatchCoreCommand(parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--non-interactive"]),{services:state.services});
  assert.equal(accepted.exitCode,0,accepted.result.error?.message);
  const eventCount=state.control.events.length;
  const mutations=[
    ["release",value => { value.release.active=false; }],
    ["base",value => { value.pull_request.base="main"; }],
    ["review",value => { value.review.reviewed_revision="0".repeat(40); }],
    ["checks",value => { value.checks.state="FAILED"; }],
  ];
  const results=[];
  for (const [label,mutate] of mutations) {
    const services=withSnapshotMutation(state,"epic-accept",mutate);
    results.push([label,await dispatchCoreCommand(parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--non-interactive"]),{services})]);
  }

  for (const [label,result] of results) assert.notEqual(result.exitCode,0,label);
  assert.equal(state.control.events.length,eventCount);
});

test("fake review check mutation advances the pull request revision",async () => {
  const state=await reviewedEpicHarness();
  const repository=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
  const pull=repository.pull_requests.find(value => value.work_item_id===EPIC);

  state.fixture.setReviewChecks("TOSS-Soft/toss-cli",pull.number,{state:"FAILED",revision:pull.head_sha});

  const changed=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli").pull_requests.find(value => value.work_item_id===EPIC);
  assert.notEqual(changed.revision,pull.revision);
});

test("fake acceptance CAS rejects every signed evidence class that drifts after inspect",async () => {
  const modes=[
    "drift-epic-child-binding","drift-epic-edge-binding","drift-epic-release-binding",
    "drift-epic-review-binding","drift-epic-checks-binding","drift-epic-project-binding",
  ];
  for (let index=0;index<modes.length;index+=1) {
    const state=await reviewedEpicHarness({children:[child,dependentChild],dependencies:[dependencyEdge],completionOrder:[child,dependentChild]});
    const snapshot=await state.fixture.github.snapshot({kind:"epic-accept",id:EPIC});
    authorizeAccept(state,snapshot,`AUTH-20260902-${String(600+index).padStart(4,"0")}`);
    state.fixture.setFailureMode(modes[index]);
    const eventCount=state.control.events.length;

    const result=await dispatchCoreCommand(parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--non-interactive"]),{services:state.services});

    assert.equal(result.exitCode,6,`${modes[index]}: ${result.result.error?.message}`);
    assert.equal(state.control.events.length,eventCount+2,modes[index]);
    assert.equal(state.control.events.at(-1).value.status,"failed",modes[index]);
    const repository=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
    assert.equal(repository.pull_requests.find(value => value.work_item_id===EPIC).state,"READY",modes[index]);
    assert.equal(repository.issues.find(value => value.work.item.id===EPIC).work.issue_state,"OPEN",modes[index]);
  }
});

test("epic acceptance merge failure occurs before native close or Project Done",async () => {
  const state=await reviewedEpicHarness();
  const snapshot=await state.fixture.github.snapshot({kind:"epic-accept",id:EPIC});
  authorizeAccept(state,snapshot);
  state.fixture.setFailureMode("fail-epic-merge");

  const failed=await dispatchCoreCommand(parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--non-interactive"]),{services:state.services});

  assert.equal(failed.exitCode,70);
  const repository=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
  const epic=repository.issues.find(value => value.work.item.id===EPIC);
  const pull=repository.pull_requests.find(value => value.work_item_id===EPIC);
  assert.equal(pull.state,"READY");
  assert.equal(epic.work.issue_state,"OPEN");
  assert.notEqual(epic.work.project.fields.Status,"Done");
  assert.equal(state.control.events.at(-1).value.status,"failed");
});

test("epic acceptance records failed reconciliation when Project Done fails after merge and close",async () => {
  const state=await reviewedEpicHarness();
  const snapshot=await state.fixture.github.snapshot({kind:"epic-accept",id:EPIC});
  authorizeAccept(state,snapshot);
  state.fixture.setFailureMode("fail-epic-project");

  const failed=await dispatchCoreCommand(parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--non-interactive"]),{services:state.services});

  assert.equal(failed.exitCode,70);
  const repository=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
  const epic=repository.issues.find(value => value.work.item.id===EPIC);
  const pull=repository.pull_requests.find(value => value.work_item_id===EPIC);
  assert.equal(pull.state,"MERGED");
  assert.equal(epic.work.issue_state,"CLOSED");
  assert.notEqual(epic.work.project.fields.Status,"Done");
  const receipt=state.control.events.at(-1).value;
  const intent=state.control.events.at(-2).value;
  const completed=intent.operations.find(value => value.payload.kind==="epic-accept");
  assert.equal(receipt.status,"failed");
  assert.deepEqual(receipt.observed_revisions.map(value => value.operation_id),[completed.operation_id]);
  assert.notEqual(receipt.observed_revisions[0].revision,completed.expected_revision);

  const status=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{services:state.services});
  assert.equal(status.exitCode,0,status.result.error?.message);
  assert.equal(status.result.data.state.status,"Blocked");
  assert.equal(status.result.data.state.gate,"RECONCILE_REQUIRED");
  assert.equal(status.result.data.reconciliation.required,true);
  assert.equal(status.result.data.reconciliation.receipts[0].receipt_id,receipt.receipt_id);
  assert.deepEqual(status.result.data.reconciliation.receipts[0].completed_operation_ids,[completed.operation_id]);

  const mutations=[
    ["prepare",["epic","prepare",EPIC,"--from","plan.json","--apply","--non-interactive"]],
    ["approve",["epic","approve",EPIC,"--authority","approve.json","--apply","--non-interactive"]],
    ["submit",["epic","submit",EPIC,"--apply","--non-interactive"]],
    ["accept",["epic","accept",EPIC,"--authority","accept.json","--apply","--non-interactive"]],
  ];
  for (const [label,argv] of mutations) {
    const eventCount=state.control.events.length;
    const mutationCallCount=state.fixture.view().calls.filter(value => ["inspect","apply"].includes(value.method)).length;
    const retry=await dispatchCoreCommand(parseCoreCommand(argv),{services:state.services});
    assert.equal(retry.exitCode,4,`${label}: ${retry.result.data?.status ?? retry.result.error?.message}`);
    assert.match(retry.result.error.message,/Blocked \/ RECONCILE_REQUIRED/u,label);
    assert.equal(state.control.events.length,eventCount,label);
    assert.equal(state.fixture.view().calls.filter(value => ["inspect","apply"].includes(value.method)).length,mutationCallCount,label);
  }
});

test("epic mutation confirmation sees the exact final preview and decline is write-free",async () => {
  const declined=await reviewedEpicHarness();
  authorizeAccept(declined,await declined.fixture.github.snapshot({kind:"epic-accept",id:EPIC}));
  const declinedEvents=declined.control.events.length;
  const declinedWrites=declined.fixture.view().calls.filter(value => ["inspect","apply"].includes(value.method)).length;
  let declinedPreview=null;
  const declinedResult=await dispatchCoreCommand(
    parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--json"]),
    {services:declined.services,confirm:async preview => {
      declinedPreview=preview;
      assert.equal(declined.control.events.length,declinedEvents);
      assert.equal(declined.fixture.view().calls.filter(value => ["inspect","apply"].includes(value.method)).length,declinedWrites);
      return false;
    }},
  );
  assert.equal(declinedResult.exitCode,4);
  assert.equal(declinedPreview.command,"epic.accept");
  assert.equal(declined.control.events.length,declinedEvents);
  assert.equal(declined.fixture.view().calls.filter(value => ["inspect","apply"].includes(value.method)).length,declinedWrites);

  const accepted=await reviewedEpicHarness();
  authorizeAccept(accepted,await accepted.fixture.github.snapshot({kind:"epic-accept",id:EPIC}),"AUTH-20260902-0910");
  let acceptedPreview=null;
  const result=await dispatchCoreCommand(
    parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--json"]),
    {services:accepted.services,confirm:async preview => { acceptedPreview=preview; return true; }},
  );
  assert.equal(result.exitCode,0,result.result.error?.message);
  const intent=accepted.control.events.at(-2).value;
  assert.equal(acceptedPreview.intent_sha256,sha256Canonical(intent));
  assert.equal(canonicalJson(acceptedPreview.operations),canonicalJson(intent.operations));
  assert.deepEqual(JSON.parse(JSON.stringify(result)),result);

  const promptFree=await reviewedEpicHarness();
  authorizeAccept(promptFree,await promptFree.fixture.github.snapshot({kind:"epic-accept",id:EPIC}),"AUTH-20260902-0911");
  let prompts=0;
  const nonInteractive=await dispatchCoreCommand(
    parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--non-interactive","--json"]),
    {services:promptFree.services,confirm:async () => { prompts+=1; return false; }},
  );
  assert.equal(nonInteractive.exitCode,0,nonInteractive.result.error?.message);
  assert.equal(prompts,0);
});

test("epic status returns a detached full view and derives review required after current-head drift",async () => {
  const state=await reviewedEpicHarness();
  const repository=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
  const pull=repository.pull_requests.find(value => value.work_item_id===EPIC);
  authorizeAccept(state,await state.fixture.github.snapshot({kind:"epic-accept",id:EPIC}));
  state.fixture.setPullRequestHead("TOSS-Soft/toss-cli",pull.number,"9".repeat(40),{checks:"PASSED",reconcileProject:true});
  const before=state.fixture.view().calls.length;

  const status=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{services:state.services});

  assert.equal(status.exitCode,0,status.result.error?.message);
  assert.equal(status.result.data.state.status,"In review");
  assert.equal(status.result.data.state.gate,"REVIEW_REQUIRED");
  assert.equal(status.result.data.next_command,"toss-core review record");
  assert.match(status.result.data.plan.content_sha256,/^[a-f0-9]{64}$/u);
  assert.equal(status.result.data.children.length,1);
  assert.equal(status.result.data.physical_branch.name,work.item.branch);
  assert.equal(status.result.data.pull_request.head_sha,"9".repeat(40));
  assert.equal(status.result.data.review.reviewed_revision,"e".repeat(40));
  assert.equal(status.result.data.checks.revision,"9".repeat(40));
  assert.throws(() => { status.result.data.children.push({}); },TypeError);
  const calls=state.fixture.view().calls.slice(before);
  assert.equal(calls.length,1);
  assert.equal(calls[0].method,"snapshot");
  const eventCount=state.control.events.length;
  const accept=await dispatchCoreCommand(parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--non-interactive"]),{services:state.services});
  assert.notEqual(accept.exitCode,0);
  assert.equal(state.control.events.length,eventCount);
  assert.equal(state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli").pull_requests.find(value => value.work_item_id===EPIC).state,"READY");
});

test("epic status proves scope approval from its immutable signed intent and receipt",async () => {
  const state=await approvedFakeHarness();
  const status=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{services:state.services});
  assert.equal(status.exitCode,0,status.result.error?.message);
  const approvalIntent=state.control.events.find(value => value.kind==="intent" && value.value.command==="epic.approve").value;
  const approvalReceipt=state.control.events.find(value => value.kind==="receipt" && value.value.intent_id===approvalIntent.intent_id).value;
  assert.equal(canonicalJson(status.result.data.approval.provenance),canonicalJson({
    authority_record:approvalIntent.authority,
    intent_id:approvalIntent.intent_id,intent_sha256:sha256Canonical(approvalIntent),
    receipt_id:approvalReceipt.receipt_id,receipt_sha256:sha256Canonical(approvalReceipt),
  }));

  const events=state.control.events.length;
  const tampered=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{
    services:withSnapshotMutation(state,"epic-status",snapshot => {
      snapshot.epic_approval.plan.content_sha256="0".repeat(64);
    }),
  });
  assert.equal(tampered.exitCode,6);
  assert.equal(state.control.events.length,events);
});

test("epic status rejects every impossible prepared plan approval state combination",async () => {
  const state=await approvedFakeHarness();
  const cases=[
    ["approval without plan",snapshot => {
      snapshot.plan=null;
      snapshot.epic.prepared=false;
      snapshot.epic.scope_approved=false;
    }],
    ["scope approved without approval",snapshot => { snapshot.epic_approval=null; }],
    ["immutable approval omitted with mutable flag cleared",snapshot => {
      snapshot.epic_approval=null;
      snapshot.epic.scope_approved=false;
    }],
    ["approval without prepared state",snapshot => { snapshot.epic.prepared=false; }],
  ];
  for (const [label,mutate] of cases) {
    const result=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{
      services:withSnapshotMutation(state,"epic-status",mutate),
    });
    assert.equal(result.exitCode,6,label);
  }
});

test("epic status rejects prepared unapproved scope drift and approved completion or blocker drift",async () => {
  const plan={plan_id:"EPIC-PLAN-0042",created_at:"2026-09-01T10:00:00.000Z",source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@42",sha256:"a".repeat(64)},epic:work.item,children:[child],dependencies:[]};
  const prepared=fakeHarness({"plan.json":plan});
  prepared.fixture.seedWork(work);
  await dispatchCoreCommand(parseCoreCommand(["epic","prepare",EPIC,"--from","plan.json","--apply","--non-interactive"]),{services:prepared.services});
  const preparedEvents=prepared.control.events.length;
  const preparedResult=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{
    services:withSnapshotMutation(prepared,"epic-status",snapshot => { snapshot.children=[]; }),
  });

  const approved=await approvedFakeHarness();
  approved.fixture.assignActiveRelease(EPIC,"v2.1.2");
  const approvedEvents=approved.control.events.length;
  const completion=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{
    services:withSnapshotMutation(approved,"epic-status",snapshot => { snapshot.epic.children_complete=true; }),
  });
  const blockers=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{
    services:withSnapshotMutation(approved,"epic-status",snapshot => { snapshot.epic.blocking_dependencies=[child.id]; }),
  });

  assert.notEqual(preparedResult.exitCode,0,"prepared scope");
  assert.equal(prepared.control.events.length,preparedEvents);
  assert.notEqual(completion.exitCode,0,"children_complete");
  assert.notEqual(blockers.exitCode,0,"blocking_dependencies");
  assert.equal(approved.control.events.length,approvedEvents);
});

test("epic status rejects prepared unapproved completion and blocker cache drift",async () => {
  const plan={plan_id:"EPIC-PLAN-0042",created_at:"2026-09-01T10:00:00.000Z",source:{repository:"TOSS-Soft/toss-cli",revision:"feature-request@42",sha256:"a".repeat(64)},epic:work.item,children:[child],dependencies:[]};
  const state=fakeHarness({"plan.json":plan});
  state.fixture.seedWork(work);
  await dispatchCoreCommand(parseCoreCommand(["epic","prepare",EPIC,"--from","plan.json","--apply","--non-interactive"]),{services:state.services});
  const eventCount=state.control.events.length;
  const cases=[
    ["children_complete",snapshot => { snapshot.epic.children_complete=true; }],
    ["blocking_dependencies",snapshot => { snapshot.epic.blocking_dependencies=[child.id]; }],
  ];
  const results=[];

  for (const [label,mutate] of cases) {
    const result=await dispatchCoreCommand(parseCoreCommand(["epic","status",EPIC]),{
      services:withSnapshotMutation(state,"epic-status",mutate),
    });
    results.push([label,result.exitCode]);
  }

  assert.deepEqual(results,[["children_complete",6],["blocking_dependencies",6]]);
  assert.equal(state.control.events.length,eventCount);
});

test("epic transition replays and acceptance authority cannot bypass derived lifecycle gates",async () => {
  const approved=await approvedFakeHarness();
  const approvalEvents=approved.control.events.length;
  const approvalResult=await dispatchCoreCommand(
    parseCoreCommand(["epic","approve",EPIC,"--authority","approve.json","--apply","--non-interactive"]),
    {services:withSnapshotMutation(approved,"epic-approval",snapshot => { snapshot.epic.drifted=true; })},
  );
  assert.equal(approvalResult.exitCode,4,"approval replay drift gate");
  assert.equal(approved.control.events.length,approvalEvents);

  const submitted=await reviewedEpicHarness();
  const submitEvents=submitted.control.events.length;
  const submitResult=await dispatchCoreCommand(
    parseCoreCommand(["epic","submit",EPIC,"--apply","--non-interactive"]),
    {services:withSnapshotMutation(submitted,"epic-submit",snapshot => { snapshot.epic.drifted=true; })},
  );
  assert.equal(submitResult.exitCode,4,"submit replay drift gate");
  assert.equal(submitted.control.events.length,submitEvents);

  const acceptance=await reviewedEpicHarness();
  const releaseApprovalSnapshot=structuredClone(await acceptance.fixture.github.snapshot({kind:"epic-accept",id:EPIC}));
  releaseApprovalSnapshot.epic.authority={epic_acceptance_required:false,release_approval_required:true};
  authorizeAccept(acceptance,releaseApprovalSnapshot,"AUTH-20260902-0801");
  const acceptanceEvents=acceptance.control.events.length;
  const acceptResult=await dispatchCoreCommand(
    parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--non-interactive"]),
    {services:withSnapshotMutation(acceptance,"epic-accept",snapshot => {
      snapshot.epic.authority={epic_acceptance_required:false,release_approval_required:true};
    })},
  );
  assert.equal(acceptResult.exitCode,4,"release approval gate");
  assert.equal(acceptance.control.events.length,acceptanceEvents);
});

test("fake release and child completion keep Epic dependency blockers synchronized",async () => {
  const state=await approvedFakeHarness({children:[child,dependentChild],dependencies:[dependencyEdge]});
  state.fixture.assignActiveRelease(EPIC,"v2.1.2");
  let epic=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli").issues.find(value => value.work.item.id===EPIC);
  assert.deepEqual(epic.work.blocking_dependencies,[child.id]);

  await dispatchCoreCommand(parseCoreCommand(["issue","start",child.id,"--apply","--non-interactive"]),{services:state.services});
  state.fixture.setBranchHead("TOSS-Soft/toss-cli",child.branch,"a".repeat(40));
  await dispatchCoreCommand(parseCoreCommand(["issue","submit",child.id,"--apply","--non-interactive"]),{services:state.services});
  state.fixture.mergeWorkPullRequest(child.id);

  epic=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli").issues.find(value => value.work.item.id===EPIC);
  assert.deepEqual(epic.work.blocking_dependencies,[]);
});

test("epic accept fails closed on altered plan, missing child, scope drift, stale review, failed checks, non-independent review, and wrong base",async () => {
  const cases=[
    ["altered plan",snapshot => { snapshot.plan.plan_id="EPIC-PLAN-ALTERED"; }],
    ["missing child",snapshot => { snapshot.children=[]; }],
    ["altered approved scope",snapshot => { snapshot.children[0].item.branch="issue/43-altered"; }],
    ["altered approval",snapshot => { snapshot.epic_approval.children=[]; }],
    ["stale review",snapshot => { snapshot.review.reviewed_revision="8".repeat(40); }],
    ["failed checks",snapshot => { snapshot.checks.state="FAILED"; }],
    ["non-independent review",snapshot => { snapshot.review.independent=false; }],
    ["wrong pull request base",snapshot => { snapshot.pull_request.base="main"; }],
  ];
  for (const [label,mutate] of cases) {
    const state=await reviewedEpicHarness();
    const snapshot=await state.fixture.github.snapshot({kind:"epic-accept",id:EPIC});
    authorizeAccept(state,snapshot,`AUTH-20260902-${String(cases.indexOf(cases.find(value => value[0]===label))+100).padStart(4,"0")}`);
    const eventCount=state.control.events.length;
    const services=withSnapshotMutation(state,"epic-accept",mutate);

    const result=await dispatchCoreCommand(parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--non-interactive"]),{services});

    assert.notEqual(result.exitCode,0,label);
    assert.equal(state.control.events.length,eventCount,label);
    const repository=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
    assert.equal(repository.pull_requests.find(value => value.work_item_id===EPIC).state,"READY",label);
    assert.equal(repository.issues.find(value => value.work.item.id===EPIC).work.issue_state,"OPEN",label);
  }
});

test("epic submit rejects incomplete governed children and dependency targets before opening a PR",async () => {
  const state=await approvedFakeHarness({children:[child,dependentChild],dependencies:[dependencyEdge]});
  state.fixture.assignActiveRelease(EPIC,"v2.1.2");
  const eventCount=state.control.events.length;

  const result=await dispatchCoreCommand(parseCoreCommand(["epic","submit",EPIC,"--apply","--non-interactive"]),{services:state.services});

  assert.notEqual(result.exitCode,0);
  assert.equal(state.control.events.length,eventCount);
  const repository=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli");
  assert.equal(repository.pull_requests.some(value => value.work_item_id===EPIC),false);
  assert.deepEqual(repository.issues.find(value => value.work.item.id===dependentChild.id).work.blocking_dependencies,[child.id]);

  for (const [planned,head] of [[child,"3".repeat(40)],[dependentChild,"4".repeat(40)]]) {
    const started=await dispatchCoreCommand(parseCoreCommand(["issue","start",planned.id,"--apply","--non-interactive"]),{services:state.services});
    assert.equal(started.exitCode,0,started.result.error?.message);
    state.fixture.setBranchHead("TOSS-Soft/toss-cli",planned.branch,head);
    const submitted=await dispatchCoreCommand(parseCoreCommand(["issue","submit",planned.id,"--apply","--non-interactive"]),{services:state.services});
    assert.equal(submitted.exitCode,0,submitted.result.error?.message);
    state.fixture.mergeWorkPullRequest(planned.id);
  }
  const completedEventCount=state.control.events.length;
  const incompleteDependency=withSnapshotMutation(state,"epic-submit",snapshot => {
    snapshot.edges[0].target_state="OPEN";
  });

  const dependencyBlocked=await dispatchCoreCommand(parseCoreCommand(["epic","submit",EPIC,"--apply","--non-interactive"]),{services:incompleteDependency});

  assert.notEqual(dependencyBlocked.exitCode,0);
  assert.equal(state.control.events.length,completedEventCount);
  assert.equal(state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli").pull_requests.some(value => value.work_item_id===EPIC),false);
});

test("epic prepare cannot replace an approved plan with altered scope",async () => {
  const state=await approvedFakeHarness();
  state.inputs["altered.json"]={...state.plan,children:[{...child,acceptance_criteria:["Altered after approval."]}]};
  const eventCount=state.control.events.length;

  const result=await dispatchCoreCommand(parseCoreCommand(["epic","prepare",EPIC,"--from","altered.json","--apply","--non-interactive"]),{services:state.services});

  assert.equal(result.exitCode,6);
  assert.equal(state.control.events.length,eventCount);
  const epic=state.fixture.view().repositories.find(value => value.repository==="TOSS-Soft/toss-cli").issues.find(value => value.work.item.id===EPIC);
  assert.equal(epic.epic_plan.children[0].acceptance_criteria[0],child.acceptance_criteria[0]);
});

test("signed acceptance rejects a tampered canonical binding and a non-independent authority",async () => {
  for (const kind of ["tampered binding","non-independent authority"]) {
    const state=await reviewedEpicHarness();
    const snapshot=await state.fixture.github.snapshot({kind:"epic-accept",id:EPIC});
    const binding=authorizeAccept(state,snapshot);
    const bound=kind==="tampered binding" ? {...binding,checks:{...binding.checks,observation:"0".repeat(64)}} : binding;
    state.authorities["accept.json"]=signedAuthority(state.privateKey,{
      record_id:kind==="tampered binding" ? "AUTH-20260902-0201" : "AUTH-20260902-0202",
      command:"epic.accept",
      actor:kind==="non-independent authority" ? "toss-core" : "independent-approver",
      targets:["TOSS-Soft/toss-cli",snapshot.project.id,`binding:${sha256Canonical(bound)}`],
      expected_revisions:[{repository:"TOSS-Soft/toss-cli",revision:snapshot.pull_request.revision},{repository:null,revision:snapshot.project.revision}],
    });
    const eventCount=state.control.events.length;

    const result=await dispatchCoreCommand(parseCoreCommand(["epic","accept",EPIC,"--authority","accept.json","--apply","--non-interactive"]),{services:state.services});

    assert.equal(result.exitCode,4,kind);
    assert.equal(state.control.events.length,eventCount,kind);
  }
});

test("feature add through signed epic acceptance is one public two-stage lifecycle with no main or cross-repository work target",async () => {
  const repositoryName="TOSS-Soft/toss-cli";
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  const authorities={};
  const inputs={"feature.json":{title:"Organizational lifecycle",description:"Govern one complete epic lifecycle.",priority:1,change_class:"backward_compatible_feature"}};
  const state=fakeHarness(inputs,{
    authorityRegistry:{keys:[{key_id:"approver",actor:"independent-approver",public_key:publicKey.export({format:"pem",type:"spki"}).toString()}]},authorities,
  });
  const feature=await dispatchCoreCommand(parseCoreCommand(["feature","add",repositoryName,"--from","feature.json","--apply","--non-interactive"]),{services:state.services});
  assert.equal(feature.exitCode,0,feature.result.error?.message);
  let view=state.fixture.view();
  const epicRecord=view.repositories.find(value => value.repository===repositoryName).issues[0];
  const epicId=epicRecord.work.item.id;
  const plannedChild={schema_version:"work-item.v1",id:`${repositoryName}#2`,repository:repositoryName,issue_number:2,kind:"issue",parent_id:epicId,acceptance_criteria:["The lifecycle E2E reaches native completion."],branch:"issue/2-lifecycle-e2e",base_branch:epicRecord.work.item.branch,milestone:null,status:"Backlog",gate:"RELEASE_PLANNING"};
  inputs["plan.json"]={plan_id:"EPIC-PLAN-0001",created_at:"2026-09-02T06:30:00.000Z",source:{repository:repositoryName,revision:"feature-request@1",sha256:"a".repeat(64)},epic:epicRecord.work.item,children:[plannedChild],dependencies:[]};
  const prepared=await dispatchCoreCommand(parseCoreCommand(["epic","prepare",epicId,"--from","plan.json","--apply","--non-interactive"]),{services:state.services});
  assert.equal(prepared.exitCode,0,prepared.result.error?.message);
  view=state.fixture.view();
  const preparedRepository=view.repositories.find(value => value.repository===repositoryName);
  const preparedEpic=preparedRepository.issues.find(value => value.work.item.id===epicId);
  const preparedChild=preparedRepository.issues.find(value => value.work.item.id===plannedChild.id);
  const approvalBinding={epic:{id:epicId,revision:preparedEpic.revision},plan:{plan_id:preparedEpic.epic_plan.plan_id,content_sha256:preparedEpic.epic_plan.content_sha256},children:[{id:plannedChild.id,revision:preparedChild.revision}],edges:[],project:{id:view.project.id,revision:view.project.revision},policy_revision:"POLICY-0001"};
  authorities["approve.json"]=signedAuthority(privateKey,{record_id:"AUTH-20260902-0301",command:"epic.approve",targets:[repositoryName,view.project.id,`binding:${sha256Canonical(approvalBinding)}`],expected_revisions:[{repository:repositoryName,revision:preparedEpic.revision},{repository:null,revision:view.project.revision}]});
  const approved=await dispatchCoreCommand(parseCoreCommand(["epic","approve",epicId,"--authority","approve.json","--apply","--non-interactive"]),{services:state.services});
  assert.equal(approved.exitCode,0,approved.result.error?.message);
  state.fixture.assignActiveRelease(epicId,"v2.1.2");
  await dispatchCoreCommand(parseCoreCommand(["issue","start",plannedChild.id,"--apply","--non-interactive"]),{services:state.services});
  state.fixture.setBranchHead(repositoryName,plannedChild.branch,"7".repeat(40));
  await dispatchCoreCommand(parseCoreCommand(["issue","submit",plannedChild.id,"--apply","--non-interactive"]),{services:state.services});
  state.fixture.mergeWorkPullRequest(plannedChild.id);
  await dispatchCoreCommand(parseCoreCommand(["epic","submit",epicId,"--apply","--non-interactive"]),{services:state.services});
  view=state.fixture.view();
  const epicPull=view.repositories.find(value => value.repository===repositoryName).pull_requests.find(value => value.work_item_id===epicId);
  const commits=[{revision:epicPull.head_sha,author:"implementation-author",committer:"implementation-author"}];
  state.fixture.enableReviewPullRequest(repositoryName,epicPull.number,{checks:{state:"PASSED",revision:epicPull.head_sha},implementationIdentity:{base_revision:"1".repeat(40),revision:epicPull.head_sha,pull_request_author:"implementation-author",commit_count:1,commits_sha256:sha256Canonical(commits),commits}});
  inputs["review.json"]={schema_version:"review-result.v1",review_id:"REVIEW-20260902-0301",repository:repositoryName,pull_request_number:epicPull.number,reviewed_revision:epicPull.head_sha,reviewer:{identity:"independent-reviewer",role:"independent-reviewer"},verdict:"APPROVED",freshness:"CURRENT",findings:[],unresolved:[],verification_evidence:["node --test test/core-epic-lifecycle.test.js"],follow_up_issues:[],reviewed_at:"2026-09-02T07:30:00.000Z",recorded_at:"2026-09-02T07:45:00.000Z"};
  await dispatchCoreCommand(parseCoreCommand(["review","record",`${repositoryName}#${epicPull.number}`,"--from","review.json","--apply","--non-interactive"]),{services:state.services});
  const snapshot=await state.fixture.github.snapshot({kind:"epic-accept",id:epicId});
  const acceptanceBinding={epic:{id:epicId,revision:snapshot.epic_revision},plan:{plan_id:snapshot.plan.plan_id,content_sha256:snapshot.plan.content_sha256},children:snapshot.children.map(value => ({id:value.id,revision:value.revision})),edges:snapshot.edges.map(value => ({edge_id:value.edge_id,revision:value.revision})),release:snapshot.release,pull_request:snapshot.pull_request,review:snapshot.review,checks:snapshot.checks,project:snapshot.project,policy_revision:"POLICY-0001"};
  authorities["accept.json"]=signedAuthority(privateKey,{record_id:"AUTH-20260902-0302",command:"epic.accept",targets:[repositoryName,snapshot.project.id,`binding:${sha256Canonical(acceptanceBinding)}`],expected_revisions:[{repository:repositoryName,revision:snapshot.pull_request.revision},{repository:null,revision:snapshot.project.revision}]});
  const accepted=await dispatchCoreCommand(parseCoreCommand(["epic","accept",epicId,"--authority","accept.json","--apply","--non-interactive"]),{services:state.services});
  assert.equal(accepted.exitCode,0,accepted.result.error?.message);
  view=state.fixture.view();
  const finalEpic=view.repositories.find(value => value.repository===repositoryName).issues.find(value => value.work.item.id===epicId);
  assert.equal(finalEpic.work.issue_state,"CLOSED");
  const workOperations=view.calls.filter(value => value.method==="apply").flatMap(value => value.operations).filter(value => value.resource==="branch" || value.resource==="pull_request");
  assert.equal(workOperations.every(value => value.repository===repositoryName),true);
  assert.equal(workOperations.filter(value => value.payload.kind==="work-pull-request").every(value => value.payload.base!=="main"),true);
  assert.equal(workOperations.filter(value => value.payload.kind==="work-branch").every(value => value.payload.base_branch!=="main"),true);
});
