# TOSS Core Bootstrap Snapshot Validation Repair Design

- **Date:** 2026-09-01
- **Status:** Approved for implementation planning
- **Parent design:** `docs/superpowers/specs/2026-08-31-toss-core-organizational-lifecycle-design.md`
- **Affected package:** `@toss-software/cli`
- **Affected executable:** `toss-core`
- **Foundation baseline:** `e2918229a4b1e397da66ace583d8facf6a5cbf06`

## Executive Decision

TOSS Core will replace its distributed bootstrap checks with one closed,
revision-pinned ledger validation pipeline. The pipeline will validate the
repository-supplied root snapshot before reading any field, classify bootstrap
state from both the immutable root tree and the current pinned tree, prove an
exact root bootstrap when present, and validate every current intent and receipt
before any public reader returns a value.

The repair does not add a marker file, change a persisted schema, migrate an
existing control repository, bump the package version, or widen the shipped
runtime boundary. It closes the existing five-document first-commit contract.

## Problem Statement

The Foundation implementation correctly pins bootstrap proof to a reachable Git
root commit, but three trust-boundary gaps remain:

1. `loadBootstrapState()` can return `null` before current receipt records pass
   the shared validator. A bootstrap-shaped transaction added after an unrelated
   root can therefore be treated as absent instead of corrupt.
2. A root containing only part of the bootstrap surface, such as
   `config/organization.yaml`, can be classified as no bootstrap. Once any
   control material exists, an incomplete root must be corruption, not absence.
3. The value returned by the repository's `rootSnapshotAt()` port is inspected
   before it is closed as ordinary own data. Accessors, proxies, symbols, hidden
   fields, and malformed arrays can execute code or escape stable error typing.

These are one architectural issue: callers can branch on partially trusted
bootstrap state before one authoritative snapshot validator has completed.

## Goals

1. Validate every root-snapshot port result without invoking user-controlled
   getters or proxy traps.
2. Distinguish exactly two successful states: a genuinely empty/unrelated
   control history or one exact, proven root bootstrap.
3. Treat partial, late, duplicated, or malformed bootstrap material as
   `CONTROL_LEDGER_CONFLICT`.
4. Validate current intent and receipt records at the same captured revision
   before `loadBootstrapState()`, `loadOrganizationState()`, `findReceipt()`, or
   repository-registration recovery returns.
5. Preserve a legitimate root bootstrap across later configuration, intent,
   receipt, and program commits.
6. Preserve all existing Foundation security, CAS, hook, path, packaging, and
   CLI guarantees.

## Non-Goals

- Adding a bootstrap marker or another persisted document.
- Changing the five-document root transaction or the seven-operation bootstrap
  intent.
- Migrating a malformed or historically unrelated repository into a valid
  control repository.
- Adding a recovery command; reconciliation remains the response to corruption.
- Claiming protection from hostile parent-directory swaps beyond the approved
  portable `lstat` and no-follow contract.
- Adding GitHub access, credentials, environment injection, or a live network
  dependency.

## Invariants

### Revision pinning

Every validation starts by capturing one exact 40-character control-repository
revision. Root discovery, root-tree reads, current intent enumeration, current
receipt enumeration, and all related document reads use that revision or its
uniquely reachable root. No step re-reads ambient `HEAD`.

### Closed root snapshot

`rootSnapshotAt({at})` remains the repository port. Its untrusted result is
accepted only when all of these conditions hold:

- the root value is an ordinary or null-prototype non-proxy object;
- its only own keys are enumerable data properties `revision` and `paths`;
- it has no symbols, accessors, or hidden properties;
- `revision` is one lowercase 40-character Git SHA;
- `paths` is a dense, ordinary, non-proxy array whose only own keys are the
  enumerable data indices `0..length-1` and the standard non-enumerable data
  property `length`; it has no symbols, accessors, or extra hidden properties;
- every path is a safe repository-relative string;
- paths are strictly raw-code-point sorted and globally unique.

Validation checks proxy identity and property descriptors before reading values.
It returns a new deeply frozen copy. Repository errors and malformed values are
wrapped as `CONTROL_LEDGER_CONFLICT` without leaking an untyped provider error.

### Bootstrap classification

The known control surface is any path at or below `config/`, `policies/`,
`programs/`, `intents/`, `receipts/`, or `migrations/`.

A pinned ledger can be successfully classified only as:

- `absent`: neither the root tree nor the current pinned tree contains a known
  control-surface path; or
- `verified`: the uniquely reachable root contains exactly the five canonical
  bootstrap documents and they pass the existing exact bootstrap proof.

If either tree contains known control material and the root is not an exact
bootstrap, validation throws `CONTROL_LEDGER_CONFLICT`. This includes an
organization-only root, a bootstrap-shaped second commit after an unrelated
root, missing policies, extra root files under the control surface, and a late
bootstrap intent or receipt.

Unrelated root files such as `README.md` are permitted only while the current
tree also contains no control material. They do not establish initialization.

### Exact root bootstrap

A verified root contains exactly:

```text
config/organization.yaml
policies/lifecycle.yaml
policies/release.yaml
intents/<year>/<month>/<bootstrap-intent-id>.json
receipts/<year>/<month>/<bootstrap-receipt-id>.json
```

The existing proof remains normative:

- one canonical `init` intent with explicit authority;
- the organization, policy revision, control repository, and Project identity
  are bound exactly;
- seven canonical operations are present in canonical order;
- the completed receipt binds the intent hash and observes exactly the three
  remote bootstrap operations;
- the organization registry is empty at the root;
- root intent and receipt paths match their immutable identities.

Later revisions must retain byte-equivalent root intent and receipt documents.
Later ordinary receipts do not receive the bootstrap observation exception.

### Current ledger validation

One internal `loadValidatedLedgerAt(revision)`-style boundary performs the
following sequence:

1. normalize and classify the root snapshot;
2. enumerate current known control paths at `revision`;
3. load current intents and receipts at `revision` with global identity checks;
4. prove and bind the root bootstrap record when classification is `verified`;
5. require at most one receipt per intent;
6. validate every receipt's intent identity and canonical intent hash;
7. allow reduced observation coverage only for the exact immutable root
   bootstrap receipt;
8. require every other completed receipt to observe every intent operation
   exactly once; failed receipts may retain partial evidence;
9. return a deeply frozen validated result or throw
   `CONTROL_LEDGER_CONFLICT`.

There is no early `null` return between these steps.

## Public Reader Semantics

### `loadBootstrapState()`

Captures one revision and calls the shared validator. It returns `null` only for
the validated `absent` state. It returns the verified root bootstrap plus the
current revision for `verified`. Any partial or late control state conflicts.

### `loadOrganizationState()`

Uses the same validated ledger result before assembling the organization,
repositories, policies, programs, and receipts. It cannot accept a receipt that
`findReceipt()` rejects.

### `findReceipt()` and recovery

Exact receipt lookup uses the same pinned validated records and bootstrap
classification. Repository-registration recovery consumes that exact result;
it does not run a weaker or second receipt validator.

### Write paths

`commitBootstrap()` remains unborn-only and exact. `commitReceipt()` continues
to reject a second receipt for an intent with `CONTROL_LEDGER_CONFLICT` and
never grants the bootstrap exception. The repair does not change Git CAS or
hook publication behavior.

## Error Model

- Malformed port output: `CONTROL_LEDGER_CONFLICT`.
- Ambiguous or unreachable root history: `CONTROL_LEDGER_CONFLICT`.
- Partial or late bootstrap/control material: `CONTROL_LEDGER_CONFLICT`.
- Missing, duplicated, mismatched, or incomplete persisted receipt evidence:
  `CONTROL_LEDGER_CONFLICT`.
- An unborn repository remains the only pre-bootstrap state represented by a
  `null` head. A born but unrelated repository may be read as `absent` only
  while no known control material exists anywhere in the pinned tree.

Existing CLI mapping continues to expose control-ledger conflicts as exit code
6 and stable JSON error output.

## Test Strategy

### Closed snapshot boundary

- Reject root objects with getters, setters, symbols, hidden fields, proxy
  wrappers, wrong prototypes, extra keys, or malformed SHA values.
- Reject proxy, sparse, accessor-backed, symbolic, hidden, duplicated,
  unsorted, or unsafe `paths` arrays.
- Prove getters and proxy traps are not invoked.
- Wrap repository-thrown errors as `CONTROL_LEDGER_CONFLICT`.

### State classification

- Empty/unborn state remains valid.
- An unrelated `README.md` root with no current control material is `absent`.
- Organization-only, policy-only, intent-only, receipt-only, program-only, and
  migration-only control roots conflict.
- An unrelated root followed by an exact bootstrap-shaped later commit
  conflicts in every public reader.
- Current control material added after an unrelated root conflicts even when it
  contains no receipt.

### Bootstrap continuity

- An exact root bootstrap is accepted.
- Exact bootstrap receipt lookup succeeds.
- Later valid configuration, intent, receipt, and program commits preserve the
  root proof.
- A later bootstrap-shaped intent cannot borrow the root exception.
- Mutation or removal of the root intent/receipt in the current tree conflicts.

### Receipt agreement

- `loadBootstrapState()`, `loadOrganizationState()`, `findReceipt()`, and
  repository-registration recovery agree on valid and corrupt fixtures.
- Duplicate receipt IDs and multiple receipt IDs for one intent conflict.
- Ordinary completed receipts, including ordinary `init`, require full exact
  observation coverage.
- Failed receipts retain valid partial or empty evidence.

### Regression gates

The repair must pass the six focused Foundation suites, fast, integration,
e2e, package, full, boundary-integrity, syntax, diff, packed-inventory, and
production URL/token scans. Tests remain hermetic and perform no live GitHub
mutation.

## Compatibility and Rollout

The repair changes no command, JSON schema, file layout, package version, or
public exit-code assignment. A repository previously accepted only because it
contained partial or late bootstrap material will now fail closed and require
reconciliation. A valid control repository created by `commitBootstrap()`
continues to work across all later commits.

The Foundation plan remains unaccepted until this repair passes an independent
task review and a fresh whole-Foundation review. Work-lifecycle, release,
reconciliation-actions, and cutover implementation remain blocked until that
gate is clean.
