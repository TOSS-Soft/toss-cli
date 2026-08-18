import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {
  approvalsFor,
  authorityRegistry,
  designCommandInput,
  DIRECTION_TYPES,
  graphForLevel,
  signedStageApproval,
} from "./support/design-command-fixture.js";

const runtimeModule=await import("../src/cli-lifecycle.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const createLifecycleRuntimeProvider=runtimeModule.createLifecycleRuntimeProvider;
const runLifecycleCommand=runtimeModule.runLifecycleCommand;
const cli=new URL("../bin/toss.js",import.meta.url).pathname;

async function temporaryRoot(t) {
  const root=await mkdtemp(join(tmpdir(),"toss-design-cli-runtime-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  return root;
}

test("the real binary exits four for a blocked design approval gate",async t => {
  const root=await temporaryRoot(t);
  const input=designCommandInput();
  const inputPath=join(root,"design.json");
  await writeFile(inputPath,JSON.stringify(input),"utf8");
  const child=spawnSync(process.execPath,[
    cli,"design","screens","--from",inputPath,"--non-interactive",
    "--project",root,"--json",
  ],{encoding:"utf8"});
  assert.equal(child.status,4,child.stdout || child.stderr);
  const result=JSON.parse(child.stdout);
  assert.equal(result.ok,true);
  assert.equal(result.data.blocked,true);
  assert.equal(result.data.command_exit_code,4);
});

test("standalone interactive design fails closed when no trusted runtime is configured",async t => {
  assert.equal(typeof runLifecycleCommand,"function");
  const root=await temporaryRoot(t);
  const dispatched=await runLifecycleCommand(
    ["design","init"],{root},
  );
  assert.equal(dispatched.exitCode,4);
  assert.equal(dispatched.result.ok,false);
  assert.equal(dispatched.result.error.code,"DESIGN_RUNTIME_REQUIRED");
});

test("runtime authority is constructor-bound and captured without reading accessors",async t => {
  let reads=0;
  const accessorConfiguration={prompt:async () => null};
  Object.defineProperty(accessorConfiguration,"authorityRegistry",{
    enumerable:true,
    get() {
      reads+=1;
      return authorityRegistry();
    },
  });
  assert.throws(
    () => createLifecycleRuntimeProvider(accessorConfiguration),
    /accessor, hidden, or unexpected property/,
  );
  assert.equal(reads,0);
  assert.throws(() => createLifecycleRuntimeProvider({
    authorityRegistry:{actors:[new Proxy(authorityRegistry().actors[0],{
      get() {
        reads+=1;
        return undefined;
      },
    })]},
    prompt:async () => null,
  }),/canonical JSON/);
  assert.equal(reads,0);

  const root=await temporaryRoot(t);
  const forged=Object.freeze({
    services:() => Object.freeze({
      authorityRegistry:authorityRegistry(),
      prompt:async () => designCommandInput(),
    }),
  });
  const dispatched=await runLifecycleCommand(
    ["design","init"],{root,runtimeProvider:forged},
  );
  assert.equal(dispatched.exitCode,4);
  assert.equal(dispatched.result.error.code,"DESIGN_RUNTIME_INVALID");
});

test("runtime-composed interactive CLI completes signed gates and never prompts automation",async t => {
  assert.equal(typeof createLifecycleRuntimeProvider,"function");
  assert.equal(typeof runLifecycleCommand,"function");
  const root=await temporaryRoot(t);
  const graph=graphForLevel();
  const direction=signedStageApproval(
    "VISUAL_DIRECTION",graph.filter(row => DIRECTION_TYPES.includes(row.document_type)),
  );
  const approved=approvalsFor(graph);
  const inputs=[
    designCommandInput({artifacts:graph}),
    designCommandInput({artifacts:graph,approvalRecords:[direction]}),
    designCommandInput({artifacts:graph,approvalRecords:approved}),
    designCommandInput({artifacts:graph,approvalRecords:approved}),
    designCommandInput({artifacts:graph,approvalRecords:approved}),
  ];
  let promptCalls=0;
  const runtimeProvider=createLifecycleRuntimeProvider({
    authorityRegistry:authorityRegistry(),
    prompt:async request => {
      assert.equal(request.kind,"design");
      promptCalls+=1;
      return inputs.shift();
    },
  });
  const invoke=args => runLifecycleCommand(args,{root,runtimeProvider});

  const directionGate=await invoke(["design","screens"]);
  assert.equal(directionGate.exitCode,4);
  assert.equal(directionGate.result.data.state,"DIRECTION_PENDING");
  const systemGate=await invoke(["design","approve"]);
  assert.equal(systemGate.exitCode,4);
  assert.equal(systemGate.result.data.state,"SYSTEM_PENDING");
  const systemApproved=await invoke(["design","approve"]);
  assert.equal(systemApproved.exitCode,0);
  assert.equal(systemApproved.result.data.state,"SYSTEM_APPROVED");
  const finalGate=await invoke(["design","prepare"]);
  assert.equal(finalGate.exitCode,4);
  assert.equal(finalGate.result.data.state,"FINAL_APPROVAL_PENDING");
  const complete=await invoke(["design","approve"]);
  assert.equal(complete.exitCode,0);
  assert.equal(complete.result.data.state,"APPROVED");
  assert.equal(promptCalls,5);

  const nonInteractive=await invoke([
    "design","prepare","--non-interactive",
  ]);
  assert.notEqual(nonInteractive.exitCode,0);
  assert.equal(promptCalls,5);
});
