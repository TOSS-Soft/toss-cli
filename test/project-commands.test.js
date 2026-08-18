import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";

import {parseCommand,dispatchCommand} from "../src/commands/router.js";
import {runNextStage} from "../src/pipeline/orchestrator.js";
import {clone,rehash} from "./support/trace-fixture.js";
import {
  commandServices as services,
  commandStore as testStore,
  countedCommandStore,
  memoryCommandStore,
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

async function injectRecoveryState(store,input,event,extra={}) {
  return runNextStage({
    store,
    analysis_id:input.analysis_id,
    state:extra.state ?? "ANALYZING",
    event,
    source_revision:input.provenance.source_revision,
    source_sha256:input.provenance.source_sha256,
    artifacts:{},
    provenance:input.provenance,
    run_id:input.run_id,
    producer:{role:"orchestrator",identity:"toss-project-orchestrator"},
    runtime_identity:input.runtime_identity,
    created_at:input.created_at,
    ...extra,
  });
}

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
  const automation=await runProjectCommand(
    command("project.prepare",{from:"blocked.yaml",nonInteractive:true}),
    services(decisionStore,decisionInput),
  );
  assert.equal(automation.blocked,true);
  assert.equal(automation.command_exit_code,4);
  assert.deepEqual(automation.package,interactive.package);

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

test("project resume records legal RESUME and RETRY recovery transitions",{
  skip:!projectAvailable,
},async () => {
  const blockedStore=memoryCommandStore();
  const blockedInput=projectInput();
  await runProjectCommand(command("project.create",{from:"project.json"}),services(
    blockedStore,blockedInput,
  ));
  await injectRecoveryState(blockedStore,blockedInput,"BLOCK",{
    next_action:{action:"RESOLVE_BLOCKING_FINDINGS",owner:"PM"},
  });
  const resumed=await runProjectCommand(
    command("project.resume",{continue:true}),services(blockedStore,blockedInput),
  );
  const blockedEvents=await blockedStore.list({document_type:"transition-event"});
  assert.equal(resumed.state,"READY_FOR_ISSUES");
  assert.equal(blockedEvents.filter(row => row.content.event==="RESUME").length,1);
  const beforeRerun=await blockedStore.list();
  await runProjectCommand(
    command("project.resume",{continue:true}),services(blockedStore,blockedInput),
  );
  assert.deepEqual(await blockedStore.list(),beforeRerun);

  const retryStore=memoryCommandStore();
  const retryInput=projectInput();
  await runProjectCommand(command("project.create",{from:"project.json"}),services(
    retryStore,retryInput,
  ));
  await injectRecoveryState(retryStore,retryInput,"FAIL_RETRYABLE",{
    failure:{code:"TEMPORARY_FAILURE",message:"Retry from verified input."},
    resume_state:"ANALYZING",
  });
  const retried=await runProjectCommand(
    command("project.resume",{continue:true}),services(retryStore,retryInput),
  );
  const retryEvents=await retryStore.list({document_type:"transition-event"});
  assert.equal(retried.state,"READY_FOR_ISSUES");
  assert.equal(retryEvents.filter(row => row.content.event==="RETRY").length,1);
});

test("project resume rejects invalid recovery evidence before any append",{
  skip:!projectAvailable,
},async () => {
  const store=memoryCommandStore();
  const input=projectInput();
  input.artifacts.issue_plan.content.acceptance_criteria[0].verifies[0].id="REQ-NOPE";
  rehash(input.artifacts.issue_plan);
  await runProjectCommand(command("project.create",{from:"project.json"}),services(store,input));
  await injectRecoveryState(store,input,"FAIL_RETRYABLE",{
    failure:{code:"TEMPORARY_FAILURE",message:"Retry from verified input."},
    resume_state:"ANALYZING",
  });
  let appends=0;
  const observed={
    get:store.get,
    list:store.list,
    verify:store.verify,
    append:async draft => {
      appends+=1;
      return store.append(draft);
    },
  };
  await assert.rejects(
    runProjectCommand(command("project.resume",{continue:true}),services(observed,input)),
    error => error?.code==="INVALID_RECOVERY_EVIDENCE",
  );
  assert.equal(appends,0);
});

test("project status uses the verified package owner and blocked dispatch keeps the package",{
  skip:!projectAvailable,
},async () => {
  const store=memoryCommandStore();
  const input=projectInput({blockingDecision:true});
  input.artifacts.pm_analysis.content.open_questions[0].severity="P1";
  rehash(input.artifacts.pm_analysis);
  const interactive=await runProjectCommand(
    command("project.prepare",{from:"blocked.json"}),services(store,input),
  );
  assert.equal(interactive.package.questions[0].owner,"ARCHITECT");
  assert.equal(interactive.blocking_owner,"ARCHITECT");

  const dispatched=await dispatchCommand(
    command("project.prepare",{from:"blocked.json",nonInteractive:true}),
    {services:services(store,input)},
  );
  assert.equal(dispatched.exitCode,4);
  assert.equal(dispatched.result.ok,true);
  assert.equal(dispatched.result.data.blocked,true);
  assert.deepEqual(dispatched.result.data.package,interactive.package);
});

test("noninteractive project blocking is exit 4 command-result data, not a lossy error",{
  skip:!projectAvailable,
},async () => {
  const store=memoryCommandStore();
  const input=projectInput({blockingDecision:true});
  const dispatched=await dispatchCommand(
    command("project.prepare",{from:"blocked.json",nonInteractive:true}),
    {services:services(store,input)},
  );
  assert.equal(dispatched.exitCode,4);
  assert.equal(dispatched.result.schema_version,"command-result.v1");
  assert.equal(dispatched.result.ok,true);
  assert.equal(dispatched.result.data.blocked,true);
  assert.equal(dispatched.result.data.package.document_type,"decision-package");
});

test("READY re-entry resolves the one exact spec audit referenced by its transition",{
  skip:!projectAvailable,
},async () => {
  const store=memoryCommandStore();
  const input=projectInput();
  await runProjectCommand(
    command("project.prepare",{from:"project.json"}),services(store,input),
  );
  const exact=(await store.list({document_type:"spec-audit"}))[0];
  const forged=clone(exact);
  forged.artifact_id="spec-audit:forged-same-source";
  await store.append(forged);
  const adversarial={
    append:store.append,
    get:store.get,
    verify:store.verify,
    list:async filter => {
      const rows=await store.list(filter);
      return filter?.document_type==="spec-audit" ? rows.reverse() : rows;
    },
  };
  const result=await runProjectCommand(
    command("project.prepare",{continue:true}),services(adversarial,input),
  );
  assert.equal(result.state,"READY_FOR_ISSUES");
  assert.equal(result.readiness.ready_for_issue_generation,true);
});

test("project prepare uses one command-scoped verified catalog",{
  skip:!projectAvailable,
},async () => {
  const counted=countedCommandStore(memoryCommandStore());
  const result=await runProjectCommand(
    command("project.prepare",{from:"project.json"}),
    services(counted.store,projectInput()),
  );
  assert.equal(result.state,"READY_FOR_ISSUES");
  assert.ok(
    counted.calls.list<=3 && counted.calls.get<=15 && counted.calls.verify<=15,
    `project command store amplification: ${JSON.stringify(counted.calls)}`,
  );
  assert.equal(counted.calls.append,10);
});

test("project prepare rejects an unexpected artifact at its final consistency refresh",{
  skip:!projectAvailable,
},async () => {
  const backing=memoryCommandStore();
  let listCalls=0;
  let external=null;
  const isExternal=reference => external &&
    reference.document_type===external.document_type &&
    reference.artifact_id===external.artifact_id &&
    reference.revision===external.revision &&
    reference.content_sha256===external.content_sha256;
  const store={
    append:backing.append,
    get:async reference => isExternal(reference) ? clone(external) : backing.get(reference),
    verify:async reference => isExternal(reference) ? clone(external) : backing.verify(reference),
    list:async filter => {
      listCalls+=1;
      const rows=await backing.list(filter);
      if (listCalls>1 && rows.length>0) {
        external=clone(rows[0]);
        external.artifact_id=`external:${external.artifact_id}`;
        return [...rows,clone(external)];
      }
      return rows;
    },
  };

  await assert.rejects(
    runProjectCommand(
      command("project.prepare",{from:"project.json"}),
      services(store,projectInput()),
    ),
    error => error?.code==="UNEXPECTED_ARTIFACT_CHANGE" && error?.exitCode===6,
  );
  assert.equal(listCalls,2);
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
