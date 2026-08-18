import assert from "node:assert/strict";
import test from "node:test";

import {parseCommand} from "../src/commands/router.js";
import {commandStore} from "./support/command-fixture.js";
import {
  approvalsFor,
  authorityRegistry,
  classificationInput,
  designCommandInput,
  graphForLevel,
} from "./support/design-command-fixture.js";

const designModule=await import("../src/commands/design.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const runDesignCommand=designModule.runDesignCommand;

function services(store,input) {
  return {
    artifactStore:store,
    readInput:async () => JSON.stringify(input),
    authorityRegistry:authorityRegistry(),
  };
}

function parsed(name,options=[]) {
  return parseCommand(["design",name,...options]);
}

function instrumentStore(delegate,{failAtDesignAppend=Infinity}={}) {
  const appended=[];
  let designAppendCount=0;
  return {
    appended,
    store:{
      append:async artifact => {
        if (artifact.document_type!=="design-orchestration-state") {
          designAppendCount+=1;
          if (designAppendCount===failAtDesignAppend) {
            throw new Error("simulated interrupted design append");
          }
        }
        const result=await delegate.append(artifact);
        appended.push(result.document_type);
        return result;
      },
      get:delegate.get,
      list:delegate.list,
      verify:delegate.verify,
    },
  };
}

async function designRows(store) {
  return (await store.list()).filter(row =>
    row.document_type!=="design-orchestration-state");
}

async function reachSystemGate(store,graph) {
  await runDesignCommand(
    parsed("prepare",["--from","design.json"]),
    services(store,designCommandInput({artifacts:graph})),
  );
  const approved=designCommandInput({artifacts:graph,approvalRecords:approvalsFor(graph)});
  const result=await runDesignCommand(
    parsed("approve",["--from","design.json"]),
    services(store,approved),
  );
  assert.equal(result.state,"SYSTEM_APPROVED");
  assert.equal(result.ready_to_persist,true);
  return approved;
}

test("pre-gate prepare stores only immutable commitments and truthful status",async t => {
  assert.equal(typeof runDesignCommand,"function");
  const store=await commandStore(t);
  const graph=graphForLevel();
  const result=await runDesignCommand(
    parsed("screens",["--from","design.json"]),
    services(store,designCommandInput({artifacts:graph})),
  );

  assert.equal(result.state,"DIRECTION_PENDING");
  assert.equal(result.blocked,true);
  assert.deepEqual(result.artifact_revisions,[]);
  assert.deepEqual(result.persisted,[]);
  assert.ok(result.collected.includes("DIRECTION"));
  assert.ok(result.payload_commitments.every(row =>
    row.status==="COLLECTED" && row.artifact_ref===null));
  assert.equal((await designRows(store)).length,0);

  const stateRows=await store.list({document_type:"design-orchestration-state"});
  assert.equal(stateRows.length,1);
  assert.ok(stateRows[0].content.payload_commitments.every(row =>
    !Object.hasOwn(row,"payload") && row.artifact_ref===null));
});

test("missing or stale gate replay fails before any design or state append",async t => {
  assert.equal(typeof runDesignCommand,"function");
  const store=await commandStore(t);
  const graph=graphForLevel();
  const approved=await reachSystemGate(store,graph);
  const before=await store.list();

  await assert.rejects(
    runDesignCommand(
      parsed("prepare",["--continue"]),
      {artifactStore:store,authorityRegistry:authorityRegistry()},
    ),
    error => error?.code==="INPUT_REQUIRED",
  );
  assert.deepEqual(await store.list(),before);

  const stale=structuredClone(approved);
  stale.artifacts[0].created_at="2026-08-18T10:00:01.000Z";
  await assert.rejects(
    runDesignCommand(
      parsed("prepare",["--from","stale.json"]),
      services(store,stale),
    ),
    error => error?.code==="INPUT_STALE",
  );
  assert.deepEqual(await store.list(),before);
});

test("approved replay appends the candidate graph in physical dependency order",async t => {
  assert.equal(typeof runDesignCommand,"function");
  const backing=await commandStore(t);
  const graph=graphForLevel();
  const approved=await reachSystemGate(backing,graph);
  approved.artifacts.reverse();
  const observed=instrumentStore(backing);

  const result=await runDesignCommand(
    parsed("screens",["--from","design.json"]),
    services(observed.store,approved),
  );

  assert.equal(result.state,"FINAL_APPROVAL_PENDING");
  assert.equal(result.gate,"FINAL_APPROVAL");
  const physical=observed.appended.filter(type => type!=="design-orchestration-state");
  assert.equal(physical.includes("design-approval"),false);
  const index=new Map(physical.map((type,position) => [type,position]));
  for (const artifact of graph.filter(row => row.document_type!=="design-approval")) {
    for (const dependency of artifact.inputs) {
      assert.ok(index.get(dependency.document_type)<index.get(artifact.document_type),
        `${dependency.document_type} must precede ${artifact.document_type}`);
    }
  }
  assert.deepEqual((await designRows(backing)).map(row => row.document_type).sort(),
    graph.filter(row => row.document_type!=="design-approval")
      .map(row => row.document_type).sort());
});

test("interrupted physical append resumes idempotently and status stays truthful",async t => {
  assert.equal(typeof runDesignCommand,"function");
  const backing=await commandStore(t);
  const graph=graphForLevel();
  const approved=await reachSystemGate(backing,graph);
  const interrupted=instrumentStore(backing,{failAtDesignAppend:3});

  await assert.rejects(
    runDesignCommand(
      parsed("prepare",["--from","design.json"]),
      services(interrupted.store,approved),
    ),
    /simulated interrupted design append/,
  );
  const partial=await designRows(backing);
  assert.equal(partial.length,2);
  const interruptedStatus=await runDesignCommand(
    parsed("status"),
    {artifactStore:backing,authorityRegistry:authorityRegistry()},
  );
  assert.equal(interruptedStatus.persisted.length,2);
  assert.equal(interruptedStatus.payload_commitments.filter(row =>
    row.status==="PERSISTED").length,2);

  const resumed=await runDesignCommand(
    parsed("prepare",["--from","design.json"]),
    services(backing,approved),
  );
  assert.equal(resumed.state,"FINAL_APPROVAL_PENDING");
  assert.deepEqual(resumed.reused_revisions.map(row => row.document_type).sort(),
    partial.map(row => row.document_type).sort());
  const afterResume=await designRows(backing);

  const rerun=await runDesignCommand(
    parsed("prepare",["--from","design.json"]),
    services(backing,approved),
  );
  assert.deepEqual(await designRows(backing),afterResume);
  assert.deepEqual(rerun.artifact_revisions,resumed.artifact_revisions);

  const status=await runDesignCommand(
    parsed("status"),
    {artifactStore:backing,authorityRegistry:authorityRegistry()},
  );
  assert.equal(status.state,"FINAL_APPROVAL_PENDING");
  assert.equal(status.persisted.length,afterResume.length);
  assert.equal(status.payload_commitments.filter(row => row.status==="PERSISTED").length,
    afterResume.length);
  assert.ok(Object.isFrozen(status));
});

test("the complete design family supports router modes and final approval",async t => {
  assert.equal(typeof runDesignCommand,"function");
  const names=[
    "init","analyze","prepare","status","flows","wireframes","direction","system",
    "screens","prototype","audit","review","approve",
  ];
  for (const name of names) assert.equal(parsed(name).name,`design.${name}`);

  const store=await commandStore(t);
  const graph=graphForLevel();
  const approved=await reachSystemGate(store,graph);
  const prepared=await runDesignCommand(
    parsed("prepare",["--from","design.json","--json"]),
    services(store,approved),
  );
  assert.equal(prepared.state,"FINAL_APPROVAL_PENDING");
  const final=await runDesignCommand(
    parsed("approve",["--from","design.json"]),
    services(store,approved),
  );
  assert.equal(final.state,"APPROVED");
  assert.equal(final.gate,"COMPLETE");
  assert.ok(final.artifact_revisions.some(row => row.document_type==="design-approval"));

  const interactiveStore=await commandStore(t);
  const promptInput=designCommandInput({artifacts:graph});
  const prompted=await runDesignCommand(parsed("init"),{
    artifactStore:interactiveStore,
    prompt:async request => {
      assert.equal(request.kind,"design");
      return promptInput;
    },
    authorityRegistry:authorityRegistry(),
  });
  assert.equal(prompted.state,"DIRECTION_PENDING");
  await assert.rejects(
    runDesignCommand(parsed("init",["--non-interactive"]),{
      artifactStore:await commandStore(t),authorityRegistry:authorityRegistry(),
    }),
    error => error?.code==="INPUT_REQUIRED",
  );

});

test("approve is illegal without one persisted pending gate and appends nothing",async t => {
  assert.equal(typeof runDesignCommand,"function");
  const store=await commandStore(t);
  const graph=graphForLevel();
  const before=await store.list();
  await assert.rejects(
    runDesignCommand(
      parsed("approve",["--from","design.json"]),
      services(store,designCommandInput({artifacts:graph})),
    ),
    error => error?.code==="ILLEGAL_DESIGN_TRANSITION",
  );
  assert.deepEqual(await store.list(),before);
});

test("N/A feature-free design persists exactly one brief and one state",async t => {
  assert.equal(typeof runDesignCommand,"function");
  const store=await commandStore(t);
  const graph=graphForLevel("NOT_APPLICABLE");
  const input=designCommandInput({
    artifacts:graph,
    classification:classificationInput({
      delivery_targets:["API","CLI","BACKEND"],
      affected_surfaces:[],
      risk_signals:[],
      source:"NOT_APPLICABLE",
    }),
  });
  const result=await runDesignCommand(
    parsed("prepare",["--from","design.json"]),services(store,input),
  );
  assert.equal(result.state,"NOT_APPLICABLE");
  assert.equal(result.blocked,false);
  assert.deepEqual((await designRows(store)).map(row => row.document_type),["design-brief"]);
  assert.equal((await store.list({document_type:"design-orchestration-state"})).length,1);
});
