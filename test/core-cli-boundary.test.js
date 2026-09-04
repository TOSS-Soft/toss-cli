import assert from "node:assert/strict";
import {execFile as execFileCallback,spawnSync} from "node:child_process";
import {generateKeyPairSync,sign as signDetached} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {canonicalJson} from "../src/contracts/acp.js";
import {authoritySigningPayload} from "../src/core/authority.js";
import {runCoreCli} from "../src/core/cli.js";
import {CoreBlockedError} from "../src/core/errors.js";
import {createCoreRuntime} from "../src/core/runtime.js";

const repositoryRoot=fileURLToPath(new URL("..",import.meta.url));
const coreCli=join(repositoryRoot,"bin","toss-core.js");
const legacyCli=join(repositoryRoot,"bin","toss.js");
const manifest=JSON.parse(await readFile(join(repositoryRoot,"package.json"),"utf8"));
const CORE_HELP=`Usage: toss-core <command> [options]

Commands:
  init
  repo add <OWNER/REPO> --from <FILE>
  repo list

Common options:
  --json
  --control <PATH>  Local control repository (default: .toss-core-control)
  --apply --non-interactive
  --dry-run
`;

function stream() {
  let value="";
  return Object.freeze({write(chunk) { value+=chunk; },read() { return value; }});
}

function invoke(args,{cwd=repositoryRoot}={}) {
  return spawnSync(process.execPath,[coreCli,...args],{
    cwd,
    encoding:"utf8",
    maxBuffer:10*1024*1024,
  });
}

function git(cwd,args) {
  const result=spawnSync("git",args,{cwd,encoding:"utf8"});
  assert.equal(result.status,0,result.stderr || result.stdout);
}

async function controlRepository(t) {
  const root=await mkdtemp(join(tmpdir(),"toss-core-cli-boundary-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const control=join(root,"control");
  git(root,["init","--quiet",control]);
  git(control,["config","user.name","TOSS Test"]);
  git(control,["config","user.email","toss-test@example.invalid"]);
  return {root,control};
}

function authoritySigner() {
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  return Object.freeze({
    registry:Object.freeze({keys:Object.freeze([Object.freeze({
      key_id:"key-1",
      actor:"approver",
      public_key:publicKey.export({format:"pem",type:"spki"}).toString(),
    })])}),
    record({record_id,command,targets,expected_revisions}) {
      const unsigned={
        schema_version:"authority-record.v1",
        document_type:"authority-record",
        record_id,
        actor:"approver",
        command,
        targets,
        expected_revisions,
        policy_revision:"POLICY-0001",
        issued_at:"2026-09-01T07:00:00.000Z",
        expires_at:"2026-09-01T09:00:00.000Z",
        signature:{algorithm:"ed25519",key_id:"key-1",value:""},
      };
      return {
        ...unsigned,
        signature:{
          ...unsigned.signature,
          value:signDetached(
            null,
            Buffer.from(canonicalJson(authoritySigningPayload(unsigned)),"utf8"),
            privateKey,
          ).toString("base64"),
        },
      };
    },
  });
}

function bootstrapSnapshot() {
  return {
    kind:"bootstrap",
    source:{
      repository:"TOSS-Soft/toss-os-control",
      revision:"remote-0",
      sha256:"a".repeat(64),
    },
    control_repository:{exists:false,revision:null},
    organization:{
      organization:"TOSS-Soft",
      project:{node_id:"PVT_org",number:7,revision:"project-1"},
      policy_revision:"POLICY-0001",
      lifecycle_policy:{revision:"POLICY-0001",states:["Backlog","Ready"]},
      release_policy:{revision:"POLICY-0001",gates:["NONE","RECONCILE_REQUIRED"]},
    },
  };
}

function repositorySnapshot(repository) {
  return {
    kind:"repository-registration",
    source:{repository,revision:"repo-1",sha256:"b".repeat(64)},
    repository:{
      node_id:"R_example",
      default_branch:"main",
      revision:"repo-1",
      access:{admin:true},
      rules:{default_branch_protected:true},
      project_item_id:"PVTI_example",
    },
    project:{
      node_id:"PVT_org",
      number:7,
      fields:{status:"FIELD_STATUS",gate:"FIELD_GATE"},
    },
  };
}

function fakeGitHub(events) {
  return Object.freeze({
    async snapshot(query) {
      events.push(`snapshot:${query.kind}`);
      if (query.kind==="bootstrap") return bootstrapSnapshot();
      if (query.kind==="repository-registration") return repositorySnapshot(query.repository);
      throw new Error("unexpected fake GitHub query: "+query.kind);
    },
    async inspect(operations) {
      events.push("inspect");
      return operations.map(operation => ({
        operation_id:operation.operation_id,
        repository:operation.repository,
        revision:operation.expected_revision,
      }));
    },
    async apply(operations) {
      events.push("apply");
      return {
        status:"completed",
        observed_revisions:operations.map(operation => ({
          operation_id:operation.operation_id,
          repository:operation.repository,
          revision:`remote-${operation.operation_id}`,
        })),
      };
    },
  });
}

function runtimeProvider({github,authorityRegistry,prompt}={}) {
  const execFile=promisify(execFileCallback);
  let sequence=0;
  return async ({cwd,command}) => ({
    services:createCoreRuntime({
      cwd,
      controlPath:command.options.control ?? "control",
      execFile,
      github,
      clock:() => "2026-09-01T08:00:00.000Z",
      idGenerator:kind => `${kind==="intent" ? "INTENT" : "RECEIPT"}-20260901-${String(++sequence).padStart(4,"0")}`,
      authorityRegistry,
      policyRevision:() => "POLICY-0001",
    }),
    ...(prompt===undefined ? {} : {prompt}),
  });
}

async function runProgrammatic(argv,{cwd,runtimeProvider:provider}) {
  const stdout=stream();
  const stderr=stream();
  const exitCode=await runCoreCli(argv,{
    cwd,
    stdin:Object.freeze({}),
    stdout,
    stderr,
    runtimeProvider:provider,
  });
  return {exitCode,stdout:stdout.read(),stderr:stderr.read()};
}

test("runCoreCli bootstrap persists control state before the real executable reads it",async t => {
  const {root,control}=await controlRepository(t);
  const events=[];
  const signer=authoritySigner();
  const initAuthority=signer.record({
    record_id:"AUTH-20260901-0001",
    command:"init",
    targets:["PVT_org","TOSS-Soft/toss-os-control"],
    expected_revisions:[{repository:"TOSS-Soft/toss-os-control",revision:null},{repository:null,revision:"project-1"}],
  });
  await writeFile(join(root,"init-authority.json"),JSON.stringify(initAuthority),"utf8");
  const provider=runtimeProvider({github:fakeGitHub(events),authorityRegistry:signer.registry});

  const preview=await runProgrammatic(["init","--control","control","--json"],{cwd:root,runtimeProvider:provider});
  assert.equal(preview.exitCode,0,preview.stderr);
  assert.equal(preview.stderr,"");
  assert.equal(JSON.parse(preview.stdout).data.schema_version,"operation-preview.v1");

  const applied=await runProgrammatic([
    "init","--control","control","--apply","--non-interactive",
    "--authority","init-authority.json","--json",
  ],{cwd:root,runtimeProvider:provider});
  assert.equal(applied.exitCode,0,applied.stderr || applied.stdout);
  assert.equal(applied.stderr,"");
  assert.equal(JSON.parse(applied.stdout).data.status,"completed");
  assert.deepEqual(events,["snapshot:bootstrap","snapshot:bootstrap","inspect","apply"]);
  git(control,["rev-parse","--verify","HEAD"]);

  const help=invoke(["--help"]);
  assert.equal(help.status,0,help.stderr);
  assert.equal(help.stderr,"");
  assert.equal(help.stdout,CORE_HELP);
  const shortHelp=invoke(["-h"]);
  assert.equal(shortHelp.status,0,shortHelp.stderr);
  assert.equal(shortHelp.stdout,help.stdout);

  const version=invoke(["--version"]);
  assert.equal(version.status,0,version.stderr);
  assert.equal(version.stderr,"");
  assert.equal(version.stdout,manifest.version+"\n");
  const shortVersion=invoke(["-v"]);
  assert.equal(shortVersion.status,0,shortVersion.stderr);
  assert.equal(shortVersion.stdout,version.stdout);

  const listed=invoke(["repo","list","--control","control","--json"],{cwd:root});
  assert.equal(listed.status,0,listed.stderr || listed.stdout);
  assert.equal(listed.stderr,"");
  assert.equal(listed.stdout.trim().split("\n").filter(Boolean).length>0,true);
  const result=JSON.parse(listed.stdout);
  assert.equal(result.schema_version,"command-result.v1");
  assert.deepEqual(result.data.repositories,[]);
  assert.deepEqual(result.data.github_revisions,[]);

  const registeredRepository="TOSS-Soft/toss-example";
  const repoAuthority=signer.record({
    record_id:"AUTH-20260901-0002",
    command:"repo.add",
    targets:[registeredRepository],
    expected_revisions:[{repository:registeredRepository,revision:"repo-1"}],
  });
  await writeFile(join(root,"repo-authority.json"),JSON.stringify(repoAuthority),"utf8");
  await writeFile(join(root,"repository.json"),JSON.stringify({
    default_branch:"main",
    project_owner:"TOSS-Soft",
    project_number:7,
    publication:{package_name:"@toss-software/example",workflow:"publish.yml",
      required_assets:[]},
  }),"utf8");
  const registered=await runProgrammatic([
    "repo","add",registeredRepository,"--control","control","--from","repository.json",
    "--apply","--non-interactive","--authority","repo-authority.json","--json",
  ],{cwd:root,runtimeProvider:provider});
  assert.equal(registered.exitCode,0,registered.stderr);
  assert.equal(JSON.parse(registered.stdout).data.status,"registered");
  const unavailable=invoke(["repo","list","--control","control","--json"],{cwd:root});
  assert.equal(unavailable.status,69,unavailable.stderr || unavailable.stdout);
  assert.equal(unavailable.stderr,"");
  const unavailableResult=JSON.parse(unavailable.stdout);
  assert.equal(unavailableResult.schema_version,"command-result.v1");
  assert.equal(unavailableResult.error.code,"COMMAND_NOT_IMPLEMENTED");

  const invalid=invoke(["--version","--json"]);
  assert.equal(invalid.status,2);
  assert.equal(invalid.stderr,"");
  assert.equal(JSON.parse(invalid.stdout).error.code,"COMMAND_USAGE");
  const invalidHelp=invoke(["--help","--json"]);
  assert.equal(invalidHelp.status,2);
  assert.equal(invalidHelp.stderr,"");
  assert.equal(JSON.parse(invalidHelp.stdout).error.code,"COMMAND_USAGE");
});

test("interactive init and repo add confirm their exact previews before any write",async t => {
  const {root,control}=await controlRepository(t);
  const signer=authoritySigner();
  const initAuthority=signer.record({record_id:"AUTH-20260901-0001",command:"init",targets:["PVT_org","TOSS-Soft/toss-os-control"],expected_revisions:[{repository:"TOSS-Soft/toss-os-control",revision:null},{repository:null,revision:"project-1"}]});
  const repository="TOSS-Soft/toss-example";
  const repoAuthority=signer.record({record_id:"AUTH-20260901-0002",command:"repo.add",targets:[repository],expected_revisions:[{repository,revision:"repo-1"}]});
  await writeFile(join(root,"init-authority.json"),JSON.stringify(initAuthority),"utf8");
  await writeFile(join(root,"repo-authority.json"),JSON.stringify(repoAuthority),"utf8");
  await writeFile(join(root,"repository.json"),JSON.stringify({default_branch:"main",
    project_owner:"TOSS-Soft",project_number:7,
    publication:{package_name:"@toss-software/example",workflow:"publish.yml",
      required_assets:[]}}),"utf8");
  const events=[]; const prompts=[];
  const provider=runtimeProvider({github:fakeGitHub(events),authorityRegistry:signer.registry,prompt:async request => { prompts.push(request); assert.equal(request.kind,"confirm-apply"); assert.equal(request.preview.schema_version,"operation-preview.v1"); assert.equal(request.preview.command,request.command.name); return true; }});
  const initialized=await runProgrammatic(["init","--control","control","--apply","--authority","init-authority.json","--json"],{cwd:root,runtimeProvider:provider});
  assert.equal(initialized.exitCode,0,initialized.stderr); assert.equal(JSON.parse(initialized.stdout).data.status,"completed");
  const registered=await runProgrammatic(["repo","add",repository,"--control","control","--from","repository.json","--apply","--authority","repo-authority.json","--json"],{cwd:root,runtimeProvider:provider});
  assert.equal(registered.exitCode,0,registered.stderr); assert.equal(JSON.parse(registered.stdout).data.status,"registered");
  assert.equal(prompts.length,2); assert.equal(prompts[0].preview.operations.length,7); assert.equal(prompts[1].preview.operations.length,1);
});

test("every interactive release mutation receives the generic CLI confirmation bridge",async t => {
  const {root}=await controlRepository(t);
  const prompts=[];
  const previews=[];
  let approvalPhase=0;
  const provider=async () => ({
    services:{},
    handlers:{
      "release.plan":async (command,services) => {
        const preview={schema_version:"operation-preview.v1",intent_id:"INTENT-20260903-0001",
          intent_sha256:"a".repeat(64),command:command.name,operations:[]};
        previews.push(preview);
        assert.equal(await services.confirm(preview),true);
        return {status:"confirmed"};
      },
      "release.activate":async (command,services) => {
        const preview={schema_version:"operation-preview.v1",intent_id:"INTENT-20260903-0002",
          intent_sha256:"b".repeat(64),command:command.name,operations:[]};
        previews.push(preview);
        assert.equal(await services.confirm(preview),true);
        return {status:"confirmed"};
      },
      "release.approve":async (command,services) => {
        approvalPhase+=1;
        const preview={schema_version:"operation-preview.v1",
          intent_id:`INTENT-20260903-000${approvalPhase+2}`,
          intent_sha256:String(approvalPhase+1).repeat(64),command:command.name,operations:[]};
        previews.push(preview);
        assert.equal(await services.confirm(preview),true);
        return {status:["approval","publication","patch-completion"][approvalPhase-1]};
      },
    },
    prompt:async request => { prompts.push(request); return true; },
  });

  for (const argv of [
    ["release","plan","--apply","--json"],
    ["release","activate","TOSS-OS-R0001","--apply","--json"],
    ["release","approve","TOSS-Soft/toss-cli@2.2.0","--apply",
      "--authority","authority.json","--json"],
    ["release","approve","TOSS-Soft/toss-cli@2.2.0","--apply","--json"],
    ["release","approve","TOSS-Soft/toss-cli@2.2.0","--apply","--json"],
  ]) {
    const result=await runProgrammatic(argv,{cwd:root,runtimeProvider:provider});
    assert.equal(result.exitCode,0,result.stderr);
  }
  assert.equal(prompts.length,5);
  assert.deepEqual(prompts.map(value => value.kind),Array(5).fill("confirm-apply"));
  assert.deepEqual(prompts.map(value => value.command.name),[
    "release.plan","release.activate","release.approve","release.approve","release.approve",
  ]);
  assert.deepEqual(prompts.map(value => value.preview),previews);

  let writes=0;
  let declines=0;
  const declineProvider=async () => ({services:{},handlers:{
    "release.approve":async (command,services) => {
      const preview={schema_version:"operation-preview.v1",intent_id:"INTENT-20260903-0099",
        intent_sha256:"f".repeat(64),command:command.name,operations:[]};
      if (await services.confirm(preview)!==true) {
        throw new CoreBlockedError("Interactive apply was not confirmed");
      }
      writes+=1;
      return {status:"written"};
    },
  },prompt:async () => { declines+=1; return false; }});
  const declined=await runProgrammatic([
    "release","approve","TOSS-Soft/toss-cli@2.2.0","--apply","--json",
  ],{cwd:root,runtimeProvider:declineProvider});
  assert.equal(declined.exitCode,4);
  assert.equal(declines,1);
  assert.equal(writes,0);
});

test("interactive decline receives the exact preview and performs no init or repo-add write",async t => {
  const {root,control}=await controlRepository(t);
  const signer=authoritySigner();
  const initAuthority=signer.record({record_id:"AUTH-20260901-0001",command:"init",targets:["PVT_org","TOSS-Soft/toss-os-control"],expected_revisions:[{repository:"TOSS-Soft/toss-os-control",revision:null},{repository:null,revision:"project-1"}]});
  const repository="TOSS-Soft/toss-example";
  const repoAuthority=signer.record({record_id:"AUTH-20260901-0002",command:"repo.add",targets:[repository],expected_revisions:[{repository,revision:"repo-1"}]});
  await writeFile(join(root,"init-authority.json"),JSON.stringify(initAuthority),"utf8"); await writeFile(join(root,"repo-authority.json"),JSON.stringify(repoAuthority),"utf8"); await writeFile(join(root,"repository.json"),JSON.stringify({default_branch:"main",project_owner:"TOSS-Soft",project_number:7,publication:{package_name:"@toss-software/example",workflow:"publish.yml",required_assets:[]}}),"utf8");
  const events=[]; const declined=[];
  const declineProvider=runtimeProvider({github:fakeGitHub(events),authorityRegistry:signer.registry,prompt:async request => { declined.push(request.preview); return false; }});
  const initDeclined=await runProgrammatic(["init","--control","control","--apply","--authority","init-authority.json","--json"],{cwd:root,runtimeProvider:declineProvider});
  assert.equal(initDeclined.exitCode,4); assert.equal(JSON.parse(initDeclined.stdout).error.code,"CORE_BLOCKED"); assert.equal(declined[0].operations.length,7); assert.deepEqual(events,["snapshot:bootstrap"]);
  const acceptProvider=runtimeProvider({github:fakeGitHub(events),authorityRegistry:signer.registry});
  const initialized=await runProgrammatic(["init","--control","control","--apply","--non-interactive","--authority","init-authority.json","--json"],{cwd:root,runtimeProvider:acceptProvider});
  assert.equal(initialized.exitCode,0,initialized.stderr); const headBefore=(await readFile(join(control,".git","HEAD"),"utf8"));
  events.length=0;
  const repoDeclined=await runProgrammatic(["repo","add",repository,"--control","control","--from","repository.json","--apply","--authority","repo-authority.json","--json"],{cwd:root,runtimeProvider:declineProvider});
  assert.equal(repoDeclined.exitCode,4); assert.equal(JSON.parse(repoDeclined.stdout).error.code,"CORE_BLOCKED"); assert.equal(declined[1].operations.length,1); assert.deepEqual(events,["snapshot:repository-registration"]); assert.equal(await readFile(join(control,".git","HEAD"),"utf8"),headBefore);
});

test("legacy toss feature status retains its established JSON failure contract",() => {
  const result=spawnSync(process.execPath,[legacyCli,"feature","status","--json"],{
    cwd:repositoryRoot,
    encoding:"utf8",
  });
  assert.equal(result.status,3,result.stderr || result.stdout);
  assert.equal(result.stderr,"");
  assert.deepEqual(JSON.parse(result.stdout),{
    schema_version:"command-result.v1",
    document_type:"command-result",
    ok:false,
    data:null,
    error:{
      code:"FEATURE_INPUT_REQUIRED",
      message:"No persisted feature input exists",
    },
  });
});
