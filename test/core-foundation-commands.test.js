import assert from "node:assert/strict";
import {mkdir,mkdtemp, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {parseCoreCommand} from "../src/core/commands/router.js";
import {createCoreInputReader} from "../src/core/input.js";
import {runInitCommand} from "../src/core/commands/init.js";
import {runRepositoryCommand} from "../src/core/commands/repository.js";
import {createCoreRuntime} from "../src/core/runtime.js";
import {createOperationIntent} from "../src/core/operations/plan.js";
import {sha256Canonical} from "../src/contracts/acp.js";

const SHA="a".repeat(64);
const command=argv => parseCoreCommand(argv);
const source=(repository,revision="remote-1") => ({repository,revision,sha256:SHA});

function bootstrapSnapshot({exists=false}={}) {
  return {kind:"bootstrap",source:source("TOSS-Soft/toss-os-control",exists ? "remote-2" : "remote-0"),control_repository:{exists,revision:exists ? "remote-2" : null},organization:{organization:"TOSS-Soft",project:{node_id:"PVT_org",number:7,revision:"project-1"},policy_revision:"POLICY-0001",lifecycle_policy:{revision:"POLICY-0001",states:["Backlog","Ready"]},release_policy:{revision:"POLICY-0001",gates:["NONE","RECONCILE_REQUIRED"]}}};
}
function registrationSnapshot(repository,{node="R_1",revision="repo-1"}={}) {
  return {kind:"repository-registration",source:source(repository,revision),repository:{node_id:node,default_branch:"main",revision,access:{admin:true},rules:{default_branch_protected:true},project_item_id:"PVTI_1"},project:{node_id:"PVT_org",number:7,fields:{status:"FIELD_STATUS",gate:"FIELD_GATE"}}};
}
function memoryControl() {
  let revision="head-0";
  let organization={schema_version:"organization-config.v1",organization:"TOSS-Soft",project:{node_id:"PVT_org",number:7},control_repository:"TOSS-Soft/toss-os-control",policy_revision:"POLICY-0001",repositories:[]};
  const repositories=new Map(); const writes=[]; let bootstrapState=null;
  return Object.freeze({writes,async head() { return revision; },async loadOrganization() { return organization; },async loadBootstrapState() { return bootstrapState; },async loadRepository(identity) { return repositories.get(identity) ?? null; },async listRepositories() { return [...repositories.values()]; },async loadRegistryState() { return {revision,organization,repositories:[...repositories.values()].sort((left,right) => left.repository<right.repository ? -1 : left.repository>right.repository ? 1 : 0)}; },async findCompletedRepositoryRegistration() { return null; },async commitConfiguration({expectedHead,files}) { assert.equal(expectedHead,revision); writes.push(files); organization=files["config/organization.yaml"]; for (const [path,value] of Object.entries(files)) if (path.startsWith("config/repositories/")) repositories.set(value.repository,value); revision=`head-${writes.length}`; return {commit_sha:revision}; },async commitBootstrap({expectedHead,files}) { assert.equal(expectedHead,null); writes.push(files); organization=files["config/organization.yaml"]; revision="bootstrap-head"; bootstrapState={organization,lifecycle:files["policies/lifecycle.yaml"],release:files["policies/release.yaml"],intent:files["intents/2026/09/INTENT-20260901-0001.json"],receipt:files["receipts/2026/09/RECEIPT-20260901-0001.json"],revision}; return {commit_sha:revision}; }});
}
function unbornControl() {
  const base=memoryControl(); let organization=null; let born=false;
  return Object.freeze({...base,async head() { return born ? base.head() : null; },async loadOrganization() { return organization; },async commitBootstrap(input) { const result=await base.commitBootstrap(input); organization=input.files["config/organization.yaml"]; born=true; return result; }});
}
function authorityFixture() {
  return {schema_version:"authority-record.v1",document_type:"authority-record",record_id:"AUTH-20260901-0001",actor:"approver",command:"init",targets:["TOSS-Soft/toss-os-control"],expected_revisions:[{repository:"TOSS-Soft/toss-os-control",revision:null}],policy_revision:"POLICY-0001",issued_at:"2026-09-01T07:00:00.000Z",expires_at:"2026-09-01T09:00:00.000Z",signature:{algorithm:"ed25519",key_id:"key-1",value:`${"A".repeat(86)}==`}};
}
function services({control=memoryControl(),github,readInput=async () => ({default_branch:"main",project_owner:"TOSS-Soft",project_number:7})}={}) {
  const calls=[];
  const operations=Object.freeze({async execute(input) { calls.push(input); if (!input.command.options.apply || input.command.options.dryRun) return {schema_version:"operation-preview.v1",intent_id:"INTENT-20260901-0001",intent_sha256:SHA,command:input.command.name,operations:input.operations}; return {receipt_id:"RECEIPT-20260901-0001",status:"completed"}; },async verifyAuthorityFor() { return null; }});
  return Object.freeze({control,github,calls,operations,readInput,readAuthority:async () => null,clock:() => "2026-09-01T08:00:00.000Z",idGenerator:kind => kind==="intent" ? "INTENT-20260901-0001" : "RECEIPT-20260901-0001"});
}
function githubFor({bootstrap=bootstrapSnapshot(),registrations=new Map()}={}) {
  const calls=[];
  return Object.freeze({calls,async snapshot(query) { calls.push({method:"snapshot",query}); if (query.kind==="bootstrap") return bootstrap; if (query.kind==="repository-list") return {kind:"repository-list",revisions:query.repositories.map(repository => ({repository,revision:"github-current"}))}; return registrations.get(query.repository); },async inspect(operations) { calls.push({method:"inspect",operations}); return operations.map(operation => ({operation_id:operation.operation_id,repository:operation.repository,revision:operation.expected_revision})); },async apply(operations) { calls.push({method:"apply",operations}); return {status:"completed",observed_revisions:operations.map(operation => ({operation_id:operation.operation_id,repository:operation.repository,revision:"remote-2"}))}; }});
}

function durableRegistry({onConfiguration,onReceipt}={}) {
  const state={revision:"head-0",organization:{schema_version:"organization-config.v1",organization:"TOSS-Soft",project:{node_id:"PVT_org",number:7},control_repository:"TOSS-Soft/toss-os-control",policy_revision:"POLICY-0001",repositories:[]},repositories:new Map(),intents:[],receipts:[],onConfiguration,onReceipt};
  function pending(repository) {
    const intents=state.intents.filter(intent => intent.command==="repo.add" && intent.operations.length===1 && intent.operations[0].repository===repository && intent.operations[0].payload.kind==="repository-registration");
    if (intents.length!==1) return null;
    const intent=intents[0]; const receipt=state.receipts.find(value => value.intent_id===intent.intent_id && value.intent_sha256===sha256Canonical(intent));
    return receipt?.status==="completed" ? {revision:state.revision,intent,receipt,configuration:intent.operations[0].payload.repository_config} : null;
  }
  function control() { return Object.freeze({
    async head() { return state.revision; }, async loadOrganization() { return state.organization; }, async loadRegistryState() { return {revision:state.revision,organization:state.organization,repositories:[...state.repositories.values()].sort((a,b) => a.repository<b.repository ? -1 : a.repository>b.repository ? 1 : 0)}; },
    async loadRepository(repository) { return state.repositories.get(repository) ?? null; }, async listRepositories() { return [...state.repositories.values()]; }, async findCompletedRepositoryRegistration(repository) { return pending(repository); },
    async commitConfiguration({expectedHead,files}) { if (state.onConfiguration) { const action=state.onConfiguration(state,expectedHead,files); if (action) throw action; } assert.equal(expectedHead,state.revision); state.organization=files["config/organization.yaml"]; for (const [path,value] of Object.entries(files)) if (path.startsWith("config/repositories/")) state.repositories.set(value.repository,value); state.revision=`head-${Number(state.revision.slice(5))+1}`; return {commit_sha:state.revision}; },
  }); }
  function operations(github,clock) { return Object.freeze({ async verifyAuthorityFor() {}, async execute(input) { const intent=createOperationIntent({intent_id:"INTENT-20260901-0099",created_at:clock(),command:input.command.name,policy_revision:"POLICY-0001",source:input.source,authority:null,operations:input.operations}); state.intents.push(intent); const inspected=await github.inspect(intent.operations); const remote=await github.apply(intent.operations); const receipt={schema_version:"operation-receipt.v1",document_type:"operation-receipt",receipt_id:"RECEIPT-20260901-0099",intent_id:intent.intent_id,intent_sha256:sha256Canonical(intent),created_at:clock(),status:remote.status,observed_revisions:remote.observed_revisions}; state.receipts.push(receipt); state.revision=`head-${Number(state.revision.slice(5))+1}`; if (state.onReceipt) state.onReceipt(state); return receipt; } }); }
  return {state,control,operations};
}

test("input reader accepts only closed local JSON or YAML documents",async t => {
  const cwd=await mkdtemp(join(tmpdir(),"toss-core-input-")); t.after(() => rm(cwd,{recursive:true,force:true}));
  await writeFile(join(cwd,"repo.yaml"),"default_branch: main\nproject_owner: TOSS-Soft\nproject_number: 7\n");
  await writeFile(join(cwd,"duplicate.yaml"),"default_branch: main\ndefault_branch: trunk\n"); await writeFile(join(cwd,"alias.yaml"),"base: &base {default_branch: main}\nvalue: *base\n"); await writeFile(join(cwd,"tag.yaml"),"value: !unsafe hello\n"); await writeFile(join(cwd,"invalid.json"),Buffer.from([0xff,0xfe])); await writeFile(join(cwd,"large.json"),`{"value":"${"x".repeat(1024)}"}`); await symlink(join(cwd,"repo.yaml"),join(cwd,"link.yaml"));
  await mkdir(join(cwd,"actual")); await writeFile(join(cwd,"actual","nested.yaml"),"value: ok\n"); await symlink(join(cwd,"actual"),join(cwd,"linked-parent"));
  const reader=createCoreInputReader({cwd,maxBytes:128});
  assert.deepEqual(await reader.readInput("repo.yaml"),{default_branch:"main",project_owner:"TOSS-Soft",project_number:7});
  await assert.rejects(reader.readInput("duplicate.yaml"),/duplicate|unique/i); await assert.rejects(reader.readInput("alias.yaml"),/alias|closed|canonical/i); await assert.rejects(reader.readInput("tag.yaml"),/tag|closed|canonical/i); await assert.rejects(reader.readInput("invalid.json"),/UTF-8|closed/i); await assert.rejects(reader.readInput("large.json"),/maximum|large/i); await assert.rejects(reader.readInput("link.yaml"),/symbolic|symlink|follow/i); await assert.rejects(reader.readInput("linked-parent/nested.yaml"),/symbolic|symlink|follow/i); await assert.rejects(reader.readInput("../repo.yaml"),/safe relative/i); await assert.rejects(reader.readInput("actual/../repo.yaml"),/safe relative/i); await assert.rejects(reader.readInput("./repo.yaml"),/safe relative/i); await assert.rejects(reader.readInput("\\repo.yaml"),/safe relative/i);
  const rootLink=join(cwd,"root-link"); await symlink(cwd,rootLink); const symlinkRootReader=createCoreInputReader({cwd:rootLink,maxBytes:128}); await assert.rejects(symlinkRootReader.readInput("repo.yaml"),/symbolic|symlink|directory/i);
});
test("init previews the complete bootstrap without remote or control writes",async () => {
  const github=githubFor(); const service=services({github,control:unbornControl()}); const result=await runInitCommand(command(["init"]),service);
  assert.equal(result.schema_version,"operation-preview.v1"); assert.deepEqual(github.calls.map(call => call.method),["snapshot"]); assert.equal(service.control.writes.length,0); assert.match(result.operations.map(operation => operation.payload.kind).join(" "),/control-repository/); assert.match(result.operations.map(operation => operation.payload.kind).join(" "),/lifecycle-policy/);
});
test("init applies one bootstrap transaction, is idempotent, and blocks incomplete bootstrap",async () => {
  const github=githubFor(); const service=services({github,control:unbornControl()}); const applied=await runInitCommand(command(["init","--apply","--non-interactive","--authority","authority.json"]),{...service,readAuthority:async () => authorityFixture()});
  assert.equal(applied.status,"completed"); assert.equal(service.control.writes.length,1); assert.deepEqual(Object.keys(service.control.writes[0]).sort(),["config/organization.yaml","intents/2026/09/INTENT-20260901-0001.json","policies/lifecycle.yaml","policies/release.yaml","receipts/2026/09/RECEIPT-20260901-0001.json"]); assert.equal((await runInitCommand(command(["init"]),{...service,github:githubFor({bootstrap:bootstrapSnapshot({exists:true})})})).status,"already-initialized"); await assert.rejects(runInitCommand(command(["init"]),services({control:unbornControl(),github:githubFor({bootstrap:bootstrapSnapshot({exists:true})})})),/incomplete/i);
});
test("repo add previews, registers arbitrary repositories, remains idempotent, and conflicts on a node change",async () => {
  const repository="TOSS-Soft/future-repository"; const github=githubFor({registrations:new Map([[repository,registrationSnapshot(repository)]])}); const service=services({github});
  const preview=await runRepositoryCommand(command(["repo","add",repository,"--from","repo.yaml"]),service); assert.equal(preview.schema_version,"operation-preview.v1"); assert.equal(service.control.writes.length,0);
  const applied=await runRepositoryCommand(command(["repo","add",repository,"--from","repo.yaml","--apply","--non-interactive","--authority","authority.json"]),{...service,readAuthority:async () => authorityFixture()}); assert.equal(applied.status,"registered"); assert.equal(service.control.writes.length,1);
  const again=await runRepositoryCommand(command(["repo","add",repository,"--from","repo.yaml","--apply","--non-interactive","--authority","authority.json"]),{...service,readAuthority:async () => authorityFixture()}); assert.equal(again.status,"already-registered");
  const changed=githubFor({registrations:new Map([[repository,registrationSnapshot(repository,{node:"R_other"})]])}); await assert.rejects(runRepositoryCommand(command(["repo","add",repository,"--from","repo.yaml","--apply","--non-interactive","--authority","authority.json"]),{...service,github:changed,readAuthority:async () => authorityFixture()}),/conflict/i);
});
test("repo add completes a persisted registration locally after restart without remote replay, preserves concurrent registrations, and maps configuration failures",async () => {
  const repository="TOSS-Soft/future-repository"; const other="TOSS-Soft/other"; const registrations=new Map([[repository,registrationSnapshot(repository)]]); const github=githubFor({registrations});
  let injected=true; const durable=durableRegistry({onConfiguration(state) { if (injected) { injected=false; return new Error("disk failure"); } return null; }}); const firstServices={control:durable.control(),github,operations:durable.operations(github,() => "2026-09-01T08:00:00.000Z"),readInput:async () => ({default_branch:"main",project_owner:"TOSS-Soft",project_number:7}),readAuthority:async () => authorityFixture(),clock:() => "2026-09-01T09:00:00.000Z"};
  await assert.rejects(runRepositoryCommand(command(["repo","add",repository,"--from","repo.yaml","--apply","--non-interactive","--authority","authority.json"]),firstServices),error => error?.exitCode===70);
  assert.equal(durable.state.intents.length,1); assert.equal(durable.state.receipts.length,1); const original=durable.state.intents[0].operations[0].payload.repository_config; const remoteCalls=github.calls.filter(call => call.method==="inspect" || call.method==="apply").length;
  const recoveryPreview=await runRepositoryCommand(command(["repo","add",repository,"--from","repo.yaml"]),firstServices); const dryRecovery=await runRepositoryCommand(command(["repo","add",repository,"--from","repo.yaml","--dry-run"]),firstServices); assert.equal(recoveryPreview.status,"recovery-preview"); assert.equal(dryRecovery.status,"recovery-preview"); assert.equal(Object.isFrozen(recoveryPreview),true); assert.equal(recoveryPreview.receipt.receipt_id,"RECEIPT-20260901-0099"); assert.deepEqual(recoveryPreview.configuration,original); assert.equal(github.calls.filter(call => call.method==="inspect" || call.method==="apply").length,remoteCalls);
  await assert.rejects(runRepositoryCommand(command(["repo","add",repository,"--from","repo.yaml","--apply","--non-interactive"]),firstServices),error => error?.exitCode===4);
  const invalidOperations=Object.freeze({async execute() { throw new Error("must not execute"); },async verifyAuthorityFor() { const error=new Error("forged authority"); error.exitCode=4; throw error; }}); await assert.rejects(runRepositoryCommand(command(["repo","add",repository,"--from","repo.yaml","--apply","--non-interactive","--authority","authority.json"]),{...firstServices,operations:invalidOperations}),error => error?.exitCode===4); assert.equal(github.calls.filter(call => call.method==="inspect" || call.method==="apply").length,remoteCalls);
  const restarted={...firstServices,control:durable.control(),operations:durable.operations(github,() => "2030-01-01T00:00:00.000Z"),clock:() => "2030-01-01T00:00:00.000Z"}; const completed=await runRepositoryCommand(command(["repo","add",repository,"--from","repo.yaml","--apply","--non-interactive","--authority","authority.json"]),restarted);
  assert.equal(completed.status,"registered"); assert.equal(completed.receipt.receipt_id,"RECEIPT-20260901-0099"); assert.deepEqual(durable.state.repositories.get(repository),original); assert.equal(github.calls.filter(call => call.method==="inspect" || call.method==="apply").length,remoteCalls);
  for (const argv of [["repo","add",repository,"--from","repo.yaml"],["repo","add",repository,"--from","repo.yaml","--dry-run"],["repo","add",repository,"--from","repo.yaml","--apply","--non-interactive"]]) assert.equal((await runRepositoryCommand(command(argv),restarted)).status,"already-registered");
  const changedHistorical=githubFor({registrations:new Map([[repository,registrationSnapshot(repository,{node:"R_changed"})]])}); await assert.rejects(runRepositoryCommand(command(["repo","add",repository,"--from","repo.yaml"]),{...restarted,github:changedHistorical}),error => error?.exitCode===6);
  const concurrent=durableRegistry({onReceipt(state) { const value={schema_version:"repository-config.v1",repository:other,repository_node_id:"R_other",default_branch:"main",active_release:null,project_item_id:"PVTI_other",project_fields:{status:"S",gate:"G"},registered_at:"2026-09-01T08:00:00.000Z"}; state.repositories.set(other,value); state.organization={...state.organization,repositories:[other]}; state.revision="head-2"; }}); const concurrentGithub=githubFor({registrations}); const concurrentServices={...firstServices,control:concurrent.control(),github:concurrentGithub,operations:concurrent.operations(concurrentGithub,() => "2026-09-01T08:00:00.000Z")}; await runRepositoryCommand(command(["repo","add",repository,"--from","repo.yaml","--apply","--non-interactive","--authority","authority.json"]),concurrentServices); assert.deepEqual(concurrent.state.organization.repositories,[repository,other]);
  const conflict=durableRegistry({onConfiguration() { const error=new Error("cas"); error.code="CONTROL_LEDGER_CONFLICT"; return error; }}); const conflictServices={...firstServices,control:conflict.control(),operations:conflict.operations(github,() => "2026-09-01T08:00:00.000Z")}; await assert.rejects(runRepositoryCommand(command(["repo","add",repository,"--from","repo.yaml","--apply","--non-interactive","--authority","authority.json"]),conflictServices),error => error?.exitCode===6);
});
test("repo list is deterministic and read-only while later command families remain exit 69",async () => {
  const github=githubFor(); const control=memoryControl(); await control.commitConfiguration({expectedHead:"head-0",files:{"config/organization.yaml":{...(await control.loadOrganization()),repositories:["TOSS-Soft/a","TOSS-Soft/z"]},"config/repositories/toss-soft%2Fa.yaml":{schema_version:"repository-config.v1",repository:"TOSS-Soft/a",repository_node_id:"R_a",default_branch:"main",active_release:null,project_item_id:"PVTI_a",project_fields:{status:"S",gate:"G"},registered_at:"2026-09-01T08:00:00.000Z"},"config/repositories/toss-soft%2Fz.yaml":{schema_version:"repository-config.v1",repository:"TOSS-Soft/z",repository_node_id:"R_z",default_branch:"main",active_release:null,project_item_id:"PVTI_z",project_fields:{status:"S",gate:"G"},registered_at:"2026-09-01T08:00:00.000Z"}}});
  const result=await runRepositoryCommand(command(["repo","list"]),services({control,github})); assert.deepEqual(result.repositories.map(value => value.repository),["TOSS-Soft/a","TOSS-Soft/z"]); assert.deepEqual(result.github_revisions,[{repository:"TOSS-Soft/a",revision:"github-current"},{repository:"TOSS-Soft/z",revision:"github-current"}]); assert.equal(control.writes.length,1); const {dispatchCoreCommand}=await import("../src/core/commands/router.js"); assert.equal((await dispatchCoreCommand(command(["feature","status","FEATURE-1"]),{})).exitCode,69);
});
test("runtime assembles only explicit own-data services and rejects malicious ports",() => {
  const github=Object.freeze({async snapshot() { return {}; },async inspect() { return []; },async apply() { return {status:"completed",observed_revisions:[]}; }});
  const reader=Object.freeze({async readInput() { return {}; },async readAuthority() { return authorityFixture(); }});
  const runtime=createCoreRuntime({cwd:"/workspace",controlPath:"control",execFile:async () => ({stdout:"",stderr:""}),github,clock:() => "2026-09-01T08:00:00.000Z",idGenerator:() => "INTENT-20260901-0001",authorityRegistry:{keys:[]},inputReader:reader,policyRevision:() => "POLICY-0001"});
  assert.deepEqual(Object.keys(runtime).sort(),["clock","control","github","idGenerator","operations","readAuthority","readInput"]);
  assert.equal(Object.isFrozen(runtime),true);
  assert.throws(() => createCoreRuntime({cwd:"/workspace",controlPath:"control",get execFile() { return async () => ({}); },github,clock:() => 0,idGenerator:() => "INTENT-20260901-0001",authorityRegistry:{keys:[]},inputReader:reader,policyRevision:() => "POLICY-0001"}),/own data|accessor/i);
  assert.throws(() => createCoreRuntime({cwd:"/workspace",controlPath:"control",execFile:async () => ({}),github:new Proxy(github,{}),clock:() => 0,idGenerator:() => "INTENT-20260901-0001",authorityRegistry:{keys:[]},inputReader:reader,policyRevision:() => "POLICY-0001"}),/non-proxy/i);
  const hiddenGithub={async snapshot() { return {}; },async inspect() { return []; }};
  Object.defineProperty(hiddenGithub,"apply",{enumerable:false,value:async () => ({status:"completed",observed_revisions:[]})});
  assert.throws(() => createCoreRuntime({cwd:"/workspace",controlPath:"control",execFile:async () => ({}),github:hiddenGithub,clock:() => 0,idGenerator:() => "INTENT-20260901-0001",authorityRegistry:{keys:[]},inputReader:reader,policyRevision:() => "POLICY-0001"}),/hidden|exact/i);
  assert.throws(() => createCoreRuntime({cwd:"/workspace",controlPath:"../control",execFile:async () => ({}),github,clock:() => 0,idGenerator:() => "INTENT-20260901-0001",authorityRegistry:{keys:[]},inputReader:reader,policyRevision:() => "POLICY-0001"}),/safe relative/i);
});

test("runtime rejects a stable symlinked cwd parent before control operations",async t => {
  const root=await mkdtemp(join(tmpdir(),"toss-core-runtime-path-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const physicalRoot=await realpath(root);
  const real=join(physicalRoot,"real"); const alias=join(physicalRoot,"alias");
  await mkdir(real); await symlink(real,alias);
  const github=Object.freeze({async snapshot() { return {}; },async inspect() { return []; },async apply() { return {status:"completed",observed_revisions:[]}; }});
  const reader=Object.freeze({async readInput() { return {}; },async readAuthority() { return authorityFixture(); }});
  assert.throws(() => createCoreRuntime({cwd:alias,controlPath:"missing/control",execFile:async () => ({}),github,clock:() => 0,idGenerator:() => "INTENT-20260901-0001",authorityRegistry:{keys:[]},inputReader:reader,policyRevision:() => "POLICY-0001"}),/symbolic|symlink/i);
  assert.doesNotThrow(() => createCoreRuntime({cwd:real,controlPath:"missing/control",execFile:async () => ({}),github,clock:() => 0,idGenerator:() => "INTENT-20260901-0001",authorityRegistry:{keys:[]},inputReader:reader,policyRevision:() => "POLICY-0001"}));
});
test("core router dispatches only foundation handlers without importing later families",async () => {
  const {dispatchCoreCommand}=await import("../src/core/commands/router.js");
  const dispatched=await dispatchCoreCommand(command(["init"]),{services:services({control:unbornControl(),github:githubFor()})});
  assert.equal(dispatched.exitCode,0);
  assert.equal(dispatched.result.data.command,"init");
  assert.equal((await dispatchCoreCommand(command(["release","status","v1.0.0"]),{services:{}})).exitCode,69);
});
