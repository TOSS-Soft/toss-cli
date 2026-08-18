# Project and Feature Commands v1

This document is the normative orchestration contract for the `project` and
`feature` lifecycle commands. It extends, but does not change, the ownership,
transition, and authority rules in `analysis-state-machine.md` and
`authority-severity-mapping.md`.

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
must have one unambiguous, contiguous identity history.

`project resume` starts from the latest verified transition revision for the
exact source revision and hash. Existing exact revisions are reused. A retry
after an interrupted append therefore continues without overwriting or
forking persisted history.

## Project stop and next-command mapping

| State | Blocking owner | Next command |
| --- | --- | --- |
| `ANALYZING` | none | `project analyze` |
| `QUESTIONS_PENDING` | `USER` | `decisions list` |
| `USER_DECISION` | `USER` | `decisions list` |
| `ARCHITECTURE_PENDING` | none | `project prepare` |
| `ADR_PENDING_APPROVAL` | `USER` | `architecture approve` |
| `PM_FINALIZATION` | none | `project prepare` |
| `SPEC_AUDIT` | none | `project prepare` |
| `READY_FOR_ISSUES` | none | `issues preview` |
| `BLOCKED` | exact `next_action.owner` from the verified transition | `project resume` |
| `FAILED_RETRYABLE` | none | `project resume` |
| `FAILED_TERMINAL` | none | none |

An unresolved P0–P2 decision stops with the exact decision package. A pending
ADR stops with the exact ADR approval package. Interactive callers receive the
package without invented answers or approvals; non-interactive callers receive
the blocked exit code. P3/P4 assumptions remain warnings and never become
authority attestations.

## Feature delta authority and identity

A feature delta is a non-authoritative impact artifact. Its closed content
records the complete exact `READY_FOR_ISSUES` base snapshot and declares
`authority: reference-only`. Its ACP `inputs` anchor the exact READY transition,
which transitively names the same base artifacts. The handler explicitly
verifies every recorded base reference before and after append and rejects a
newer base artifact, changed transition, or changed feature source as stale.

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
