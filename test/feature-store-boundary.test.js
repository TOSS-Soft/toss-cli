import assert from "node:assert/strict";
import test from "node:test";

import {runFeatureCommand} from "../src/commands/feature.js";
import {runProjectCommand} from "../src/commands/project.js";
import {
  commandServices,
  commandStore,
  featureCommandInput,
  parsedCommand,
  projectCommandInput,
} from "./support/command-fixture.js";
import {artifactReference} from "./support/trace-fixture.js";

async function readyRealProject(t) {
  const store=await commandStore(t);
  const input=projectCommandInput();
  const prepared=await runProjectCommand(
    parsedCommand("project.prepare",{from:"project.json"}),
    commandServices(store,input),
  );
  assert.equal(prepared.state,"READY_FOR_ISSUES");
  return {store,prepared};
}

test("feature prepare recovers a real prepared store from interruption without ambiguous revision forks",async t => {
  const {store}=await readyRealProject(t);
  const input=featureCommandInput();
  await runFeatureCommand(
    parsedCommand("feature.add",{from:"feature.json"}),
    commandServices(store,input),
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
      commandServices(interrupted,input),
    ),
    /feature append interrupted/,
  );
  const resumed=await runFeatureCommand(
    parsedCommand("feature.prepare",{continue:true}),
    commandServices(store,input),
  );
  assert.equal(resumed.stage,"PREPARED");
  assert.ok(resumed.reused_revisions.length>0);
});

test("a prepared feature delta is verified in the real artifact store",async t => {
  const {store}=await readyRealProject(t);
  const result=await runFeatureCommand(
    parsedCommand("feature.prepare",{from:"feature.json"}),
    commandServices(store,featureCommandInput()),
  );
  const verified=await store.verify(artifactReference(result.artifact));
  assert.equal(verified.document_type,"feature-delta");
  assert.equal(verified.content.stage,"PREPARED");
  assert.equal(verified.content.base_project.authority,"reference-only");
});
