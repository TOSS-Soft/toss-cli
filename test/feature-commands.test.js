import assert from "node:assert/strict";
import test from "node:test";

import {dispatchCommand} from "../src/commands/router.js";
import {artifactReference,clone,rehash} from "./support/trace-fixture.js";
import {
  commandServices,
  commandStore,
  featureCommandInput,
  memoryCommandStore,
  parsedCommand,
  projectCommandInput,
} from "./support/command-fixture.js";

const featureModule=await import("../src/commands/feature.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const projectModule=await import("../src/commands/project.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const runFeatureCommand=featureModule.runFeatureCommand;
const runProjectCommand=projectModule.runProjectCommand;
const commandsAvailable=typeof runFeatureCommand==="function" &&
  typeof runProjectCommand==="function";

test("feature orchestration exposes one closed command handler",() => {
  assert.equal(typeof runFeatureCommand,"function");
});

async function readyProject(t,{real=false}={}) {
  const store=real ? await commandStore(t) : memoryCommandStore();
  const project=projectCommandInput();
  const prepared=await runProjectCommand(
    parsedCommand("project.prepare",{from:"project.json"}),
    commandServices(store,project),
  );
  assert.equal(prepared.state,"READY_FOR_ISSUES");
  return {store,project,prepared};
}

function featureServices(store,input,options) {
  return commandServices(store,input,options);
}

test("feature add/analyze/prepare creates immutable delta revisions over one exact base",{
  skip:!commandsAvailable,
},async t => {
  const {store,prepared}=await readyProject(t);
  const input=featureCommandInput();
  const projectBefore=await store.list();

  const added=await runFeatureCommand(
    parsedCommand("feature.add",{from:"feature.yaml"}),
    featureServices(store,input),
  );
  const analyzed=await runFeatureCommand(
    parsedCommand("feature.analyze",{continue:true}),
    featureServices(store,input),
  );
  const result=await runFeatureCommand(
    parsedCommand("feature.prepare",{continue:true}),
    featureServices(store,input),
  );

  assert.equal(added.stage,"ADDED");
  assert.equal(analyzed.stage,"ANALYZED");
  assert.equal(result.stage,"PREPARED");
  assert.equal(result.ready,true);
  assert.equal(result.artifact.document_type,"feature-delta");
  assert.equal(result.artifact.content.kind,"feature-delta");
  assert.deepEqual(result.artifact.content.base_project.artifacts,prepared.artifact_revisions);
  assert.equal(result.artifact.content.base_project.authority,"reference-only");

  const projectAfter=(await store.list()).filter(entry =>
    entry.document_type!=="feature-delta");
  assert.deepEqual(projectAfter,projectBefore);
  assert.deepEqual(result.artifact.inputs,prepared.artifact_revisions.filter(
    reference => reference.document_type==="transition-event",
  ));

  const status=await runFeatureCommand(
    parsedCommand("feature.status"),
    featureServices(store,input),
  );
  assert.equal(status.stage,"PREPARED");
  assert.equal(status.next_command,"issues preview");
  assert.equal(status.blocking_owner,null);
});

test("feature prepare is idempotent and reports reused immutable revisions",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput();
  const services=featureServices(store,input);
  const first=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),
    services,
  );
  const before=await store.list({document_type:"feature-delta"});
  const second=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),
    services,
  );
  const after=await store.list({document_type:"feature-delta"});

  assert.deepEqual(after,before);
  assert.equal(first.artifact.content_sha256,second.artifact.content_sha256);
  assert.ok(second.reused_revisions.length>=1);
});

test("feature prepare detects a stale exact base and never rewrites project artifacts",{
  skip:!commandsAvailable,
},async t => {
  const {store,project}=await readyProject(t);
  const input=featureCommandInput();
  await runFeatureCommand(
    parsedCommand("feature.add",{from:"feature.json"}),
    featureServices(store,input),
  );

  const current=project.artifacts.pm_analysis;
  const next=clone(current);
  next.revision=current.revision+1;
  next.parents=[artifactReference(current)];
  next.created_at="2026-08-18T10:00:00.000Z";
  next.content.summary=`${next.content.summary} Updated.`;
  rehash(next);
  await store.append(next);

  await assert.rejects(
    runFeatureCommand(
      parsedCommand("feature.prepare",{continue:true}),
      featureServices(store,input),
    ),
    error => error?.code==="STALE_FEATURE_BASE" && error?.exitCode===6,
  );
  const pmRows=await store.list({document_type:"pm-analysis"});
  assert.equal(pmRows.length,2);
});

test("feature prepare persists an auditable blocked delta and automation exits nonzero",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput({findings:[{
    id:"FEATURE-FINDING-001",
    severity:"P2",
    owner:"ARCHITECT",
    message:"A new externally visible delivery guarantee needs an ADR.",
  }]});
  const interactive=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),
    featureServices(store,input),
  );
  assert.equal(interactive.ready,false);
  assert.equal(interactive.blocking_owner,"ARCHITECT");
  assert.equal(interactive.artifact.content.audit.status,"FAIL");

  const automation=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json",nonInteractive:true}),
    featureServices(store,input),
  );
  assert.equal(automation.blocked,true);
  assert.equal(automation.command_exit_code,4);
  assert.deepEqual(automation.findings,interactive.artifact.content.readiness.failures);
});

test("feature prepare recovers from interruption without ambiguous revision forks",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput();
  await runFeatureCommand(
    parsedCommand("feature.add",{from:"feature.json"}),
    featureServices(store,input),
  );
  let appends=0;
  const interrupted={
    list:store.list,
    get:store.get,
    verify:store.verify,
    append:async artifact => {
      appends+=1;
      if (appends===1) throw new Error("feature append interrupted");
      return store.append(artifact);
    },
  };
  await assert.rejects(
    runFeatureCommand(
      parsedCommand("feature.prepare",{from:"feature.json"}),
      featureServices(interrupted,input),
    ),
    /feature append interrupted/,
  );
  const resumed=await runFeatureCommand(
    parsedCommand("feature.prepare",{continue:true}),
    featureServices(store,input),
  );
  assert.equal(resumed.stage,"PREPARED");
  assert.ok(resumed.reused_revisions.length>0);
});

test("a prepared feature delta is durable and verifiable in the real artifact store",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t,{real:true});
  const result=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),
    featureServices(store,featureCommandInput()),
  );
  const verified=await store.verify(artifactReference(result.artifact));
  assert.equal(verified.document_type,"feature-delta");
  assert.equal(verified.content.stage,"PREPARED");
  assert.equal(verified.content.base_project.authority,"reference-only");
});

test("feature input and service boundaries reject stale source and accessors without calls",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput();
  let getterReads=0;
  const services={artifactStore:store};
  Object.defineProperty(services,"readInput",{
    enumerable:true,
    get() {
      getterReads+=1;
      return async () => JSON.stringify(input);
    },
  });
  await assert.rejects(
    runFeatureCommand(
      parsedCommand("feature.add",{from:"feature.json"}),
      services,
    ),
    /accessor|canonical|service/i,
  );
  assert.equal(getterReads,0);

  const stale=clone(input);
  stale.provenance.source_sha256="c".repeat(64);
  await runFeatureCommand(
    parsedCommand("feature.add",{from:"feature.json"}),
    featureServices(store,input),
  );
  await assert.rejects(
    runFeatureCommand(
      parsedCommand("feature.analyze",{from:"feature.json"}),
      featureServices(store,stale),
    ),
    error => error?.code==="STALE_FEATURE_SOURCE" && error?.exitCode===6,
  );
});

test("feature source content cannot drift under one immutable source identity",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput();
  await runFeatureCommand(
    parsedCommand("feature.add",{from:"feature.json"}),featureServices(store,input),
  );
  const drifted=clone(input);
  drifted.request.summary="Materially different request under the same source hash.";
  const before=await store.list({document_type:"feature-delta"});
  await assert.rejects(
    runFeatureCommand(
      parsedCommand("feature.analyze",{from:"feature.json"}),
      featureServices(store,drifted),
    ),
    error => error?.code==="STALE_FEATURE_SOURCE" && error?.exitCode===6,
  );
  assert.deepEqual(await store.list({document_type:"feature-delta"}),before);
});

test("requires_adr independently blocks and noninteractive JSON retains findings",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput();
  input.architecture_impact.requires_adr=true;
  const interactive=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),featureServices(store,input),
  );
  assert.equal(interactive.ready,false);
  assert.equal(interactive.blocking_owner,"ARCHITECT");
  assert.equal(interactive.artifact.content.readiness.failures[0].id,"FEATURE-ADR-REQUIRED");

  const dispatched=await dispatchCommand(
    parsedCommand("feature.prepare",{from:"feature.json",nonInteractive:true}),
    {services:featureServices(store,input)},
  );
  assert.equal(dispatched.exitCode,4);
  assert.equal(dispatched.result.ok,true);
  assert.equal(dispatched.result.data.blocked,true);
  assert.deepEqual(
    dispatched.result.data.findings,
    interactive.artifact.content.readiness.failures,
  );
});

test("noninteractive feature blocking is exit 4 command-result data with findings",{
  skip:!commandsAvailable,
},async t => {
  const {store}=await readyProject(t);
  const input=featureCommandInput({findings:[{
    id:"FEATURE-FINDING-STRUCTURED",
    severity:"P2",
    owner:"ARCHITECT",
    message:"Architecture approval is required.",
  }]});
  const dispatched=await dispatchCommand(
    parsedCommand("feature.prepare",{from:"feature.json",nonInteractive:true}),
    {services:featureServices(store,input)},
  );
  assert.equal(dispatched.exitCode,4);
  assert.equal(dispatched.result.schema_version,"command-result.v1");
  assert.equal(dispatched.result.ok,true);
  assert.equal(dispatched.result.data.blocked,true);
  assert.deepEqual(dispatched.result.data.findings,input.findings);
});
