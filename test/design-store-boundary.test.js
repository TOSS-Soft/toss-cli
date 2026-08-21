import assert from "node:assert/strict";
import test from "node:test";

import {parseCommand} from "../src/commands/router.js";
import {
  createLifecycleRuntimeProvider,
  lifecycleRuntimeServices,
} from "../src/cli-lifecycle.js";
import {runDesignCommand} from "../src/commands/design.js";
import {commandStore} from "./support/command-fixture.js";
import {
  approvalsFor,
  authorityRegistry,
  designCommandInput,
  finalApprovalFor,
  graphForLevel,
} from "./support/design-command-fixture.js";

const authorityCapability=lifecycleRuntimeServices(createLifecycleRuntimeProvider({
  authorityRegistry:authorityRegistry(),
  prompt:async () => null,
})).authorityCapability;

function services(store,input) {
  return {
    artifactStore:store,
    readInput:async () => JSON.stringify(input),
    authorityCapability,
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

function assertStateInputProjection(state) {
  assert.deepEqual(state.inputs,[
    ...state.content.source_artifact_refs,
    ...state.content.artifact_refs,
  ]);
}

async function reachSystemGate(store,graph) {
  await runDesignCommand(
    parsed("prepare",["--from","design.json"]),
    services(store,designCommandInput({artifacts:graph})),
  );
  const approvals=approvalsFor(graph);
  const direction=designCommandInput({artifacts:graph,approvalRecords:[approvals[0]]});
  const pending=await runDesignCommand(
    parsed("approve",["--from","design.json"]),
    services(store,direction),
  );
  assert.equal(pending.state,"SYSTEM_PENDING");
  const approved=designCommandInput({artifacts:graph,approvalRecords:approvals});
  const result=await runDesignCommand(
    parsed("approve",["--from","design.json"]),
    services(store,approved),
  );
  assert.equal(result.state,"SYSTEM_APPROVED");
  assert.equal(result.ready_to_persist,true);
  return approved;
}

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
    {artifactStore:backing,authorityCapability},
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
  assertStateInputProjection((await backing.list({
    document_type:"design-orchestration-state",
  })).at(-1));

  const rerun=await runDesignCommand(
    parsed("prepare",["--from","design.json"]),
    services(backing,approved),
  );
  assert.deepEqual(await designRows(backing),afterResume);
  assert.deepEqual(rerun.artifact_revisions,resumed.artifact_revisions);

  const status=await runDesignCommand(
    parsed("status"),
    {artifactStore:backing,authorityCapability},
  );
  assert.equal(status.state,"FINAL_APPROVAL_PENDING");
  assert.equal(status.persisted.length,afterResume.length);
  assert.equal(status.payload_commitments.filter(row => row.status==="PERSISTED").length,
    afterResume.length);
  assert.ok(Object.isFrozen(status));
});

test("final persisted design state projects source and artifact references",async t => {
  const store=await commandStore(t);
  const graph=graphForLevel();
  const approved=await reachSystemGate(store,graph);
  await runDesignCommand(
    parsed("prepare",["--from","design.json","--json"]),
    services(store,approved),
  );
  await runDesignCommand(
    parsed("approve",["--from","design.json"]),
    services(store,designCommandInput({
      artifacts:graph,
      approvalRecords:[...approved.approval_records,finalApprovalFor(graph)],
    })),
  );
  const completeRows=await store.list();
  assertStateInputProjection(completeRows.filter(row =>
    row.document_type==="design-orchestration-state").at(-1));
});
