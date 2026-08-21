import assert from "node:assert/strict";
import test from "node:test";

import {runProjectCommand} from "../src/commands/project.js";
import {
  commandServices as services,
  commandStore,
  parsedCommand as command,
  projectCommandInput as projectInput,
} from "./support/command-fixture.js";

test("project prepare persists a verified READY pipeline and reruns idempotently",async t => {
  const store=await commandStore(t);
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

test("resume starts at the last verified revision after append interruption",async t => {
  const store=await commandStore(t);
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
