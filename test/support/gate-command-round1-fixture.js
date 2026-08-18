import { createHash, createPrivateKey, createPublicKey, sign as signDetached } from "node:crypto";

import { canonicalJson, sha256Canonical } from "../../src/contracts/acp.js";
import { authorityAttestationSigningPayload } from "../../src/pipeline/decisions.js";
import { runIssuesCommand } from "../../src/commands/issues.js";
import {
  commandServices,
  memoryCommandStore,
  parsedCommand,
  projectCommandInput
} from "./command-fixture.js";
import { clone, rehash } from "./trace-fixture.js";

const PRIVATE_KEY = createPrivateKey(`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICMMwUatUwxz9nHC1Z8Ycl5we3pAdGkWjX497KGuvT2y
-----END PRIVATE KEY-----`);
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2EfZW/G5ES5AjZflH3kWHqXYeKTS9/7qQ1QklZtMGzc=
-----END PUBLIC KEY-----`;

export { clone, rehash, commandServices, memoryCommandStore, parsedCommand, projectCommandInput };

export function decisionAuthorityRegistry() {
  return { actors: [{
    actor_id: "verified-user",
    actor_role: "USER",
    public_key: PUBLIC_KEY,
    allowed_routes: [{
      authority: "A3",
      verification_kind: "A3_VERIFIED_CEO_OR_USER_AUTHORITY"
    }]
  }] };
}

export function publicationAuthorityRegistry() {
  const cached = publicationAuthorityRegistry.cached;
  if (cached) {
    return cached;
  }

  const unsigned = {
    schema_version: "github-publication-authority-registry.v1",
    registry_id: "toss-round1-publication-authorities",
    revision: 1,
    actors: [{
      actor_id: "verified-publisher",
      actor_role: "USER",
      public_key: PUBLIC_KEY,
      public_key_fingerprint: createHash("sha256").update(createPublicKey(PUBLIC_KEY).export({
        type: "spki",
        format: "der"
      })).digest("hex"),
      allowed_publications: [{
        approval_kind: "GITHUB_ISSUE_PUBLICATION",
        repository: "acme/widgets"
      }, {
        approval_kind: "GITHUB_ISSUE_PUBLICATION",
        repository: "acme/other"
      }]
    }, {
      actor_id: "verified-user",
      actor_role: "USER",
      public_key: PUBLIC_KEY,
      public_key_fingerprint: createHash("sha256").update(createPublicKey(PUBLIC_KEY).export({
        type: "spki",
        format: "der"
      })).digest("hex"),
      allowed_publications: [],
      allowed_routes: [{
        authority: "A3",
        verification_kind: "A3_VERIFIED_CEO_OR_USER_AUTHORITY"
      }]
    }]
  };
  const registry = { ...unsigned, content_sha256: sha256Canonical(unsigned) };
  publicationAuthorityRegistry.cached = registry;
  return registry;
}

export function signedPublicationApproval(preview, overrides = {}) {
  const recordId = overrides.record_id ?? "PUB-APPROVAL-ROUND1";
  const unsigned = {
    approval_kind: "GITHUB_ISSUE_PUBLICATION",
    actor_id: "verified-publisher",
    actor_role: "USER",
    repository: overrides.repository ?? preview.repository,
    source_revision: overrides.source_revision ?? preview.source_revision,
    source_sha256: overrides.source_sha256 ?? preview.source_sha256,
    issue_plan: overrides.issue_plan ?? preview.plan_ref,
    record_id: recordId,
    record_revision: 1,
    record_sha256: sha256Canonical({ record_id: recordId, revision: 1 }),
    timestamp: "2026-08-18T12:00:00.000Z"
  };
  return {
    ...unsigned,
    signature: signDetached(null, Buffer.from(canonicalJson({
      domain: "toss.github-issue-publication.authority-approval.v1",
      ...unsigned
    }), "utf8"), PRIVATE_KEY).toString("base64")
  };
}

function authorityForQuestion(question) {
  const retained = question.evidence ?? [];
  return retained.map((evidence) => {
    const requiredAuthority = evidence.authority ?? question.authority;
    return {
      source_id: evidence.source_id,
      required_authority: requiredAuthority,
      provenance: clone(evidence.provenance)
    };
  });
}

export function signedDecisionAnswer(question, { recordId = "ANSWER-ROUND1", customValue } = {}) {
  const answer = customValue === undefined
    ? { kind: "selected-option", option_id: question.options[0].id }
    : { kind: "custom-answer", value: customValue };
  const decision = customValue ?? question.options[0].label;
  const authorityResolutions = authorityForQuestion(question).map((source) => {
    const resolution = {
      decision,
      rationale: "The verified user selected the exact product option for this source question.",
      authority: source.required_authority,
      owner: "USER",
      provenance: clone(source.provenance)
    };
    const attestation = {
      verification_kind: "A3_VERIFIED_CEO_OR_USER_AUTHORITY",
      actor_id: "verified-user",
      actor_role: "USER",
      record_id: `${recordId}-${source.source_id}`,
      record_revision: 1,
      record_sha256: sha256Canonical({ record_id: `${recordId}-${source.source_id}`, revision: 1 }),
      timestamp: "2026-08-18T10:00:00.000Z"
    };
    const payload = authorityAttestationSigningPayload({
      source_id: source.source_id,
      decision: resolution.decision,
      rationale: resolution.rationale,
      authority: resolution.authority,
      owner: resolution.owner,
      ...attestation
    });
    return {
      source_id: source.source_id,
      authority_resolution: {
        ...resolution,
        authority_attestation: {
          ...attestation,
          signature: signDetached(null, Buffer.from(canonicalJson(payload), "utf8"), PRIVATE_KEY)
            .toString("base64")
        }
      }
    };
  });
  return {
    schema_version: "decision-answer-input.v1",
    answer,
    authority_resolutions: authorityResolutions
  };
}

export function signedAdrApproval(adr, pendingPackageRef, { approvalId = "ADR-APPROVAL-ROUND1" } = {}) {
  const unsigned = {
    approval_kind: "ADR_APPROVAL",
    authority: "A3",
    verification_kind: "A3_VERIFIED_CEO_OR_USER_AUTHORITY",
    actor_id: "verified-user",
    actor_role: "USER",
    source_revision: adr.provenance.source_revision,
    source_sha256: adr.provenance.source_sha256,
    adr: {
      document_type: adr.document_type,
      artifact_id: adr.artifact_id,
      revision: adr.revision,
      content_sha256: adr.content_sha256
    },
    approval_package: clone(pendingPackageRef),
    record_id: approvalId,
    record_revision: 1,
    record_sha256: sha256Canonical({ record_id: approvalId, revision: 1 }),
    timestamp: "2026-08-18T10:05:00.000Z"
  };
  return {
    schema_version: "adr-approval-input.v1",
    ...unsigned,
    signature: signDetached(null, Buffer.from(canonicalJson({
      domain: "toss.adr-approval.authority-attestation.v1",
      ...unsigned
    }), "utf8"), PRIVATE_KEY).toString("base64")
  };
}

export function twoQuestionInput({ deduplicated = false } = {}) {
  const input = projectCommandInput({ blockingDecision: true });
  const first = input.artifacts.pm_analysis.content.open_questions[0];
  const second = clone(first);
  second.id = "Q-002";
  if (!deduplicated) {
    second.meaning = "Whether the rollout must include a separate recovery window";
    second.question = "Should rollout include a separate recovery window?";
  }
  input.artifacts.pm_analysis.content.open_questions.push(second);
  const enrichment = clone(input.artifacts.decision_enrichments[0]);
  enrichment.question_id = second.id;
  enrichment.id = second.id;
  delete enrichment.question_id;
  input.artifacts.decision_enrichments.push(enrichment);
  rehash(input.artifacts.pm_analysis);
  const pmReference = exactReference(input.artifacts.pm_analysis);
  input.artifacts.architecture.inputs = [pmReference];
  for (const adr of input.artifacts.adrs) {
    adr.inputs = [pmReference, exactReference(input.artifacts.architecture)];
  }
  input.artifacts.issue_plan.inputs = [
    pmReference,
    exactReference(input.artifacts.architecture),
    ...input.artifacts.adrs.map(exactReference)
  ];
  input.artifacts.issue_plan.content.input_snapshots = {
    pm_analysis: pmReference,
    architecture: exactReference(input.artifacts.architecture),
    adrs: input.artifacts.adrs.map(exactReference)
  };
  rehash(input.artifacts.issue_plan);
  return input;
}

export function twoPendingAdrInput() {
  const input = projectCommandInput({ pendingAdr: true });
  const first = input.artifacts.adrs[0];

  const second = clone(first);
  second.artifact_id = "ADR-ARTIFACT-002";
  second.content.id = "ADR-002";
  second.content.meaning = "Recovery rollout boundary decision";
  second.content.decision = "Retain an explicit recovery boundary for rollout";
  second.content.rationale = "Recovery behavior remains independently observable.";
  rehash(second);
  input.artifacts.adrs.push(second);

  const issuePlan = input.artifacts.issue_plan;
  const pmReference = issuePlan.content.input_snapshots.pm_analysis;
  const architectureReference = issuePlan.content.input_snapshots.architecture;
  const firstReference = {
    document_type: first.document_type,
    artifact_id: first.artifact_id,
    revision: first.revision,
    content_sha256: first.content_sha256
  };
  const secondReference = {
    document_type: second.document_type,
    artifact_id: second.artifact_id,
    revision: second.revision,
    content_sha256: second.content_sha256
  };
  issuePlan.inputs = [
    pmReference,
    architectureReference,
    firstReference,
    secondReference
  ];
  issuePlan.content.input_snapshots.adrs = [firstReference, secondReference];
  issuePlan.content.issues[0].adr_refs.push({ kind: "adr", id: second.content.id });
  rehash(issuePlan);
  return input;
}

function exactReference(artifact) {
  return {
    document_type: artifact.document_type,
    artifact_id: artifact.artifact_id,
    revision: artifact.revision,
    content_sha256: artifact.content_sha256
  };
}

export function revisedSourceInput(value, { updateQuestions = false } = {}) {
  const input = clone(value);
  const sourceRevision = "project-brief-r2";
  const sourceSha256 = "c".repeat(64);
  input.created_at = "2026-08-18T13:00:00.000Z";
  input.run_id = "run-project-command-002";
  input.provenance = {
    ...input.provenance,
    source_revision: sourceRevision,
    source_sha256: sourceSha256
  };
  const artifacts = [
    input.artifacts.pm_analysis,
    input.artifacts.architecture,
    ...input.artifacts.adrs,
    input.artifacts.issue_plan
  ];
  const prior = new Map(artifacts.map((artifact) => [artifact.artifact_id, exactReference(artifact)]));
  for (const artifact of artifacts) {
    artifact.revision = 2;
    artifact.parents = [prior.get(artifact.artifact_id)];
    artifact.run_id = `${artifact.run_id}:source-r2`;
    artifact.provenance = {
      ...artifact.provenance,
      source_revision: sourceRevision,
      source_sha256: sourceSha256
    };
  }
  const pm = input.artifacts.pm_analysis;
  for (const question of pm.content.open_questions) {
    question.provenance.source_revision = sourceRevision;
    question.provenance.source_sha256 = sourceSha256;
  }
  if (updateQuestions && pm.content.open_questions[0]) {
    pm.content.open_questions[0].rationale =
      `${pm.content.open_questions[0].rationale} Reconfirmed for source revision 2.`;
  }
  rehash(pm);
  const architecture = input.artifacts.architecture;
  architecture.inputs = [exactReference(pm)];
  for (const adr of input.artifacts.adrs) {
    adr.inputs = [exactReference(pm), exactReference(architecture)];
  }
  const issuePlan = input.artifacts.issue_plan;
  issuePlan.inputs = [
    exactReference(pm),
    exactReference(architecture),
    ...input.artifacts.adrs.map(exactReference)
  ];
  issuePlan.content.input_snapshots = {
    pm_analysis: exactReference(pm),
    architecture: exactReference(architecture),
    adrs: input.artifacts.adrs.map(exactReference)
  };
  rehash(issuePlan);
  return input;
}

export async function prepareStore(input) {
  const store = memoryCommandStore();
  const services = commandServices(store, input, { readInput: async () => canonicalJson(input) });
  const result = await (await import("../../src/commands/project.js")).runProjectCommand(
    parsedCommand("project.prepare", { from: "project-input.json" }),
    services,
  );
  return { store, services, result };
}

export async function captureWriterContext(store, commandId = "issues.preview") {
  let captured;
  const writer = {
    async preview(context) {
      captured = clone(context);
      const issuePlan = context.artifacts.issuePlan;
      return {
        schema_version: "github-publication-preview.v1",
        document_type: "github-publication-preview",
        mode: "preview",
        repository: context.repository,
        source_revision: issuePlan.provenance.source_revision,
        source_sha256: issuePlan.provenance.source_sha256,
        issue_plan: {
          document_type: issuePlan.document_type,
          artifact_id: issuePlan.artifact_id,
          revision: issuePlan.revision,
          content_sha256: issuePlan.content_sha256
        },
        operations: []
      };
    },
    async publish() {
      throw new Error("capture writer publish must not be called");
    }
  };
  await runIssuesCommand(
    parsedCommand(commandId),
    { artifactStore: store, repository: "acme/widgets", writer }
  );
  return captured;
}

export function countingAdapter({ duplicates = [] } = {}) {
  const calls = [];
  const remote = clone(duplicates);
  const adapter = {
    calls,
    remote,
    async findByMarker(marker) {
      calls.push(["findByMarker", marker]);
      return clone(remote.filter((issue) => issue.marker === marker));
    },
    async createIssue(payload) {
      calls.push(["createIssue", clone(payload)]);
      const number = remote.length + 1;
      const issue = {
        ...clone(payload),
        number,
        url: `https://github.com/acme/widgets/issues/${number}`
      };
      remote.push(issue);
      return clone(issue);
    },
    async updateIssue(number, payload) {
      calls.push(["updateIssue", number, clone(payload)]);
      const index = remote.findIndex((issue) => issue.number === number);
      if (index < 0) {
        throw new Error("remote issue missing");
      }
      remote[index] = { ...remote[index], ...clone(payload) };
      return clone(remote[index]);
    }
  };
  return adapter;
}

export function executableDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
