import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";

import {parseCommand,dispatchCommand} from "../src/commands/router.js";
import {clone} from "./support/trace-fixture.js";
import {
  commandServices as services,
  commandStore as testStore,
  parsedCommand as command,
  projectCommandInput as projectInput,
} from "./support/command-fixture.js";

const projectModule=await import("../src/commands/project.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const runProjectCommand=projectModule.runProjectCommand;
const projectAvailable=typeof runProjectCommand==="function";
const repositoryRoot=resolve(new URL("..",import.meta.url).pathname);
const cli=join(repositoryRoot,"bin","toss.js");

test("project orchestration exposes one closed command handler",() => {
  assert.equal(typeof runProjectCommand,"function");
});

test("project prepare persists a verified READY pipeline and reruns idempotently",{
  skip:!projectAvailable,
},async t => {
  const store=await testStore(t);
  const input=projectInput();
  const first=await runProjectCommand(
    command("project.prepare",{from:"project.json"}),
    services(store,input),
  );
  const before=await store.list();
  const second=await runProjectCommand(
    command("project.prepare",{from:"project.json"}),
    services(store,input),
  );
  const after=await store.list();

  assert.equal(first.state,"READY_FOR_ISSUES");
  assert.equal(first.readiness.ready_for_issue_generation,true);
  assert.equal(second.state,"READY_FOR_ISSUES");
  assert.deepEqual(after,before);
  assert.ok(second.reused_revisions.length>0);

  const status=await runProjectCommand(command("project.status"),services(store,input));
  assert.equal(status.state,"READY_FOR_ISSUES");
  assert.equal(status.blocking_owner,null);
  assert.equal(status.next_command,"issues preview");
  const verified=await Promise.all(status.artifact_revisions.map(ref => store.verify(ref)));
  assert.deepEqual(verified.map(artifact => ({
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  })),status.artifact_revisions);
});

test("non-interactive missing input never prompts, while interactive input uses the injected prompt",{
  skip:!projectAvailable,
},async t => {
  const store=await testStore(t);
  let promptCalls=0;
  const prompt=async () => {
    promptCalls+=1;
    return projectInput();
  };

  await assert.rejects(
    runProjectCommand(
      command("project.create",{nonInteractive:true}),
      {artifactStore:store,prompt},
    ),
    error => error?.code==="PROJECT_INPUT_REQUIRED" && error?.exitCode===3,
  );
  assert.equal(promptCalls,0);

  const created=await runProjectCommand(
    command("project.create"),
    {artifactStore:store,prompt},
  );
  assert.equal(created.state,"ANALYZING");
  assert.equal(promptCalls,1);
});

test("project prepare returns exact interactive decision and ADR stops and blocks automation",{
  skip:!projectAvailable,
},async t => {
  const decisionStore=await testStore(t);
  const decisionInput=projectInput({blockingDecision:true});
  const interactive=await runProjectCommand(
    command("project.prepare",{from:"blocked.yaml"}),
    services(decisionStore,decisionInput),
  );
  assert.equal(interactive.state,"QUESTIONS_PENDING");
  assert.equal(interactive.blocking_owner,"USER");
  assert.equal(interactive.package.document_type,"decision-package");
  assert.equal(interactive.package.questions[0].id,"Q-001");
  await assert.rejects(
    runProjectCommand(
      command("project.prepare",{from:"blocked.yaml",nonInteractive:true}),
      services(decisionStore,decisionInput),
    ),
    error => error?.code==="PROJECT_BLOCKED" && error?.exitCode===4,
  );

  const adrStore=await testStore(t);
  const adrInput=projectInput({pendingAdr:true});
  const adrStop=await runProjectCommand(
    command("project.prepare",{from:"pending-adr.json"}),
    services(adrStore,adrInput),
  );
  assert.equal(adrStop.state,"ADR_PENDING_APPROVAL");
  assert.equal(adrStop.blocking_owner,"USER");
  assert.equal(adrStop.package.document_type,"adr-approval-package");
  assert.equal(adrStop.package.owner,"USER");
  assert.equal(adrStop.package.adr_references[0].document_type,"adr");
});

test("resume starts at the last verified revision after append interruption",{
  skip:!projectAvailable,
},async t => {
  const store=await testStore(t);
  const input=projectInput();
  let remaining=3;
  const interrupted={
    list:store.list,
    get:store.get,
    verify:store.verify,
    append:async artifact => {
      remaining-=1;
      if (remaining===0) throw Object.assign(new Error("injected append interruption"),{
        code:"INJECTED_INTERRUPTION",
      });
      return store.append(artifact);
    },
  };

  await assert.rejects(
    runProjectCommand(
      command("project.prepare",{from:"project.json"}),
      services(interrupted,input),
    ),
    /injected append interruption/,
  );
  const partial=await store.list();
  assert.ok(partial.length>0);

  const resumed=await runProjectCommand(
    command("project.resume",{continue:true}),
    services(store,input),
  );
  assert.equal(resumed.state,"READY_FOR_ISSUES");
  assert.ok(resumed.reused_revisions.length>0);
});

test("project handlers reject stale, exotic, ambiguous, and GitHub-shaped service boundaries",{
  skip:!projectAvailable,
},async t => {
  const store=await testStore(t);
  const input=projectInput();
  let writerCalls=0;
  await assert.rejects(
    runProjectCommand(command("project.create",{from:"project.json"}),{
      ...services(store,input),
      githubWriter() {
        writerCalls+=1;
      },
    }),
    /service|closed|unexpected|canonical/i,
  );
  assert.equal(writerCalls,0);

  let getterReads=0;
  const exotic={artifactStore:store};
  Object.defineProperty(exotic,"readInput",{
    enumerable:true,
    get() {
      getterReads+=1;
      return async () => input;
    },
  });
  await assert.rejects(
    runProjectCommand(command("project.create",{from:"project.json"}),exotic),
    /accessor|canonical|service/i,
  );
  assert.equal(getterReads,0);

  const stale=clone(input);
  stale.provenance.source_sha256="f".repeat(64);
  await assert.rejects(
    runProjectCommand(
      command("project.prepare",{from:"stale.json"}),
      services(store,stale),
    ),
    error => error?.code==="STALE_PROJECT_SOURCE" || error?.exitCode===6,
  );
});

test("Task 14 dispatch lazily invokes project commands and preserves command-result.v1",{
  skip:!projectAvailable,
},async t => {
  const store=await testStore(t);
  const input=projectInput();
  const dispatched=await dispatchCommand(
    command("project.create",{from:"project.json"}),
    {services:services(store,input)},
  );
  assert.equal(dispatched.exitCode,0);
  assert.equal(dispatched.result.schema_version,"command-result.v1");
  assert.equal(dispatched.result.ok,true);

  const future=await dispatchCommand(parseCommand(["issues","preview"]),{});
  assert.equal(future.exitCode,69);
  assert.equal(future.result.error.code,"COMMAND_NOT_IMPLEMENTED");
});

test("CLI project prepare and status use only the local persisted artifact boundary",{
  skip:!projectAvailable,
},async t => {
  const directory=await mkdtemp(join(tmpdir(),"toss-project-cli-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const projectRoot=join(directory,"project");
  const inputPath=join(directory,"project.json");
  await writeFile(inputPath,JSON.stringify(projectInput()),"utf8");

  const prepared=spawnSync(process.execPath,[
    cli,"project","prepare","--from",inputPath,"--project",projectRoot,"--json",
  ],{encoding:"utf8",maxBuffer:10*1024*1024});
  assert.equal(prepared.status,0,prepared.stderr || prepared.stdout);
  const preparedResult=JSON.parse(prepared.stdout);
  assert.equal(preparedResult.schema_version,"command-result.v1");
  assert.equal(preparedResult.data.state,"READY_FOR_ISSUES");

  const status=spawnSync(process.execPath,[
    cli,"project","status","--project",projectRoot,"--json",
  ],{encoding:"utf8",maxBuffer:10*1024*1024});
  assert.equal(status.status,0,status.stderr || status.stdout);
  const statusResult=JSON.parse(status.stdout);
  assert.equal(statusResult.data.state,"READY_FOR_ISSUES");
  assert.equal(statusResult.data.next_command,"issues preview");
});
