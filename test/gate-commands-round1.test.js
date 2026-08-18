import assert from "node:assert/strict";
import test from "node:test";

import { runArchitectureCommand } from "../src/commands/architecture.js";
import { runDecisionsCommand } from "../src/commands/decisions.js";
import { runIssuesCommand } from "../src/commands/issues.js";
import { runPlanCommand } from "../src/commands/plan.js";
import { runProjectCommand } from "../src/commands/project.js";
import { runReadinessCommand } from "../src/commands/readiness.js";
import { createGitHubWriter } from "../src/pipeline/github-writer.js";
import {
  captureWriterContext,
  clone,
  commandServices,
  countingAdapter,
  decisionAuthorityRegistry,
  memoryCommandStore,
  parsedCommand,
  prepareStore,
  projectCommandInput,
  publicationAuthorityRegistry,
  rehash,
  revisedSourceInput,
  signedAdrApproval,
  signedDecisionAnswer,
  signedPublicationApproval,
  twoPendingAdrInput,
  twoQuestionInput
} from "./support/gate-command-round1-fixture.js";

function reference(artifact) {
  return {
    document_type: artifact.document_type,
    artifact_id: artifact.artifact_id,
    revision: artifact.revision,
    content_sha256: artifact.content_sha256
  };
}

function gateServices(store, extra = {}) {
  return { artifactStore: store, ...extra };
}

function answerCommand(questionId) {
  return parsedCommand("decisions.answer", { from: "answer.json", nonInteractive: true, args: [questionId] });
}

function architectureCommand(adrId) {
  return parsedCommand("architecture.approve", {
    from: "approval.json",
    nonInteractive: true,
    args: [adrId]
  });
}

function parseWithArgument(name, argument, options = []) {
  const [family, action] = name.split(".");
  return (awaitImportParseCommand)([family, action, argument, ...options]);
}

function trappedCallable(counter) {
  return new Proxy(async () => undefined, {
    get() {
      counter.get += 1;
      throw new Error("callable proxy property trap executed");
    },
    apply() {
      counter.apply += 1;
      throw new Error("callable proxy apply trap executed");
    }
  });
}

// Kept local so the regression exercises the public parser rather than a test command clone.
import { parseCommand as awaitImportParseCommand } from "../src/commands/router.js";

test("gate service normalization rejects callable proxies before any get/apply trap", async () => {
  const ready = await prepareStore(projectCommandInput());
  const storeTrap = { get: 0, apply: 0 };
  const hostileStore = {
    append: trappedCallable(storeTrap),
    get: ready.store.get,
    list: ready.store.list,
    verify: ready.store.verify
  };

  await assert.rejects(
    runPlanCommand(parsedCommand("plan.show"), { artifactStore: hostileStore }),
    (error) => error?.code === "COMMAND_CONTEXT_INVALID" && /proxy|callable/i.test(error.message)
  );
  assert.deepEqual(storeTrap, { get: 0, apply: 0 });

  const readerTrap = { get: 0, apply: 0 };
  let storeReads = 0;
  const observedStore = {
    append: ready.store.append,
    get: ready.store.get,
    list: async (...args) => {
      storeReads += 1;
      return ready.store.list(...args);
    },
    verify: ready.store.verify
  };
  await assert.rejects(
    runDecisionsCommand(
      parseWithArgument("decisions.answer", "Q-001", ["--from", "answer.json", "--non-interactive"]),
      gateServices(observedStore, {
        readInput: trappedCallable(readerTrap),
        authorityRegistry: decisionAuthorityRegistry()
      })
    ),
    (error) => error?.code === "COMMAND_CONTEXT_INVALID" && /proxy|callable/i.test(error.message)
  );
  assert.deepEqual(readerTrap, { get: 0, apply: 0 });
  assert.equal(storeReads, 0, "hostile callable must be rejected before catalog access");

  const promptTrap = { get: 0, apply: 0 };
  await assert.rejects(
    runDecisionsCommand(
      parseWithArgument("decisions.answer", "Q-001"),
      gateServices(observedStore, {
        prompt: trappedCallable(promptTrap),
        authorityRegistry: decisionAuthorityRegistry()
      })
    ),
    (error) => error?.code === "COMMAND_CONTEXT_INVALID" && /proxy|callable/i.test(error.message)
  );
  assert.deepEqual(promptTrap, { get: 0, apply: 0 });

  const writerTrap = { get: 0, apply: 0 };
  await assert.rejects(
    runIssuesCommand(
      parsedCommand("issues.preview"),
      gateServices(observedStore, {
        repository: "acme/widgets",
        writer: {
          preview: trappedCallable(writerTrap),
          publish: async () => undefined
        }
      })
    ),
    (error) => error?.code === "COMMAND_CONTEXT_INVALID" && /proxy|callable/i.test(error.message)
  );
  assert.deepEqual(writerTrap, { get: 0, apply: 0 });
  assert.equal(storeReads, 0, "all hostile callables must fail before catalog access");
});

test("verified decision history composes multiple answers and advances the analysis state", async () => {
  const { store, result } = await prepareStore(twoQuestionInput());
  assert.equal(result.state, "QUESTIONS_PENDING");
  assert.equal(result.package.questions.length, 2);
  const [first, second] = result.package.questions;

  const firstResult = await runDecisionsCommand(
    parseWithArgument("decisions.answer", first.id, ["--from", "answer.json", "--non-interactive"]),
    gateServices(store, {
      authorityRegistry: decisionAuthorityRegistry(),
      readInput: async () => JSON.stringify(signedDecisionAnswer(first, { recordId: "ROUND1-FIRST" }))
    })
  );
  assert.equal(firstResult.resolved_gate.can_continue, false);
  let listed = await runDecisionsCommand(
    parsedCommand("decisions.list"),
    gateServices(store, { authorityRegistry: decisionAuthorityRegistry() })
  );
  assert.deepEqual(listed.questions.map((question) => question.answered), [true, false]);

  const secondResult = await runDecisionsCommand(
    parseWithArgument("decisions.answer", second.id, ["--from", "answer.json", "--non-interactive"]),
    gateServices(store, {
      authorityRegistry: decisionAuthorityRegistry(),
      readInput: async () => JSON.stringify(signedDecisionAnswer(second, { recordId: "ROUND1-SECOND" }))
    })
  );
  assert.equal(secondResult.resolved_gate.can_continue, true);
  listed = await runDecisionsCommand(
    parsedCommand("decisions.list"),
    gateServices(store, { authorityRegistry: decisionAuthorityRegistry() })
  );
  assert.deepEqual(listed.questions.map((question) => question.answered), [true, true]);
  assert.equal(listed.package.gate.can_continue, true);

  const transitions = await store.list({ document_type: "transition-event" });
  assert.equal(transitions.at(-1).content.state, "ARCHITECTURE_PENDING");
  assert.deepEqual(
    transitions.at(-1).inputs.filter((input) => input.document_type === "decision-answer"),
    [reference(firstResult.artifact), reference(secondResult.artifact)].sort((left, right) =>
      left.artifact_id.localeCompare(right.artifact_id))
  );

  const continued = await runProjectCommand(
    parsedCommand("project.prepare", { continue: true }),
    {
      ...commandServices(store, twoQuestionInput()),
      authorityRegistry: decisionAuthorityRegistry()
    }
  );
  assert.equal(continued.state, "READY_FOR_ISSUES");
  const readiness = await runReadinessCommand(
    parsedCommand("readiness.check"),
    gateServices(store, { authorityRegistry: decisionAuthorityRegistry() })
  );
  assert.equal(readiness.ready_for_issue_generation, true);
  assert.deepEqual(readiness.failures, []);
});

test("one canonical decision accepts an exact signed resolution for every retained source", async () => {
  const { store, result } = await prepareStore(twoQuestionInput({ deduplicated: true }));
  assert.equal(result.package.questions.length, 1);
  const question = result.package.questions[0];
  assert.deepEqual(question.source_ids, ["Q-001", "Q-002"]);

  const input = signedDecisionAnswer(question, { recordId: "ROUND1-DEDUP" });
  assert.deepEqual(input.authority_resolutions.map((entry) => entry.source_id), question.source_ids);
  const answered = await runDecisionsCommand(
    parseWithArgument("decisions.answer", question.id, ["--from", "answer.json", "--non-interactive"]),
    gateServices(store, {
      authorityRegistry: decisionAuthorityRegistry(),
      readInput: async () => JSON.stringify(input)
    })
  );
  assert.deepEqual(
    answered.artifact.content.authority_resolutions.map((entry) => entry.source_id),
    question.source_ids
  );
  assert.equal(answered.resolved_gate.can_continue, true);
});

test("verified ADR approvals compose across multiple pending ADRs and recover to READY", async () => {
  const input = twoPendingAdrInput();
  const { store, result } = await prepareStore(input);
  assert.equal(result.state, "ADR_PENDING_APPROVAL");
  assert.equal(result.package.adr_references.length, 2);

  const approved = [];
  for (const [index, adrRef] of result.package.adr_references.entries()) {
    const adr = await store.verify(adrRef);
    approved.push(await runArchitectureCommand(
      parseWithArgument("architecture.approve", adr.content.id, [
        "--from", "approval.json", "--non-interactive"
      ]),
      gateServices(store, {
        authorityRegistry: decisionAuthorityRegistry(),
        readInput: async () => JSON.stringify(signedAdrApproval(adr, result.package, {
          approvalId: `ROUND1-ADR-${index + 1}`
        }))
      })
    ));
  }

  const review = await runArchitectureCommand(
    parsedCommand("architecture.review"),
    gateServices(store, { authorityRegistry: decisionAuthorityRegistry() })
  );
  assert.equal(review.pending_adrs.length, 0);
  assert.equal(review.ready_for_pm_finalization, true);
  assert.deepEqual(review.approvals, approved.map((entry) => reference(entry.artifact)));

  const continued = await runProjectCommand(
    parsedCommand("project.prepare", { continue: true }),
    {
      ...commandServices(store, input),
      authorityRegistry: decisionAuthorityRegistry()
    }
  );
  assert.equal(continued.state, "READY_FOR_ISSUES");

  const recoveredReview = await runArchitectureCommand(
    parsedCommand("architecture.review"),
    gateServices(store, { authorityRegistry: decisionAuthorityRegistry() })
  );
  assert.deepEqual(recoveredReview.approvals, approved.map((entry) => reference(entry.artifact)));
  const adapter = countingAdapter();
  const writer = createGitHubWriter({
    adapter,
    store,
    authorityRegistry: publicationAuthorityRegistry()
  });
  const preview = await runIssuesCommand(
    parsedCommand("issues.preview"),
    gateServices(store, {
      repository: "acme/widgets",
      writer,
      authorityRegistry: decisionAuthorityRegistry()
    })
  );
  assert.equal(preview.mode, "preview");
  assert.equal(preview.operations.length, 1);
  assert.equal(adapter.calls.filter(([method]) => method !== "findByMarker").length, 0);
});

test("answer and ADR approval revisions are monotonic and parent the prior immutable record", async () => {
  const decisionInput = projectCommandInput({ blockingDecision: true });
  const decision = await prepareStore(decisionInput);
  const question = decision.result.package.questions[0];
  const firstAnswer = await runDecisionsCommand(
    parseWithArgument("decisions.answer", question.id, ["--from", "answer.json", "--non-interactive"]),
    gateServices(decision.store, {
      authorityRegistry: decisionAuthorityRegistry(),
      readInput: async () => JSON.stringify(signedDecisionAnswer(question, { recordId: "ROUND1-ANSWER-G1" }))
    })
  );
  const revisedDecision = revisedSourceInput(decisionInput, { updateQuestions: true });
  const decisionGeneration = await runProjectCommand(
    parsedCommand("project.prepare", { from: "project-r2.json" }),
    {
      ...commandServices(decision.store, revisedDecision),
      authorityRegistry: decisionAuthorityRegistry()
    }
  );
  assert.equal(decisionGeneration.state, "QUESTIONS_PENDING");
  const revisedQuestion = decisionGeneration.package.questions[0];
  const secondAnswer = await runDecisionsCommand(
    parseWithArgument("decisions.answer", revisedQuestion.id, [
      "--from", "answer-r2.json", "--non-interactive"
    ]),
    gateServices(decision.store, {
      authorityRegistry: decisionAuthorityRegistry(),
      readInput: async () => JSON.stringify(signedDecisionAnswer(revisedQuestion, {
        recordId: "ROUND1-ANSWER-G2"
      }))
    })
  );
  assert.equal(secondAnswer.artifact.revision, 2);
  assert.deepEqual(secondAnswer.artifact.parents, [reference(firstAnswer.artifact)]);

  const architectureInput = projectCommandInput({ pendingAdr: true });
  const architecture = await prepareStore(architectureInput);
  const adr = await architecture.store.verify(architecture.result.package.adr_references[0]);
  const firstApproval = await runArchitectureCommand(
    parseWithArgument("architecture.approve", adr.content.id, [
      "--from", "approval.json", "--non-interactive"
    ]),
    gateServices(architecture.store, {
      authorityRegistry: decisionAuthorityRegistry(),
      readInput: async () => JSON.stringify(signedAdrApproval(adr, architecture.result.package, {
        approvalId: "ROUND1-ADR-G1"
      }))
    })
  );
  const revisedArchitecture = revisedSourceInput(architectureInput);
  const architectureGeneration = await runProjectCommand(
    parsedCommand("project.prepare", { from: "project-r2.json" }),
    {
      ...commandServices(architecture.store, revisedArchitecture),
      authorityRegistry: decisionAuthorityRegistry()
    }
  );
  assert.equal(architectureGeneration.state, "ADR_PENDING_APPROVAL");
  const revisedAdr = await architecture.store.verify(
    architectureGeneration.package.adr_references[0]
  );
  const secondApproval = await runArchitectureCommand(
    parseWithArgument("architecture.approve", revisedAdr.content.id, [
      "--from", "approval-r2.json", "--non-interactive"
    ]),
    gateServices(architecture.store, {
      authorityRegistry: decisionAuthorityRegistry(),
      readInput: async () => JSON.stringify(signedAdrApproval(
        revisedAdr,
        architectureGeneration.package,
        { approvalId: "ROUND1-ADR-G2" }
      ))
    })
  );
  assert.equal(secondApproval.artifact.revision, 2);
  assert.deepEqual(secondApproval.artifact.parents, [reference(firstApproval.artifact)]);
});

test("real GitHub writer blocks independent gates before any adapter mutation", async () => {
  const { store } = await prepareStore(projectCommandInput());
  const ready = await captureWriterContext(store);
  const approval = signedPublicationApproval({
    repository: ready.repository,
    source_revision: ready.artifacts.issuePlan.provenance.source_revision,
    source_sha256: ready.artifacts.issuePlan.provenance.source_sha256,
    plan_ref: reference(ready.artifacts.issuePlan)
  });
  const blocked = [];

  const unresolved = clone(ready);
  unresolved.artifacts.pmAnalysis = twoQuestionInput().artifacts.pm_analysis;
  blocked.push(["unresolved P0-P2 decision", unresolved, approval]);

  const pendingAdr = clone(ready);
  pendingAdr.artifacts.architecture.adrs[0].content.status = "proposed";
  pendingAdr.artifacts.architecture.adrs[0].content.approval = {
    state: "pending", authority: "A3", decided_by: null, decided_at: null
  };
  rehash(pendingAdr.artifacts.architecture.adrs[0]);
  blocked.push(["pending ADR approval", pendingAdr, approval]);

  const failedAudit = clone(ready);
  failedAudit.artifacts.specAudits[0].content.status = "FAIL";
  failedAudit.artifacts.specAudits[0].content.ready_for_github = false;
  rehash(failedAudit.artifacts.specAudits[0]);
  blocked.push(["failed spec audit", failedAudit, approval]);

  const staleAudit = clone(ready);
  staleAudit.artifacts.specAudits[0].provenance.source_revision = "stale-source@1";
  blocked.push(["stale spec audit", staleAudit, approval]);

  const failedPdor = clone(ready);
  failedPdor.artifacts.traceGraph.nodes = [];
  failedPdor.artifacts.traceGraph.edges = [];
  blocked.push(["failed PDoR", failedPdor, approval]);

  for (const [label, context, authority] of blocked) {
    const adapter = countingAdapter();
    const writer = createGitHubWriter({
      adapter,
      store,
      authorityRegistry: publicationAuthorityRegistry()
    });
    await assert.rejects(writer.publish(context, { apply: true, authority }), undefined, label);
    assert.equal(adapter.calls.some(([method]) =>
      method === "createIssue" || method === "updateIssue"), false, label);
  }

  for (const [label, authority] of [
    ["missing publication approval", undefined],
    ["invalid publication approval", { approval_kind: "GITHUB_ISSUE_PUBLICATION" }],
    ["stale publication approval", signedPublicationApproval({
      repository: ready.repository,
      source_revision: "stale-source@1",
      source_sha256: "f".repeat(64),
      plan_ref: reference(ready.artifacts.issuePlan)
    })]
  ]) {
    const adapter = countingAdapter();
    const writer = createGitHubWriter({
      adapter,
      store,
      authorityRegistry: publicationAuthorityRegistry()
    });
    await assert.rejects(writer.publish(ready, { apply: true, authority }), undefined, label);
    assert.deepEqual(adapter.calls, [], label);
  }

  const appliedAdapter = countingAdapter();
  const appliedWriter = createGitHubWriter({
    adapter: appliedAdapter,
    store,
    authorityRegistry: publicationAuthorityRegistry()
  });
  const applied = await appliedWriter.publish(ready, { apply: true, authority: approval });
  assert.equal(applied.status, "complete");
  appliedAdapter.calls.length = 0;

  const replayContext = clone(ready);
  replayContext.repository = "acme/other";
  const replayApproval = signedPublicationApproval({
    repository: replayContext.repository,
    source_revision: ready.artifacts.issuePlan.provenance.source_revision,
    source_sha256: ready.artifacts.issuePlan.provenance.source_sha256,
    plan_ref: reference(ready.artifacts.issuePlan)
  }, { repository: replayContext.repository, record_id: approval.record_id });
  await assert.rejects(
    appliedWriter.publish(replayContext, { apply: true, authority: replayApproval }),
    /replay|conflict/i,
    "replayed publication approval"
  );
  assert.deepEqual(appliedAdapter.calls, [], "replayed publication approval");

  const conflictStore = {
    append: store.append,
    get: store.get,
    verify: store.verify,
    list: async (filter = {}) => {
      const rows = await store.list(filter);
      return filter.document_type === "github-publication-result" && rows.length > 0
        ? [...rows, clone(rows[0])]
        : rows;
    }
  };
  const conflictAdapter = countingAdapter();
  const conflictWriter = createGitHubWriter({
    adapter: conflictAdapter,
    store: conflictStore,
    authorityRegistry: publicationAuthorityRegistry()
  });
  await assert.rejects(
    conflictWriter.publish(ready, { apply: true, authority: approval }),
    /duplicate|conflict|history/i,
    "artifact store conflict"
  );
  assert.deepEqual(conflictAdapter.calls, [], "artifact store conflict");

  const discoveryAdapter = countingAdapter();
  const discoveryWriter = createGitHubWriter({
    adapter: discoveryAdapter,
    store: memoryCommandStore(),
    authorityRegistry: publicationAuthorityRegistry()
  });
  const preview = await discoveryWriter.preview(ready);
  const operation = preview.operations[0];
  const duplicate = {
    repository: operation.repository,
    marker: operation.marker,
    title: operation.title,
    body: operation.body,
    labels: operation.labels,
    milestone: operation.milestone,
    number: 77,
    url: "https://github.com/acme/widgets/issues/77"
  };
  const duplicateAdapter = countingAdapter({duplicates:[duplicate,{...duplicate,number:78,
    url:"https://github.com/acme/widgets/issues/78"}]});
  const duplicateWriter = createGitHubWriter({
    adapter: duplicateAdapter,
    store: memoryCommandStore(),
    authorityRegistry: publicationAuthorityRegistry()
  });
  await assert.rejects(
    duplicateWriter.publish(ready, { apply: true, authority: approval }),
    /duplicate|multiple|conflict/i,
    "remote marker duplicate"
  );
  assert.equal(duplicateAdapter.calls.some(([method]) =>
    method === "createIssue" || method === "updateIssue"), false,
  "remote marker duplicate");
});
