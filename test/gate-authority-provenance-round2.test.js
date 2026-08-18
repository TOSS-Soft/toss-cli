import assert from "node:assert/strict";
import test from "node:test";

import { runArchitectureCommand } from "../src/commands/architecture.js";
import { runAuditCommand } from "../src/commands/audit.js";
import { runDecisionsCommand } from "../src/commands/decisions.js";
import { canonicalJson, sha256Canonical } from "../src/contracts/acp.js";
import { buildDecisionPackage } from "../src/pipeline/decisions.js";
import { parseCommand } from "../src/commands/router.js";
import {
  clone,
  decisionAuthorityRegistry,
  memoryCommandStore,
  prepareStore,
  projectCommandInput,
  rehash,
  signedAdrApproval,
  signedDecisionAnswer
} from "./support/gate-command-round1-fixture.js";
import { countedCommandStore } from "./support/command-fixture.js";

function reference(artifact) {
  return {
    document_type: artifact.document_type,
    artifact_id: artifact.artifact_id,
    revision: artifact.revision,
    content_sha256: artifact.content_sha256
  };
}

function sameReference(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function replaceReference(value, oldReference, newReference) {
  return sameReference(value, oldReference) ? clone(newReference) : clone(value);
}

async function authorityStore(seed, mutate, { includeFollowing = false } = {}) {
  const store = memoryCommandStore();
  const authorityIndex = seed.rows.findIndex((row) => row.document_type === seed.documentType);
  assert.notEqual(authorityIndex, -1, `${seed.documentType} seed must contain authority evidence`);

  for (const row of seed.rows.slice(0, authorityIndex)) {
    await store.append(row);
  }

  const original = seed.rows[authorityIndex];
  const tampered = clone(original);
  await mutate(tampered, seed);
  tampered.content_sha256 = sha256Canonical(tampered.content);
  await store.append(tampered);

  if (includeFollowing) {
    const oldAuthorityReference = reference(original);
    const newAuthorityReference = reference(tampered);
    const replacedTransitions = new Map();
    for (const source of seed.rows.slice(authorityIndex + 1)) {
      const row = clone(source);
      row.parents = row.parents.map((parent) => {
        const replacement = replacedTransitions.get(canonicalJson(parent));
        return replacement ? clone(replacement) : parent;
      });
      row.inputs = row.inputs.map((input) =>
        replaceReference(input, oldAuthorityReference, newAuthorityReference));
      if (row.document_type === "transition-event") {
        row.content.input_artifacts = row.content.input_artifacts.map((input) =>
          replaceReference(input, oldAuthorityReference, newAuthorityReference));
        row.content_sha256 = sha256Canonical(row.content);
        replacedTransitions.set(canonicalJson(reference(source)), reference(row));
      }
      await store.append(row);
    }
  }

  return { store, tampered };
}

async function decisionSeed() {
  const input = projectCommandInput({ blockingDecision: true });
  const pmReference = reference(input.artifacts.pm_analysis);
  input.artifacts.architecture.inputs = [pmReference];
  for (const adr of input.artifacts.adrs) {
    adr.inputs = [pmReference, reference(input.artifacts.architecture)];
  }
  input.artifacts.issue_plan.inputs = [
    pmReference,
    reference(input.artifacts.architecture),
    ...input.artifacts.adrs.map(reference)
  ];
  input.artifacts.issue_plan.content.input_snapshots = {
    pm_analysis: pmReference,
    architecture: reference(input.artifacts.architecture),
    adrs: input.artifacts.adrs.map(reference)
  };
  rehash(input.artifacts.issue_plan);
  const prepared = await prepareStore(input);
  const question = prepared.result.package.questions[0];
  const result = await runDecisionsCommand(
    parseCommand([
      "decisions", "answer", question.id, "--from", "answer.json", "--non-interactive"
    ]),
    {
      artifactStore: prepared.store,
      authorityRegistry: decisionAuthorityRegistry(),
      readInput: async () => JSON.stringify(signedDecisionAnswer(question, {
        recordId: "ROUND2-DECISION"
      }))
    }
  );
  const rows = await prepared.store.list({});
  const answer = rows.find((row) => row.document_type === "decision-answer");
  const transition = rows.find((row) =>
    row.document_type === "transition-event" &&
    sameReference(reference(row), answer.content.source_transition));
  const pm = rows.find((row) => row.document_type === "pm-analysis");
  return {
    documentType: "decision-answer",
    input,
    prepared,
    result,
    rows,
    answer,
    transition,
    pm
  };
}

async function adrSeed() {
  const input = projectCommandInput({ pendingAdr: true });
  const prepared = await prepareStore(input);
  const adr = await prepared.store.verify(prepared.result.package.adr_references[0]);
  const result = await runArchitectureCommand(
    parseCommand([
      "architecture", "approve", adr.content.id,
      "--from", "approval.json", "--non-interactive"
    ]),
    {
      artifactStore: prepared.store,
      authorityRegistry: decisionAuthorityRegistry(),
      readInput: async () => JSON.stringify(signedAdrApproval(
        adr,
        prepared.result.package,
        { approvalId: "ROUND2-ADR" }
      ))
    }
  );
  const rows = await prepared.store.list({});
  const approval = rows.find((row) => row.document_type === "adr-approval");
  const transition = rows.find((row) =>
    row.document_type === "transition-event" &&
    sameReference(reference(row), approval.content.source_transition));
  const pm = rows.find((row) => row.document_type === "pm-analysis");
  return {
    documentType: "adr-approval",
    input,
    prepared,
    result,
    rows,
    approval,
    transition,
    pm,
    adr
  };
}

function expectClosedHistory(error) {
  return Boolean(error && [5, 6].includes(error.exitCode));
}

function alternateDecisionSnapshots(row, registry) {
  const sources = row.content.source_decision_package.questions.flatMap((question) =>
    question.evidence.map((evidence) => {
      const { source_id: sourceId, ...source } = evidence;
      return { id: sourceId, ...clone(source) };
    }));
  sources[0].context = `${sources[0].context} Unrelated retained context.`;
  const sourcePackage = buildDecisionPackage(sources, registry);
  const bySource = new Map(row.content.authority_resolutions.map((resolution) => [
    resolution.source_id,
    resolution.authority_resolution
  ]));
  const resolvedPackage = buildDecisionPackage(sources.map((source) => ({
    ...source,
    status: "resolved",
    authority_resolution: clone(bySource.get(source.id))
  })), registry);
  return {
    sourcePackage,
    sourceQuestion: sourcePackage.questions.find((question) =>
      question.id === row.content.question_id),
    resolvedPackage
  };
}

test("decision history binds claimed transition, exact inputs, provenance, and snapshots", async (t) => {
  const seed = await decisionSeed();
  const registry = decisionAuthorityRegistry();
  const transitionReference = reference(seed.transition);
  const pmReference = reference(seed.pm);
  const cases = [
    ["nonexistent claimed transition", (row) => {
      row.content.source_transition = {
        document_type: "transition-event",
        artifact_id: "UNRELATED-TRANSITION",
        revision: 99,
        content_sha256: "a".repeat(64)
      };
    }],
    ["wrong-type claimed transition", (row) => {
      row.content.source_transition = pmReference;
      row.inputs = [pmReference];
    }],
    ["missing transition input", (row) => {
      row.inputs = [];
    }],
    ["extra transition input", (row) => {
      row.inputs = [transitionReference, pmReference];
    }],
    ["retargeted transition input", (row) => {
      row.inputs = [pmReference];
    }],
    ["duplicate transition input", (row) => {
      row.inputs = [transitionReference, transitionReference];
    }],
    ["source revision provenance", (row) => {
      row.provenance.source_revision = "unrelated-source@99";
    }],
    ["source location provenance", (row) => {
      row.provenance.locations = ["unrelated.md#answer:99"];
    }],
    ["embedded source package", (row) => {
      const snapshots = alternateDecisionSnapshots(row, registry);
      row.content.source_decision_package = snapshots.sourcePackage;
      row.content.source_decision_package_hash = sha256Canonical(snapshots.sourcePackage);
      row.content.source_question = snapshots.sourceQuestion;
      row.content.resolved_decision_package = snapshots.resolvedPackage;
    }],
    ["embedded source question", (row) => {
      row.content.source_question.context = "Unrelated question snapshot context.";
    }]
  ];

  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      const isolated = await authorityStore(seed, mutate);
      const counted = countedCommandStore(isolated.store);
      await assert.rejects(
        runDecisionsCommand(parseCommand(["decisions", "list"]), {
          artifactStore: counted.store,
          authorityRegistry: registry
        }),
        expectClosedHistory
      );
      assert.equal(counted.calls.append, 0, `${label} must not append`);
    });
  }
});

test("ADR history binds claimed transition, ordered inputs, provenance, and snapshots", async (t) => {
  const seed = await adrSeed();
  const registry = decisionAuthorityRegistry();
  const transitionReference = reference(seed.transition);
  const adrReference = reference(seed.adr);
  const pmReference = reference(seed.pm);
  const cases = [
    ["nonexistent claimed transition", (row) => {
      row.content.source_transition = {
        document_type: "transition-event",
        artifact_id: "UNRELATED-TRANSITION",
        revision: 99,
        content_sha256: "b".repeat(64)
      };
    }],
    ["wrong-type claimed transition", (row) => {
      row.content.source_transition = pmReference;
      row.inputs = [pmReference, adrReference];
    }],
    ["missing ADR input", (row) => {
      row.inputs = [transitionReference];
    }],
    ["extra authority input", (row) => {
      row.inputs = [transitionReference, adrReference, pmReference];
    }],
    ["retargeted ADR input", (row) => {
      row.inputs = [transitionReference, pmReference];
    }],
    ["duplicate transition input", (row) => {
      row.inputs = [transitionReference, transitionReference, adrReference];
    }],
    ["reordered exact inputs", (row) => {
      row.inputs = [adrReference, transitionReference];
    }],
    ["source revision provenance", (row) => {
      row.provenance.source_revision = "unrelated-source@99";
    }],
    ["source location provenance", (row) => {
      row.provenance.locations = ["unrelated.md#approval:99"];
    }],
    ["embedded approval package", (row) => {
      const alternate = clone(row.content.approval_package);
      alternate.adr_references.push(pmReference);
      const signed = signedAdrApproval(seed.adr, alternate, {
        approvalId: "ROUND2-ADR-ALTERNATE-PACKAGE"
      });
      const { schema_version: ignored, ...approvalRecord } = signed;
      void ignored;
      row.content.approval_package = alternate;
      row.content.approval_record = approvalRecord;
    }],
    ["embedded ADR snapshot", (row) => {
      const signed = signedAdrApproval(seed.pm, row.content.approval_package, {
        approvalId: "ROUND2-ADR-RETARGETED-SNAPSHOT"
      });
      const { schema_version: ignored, ...approvalRecord } = signed;
      void ignored;
      row.content.adr = pmReference;
      row.content.approval_record = approvalRecord;
    }]
  ];

  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      const isolated = await authorityStore(seed, mutate);
      const counted = countedCommandStore(isolated.store);
      await assert.rejects(
        runArchitectureCommand(parseCommand(["architecture", "review"]), {
          artifactStore: counted.store,
          authorityRegistry: registry
        }),
        expectClosedHistory
      );
      assert.equal(counted.calls.append, 0, `${label} must not append`);
    });
  }
});

test("downstream audit rejects tampered decision provenance before append", async () => {
  const seed = await decisionSeed();
  const isolated = await authorityStore(seed, (row) => {
    row.provenance.locations = ["unrelated.md#answer:99"];
  }, { includeFollowing: true });
  for (const artifact of [
    seed.input.artifacts.architecture,
    ...seed.input.artifacts.adrs,
    seed.input.artifacts.issue_plan
  ]) {
    await isolated.store.append(artifact);
  }
  const counted = countedCommandStore(isolated.store);

  await assert.rejects(
    runAuditCommand(parseCommand(["audit", "run"]), {
      artifactStore: counted.store,
      authorityRegistry: decisionAuthorityRegistry()
    }),
    expectClosedHistory
  );
  assert.equal(counted.calls.append, 0);
});
