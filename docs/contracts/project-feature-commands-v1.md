# Project and Feature Commands v1

This document is the normative orchestration contract for the `project` and
`feature` lifecycle commands. It retains the ownership and transition rules in
`analysis-state-machine.md` and defines the decision-authority rules used by
these commands below.

## Decision severity, authority, and continuation

| Severity | Authority | Decision owner | Hard stop | Blocks while unresolved | Assumption evidence |
| --- | --- | --- | --- | --- | --- |
| `P0` | `A3` | `USER` | yes | yes | no |
| `P1` | `A2` | `ARCHITECT` | no | yes | no |
| `P1` with `business_input_missing: true` | `A3` | `USER` | no | yes | no |
| `P2` | `A3` | `USER` | no | yes | no |
| `P3` | `A1` | `PM` | no | no | required |
| `P4` | `A1` | `PM` | no | no | required |

Only the structured `business_input_missing: true` condition on a `P1`
question changes its default route. It is the sole route by which a technical
preference may escalate directly to `USER`. A technical preference on `P0` or
`P2` is invalid; one on `P3` or `P4` remains an A1 PM-owned assumption.

An unresolved `P0`–`P2` decision blocks continuation. Resolving one requires a
closed authority-resolution record with the exact mapped authority and owner,
plus a decision-bound authority attestation verified against the external
trusted authority registry. A3 routes use
`A3_VERIFIED_CEO_OR_USER_AUTHORITY` with a `CEO` or `USER` actor. The ordinary
P1 A2 route uses `A2_ARCHITECT_OR_SPECIALIST_EVIDENCE` with an `ARCHITECT` or
`SPECIALIST` actor. Ordinary provenance alone does not establish authority.

P3 and P4 never block or become authority attestations. They may continue only
as visible assumptions with provenance, material impact, and a valid
`reversible`, `partially-reversible`, or `irreversible` reversibility value.

## Input and service boundary

- `--from` reads a closed `project-command-input.v1` or
  `feature-command-input.v1` JSON/YAML value through an injected local reader.
- Interactive callers may inject a prompt function. A missing prompt is a
  deterministic invalid-input result. `--non-interactive` never invokes a
  prompt and missing input is nonzero.
- Programmatic services are closed to `artifactStore`, `readInput`, and
  `prompt`. Store access is closed to the public `list`, `get`, `verify`, and
  `append` operations. Accessors, proxies, exotic prototypes, sparse arrays,
  symbols, and extra service keys are invalid.
- These commands accept no GitHub client, writer, or adapter and perform no
  remote operation.

## Persistence and recovery

Project input and feature delta envelopes are immutable ACP artifacts. Every
artifact is schema-validated before append, resolved by an exact reference
through both `get` and `verify`, and verified again after append. List results
must have one unambiguous, contiguous identity history. Each command builds a
verified catalog from one canonical list snapshot per consistency boundary and
reuses each exact artifact within that catalog generation. A write command
rechecks the complete expected catalog after its append batch; feature commands
also take distinct pre- and post-base snapshots. Missing, conflicting, or
unexpected rows fail closed. A later snapshot is a canonical, schema-validated
full-row comparison with the already verified catalog, so unchanged exact
artifacts are not fetched and verified again.

`project resume` starts from the latest verified transition revision for the
exact source revision and hash. A verified `BLOCKED` state records the legal
`RESUME` transition and a verified `FAILED_RETRYABLE` state records `RETRY`
before work continues. Recovery state and evidence come from persisted,
verified history; invalid supplied evidence causes no append. Existing exact
revisions are reused, so retry after an interrupted append continues without
overwriting or forking persisted history.

## Project stop and next-command mapping

| State | Blocking owner | Next command |
| --- | --- | --- |
| `ANALYZING` | none | `project analyze` |
| `QUESTIONS_PENDING` | exact `next_action.owner` from the verified transition | `decisions list` |
| `USER_DECISION` | exact `next_action.owner` from the verified transition | `decisions list` |
| `ARCHITECTURE_PENDING` | none | `project prepare` |
| `ADR_PENDING_APPROVAL` | exact `next_action.owner` (`USER` for v1 ADR packages) | `architecture approve` |
| `PM_FINALIZATION` | none | `project prepare` |
| `SPEC_AUDIT` | none | `project prepare` |
| `READY_FOR_ISSUES` | none | `issues preview` |
| `BLOCKED` | exact `next_action.owner` from the verified transition | `project resume` |
| `FAILED_RETRYABLE` | none | `project resume` |
| `FAILED_TERMINAL` | none | none |

An unresolved P0–P2 decision stops with the exact decision package. A pending
ADR stops with the exact ADR approval package. Interactive callers receive the
package without invented answers or approvals; non-interactive callers receive
the same canonical package in structured data with the blocked exit code.
P3/P4 assumptions remain visible and never become authority attestations.

A `READY_FOR_ISSUES` result resolves exactly one spec-audit reference from the
verified READY transition. The audit must bind the exact issue-plan revision;
same-source searches and artifact-id guesses are not authority.

## Feature delta authority and identity

A feature delta is a non-authoritative impact artifact. Its closed content
records the complete exact `READY_FOR_ISSUES` base snapshot and declares
`authority: reference-only`. Its ACP `inputs` anchor the exact READY transition,
which transitively names the same base artifacts. The handler explicitly
verifies every recorded base reference before and after append and rejects a
newer base artifact, changed transition, or changed feature source as stale.
The immutable feature-source projection covers the request, impact,
requirements, architecture impact, issue-plan delta, and caller findings.
Those fields cannot drift under one source revision/hash. Stage-derived audit,
readiness, and next-command fields must equal their deterministic projection.
Feature status reconstructs that projection from the complete verified history
for the one selected feature identity; it never trusts persisted derived status
fields by themselves.

`architecture_impact.requires_adr: true` independently creates an
ARCHITECT-owned blocking finding until an exact approved feature ADR evidence
contract is introduced. Caller findings cannot override or suppress this gate.
Non-interactive blocked feature results retain the exact findings in structured
data and use exit code 4.

`feature add`, `feature analyze`, and `feature prepare` each append at most one
requested target revision. A direct prepare may therefore create a PREPARED
revision without synthetic intermediate writes. A compatible predecessor is
the exact parent; rerunning the same target reuses it. Feature commands never
rewrite project inputs, pipeline artifacts, transition state, decisions, ADRs,
or issue plans.

| Feature stage | Blocking owner | Next command |
| --- | --- | --- |
| `ADDED` | none | `feature analyze` |
| `ANALYZED` | none | `feature prepare` |
| `PREPARED` and ready | none | `issues preview` |
| `PREPARED` and blocked | first exact P0–P2 finding owner | `feature prepare` |
