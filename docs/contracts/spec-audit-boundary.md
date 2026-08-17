# Specification Audit Boundary

## Purpose

The Spec Auditor is a deterministic, provider-neutral, pre-code gate. It
checks whether an exact PM analysis, architecture/ADR set, and issue plan are
internally consistent and traceable before GitHub issue publication. It does
not write product intent, choose an architecture, finalize an issue, or repair
an input.

The normative contracts are:

- `finding.v1` for one owner-routed finding;
- `spec-audit.v1` for the immutable ACP audit artifact; and
- `auditSpecification({pmAnalysis, architecture, issuePlan})` for the pure
  runtime operation.

## Input Shape and Immutable Graph

`pmAnalysis` is one `pm-analysis.v1` ACP artifact. `issuePlan` is one
`issue-plan.v1` ACP artifact. The `architecture` argument is deliberately an
aggregate rather than a single artifact:

```js
{
  artifact: architectureV1Artifact,
  adrs: [adrV1Artifact, ...]
}
```

The aggregate is required because an architecture artifact does not embed the
complete ADR contents. Auditing only issue-plan ADR snapshots would prove that
a reference exists, but could not prove ADR completeness, approval,
requirement relevance, question resolution, or orphan status.

The auditor validates every input contract and content hash. It requires:

1. the architecture artifact to reference the exact PM revision and hash;
2. every ADR to reference the exact PM and architecture revisions and hashes;
3. the issue-plan envelope inputs to equal the exact PM, architecture, and ADR
   set;
4. `content.input_snapshots` to equal that same set; and
5. the audit artifact inputs to preserve PM, architecture, every audited ADR,
   and issue plan in deterministic order.

Missing, extra, duplicate, stale, or hash-mismatched revisions are blocking.
ADR order supplied by a caller is not meaningful; the auditor orders ADR
references by canonical artifact identity.

Programmatic values that are not canonical JSON, including prototype-bearing,
accessor, non-enumerable, sparse, cyclic, or unsupported values, are rejected
before audit execution. Valid JSON inputs are copied before analysis. The
auditor never freezes or otherwise changes the caller's objects.

## Deterministic Checks

The audit recomputes relationships rather than trusting summary fields. Its
checks include:

- functional and non-functional requirement-to-issue coverage;
- requirements mentioned by an issue but not verified by an acceptance
  criterion;
- acceptance-criterion ownership, back-links, and requirement targets;
- issue scope, acceptance criteria, Definition of Done, epic/standalone
  placement, source requirement or governance rationale, and required ADRs;
- ADR existence, approval/readiness through the upstream architecture
  contract, requirement relevance, resolved-question evidence, and orphan
  ADRs;
- orphan requirements, ADRs, and issues;
- duplicate identities and materially equal meanings within an ownership
  collection;
- dangling requirement, epic, issue, acceptance-criterion, ADR, and dependency
  references; and
- self or multi-issue dependency cycles.

An auditor finding reports a defect. It does not create a missing requirement,
ADR, issue, acceptance criterion, or dependency, and it does not rewrite an
existing one.

## Findings, Ordering, and Owners

Every `finding.v1` object contains:

- a deterministic `Q-AUDIT-*` identifier derived from canonical finding
  content;
- severity and stable type;
- the owner that can resolve it;
- a JSON-pointer path;
- at least one affected entity or artifact identity; and
- artifact/path/detail evidence.

Owners are routed as follows:

| Owner | Responsible input |
| --- | --- |
| `PM` | PM requirements, constraints, or business intent |
| `ARCHITECT` | architecture and ADR contents |
| `PM_FINALIZATION` | finalized issues, ACs, links, dependencies, and snapshots |
| `USER` | an explicitly user-authoritative decision when a later rule requires it |

Findings are deduplicated by canonical content and sorted by severity, type,
owner, path, affected identities, and evidence using code-unit ordering. The
result is independent of ambient locale behavior and caller ADR ordering.

## Status and GitHub Readiness

| Findings | Status | `ready_for_github` |
| --- | --- | --- |
| none | `PASS` | `true` |
| P3/P4 only | `WARN` | `true` |
| any P0/P1/P2 | `FAIL` | `false` |

`ready_for_github` is this contract's blocking-finding signal. It does not
authorize a remote write. Later publication policy may require `PASS` rather
than `WARN`, current artifact revisions, PDoR success, explicit `--apply`, and
verified authority.

The runtime returns a deeply frozen read model:

```js
{
  status,
  ready_for_github,
  findings,
  artifact
}
```

`artifact` is the complete `spec-audit.v1` ACP document. The top-level read
fields mirror its content for gate consumers; only the artifact is persisted.
Its deterministic metadata is derived from the audited issue-plan revision,
while producer identity is `spec-auditor` and provenance names the audit run.

## Role Boundary

The Spec Auditor may:

- validate and compare immutable inputs;
- compute findings and audit summaries; and
- emit a new spec-audit artifact.

The Spec Auditor must not:

- create, modify, delete, reprioritize, or reinterpret PM requirements;
- create, approve, reject, or change an ADR;
- create, split, merge, reorder, or change issues or acceptance criteria;
- infer missing links or silently repair stale snapshots; or
- access a model provider, network service, or GitHub mutation API.

Each finding is handed to its owner. That owner creates a new revision of the
owned artifact, after which the audit runs again against the new exact graph.

## Spec Audit Versus Superpowers Review

These controls occur at different lifecycle boundaries and neither replaces
the other.

| Control | Timing | Examines | Does not examine |
| --- | --- | --- | --- |
| Spec Audit | before coding and issue publication | requirements, architecture/ADRs, issue plan, ACs, references, dependencies, immutable revisions | implementation quality, runtime behavior, code tests, security of written code |
| Superpowers code review | after implementation changes exist | code behavior, tests, implementation quality, regressions, conformance to the approved task | whether an unaudited issue plan should have been published |

A passing code review cannot make a stale or incomplete specification safe.
A passing Spec Audit cannot prove that the later implementation is correct.
The delivery pipeline requires each control at its own boundary.
