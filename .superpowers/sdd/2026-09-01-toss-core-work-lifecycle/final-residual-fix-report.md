# Work Lifecycle exceptional final residual fix report

Baseline: `99a2ffe53c26cb74078e28d3884e79e8250e99f2`

Commit subject: `fix(core): block unresolved epic mutations`

The worktree was clean and exactly at the required baseline before this user-authorized exceptional second final-fix wave. Package version remains `2.1.1`. The wave changes only the Epic mutation boundary, the stateful test fake, Epic lifecycle regressions, and this report; it adds no schema, grammar, release-program, live-adapter, environment/global/preload, or production-fake seam.

## RED evidence and root causes

### 1. Unresolved failed/partial receipts did not close the Epic mutation boundary

- A real runner/fake regression injected a deterministic failure after the managed child operation of public `epic prepare --apply`. The runner persisted a schema-valid failed receipt containing exactly the one actually completed managed-child operation, and public Epic status correctly showed `Blocked / RECONCILE_REQUIRED` plus that immutable completed-operation identity.
- RED retry output: `unresolved partial Epic preparation blocks a public apply before another intent or remote write` failed with `completed` and `0 !== 4`. The unresolved retry was accepted, persisted a second intent/receipt, and reached fake inspection/apply.
- A second real partial-acceptance matrix extended the existing Project-Done failure regression across prepare, approve, submit, and accept. RED output for prepare was `prepare: already-reconciled` and `0 !== 4`, proving the replay path could accept the mutation while the failed acceptance receipt remained unresolved.
- Root cause: `withReconciliation` projected the failed-receipt evidence only by setting `epic.drifted=true`. Approve, submit, and accept eventually consulted derived lifecycle state, but prepare had no corresponding transition assertion, and no shared Epic mutation boundary rejected unresolved evidence before replay/operation planning.

### 2. Existing DRAFT Epic PR updates did not apply `draft:false`

- A schema-valid fake-port operation seeded an exact existing DRAFT Epic PR at the current governed head/base. Public `epic submit --apply` then ran through the real operation runner and stateful fake.
- RED output: `public epic submit promotes an exact existing DRAFT pull request and status immediately composes READY` failed with `'DRAFT' !== 'READY'` even though the command had returned success and projected submitted Work/Project state.
- Root cause: the fake adapter's existing `work-pull-request` branch updated only `head_sha` and the pull-request revision. Unlike its create path, it ignored the requested `draft` boolean, leaving native and composed PR state DRAFT while cached Work/Project carried the submit transition.

## Fixes and GREEN evidence

### Shared Epic reconciliation gate

- `mutationSnapshot` is the single mutation boundary used by prepare, approve, submit, and accept. It validates ledger reconciliation evidence, projects it through the normal Work state derivation, and returns typed `CORE_BLOCKED` exit 4 with `Blocked / RECONCILE_REQUIRED` before immutable approval joins, replay decisions, operation construction, confirmation, intent persistence, inspection, or apply.
- Status remains read-only and continues to expose the unresolved receipt, intent binding, and actually completed operation IDs. Clearing remains limited to the pre-existing rule requiring a later validated completed explicit `sync` intent affecting the same work; this wave does not implement sync or ambient clearing.
- GREEN: the real partial-prepare retry and the four-command partial-acceptance matrix pass. Each command performs only its required snapshot read; control event counts and fake `inspect`/`apply` counts remain unchanged.

### Exact DRAFT-to-READY fake projection

- The fake existing-PR `work-pull-request` path now assigns `DRAFT` when `draft:true` and `READY` when `draft:false`, then advances the native pull-request revision and projects the supplied Epic Work evidence in the same operation. Existing exact repository/work identity, head branch, base, head SHA, and expected-revision checks remain in force.
- GREEN: public submit makes one DRAFT-to-READY transition. Immediate public status composes the native READY PR and reports the review-stage `In review` state; the composed Work and Project both retain `In review / EPIC_ACCEPTANCE_REQUIRED` authority evidence. An exact READY replay is write-free.
- Direct fake update regressions reject a wrong base and a stale head while leaving READY state and revision unchanged.

## Verification

- Focused residual set: 4/4 passed (partial prepare, DRAFT promotion, update conflicts, partial-acceptance four-command matrix).
- `node --test test/core-epic-lifecycle.test.js`: 46/46 passed.
- `node --test --test-reporter=dot test/core-*.test.js`: exit 0 across all affected Core/Foundation through Task 6 suites.
- `npm run test:fast`: exit 0.
- `npm run test:integration`: exit 0.
- `npm run test:e2e`: exit 0; manifest-owned Epic lifecycle entry passed 46/46.
- `node scripts/test-boundaries.mjs`: `Test boundary integrity: PASS`.
- `node scripts/test-manifest.mjs`: `Test manifest integrity: PASS`.
- `node --check` for all three changed JavaScript files, `git diff --check`, and exact package version assertion: passed.
- Explicit changed-production scans: only `src/core/commands/epic.js` changed; release/live/runtime scope, environment/global/preload seam, production fake seam, live/network adapter seam, and version/schema/release-file scans all passed.

## Files changed

- `src/core/commands/epic.js`
- `test/core-epic-lifecycle.test.js`
- `test/support/core-github-fixture.js`
- `.superpowers/sdd/2026-09-01-toss-core-work-lifecycle/final-residual-fix-report.md`

## Self-review

- The reconciliation change is deliberately Epic-only and shares one boundary across the four specified mutations; status composition and the general receipt algorithm are unchanged.
- The fake change is one assignment in the existing update path. No production module imports the fake.
- The failure injection exists only in the stateful test fake and models a real ordered partial prepare: the child is created and observed before the subsequent Epic operation fails.
- No release command, sync implementation, schema, CLI option, version change, external write, push, merge, publish, or GitHub mutation was introduced.
