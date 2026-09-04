# TOSS Core Work Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the organization-level feature, epic, issue, dependency, branch, pull-request, and review lifecycle with exact Project status and gate derivation.

**Architecture:** Pure domain modules derive identity, branch/base relationships, dependency readiness, status, gates, and review freshness from a normalized GitHub snapshot. Command handlers translate those decisions into the deterministic intents defined in plan 1. The GitHub gateway remains injected and is exercised with a stateful fake; the live adapter and event reconciler arrive in plan 4.

**Tech Stack:** Node.js 20+ ESM, `node:test`, Ajv 2020 JSON Schema, existing core intent/authority/control-store foundation.

**Spec:** `docs/superpowers/specs/2026-08-31-toss-core-organizational-lifecycle-design.md`

**Plan sequence:** 2 of 5. Requires the completion gate in `2026-09-01-toss-core-foundation.md`; continue with `2026-09-01-toss-core-release-program.md`.

## Execution Notes

Foundation was accepted on 2026-09-01 at `6e9b370930b9fa6ea5b2b7a2292ea30c823ff357`. Work Lifecycle must build from this exact candidate or a descendant that contains it. The package version remains `2.1.1`; `feature add` never selects a release or version.

**Global Constraints:**

- `feature add` creates exactly one unversioned Epic in the TOSS OS Project; it does not select a release or version.
- Every epic and issue reserves a deterministic branch identity immediately, but no remote branch exists until the item is Ready.
- Enforce only these Git relationships: issue to epic, epic to same-repository release, release to default branch; a bounded bug targets its patch release. Cross-repository edges affect scheduling only.
- Preserve native issue state as Open until the governing PR merges. Project fields `Status`, `Gate`, repository, parent, milestone, branch, base branch, and last reconciled are machine-owned.
- Require authority records for `epic approve` and `epic accept`; acceptance can never waive dependencies, current-head review, required checks, or repository rules.
- Preserve human PR-body content outside one valid managed review block. Reject missing/duplicate/corrupt markers and stale reviewed SHAs.

## File Structure

- Create `contracts/core/work-item.v1.schema.json`, `epic-plan.v1.schema.json`, `dependency-edge.v1.schema.json`, and `review-result.v1.schema.json`.
- Create `src/core/domain/identity.js`, `branching.js`, `dependencies.js`, `state.js`, and `review.js` for pure rules.
- Create `src/core/work/epic-plan.js` and `src/core/work/operations.js` for decomposition and intent operations.
- Create `src/core/review/body.js` and `src/core/review/recorder.js` for current PR details and immutable history.
- Create `src/core/commands/feature.js`, `epic.js`, `issue.js`, `dependency.js`, and `review.js`.
- Create `test/support/core-github-fixture.js` as a stateful fake implementing the plan 1 GitHub port.
- Create `test/core-branching.test.js`, `core-dependencies.test.js`, `core-state.test.js`, `core-work-commands.test.js`, `core-review.test.js`, and `core-epic-lifecycle.test.js`.
- Modify `src/contracts/schema-catalog.js`, `src/core/commands/router.js`, `scripts/test-manifest.json`, and `scripts/test-boundaries.json`.

### Task 1: Define work-item contracts, identity, and branch/base rules

**Files:**

- Create: `contracts/core/work-item.v1.schema.json`
- Create: `contracts/core/epic-plan.v1.schema.json`
- Create: `contracts/core/dependency-edge.v1.schema.json`
- Create: `contracts/core/review-result.v1.schema.json`
- Modify: `src/contracts/schema-catalog.js`
- Create: `src/core/domain/identity.js`
- Create: `src/core/domain/branching.js`
- Create: `test/core-branching.test.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `workItemId(repository, issueNumber): string` returns `OWNER/REPO#NUMBER`.
- `reserveBranch({kind, number, title}): string` returns `epic/`, `issue/`, or `bug/` identity.
- `requiredBaseBranch(item, context): string|null` returns the exact same-repository parent branch or `null` while unplanned.
- `assertValidPullRequestTarget({headRepository, baseRepository, head, base, expectedBase}): true` fails closed on `main` or cross-repository issue/epic targets.

- [ ] Write `test/core-branching.test.js` for Unicode title normalization, repeated deterministic reservation, collisions after slug truncation, epic/issue/bug names, unplanned `null` base, issue-to-epic, epic-to-release, bug-to-patch, release-to-main, direct-to-main rejection, and cross-repository base rejection.
- [ ] Run `node --test test/core-branching.test.js` and verify the missing module failure.
- [ ] Add all four schema rows to the catalog in stable ASCII order. Close every object and enumerate `kind`, `status`, `gate`, review verdict, freshness, finding severity, and dependency kind.
- [ ] Implement stable identity and a lowercase ASCII branch slug. Normalize Unicode with NFKD, remove combining marks, convert non-alphanumerics to one hyphen, trim, cap at 48 characters, and use `item-${number}` when no letters or digits remain.

```js
export function reserveBranch({kind,number,title}) {
  const prefix={epic:"epic",issue:"issue",bug:"bug"}[kind];
  if (!prefix || !Number.isSafeInteger(number) || number<1) {
    throw new CoreValidationError("CORE_BRANCH_INPUT_INVALID","Invalid branch identity input");
  }
  return `${prefix}/${number}-${branchSlug(title,number)}`;
}
```

- [ ] Implement `requiredBaseBranch` from normalized item relationships, never from a title or milestone label. For an epic require `release.branch`; for a child require `parent.branch`; for a bug require `patch_release.branch`.
- [ ] Implement exact PR-target validation and return conflict exit 6 when an existing PR has a different base.
- [ ] Add the test to `fast`, run it with core contract tests, and commit.

```bash
git add contracts/core src/contracts/schema-catalog.js src/core/domain test/core-branching.test.js scripts/test-manifest.json
git commit -m "feat(core): define work identities and branch hierarchy"
```

### Task 2: Validate dependency DAGs and build native epic plans

**Files:**

- Create: `src/core/domain/dependencies.js`
- Create: `src/core/work/epic-plan.js`
- Create: `test/core-dependencies.test.js`
- Create: `test/fixtures/core/epic-plan-valid.json`
- Create: `test/fixtures/core/epic-plan-cycle.json`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `validateDependencyGraph({nodes, edges}): {order, stages, edges}` rejects self-reference, dangling nodes, duplicate edges, and cycles.
- `dependencyReadiness(itemId, graph, completedIds): {ready, blocking}` returns all incomplete mandatory targets.
- `normalizeEpicPlan({epic, children, dependencies, source}): EpicPlan` produces native-child operations and provenance.
- `epicPreparationOperations(plan, snapshot): Operation[]` reconciles rather than duplicates native subissues.

- [ ] Write pure graph tests for a chain, diamond, duplicate edge, self-edge, dangling target, cycle path reporting, and a cross-repository edge that orders stages but does not generate a Git base.
- [ ] Write epic-plan tests requiring each child to have one repository, explicit acceptance criteria, native parent identity, reserved branch, no milestone, and a source revision/hash.
- [ ] Run `node --test test/core-dependencies.test.js` and verify the missing module failures.
- [ ] Implement Kahn topological sorting with stable ASCII ordering and an explicit cycle path obtained by depth-first traversal of remaining nodes.

```js
export function dependencyReadiness(itemId,graph,completedIds) {
  const complete=new Set(completedIds);
  const blocking=graph.edges
    .filter(edge => edge.source===itemId && edge.kind==="requires")
    .map(edge => edge.target)
    .filter(target => !complete.has(target))
    .sort();
  return Object.freeze({ready:blocking.length===0,blocking:Object.freeze(blocking)});
}
```

- [ ] Implement `normalizeEpicPlan` so a prepared plan is a closed revision-bound document; reject a plan that changes the epic repository/number or silently drops an already-created child.
- [ ] Implement reconciliation operations using managed issue-body markers and native parent/subissue relationship payloads. An existing matching child becomes `update` or `skipped`; a conflicting marker or parent is a conflict.
- [ ] Add the test to `fast`, run the fast lane, and commit.

```bash
git add src/core/domain/dependencies.js src/core/work test/core-dependencies.test.js test/fixtures/core scripts/test-manifest.json
git commit -m "feat(core): decompose epics with validated dependencies"
```

### Task 3: Derive exact Project status, gate, and next command

**Files:**

- Create: `src/core/domain/state.js`
- Create: `test/core-state.test.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `deriveWorkItemState(snapshot): {status, gate, reason, next_command}` is a total function for epic, child, and bounded bug snapshots.
- Status is exactly one of `Backlog`, `Ready`, `In progress`, `In review`, `Blocked`, `Done`.
- Gate is exactly one of `NONE`, `EPIC_PREPARATION_REQUIRED`, `EPIC_APPROVAL_REQUIRED`, `EPIC_REQUIRED`, `RELEASE_PLANNING`, `DEPENDENCY_REQUIRED`, `REVIEW_REQUIRED`, `CHANGES_REQUESTED`, `EPIC_ACCEPTANCE_REQUIRED`, `RELEASE_APPROVAL_REQUIRED`, `RECONCILE_REQUIRED`.

- [ ] Write a table-driven test covering every status and every gate, with precedence cases for drift over readiness, changes requested over generic review required, dependency block before branch creation, stale review after a push, and merged PR forcing Done.
- [ ] Run `node --test test/core-state.test.js` and verify the missing module failure.
- [ ] Implement the total derivation with one ordered decision table. The first matching rule wins; every returned gate must have a non-empty reason and exact next command.

```js
const RULES=Object.freeze([
  [s => s.drifted,"Blocked","RECONCILE_REQUIRED","toss-core sync"],
  [s => s.merged,"Done","NONE",null],
  [s => s.kind==="bug" && s.epic_required,"Blocked","EPIC_REQUIRED","toss-core feature add"],
  [s => s.kind==="epic" && !s.prepared,"Backlog","EPIC_PREPARATION_REQUIRED","toss-core epic prepare"],
  [s => s.kind==="epic" && !s.scope_approved,"Backlog","EPIC_APPROVAL_REQUIRED","toss-core epic approve"],
  [s => !s.release_active,"Backlog","RELEASE_PLANNING","toss-core release plan"],
  [s => s.blocking_dependencies.length>0,"Blocked","DEPENDENCY_REQUIRED","toss-core dependency check"],
  [s => s.review?.verdict==="CHANGES_REQUESTED","Blocked","CHANGES_REQUESTED","toss-core review status"],
  [s => s.pr && !s.review_current,"In review","REVIEW_REQUIRED","toss-core review record"],
]);
```

- [ ] Complete the table for ready, physical branch, draft/ready PR, epic child completion, acceptance, and release approval. Throw a validation error for impossible snapshots such as merged PR with an open head revision mismatch.
- [ ] Return Project-field update operations only when observed values differ, including `last_reconciled_at` from the injected clock.
- [ ] Add the test to `fast`, run the fast lane, and commit.

```bash
git add src/core/domain/state.js test/core-state.test.js scripts/test-manifest.json
git commit -m "feat(core): derive visible work status and gates"
```

### Task 4: Implement feature, issue, and dependency commands with a stateful fake

**Files:**

- Create: `test/support/core-github-fixture.js`
- Create: `src/core/work/operations.js`
- Create: `src/core/commands/feature.js`
- Create: `src/core/commands/issue.js`
- Create: `src/core/commands/dependency.js`
- Create: `test/core-work-commands.test.js`
- Modify: `src/core/commands/router.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `feature add <OWNER/REPO> --from <FILE>` consumes `{title, description, priority, change_class}` and produces one unversioned Epic plus Project item.
- `issue add <OWNER/REPO> --from <FILE>` consumes a bounded `{kind:"bug"|"fix", title, description, affected_version, scope}`.
- `issue start <OWNER/REPO#N>` creates the physical branch from the exact parent head only when derived state is Ready.
- `issue submit <OWNER/REPO#N>` opens or updates a PR with the exact required base.
- `dependency add|remove|graph|check` consumes stable work-item IDs and provenance-bearing edge data.

- [ ] Build a stateful fake GitHub port that implements own enumerable `snapshot`, `inspect`, and `apply` functions, maintains revisions for Project items/issues/branches/PRs, and rejects a stale `expected_revision`.
- [ ] Write command tests proving feature add creates exactly one unversioned epic, reserves but does not create a branch, assigns the TOSS OS Project, and is idempotent by managed marker.
- [ ] Add bounded bug tests for required affected version, one reserved `bug/` branch, `EPIC_REQUIRED` when scope contains more than one independently deliverable unit, and no automatic epic creation.
- [ ] Add start/submit tests for exact source SHA, branch creation only when Ready, issue PR base to epic branch, bug PR base to patch branch, existing-base conflict, and Project state updated in the same intent.
- [ ] Run `node --test test/core-work-commands.test.js` and verify the missing handlers.
- [ ] Implement each mutation as `snapshot -> pure decision -> createOperationIntent -> runner.preview/apply`; handlers may read through `github.snapshot` but must never call `github.apply` directly.

```js
export async function runFeatureCommand(command,services) {
  if (command.name==="feature.status") return services.workStatus(command.args[0]);
  const input=await services.readInput(command.options.from);
  const snapshot=await services.github.snapshot({
    kind:"feature-by-marker",
    request_id:input.request_id,
  });
  const operations=featureAddOperations(input,snapshot,services.clock.now());
  return services.operations.execute({
    command,
    source:{request_id:input.request_id,revision:snapshot.revision},
    operations,
    authority:null,
  });
}
```

- [ ] Implement dependency add/remove as control-ledger revisions plus managed GitHub issue relationships; remove requires `{reason, expected_edge_revision}` and never erases immutable history.
- [ ] Route feature/issue/dependency families, add the test to `integration`, run fast and integration lanes, and commit.

```bash
git add src/core/work src/core/commands test/support/core-github-fixture.js test/core-work-commands.test.js scripts/test-manifest.json
git commit -m "feat(core): manage feature issue and dependency work"
```

### Task 5: Record exact-head independent reviews in PR details

**Files:**

- Create: `src/core/domain/review.js`
- Create: `src/core/review/body.js`
- Create: `src/core/review/recorder.js`
- Create: `src/core/commands/review.js`
- Create: `test/core-review.test.js`
- Modify: `src/core/commands/router.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `parseManagedReviewBlock(body): {before, block, after}|null` rejects duplicate or unbalanced markers.
- `renderManagedReviewBlock(result): string` renders the exact approved headings and counts.
- `updateManagedReviewBlock(body, result): string` preserves all bytes outside the managed section.
- `reviewFreshness(result, currentHeadSha): "CURRENT"|"STALE"` compares exact 40-character SHAs.
- `recordReview({pullRequest, result, implementationIdentity, project}): Operation[]` updates the body, formal review state, Project fields, follow-up issues, and immutable receipt.

- [ ] Write body tests for insertion, replacement, byte preservation, CRLF normalization policy, duplicate marker rejection, unbalanced marker rejection, and stable rendered content.
- [ ] Write review-rule tests for independent identity, exact current SHA, Critical/Important blockers, deferred Minor requiring a TOSS OS Project follow-up, formal APPROVE/REQUEST_CHANGES state, and new-push staleness.
- [ ] Run `node --test test/core-review.test.js` and verify the missing module failures.
- [ ] Implement the exact markers and body content from the spec. Escape user-controlled Markdown list text so it cannot create another managed marker or heading outside its bullet.

```js
export const REVIEW_MARKERS=Object.freeze({
  start:"<!-- toss-core:review-results:start -->",
  end:"<!-- toss-core:review-results:end -->",
});

export function reviewFreshness(result,currentHeadSha) {
  return result.reviewed_revision===currentHeadSha ? "CURRENT" : "STALE";
}
```

- [ ] Implement reviewer independence against implementation author identities collected from commits and PR authors; do not accept a caller-supplied Boolean assertion as proof.
- [ ] Generate a follow-up `issue create + project add` operation for every deferred Minor without an existing governed issue reference. Keep Critical and Important unresolved findings blocking.
- [ ] Update formal GitHub review state in the same intent as the PR body and Project gate. Commit the validated review result to immutable control history through the runner receipt.
- [ ] Route `review.record` and `review.status`, add the test to `integration`, run fast and integration lanes, and commit.

```bash
git add src/core/domain/review.js src/core/review src/core/commands/review.js test/core-review.test.js scripts/test-manifest.json
git commit -m "feat(core): record current revision pull request reviews"
```

### Task 6: Complete the two-stage epic lifecycle

**Files:**

- Create: `src/core/commands/epic.js`
- Create: `test/core-epic-lifecycle.test.js`
- Modify: `src/core/commands/router.js`
- Modify: `scripts/test-manifest.json`
- Modify: `scripts/test-boundaries.json`

**Interfaces:**

- `epic prepare <OWNER/REPO#N> --from <FILE>` creates/reconciles native children and dependency edges, ending at `Backlog / EPIC_APPROVAL_REQUIRED`.
- `epic approve <OWNER/REPO#N> --authority <FILE>` binds authority to the exact epic-plan revision and ends at `Backlog / RELEASE_PLANNING`.
- `epic submit <OWNER/REPO#N>` requires all children Done and opens/updates the epic PR against the release branch.
- `epic accept <OWNER/REPO#N> --authority <FILE>` requires current review/checks, merges the epic PR, and marks the epic Done.
- `epic status <OWNER/REPO#N>` returns children, graph, branch, PR, review, release assignment, state/gate, and next command.

- [ ] Write one end-to-end fake-adapter test for `feature add -> epic prepare -> epic approve -> release-assigned snapshot -> child branches/PR merges -> epic submit -> review record -> epic accept`.
- [ ] Add negative cases for altered plan after approval, missing child, incomplete dependency, stale review, failed check, non-independent authority, wrong PR base, and a merge that fails before native issue closure.
- [ ] Run `node --test test/core-epic-lifecycle.test.js` and verify the missing handler failure.
- [ ] Implement prepare reconciliation and set native parent relationships, acceptance criteria, branch reservations, dependency provenance, Project membership, and machine fields in one intent.
- [ ] Implement approve with an authority binding containing epic ID, plan revision/hash, child IDs, edge revisions, and policy revision. Persist approval without assigning a version.
- [ ] Implement submit so it refuses to create an epic PR until every governed child is Done; calculate its base only from the active same-repository release snapshot.
- [ ] Implement accept so one intent updates formal merge state, merges exact head SHA, closes native epic only after the merge succeeds, and reconciles Project Done.

```js
export function epicAcceptanceBinding({epic,plan,pullRequest,review,checks,policyRevision}) {
  return Object.freeze({
    command:"epic.accept",
    targets:Object.freeze([epic.id,pullRequest.id]),
    expected_revisions:Object.freeze({
      epic:epic.revision,
      plan:plan.content_sha256,
      pull_request:pullRequest.head_sha,
      review:review.record_revision,
      checks:checks.revision,
    }),
    policy_revision:policyRevision,
  });
}
```

- [ ] Add the test to `e2e`, add `core.work-branch-hierarchy`, `core.review-current-head`, and `core.epic-two-stage-authority` guarantees to the appropriate fast/integration/e2e owners, then run all non-package lanes.
- [ ] Commit the completed work lifecycle.

```bash
git add src/core/commands/epic.js src/core/commands/router.js test/core-epic-lifecycle.test.js scripts/test-manifest.json scripts/test-boundaries.json
git commit -m "feat(core): enforce two-stage epic lifecycle"
```

## Plan 2 Completion Gate

- [ ] Run `npm run test:fast`, `npm run test:integration`, and `npm run test:e2e` from a clean worktree.
- [ ] Inspect the fake-adapter operation log and confirm no issue/epic PR targets `main` and no cross-repository branch target exists.
- [ ] Push a new fake head SHA after an approved review and confirm state derives `In review / REVIEW_REQUIRED` before any merge attempt.
- [ ] Run `git diff --check` and record the work-lifecycle commit SHA in plan 3 execution notes.
