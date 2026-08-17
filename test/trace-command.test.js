import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import test from "node:test";

import {createArtifactStore} from "../src/artifacts/store.js";
import {
  appendArtifacts,
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
