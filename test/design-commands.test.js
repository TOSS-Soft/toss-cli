import assert from "node:assert/strict";
import test from "node:test";

import {dispatchCommand,parseCommand} from "../src/commands/router.js";
import {sha256Canonical} from "../src/contracts/acp.js";
import {
  createLifecycleRuntimeProvider,
  lifecycleRuntimeServices,
} from "../src/cli-lifecycle.js";
import {commandStore,memoryCommandStore} from "./support/command-fixture.js";
import {
  approvalsFor,
  artifactReference,
  authorityRegistry,
  classificationInput,
  designCommandInput,
  DIRECTION_TYPES,
  finalApprovalFor,
  graphForLevel,
  signedStageApproval,
  SYSTEM_TYPES,
} from "./support/design-command-fixture.js";

const designModule=await import("../src/commands/design.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const runDesignCommand=designModule.runDesignCommand;
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

function withFinalApproval(graph,input) {
  return designCommandInput({
    artifacts:graph,
    approvalRecords:[...input.approval_records,finalApprovalFor(graph)],
  });
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

function rewrittenStateInputStore(delegate,rewrite) {
  const project=row => {
    const result=structuredClone(row);
    if (result.document_type==="design-orchestration-state") {
      result.inputs=rewrite(result);
    }
    return result;
  };
  return {
    append:delegate.append,
    get:async reference => project(await delegate.get(reference)),
    list:async filter => (await delegate.list(filter)).map(project),
    verify:async reference => project(await delegate.verify(reference)),
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

function graphWithForgedArtifactIdentities(graph) {
  const forged=[];
  const byType=new Map();
  for (const source of graph) {
    const artifact=structuredClone(source);
    artifact.artifact_id=`${artifact.document_type}:DESIGN-FORGED`;
    const remap=reference => artifactReference(byType.get(reference.document_type));
    artifact.parents=artifact.parents.map(remap);
    artifact.inputs=artifact.inputs.map(remap);
    if (artifact.document_type==="design-approval") {
      artifact.content.graph_manifest=forged.map(artifactReference).sort((left,right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)));
      artifact.content.graph_root_sha256=sha256Canonical(
        artifact.content.graph_manifest,
      );
    }
    artifact.content_sha256=sha256Canonical(artifact.content);
    forged.push(artifact);
    byType.set(artifact.document_type,artifact);
  }
  return forged;
}

function historyWithForgedCommitments(history,graph) {
  const byType=new Map(graph.map(row => [row.document_type,row]));
  const result=[];
  for (const source of history) {
    const artifact=structuredClone(source);
    artifact.content.payload_commitments=artifact.content.payload_commitments.map(row => {
      const candidate=byType.get(row.expected_document_type);
      return {
        ...row,
        expected_artifact_ref:artifactReference(candidate),
        payload_sha256:sha256Canonical(candidate),
        artifact_ref:row.artifact_ref===null ? null : artifactReference(candidate),
      };
    });
    artifact.content.artifact_refs=artifact.content.payload_commitments.filter(row =>
      row.artifact_ref!==null).map(row => row.artifact_ref);
    artifact.inputs=artifact.content.artifact_refs;
    artifact.parents=result.length===0 ? [] : [artifactReference(result.at(-1))];
    artifact.content_sha256=sha256Canonical(artifact.content);
    result.push(artifact);
  }
  return result;
}

function historyWithResignedCommitments(history,graph) {
  const selectedArtifacts=(kind) => kind==="VISUAL_DIRECTION" ?
    graph.filter(row => DIRECTION_TYPES.includes(row.document_type)) :
    kind==="DESIGN_SYSTEM" ?
      graph.filter(row => SYSTEM_TYPES.includes(row.document_type)) : graph;
  const remapped=historyWithForgedCommitments(history,graph);
  const result=[];
  for (const source of remapped) {
    const artifact=structuredClone(source);
    artifact.content.approvals=artifact.content.approvals.map(record =>
      signedStageApproval(record.approval_kind,selectedArtifacts(record.approval_kind),{
        design_id:record.design_id,
        source_revision:record.source_revision,
        source_sha256:record.source_sha256,
        recommended_level:record.recommended_level,
        effective_level:record.effective_level,
        from_level:record.from_level,
        to_level:record.to_level,
        record_id:record.record_id,
      }));
    artifact.parents=result.length===0 ? [] : [artifactReference(result.at(-1))];
    artifact.content_sha256=sha256Canonical(artifact.content);
    result.push(artifact);
  }
  return result;
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
  assertStateInputProjection(stateRows[0]);
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
      {artifactStore:store,authorityCapability},
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
    services(store,withFinalApproval(graph,approved)),
  );
  assert.equal(final.state,"APPROVED");
  assert.equal(final.gate,"COMPLETE");
  assert.ok(final.artifact_revisions.some(row => row.document_type==="design-approval"));
  const completeRows=await store.list();
  assertStateInputProjection(completeRows.filter(row =>
    row.document_type==="design-orchestration-state").at(-1));
  await assert.rejects(runDesignCommand(
    parsed("approve",["--from","design.json"]),
    services(store,withFinalApproval(graph,approved)),
  ),error => error?.code==="ILLEGAL_DESIGN_TRANSITION");
  assert.deepEqual(await store.list(),completeRows);

  const interactiveStore=await commandStore(t);
  const promptInput=designCommandInput({artifacts:graph});
  const prompted=await runDesignCommand(parsed("init"),{
    artifactStore:interactiveStore,
    prompt:async request => {
      assert.equal(request.kind,"design");
      return promptInput;
    },
    authorityCapability,
  });
  assert.equal(prompted.state,"DIRECTION_PENDING");
  await assert.rejects(
    runDesignCommand(parsed("init",["--non-interactive"]),{
      artifactStore:await commandStore(t),authorityCapability,
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

test("a raw caller registry cannot authorize a design gate",async t => {
  const store=await commandStore(t);
  const graph=graphForLevel();
  const rawServices=input => ({
    artifactStore:store,
    readInput:async () => JSON.stringify(input),
    authorityRegistry:authorityRegistry(),
  });
  await runDesignCommand(
    parsed("prepare",["--from","design.json"]),
    rawServices(designCommandInput({artifacts:graph})),
  );
  const before=await store.list();
  const direction=signedStageApproval(
    "VISUAL_DIRECTION",graph.filter(row => DIRECTION_TYPES.includes(row.document_type)),
  );
  await assert.rejects(runDesignCommand(
    parsed("approve",["--from","design.json"]),
    rawServices(designCommandInput({artifacts:graph,approvalRecords:[direction]})),
  ),error => new Set(["DESIGN_RUNTIME_REQUIRED","DESIGN_AUTHORITY_INVALID"]).has(
    error?.code,
  ));
  assert.deepEqual(await store.list(),before);

  let proxyReads=0;
  const forgedCapabilities=[Object.freeze({}),new Proxy({}, {
    get() {
      proxyReads+=1;
      return undefined;
    },
  })];
  for (const forgedCapability of forgedCapabilities) {
    await assert.rejects(runDesignCommand(
      parsed("approve",["--from","design.json"]),{
        artifactStore:store,
        readInput:async () => JSON.stringify(designCommandInput({
          artifacts:graph,approvalRecords:[direction],
        })),
        authorityCapability:forgedCapability,
      },
    ),error => error?.code==="DESIGN_RUNTIME_INVALID");
  }
  assert.equal(proxyReads,0);
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
      purpose:"The verified feature scope has no user-interface impact.",
      success_criteria:["No UI design artifact is required for this source revision."],
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

function approvalOfKind(kind,graph,overrides={}) {
  const types=kind==="VISUAL_DIRECTION" ? DIRECTION_TYPES : SYSTEM_TYPES;
  return signedStageApproval(
    kind,graph.filter(row => types.includes(row.document_type)),overrides,
  );
}

async function reachDirectionGate(store,graph) {
  return runDesignCommand(
    parsed("prepare",["--from","design.json"]),
    services(store,designCommandInput({artifacts:graph})),
  );
}

async function reachSystemPending(store,graph) {
  await reachDirectionGate(store,graph);
  const direction=approvalOfKind("VISUAL_DIRECTION",graph);
  const result=await runDesignCommand(
    parsed("approve",["--from","design.json"]),
    services(store,designCommandInput({artifacts:graph,approvalRecords:[direction]})),
  );
  return {direction,result};
}

test("approval history is an immutable ordered prefix with one expected transition",async t => {
  await t.test("cannot skip direction and system gates in one approval",async () => {
    const store=await commandStore(t);
    const graph=graphForLevel();
    await reachDirectionGate(store,graph);
    const before=await store.list();
    await assert.rejects(runDesignCommand(
      parsed("approve",["--from","design.json"]),
      services(store,designCommandInput({
        artifacts:graph,approvalRecords:approvalsFor(graph),
      })),
    ),error => error?.code==="ILLEGAL_DESIGN_TRANSITION");
    assert.deepEqual(await store.list(),before);
  });

  await t.test("cannot remove or replace an immutable approval",async () => {
    for (const replacement of [null,"DESIGN-VISUAL-DIRECTION-REPLACED"]) {
      const store=await commandStore(t);
      const graph=graphForLevel();
      const {direction}=await reachSystemPending(store,graph);
      const approvalRecords=replacement===null ? [] : [approvalOfKind(
        "VISUAL_DIRECTION",graph,{record_id:replacement},
      )];
      const before=await store.list();
      await assert.rejects(runDesignCommand(
        parsed("prepare",["--from","design.json"]),
        services(store,designCommandInput({artifacts:graph,approvalRecords})),
      ),error => error?.code==="ILLEGAL_DESIGN_TRANSITION");
      assert.deepEqual(await store.list(),before);
      assert.equal(direction.approval_kind,"VISUAL_DIRECTION");
    }
  });

  await t.test("cannot reorder an immutable approval history",async () => {
    const store=await commandStore(t);
    const graph=graphForLevel();
    const {direction}=await reachSystemPending(store,graph);
    const system=approvalOfKind("DESIGN_SYSTEM",graph);
    await runDesignCommand(
      parsed("approve",["--from","design.json"]),
      services(store,designCommandInput({
        artifacts:graph,approvalRecords:[direction,system],
      })),
    );
    const before=await store.list();
    await assert.rejects(runDesignCommand(
      parsed("prepare",["--from","design.json"]),
      services(store,designCommandInput({
        artifacts:graph,approvalRecords:[system,direction],
      })),
    ),error => error?.code==="ILLEGAL_DESIGN_TRANSITION");
    assert.deepEqual(await store.list(),before);
  });
});

test("design status rejects fabricated semantic completion, crypto, and no-op history",async t => {
  for (const kind of ["semantic","crypto","idempotence"]) {
    await t.test(kind,async () => {
      const store=await commandStore(t);
      const graph=graphForLevel();
      await reachDirectionGate(store,graph);
      const prior=(await store.list({document_type:"design-orchestration-state"})).at(-1);
      const forged=structuredClone(prior);
      forged.revision=2;
      forged.parents=[artifactReference(prior)];
      if (kind==="semantic") {
        forged.content.state="APPROVED";
        forged.content.gate="COMPLETE";
        forged.content.next_action={
          command:"toss design status",
          owner:"DESIGN_SPECIALIST",
          reason:"Fabricated completion.",
        };
      } else {
        if (kind==="crypto") {
          const direction=approvalOfKind("VISUAL_DIRECTION",graph);
          direction.signature=`${direction.signature.slice(0,-3)}A==`;
          forged.content.approvals=[direction];
          forged.content.state="SYSTEM_PENDING";
          forged.content.gate="DESIGN_SYSTEM_APPROVAL";
          forged.content.next_action={
            command:"toss design approve",
            owner:"USER",
            reason:"Fabricated signature.",
          };
        }
      }
      forged.content_sha256=sha256Canonical(forged.content);
      await store.append(forged);
      await assert.rejects(runDesignCommand(
        parsed("status"),{artifactStore:store,authorityCapability},
      ),error => new Set([
        "DESIGN_STATE_INVALID","DESIGN_AUTHORITY_INVALID","INPUT_STALE",
      ]).has(error?.code));
    });
  }
});

test("design status rejects signed approvals replayed onto different committed artifacts",async t => {
  const sourceStore=memoryCommandStore();
  const graph=graphForLevel();
  const approved=await reachSystemGate(sourceStore,graph);
  await runDesignCommand(
    parsed("prepare",["--from","design.json"]),services(sourceStore,approved),
  );
  await runDesignCommand(
    parsed("approve",["--from","design.json"]),
    services(sourceStore,withFinalApproval(graph,approved)),
  );
  const forgedGraph=graphWithForgedArtifactIdentities(graph);
  const sourceHistory=await sourceStore.list({
    document_type:"design-orchestration-state",
  });
  const forgedHistory=historyWithForgedCommitments(sourceHistory,forgedGraph);
  const maliciousStore=memoryCommandStore();
  for (const artifact of forgedGraph) await maliciousStore.append(artifact);
  for (const artifact of forgedHistory) await maliciousStore.append(artifact);

  await assert.rejects(runDesignCommand(
    parsed("status"),{
      artifactStore:maliciousStore,
      authorityCapability,
    },
  ),error => new Set([
    "DESIGN_AUTHORITY_INVALID","DESIGN_STATE_INVALID","INPUT_STALE",
  ]).has(error?.code));
});

test("design status rejects signed approvals replayed onto rewritten envelope dependencies",async () => {
  const sourceStore=memoryCommandStore();
  const graph=graphForLevel();
  const approved=await reachSystemGate(sourceStore,graph);
  await runDesignCommand(
    parsed("prepare",["--from","design.json"]),services(sourceStore,approved),
  );
  await runDesignCommand(
    parsed("approve",["--from","design.json"]),
    services(sourceStore,withFinalApproval(graph,approved)),
  );
  const rewrittenGraph=graph.map(source => ({
    ...structuredClone(source),
    parents:[],
    inputs:[],
  }));
  assert.equal(graph.reduce(
    (count,row) => count+row.parents.length+row.inputs.length,0,
  ),16);
  const sourceHistory=await sourceStore.list({
    document_type:"design-orchestration-state",
  });
  const rewrittenHistory=historyWithForgedCommitments(sourceHistory,rewrittenGraph);
  const maliciousStore=memoryCommandStore();
  for (const artifact of rewrittenGraph) await maliciousStore.append(artifact);
  for (const artifact of rewrittenHistory) await maliciousStore.append(artifact);

  await assert.rejects(runDesignCommand(
    parsed("status"),{
      artifactStore:maliciousStore,
      authorityCapability,
    },
  ),error => new Set([
    "DESIGN_AUTHORITY_INVALID","DESIGN_STATE_INVALID","INPUT_STALE",
  ]).has(error?.code));
});

test("design status rejects an authority-signed but dependency-invalid resolved graph",async () => {
  const sourceStore=memoryCommandStore();
  const graph=graphForLevel();
  const approved=await reachSystemGate(sourceStore,graph);
  await runDesignCommand(
    parsed("prepare",["--from","design.json"]),services(sourceStore,approved),
  );
  await runDesignCommand(
    parsed("approve",["--from","design.json"]),
    services(sourceStore,withFinalApproval(graph,approved)),
  );
  const rewrittenGraph=graph.map(source => ({
    ...structuredClone(source),parents:[],inputs:[],
  }));
  const sourceHistory=await sourceStore.list({
    document_type:"design-orchestration-state",
  });
  const rewrittenHistory=historyWithResignedCommitments(sourceHistory,rewrittenGraph);
  const maliciousStore=memoryCommandStore();
  for (const artifact of rewrittenGraph) await maliciousStore.append(artifact);
  for (const artifact of rewrittenHistory) await maliciousStore.append(artifact);

  await assert.rejects(runDesignCommand(
    parsed("status"),{artifactStore:maliciousStore,authorityCapability},
  ),error => error?.code==="INPUT_STALE");
});

test("design status rejects missing, extra, duplicate, and reordered state inputs",async t => {
  const sourceStore=memoryCommandStore();
  const graph=graphForLevel();
  const approved=await reachSystemGate(sourceStore,graph);
  await runDesignCommand(
    parsed("prepare",["--from","design.json"]),services(sourceStore,approved),
  );
  await runDesignCommand(
    parsed("approve",["--from","design.json"]),
    services(sourceStore,withFinalApproval(graph,approved)),
  );
  const history=await sourceStore.list({document_type:"design-orchestration-state"});
  const latestRevision=history.at(-1).revision;
  const variants={
    missing:row => row.revision===latestRevision ? row.inputs.slice(1) : row.inputs,
    extra:row => row.revision===latestRevision ?
      [...row.inputs,artifactReference(history[0])] : row.inputs,
    duplicate:row => row.revision===latestRevision ?
      [...row.inputs,row.inputs[0]] : row.inputs,
    reordered:row => row.revision===latestRevision ? [...row.inputs].reverse() : row.inputs,
    cleared:() => [],
  };
  for (const [name,rewrite] of Object.entries(variants)) {
    await t.test(name,async () => {
      await assert.rejects(runDesignCommand(
        parsed("status"),{
          artifactStore:rewrittenStateInputStore(sourceStore,rewrite),
          authorityCapability,
        },
      ),error => new Set(["DESIGN_STATE_INVALID","INPUT_STALE"]).has(error?.code));
    });
  }

  const rootStore=memoryCommandStore();
  const rootGraph=graphForLevel("NOT_APPLICABLE");
  const rootInput=designCommandInput({
    artifacts:rootGraph,
    classification:classificationInput({
      delivery_targets:["API","CLI","BACKEND"],
      affected_surfaces:[],risk_signals:[],
      source:"NOT_APPLICABLE",
      purpose:"The verified feature scope has no user-interface impact.",
      success_criteria:["No UI design artifact is required for this source revision."],
    }),
  });
  await runDesignCommand(
    parsed("prepare",["--from","design.json"]),services(rootStore,rootInput),
  );
  await t.test("root",async () => {
    await assert.rejects(runDesignCommand(
      parsed("status"),{
        artifactStore:rewrittenStateInputStore(rootStore,() => []),
        authorityCapability,
      },
    ),error => new Set(["DESIGN_STATE_INVALID","INPUT_STALE"]).has(error?.code));
  });
});

test("every design approval gate dispatches as structured blocked exit four",async t => {
  const store=await commandStore(t);
  const graph=graphForLevel();
  const dispatched=await dispatchCommand(
    parsed("screens",["--from","design.json","--non-interactive"]),
    {services:services(store,designCommandInput({artifacts:graph}))},
  );
  assert.equal(dispatched.exitCode,4);
  assert.equal(dispatched.result.ok,true);
  assert.equal(dispatched.result.data.blocked,true);
  assert.equal(dispatched.result.data.command_exit_code,4);
});
