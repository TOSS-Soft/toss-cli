import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import test from "node:test";

import {createArtifactStore} from "../src/artifacts/store.js";
import {
  appendArtifacts,
  clone,
  completeArtifacts,
  rehash,
} from "./support/trace-fixture.js";

const traceCommandModule=await import("../src/commands/trace.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});

const unavailable=async () => {
  throw new Error("runTraceCommand is unavailable");
};
const runTraceCommand=traceCommandModule.runTraceCommand ?? unavailable;
const TraceCommandError=traceCommandModule.TraceCommandError ?? Error;

const root=path.resolve(new URL("..",import.meta.url).pathname);
const cli=path.join(root,"bin","toss.js");

function runCli(args,cwd) {
  return spawnSync(process.execPath,[cli,...args],{cwd,encoding:"utf8"});
}

async function cliStore(t,artifacts=completeArtifacts()) {
  const directory=await mkdtemp(path.join(os.tmpdir(),"toss-trace-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  await appendArtifacts(createArtifactStore({root:directory}),artifacts);
  return directory;
}

function referenceKey(reference) {
  return [
    reference.document_type,
    reference.artifact_id,
    reference.revision,
    reference.content_sha256,
  ].join("|");
}

function fakeTraceStore({listResult,getResult,mutateArtifacts,verifyResult}={}) {
  const artifacts=completeArtifacts();
  mutateArtifacts?.(artifacts);
  const all=[
    artifacts.pmAnalysis,
    artifacts.architecture.artifact,
    ...artifacts.architecture.adrs,
    artifacts.issuePlan,
  ];
  const byReference=new Map(all.map(artifact => [referenceKey(artifact),artifact]));
  const calls={get:[],getObjects:[],verify:[],verifyObjects:[]};
  const resolve=(reference,override) => {
    const artifact=byReference.get(referenceKey(reference));
    if (!artifact) throw new Error(`Missing fake artifact ${referenceKey(reference)}`);
    if (override===undefined) return clone(artifact);
    return typeof override==="function" ? override(clone(artifact),reference) : override;
  };
  const store={
    async list() {
      if (listResult===undefined) return clone([artifacts.issuePlan]);
      return typeof listResult==="function" ? listResult(artifacts) : listResult;
    },
    async get(reference) {
      calls.getObjects.push(reference);
      calls.get.push(clone(reference));
      return resolve(reference,getResult);
    },
    async verify(reference) {
      calls.verifyObjects.push(reference);
      calls.verify.push(clone(reference));
      return resolve(reference,verifyResult);
    },
  };
  return {artifacts,calls,store};
}

test("trace command exposes the minimal trace command boundary",() => {
  assert.equal(typeof traceCommandModule.runTraceCommand,"function");
});

test("runTraceCommand returns a raw result plus the requested output format",async () => {
  const command=await runTraceCommand(["REQ-001","--json"],{
    artifacts:completeArtifacts(),
  });

  assert.equal(command.format,"json");
  assert.equal(command.result.schema_version,"trace-result.v1");
  assert.equal(Object.hasOwn(command.result,"data"),false);
  assert.equal(Object.isFrozen(command),true);
});

test("trace command rejects missing IDs, unknown options, and accessor contexts",async () => {
  await assert.rejects(runTraceCommand([],{
    artifacts:completeArtifacts(),
  }),/usage|entity/i);
  await assert.rejects(runTraceCommand(["REQ-001","--unknown"],{
    artifacts:completeArtifacts(),
  }),/unknown option/i);
  const context={};
  Object.defineProperty(context,"artifacts",{get() { return completeArtifacts(); }});
  await assert.rejects(runTraceCommand(["REQ-001"],context),/accessor|JSON/i);
});

test("store tracing verifies and gets the issue plan and every exact snapshot",async () => {
  const {calls,store}=fakeTraceStore();

  const command=await runTraceCommand(["REQ-001","--json"],{artifactStore:store});

  assert.equal(command.result.schema_version,"trace-result.v1");
  assert.equal(calls.verify.length,4);
  assert.equal(calls.get.length,4);
  assert.deepEqual(calls.verify,calls.get);
  assert.deepEqual(calls.verify.map(reference => reference.document_type).sort(),
    ["adr","architecture","issue-plan","pm-analysis"]);
  for (const [index,reference] of calls.verifyObjects.entries()) {
    assert.equal(Object.isFrozen(reference),true);
    assert.equal(Object.isFrozen(calls.getObjects[index]),true);
    assert.notStrictEqual(reference,calls.getObjects[index]);
  }
});

test("a store cannot retarget a mutable expected reference to an unlisted plan",async () => {
  const {artifacts,store}=fakeTraceStore();
  const baseGet=store.get;
  const baseVerify=store.verify;
  const hijack={...clone(artifacts.issuePlan),artifact_id:"HIJACK"};
  let receivedReference;
  store.verify=async reference => {
    if (reference.document_type!=="issue-plan") return baseVerify(reference);
    receivedReference=reference;
    reference.artifact_id="HIJACK";
    return clone(hijack);
  };
  store.get=async reference =>
    reference.artifact_id==="HIJACK" ? clone(hijack) : baseGet(reference);

  await assert.rejects(runTraceCommand(["REQ-001"],{artifactStore:store}),error =>
    error instanceof TraceCommandError && error.code==="TRACE_INPUT_INVALID",
  );
  assert.equal(receivedReference.artifact_id,"ISSUE-PLAN-001");
});

test("a store verification failure is a stable trace command failure",async () => {
  const {store}=fakeTraceStore();
  store.verify=async () => {
    throw new Error("verification refused");
  };

  await assert.rejects(runTraceCommand(["REQ-001"],{artifactStore:store}),error =>
    error instanceof TraceCommandError &&
    error.code==="TRACE_INPUT_INVALID" &&
    /verify|verification/i.test(error.message),
  );
});

test("store methods must be own enumerable data functions without getter reads",async () => {
  const base=fakeTraceStore().store;
  let getterReads=0;
  const accessorStore={get:base.get,verify:base.verify};
  Object.defineProperty(accessorStore,"list",{
    enumerable:true,
    get() {
      getterReads+=1;
      return base.list;
    },
  });
  const inheritedStore=Object.create(base);
  const hiddenStore={get:base.get,verify:base.verify};
  Object.defineProperty(hiddenStore,"list",{value:base.list,enumerable:false});
  const nonfunctionStore={...base,list:true};

  for (const store of [accessorStore,inheritedStore,hiddenStore,nonfunctionStore]) {
    await assert.rejects(runTraceCommand(["REQ-001"],{artifactStore:store}),error =>
      error instanceof TraceCommandError && error.code==="TRACE_STORE_INVALID",
    );
  }
  assert.equal(getterReads,0);
});

test("malformed store discovery values fail closed without accessor reads",async () => {
  let getterReads=0;
  const accessorArtifact={};
  Object.defineProperty(accessorArtifact,"artifact_id",{
    enumerable:true,
    get() {
      getterReads+=1;
      return "ISSUE-PLAN-001";
    },
  });
  const symbolic=[completeArtifacts().issuePlan];
  symbolic[0][Symbol("invalid")]=true;
  const sparse=[];
  sparse.length=1;
  const malformed=[{},sparse,[accessorArtifact],symbolic,new Date(),() => undefined];

  for (const listResult of malformed) {
    const {store}=fakeTraceStore({listResult});
    await assert.rejects(runTraceCommand(["REQ-001"],{artifactStore:store}),error =>
      error instanceof TraceCommandError && error.code==="TRACE_STORE_INVALID",
    );
  }
  assert.equal(getterReads,0);
});

test("verified and fetched artifacts must be canonical, exact, and identical",async () => {
  const malformed=[];
  const accessor={};
  Object.defineProperty(accessor,"content",{enumerable:true,get() {
    throw new Error("artifact getter must not run");
  }});
  malformed.push(
    {verifyResult:{}},
    {verifyResult:accessor},
    {verifyResult:artifact => ({...artifact,artifact_id:"FORGED"})},
    {getResult:artifact => ({...artifact,run_id:`${artifact.run_id}-different`})},
    {getResult:artifact => ({...artifact,invalid:Symbol("invalid")})},
  );

  for (const overrides of malformed) {
    const {store}=fakeTraceStore(overrides);
    await assert.rejects(runTraceCommand(["REQ-001"],{artifactStore:store}),error =>
      error instanceof TraceCommandError && error.code==="TRACE_INPUT_INVALID",
    );
  }
});

test("selected issue plans are fully valid and hash-authentic before nested reads",async t => {
  const cases={
    "schema-invalid content":issuePlan => {
      issuePlan.content.status="FORGED";
      rehash(issuePlan);
    },
    "content hash mismatch":issuePlan => {
      issuePlan.content.issues[0].meaning="Tampered after hashing.";
    },
  };

  for (const [name,mutate] of Object.entries(cases)) {
    await t.test(name,async () => {
      const {calls,store}=fakeTraceStore({
        mutateArtifacts:artifacts => mutate(artifacts.issuePlan),
      });
      await assert.rejects(runTraceCommand(["REQ-001"],{artifactStore:store}),error =>
        error instanceof TraceCommandError && error.code==="TRACE_INPUT_INVALID",
      );
      assert.equal(calls.verify.length,1);
      assert.equal(calls.get.length,1);
    });
  }
});

test("nested artifact references satisfy store-safe constraints before store calls",async t => {
  const cases={
    "path traversal artifact id":snapshot => {
      snapshot.artifact_id="../escape";
    },
    "contract-only colon artifact id":snapshot => {
      snapshot.artifact_id="urn:escape";
    },
    "unsupported revision width":snapshot => {
      snapshot.revision=1000000;
    },
    "non-lowercase hash":snapshot => {
      snapshot.content_sha256="A".repeat(64);
    },
    "wrong document type":snapshot => {
      snapshot.document_type="adr";
    },
  };

  for (const [name,mutate] of Object.entries(cases)) {
    await t.test(name,async () => {
      const {calls,store}=fakeTraceStore({
        mutateArtifacts:artifacts => {
          mutate(artifacts.issuePlan.content.input_snapshots.pm_analysis);
          rehash(artifacts.issuePlan);
        },
      });
      await assert.rejects(runTraceCommand(["REQ-001"],{artifactStore:store}),error =>
        error instanceof TraceCommandError && error.code==="TRACE_INPUT_INVALID",
      );
      assert.equal(calls.verify.length,1);
      assert.equal(calls.get.length,1);
    });
  }
});

test("duplicate immutable discovery identities fail independent of hash and order",async t => {
  const cases=[
    {name:"different hash forward",differentHash:true,reverse:false},
    {name:"different hash reversed",differentHash:true,reverse:true},
    {name:"exact duplicate",differentHash:false,reverse:false},
  ];

  for (const {name,differentHash,reverse} of cases) {
    await t.test(name,async () => {
      const {calls,store}=fakeTraceStore({
        listResult:artifacts => {
          const original=clone(artifacts.issuePlan);
          const duplicate=clone(original);
          if (differentHash) {
            duplicate.content.issues[0].meaning="Conflicting immutable revision.";
            rehash(duplicate);
          }
          return reverse ? [duplicate,original] : [original,duplicate];
        },
      });
      await assert.rejects(runTraceCommand(["REQ-001"],{artifactStore:store}),error =>
        error instanceof TraceCommandError &&
        error.code==="TRACE_STORE_INVALID" &&
        /duplicate.*discovery/i.test(error.message),
      );
      assert.equal(calls.verify.length,0);
      assert.equal(calls.get.length,0);
    });
  }
});

test("real CLI emits raw trace-result JSON and stable readable human output",async t => {
  const directory=await cliStore(t);

  const json=runCli(["trace","REQ-001","--json"],directory);
  assert.equal(json.status,0,json.stderr);
  const result=JSON.parse(json.stdout);
  assert.equal(result.schema_version,"trace-result.v1");
  assert.equal(result.document_type,"trace-result");
  assert.equal(Object.hasOwn(result,"data"),false);

  const human=runCli(["trace","REQ-001"],directory);
  assert.equal(human.status,0,human.stderr);
  assert.match(human.stdout,/Trace REQ-001 \[REQ\]/);
  assert.match(human.stdout,/Downstream/);
  assert.match(human.stdout,/ARCHQ-001/);
  assert.match(human.stdout,/Requirement coverage: 100\.00%/);
});

test("CLI trace failures are non-zero and JSON errors stay machine-readable",async t => {
  const missingDirectory=await cliStore(t);
  const missing=runCli(["trace","REQ-MISSING","--json"],missingDirectory);
  assert.notEqual(missing.status,0);
  const missingError=JSON.parse(missing.stderr);
  assert.equal(typeof missingError.error.code,"string");
  assert.match(missingError.error.message,/not found/i);

  const dangling=completeArtifacts();
  dangling.issuePlan.content.acceptance_criteria[0].verifies=[{
    kind:"requirement",
    id:"REQ-MISSING",
  }];
  rehash(dangling.issuePlan);
  const danglingDirectory=await cliStore(t,dangling);
  const invalid=runCli(["trace","REQ-001","--json"],danglingDirectory);
  assert.notEqual(invalid.status,0);
  assert.match(JSON.parse(invalid.stderr).error.message,/dangling/i);

  const orphanDirectory=await cliStore(t,completeArtifacts({orphanAdr:true}));
  const orphan=runCli(["trace","REQ-001","--json"],orphanDirectory);
  assert.notEqual(orphan.status,0);
  assert.match(JSON.parse(orphan.stderr).error.message,/orphan/i);
});
