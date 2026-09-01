# TOSS Core Release Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan and operate coordinated TOSS OS release programs with independent repository SemVer, one active release per repository, explicit approval, production patch interruption, verified publication, and automatic preparation of the next draft.

**Architecture:** Pure SemVer and scope planners consume approved unversioned epics, repository publication history, and dependency graphs to create an explainable program manifest. Release state transitions produce deterministic operations for milestones, branches, assignments, draft PR intent, merge, tag, and publication verification. An urgent production patch uses a linked patch program so the paused feature program retains its physical branch without violating the one-track-per-repository program model.

**Tech Stack:** Node.js 20+ ESM, `node:test`, Ajv 2020 JSON Schema, core operation runner, work lifecycle snapshots, GitHub gateway fake.

**Spec:** `docs/superpowers/specs/2026-08-31-toss-core-organizational-lifecycle-design.md`

**Plan sequence:** 3 of 5. Requires `2026-09-01-toss-core-work-lifecycle.md`; continue with `2026-09-01-toss-core-reconciliation-actions.md`.

**Global Constraints:**

- A program coordinates repositories but never imposes one shared product version. Each repository owns its SemVer, milestone, release branch, tag, package, and evidence.
- Select only explicitly approved, unversioned, registered, sufficiently decomposed epics not active in another plan. Record selected and deferred scope with machine-readable rationale.
- Breaking public boundary changes select major; at least one backward-compatible feature selects minor; a fix-only published-product release selects patch. Bugs found only in unreleased feature code stay in that feature release.
- Permit at most one Active release per repository. Draft releases own neither milestone nor branch. Different repositories may be Active concurrently when dependency stages allow it.
- `release approve` authorizes merge/tag/publication initiation but does not mark Released. Exact tag, package, GitHub Release, and evidence verification is required.
- After program completion, prepare the next Draft automatically. When nothing is eligible, persist `WAITING_FOR_EPIC` without an empty milestone or branch.

## File Structure

- Create `contracts/core/release-program.v1.schema.json`, `repository-release.v1.schema.json`, and `publication-evidence.v1.schema.json`.
- Create `src/core/release/semver.js`, `state.js`, `planner.js`, `operations.js`, `patch.js`, and `verification.js`.
- Create `src/core/commands/release.js` and `src/core/commands/program.js`.
- Create `test/core-semver.test.js`, `core-release-planner.test.js`, `core-release-activation.test.js`, `core-patch-interruption.test.js`, and `core-release-completion.test.js`.
- Modify `src/contracts/schema-catalog.js`, `src/core/commands/router.js`, `scripts/test-manifest.json`, and `scripts/test-boundaries.json`.

### Task 1: Define release/program contracts and legal transitions

**Files:**

- Create: `contracts/core/repository-release.v1.schema.json`
- Create: `contracts/core/release-program.v1.schema.json`
- Create: `contracts/core/publication-evidence.v1.schema.json`
- Modify: `src/contracts/schema-catalog.js`
- Create: `src/core/release/state.js`
- Create: `test/core-release-state.test.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- Repository release phase: `DRAFT | ACTIVE | PAUSED | READY_FOR_APPROVAL | PUBLISHING | RELEASED`.
- Program phase: `DRAFT | ACTIVE | PAUSED | PUBLISHING | RELEASED | WAITING_FOR_EPIC`.
- `transitionRepositoryRelease(release, event): RepositoryRelease` validates revision-bound legal transitions.
- `assertRepositoryConcurrency(programs): true` rejects two Active/PUBLISHING releases for one repository; a Paused release may retain its branch.

- [ ] Write transition tests for draft activation, active pause, paused resume, ready approval, publishing verification, and every illegal skip; add concurrency tests for two repositories active together and two releases active in one repository.
- [ ] Run `node --test test/core-release-state.test.js` and verify the missing contracts/modules.
- [ ] Register the three schemas in stable ASCII order and close all nested objects. Require `version`, `milestone`, `branch`, and `release_pr_intent` to be `null` in DRAFT/WAITING state and non-null once ACTIVE.
- [ ] Define one repository release per included repository in a program. Model patch interruption as a separate program with exact links:

```json
{
  "interrupts": {
    "program_id": "TOSS-OS-R0007",
    "repository_release_id": "REL-toss-cli-2.2.0",
    "paused_release_revision": "REV-0042"
  }
}
```

- [ ] Implement event-driven transitions using exact allowed pairs; increment `revision` once and append a transition record containing event, source phase, target phase, timestamp, and source receipt.

```js
const TRANSITIONS=Object.freeze({
  ACTIVATE:Object.freeze({DRAFT:"ACTIVE"}),
  PAUSE_FOR_PATCH:Object.freeze({ACTIVE:"PAUSED"}),
  RESUME_AFTER_PATCH:Object.freeze({PAUSED:"ACTIVE"}),
  SCOPE_DONE:Object.freeze({ACTIVE:"READY_FOR_APPROVAL"}),
  APPROVE:Object.freeze({READY_FOR_APPROVAL:"PUBLISHING"}),
  VERIFY_PUBLICATION:Object.freeze({PUBLISHING:"RELEASED"}),
});
```

- [ ] Add the test to `fast`, run the focused and full fast lane, and commit.

```bash
git add contracts/core src/contracts/schema-catalog.js src/core/release/state.js test/core-release-state.test.js scripts/test-manifest.json
git commit -m "feat(core): define release program state contracts"
```

### Task 2: Implement exact SemVer classification

**Files:**

- Create: `src/core/release/semver.js`
- Create: `test/core-semver.test.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `parseSemVer(value): {major, minor, patch}` accepts only canonical stable versions without prerelease/build data.
- `classifyReleaseChange(scope): "major"|"minor"|"patch"` applies the approved precedence.
- `nextVersion(currentVersion, changeClass): string` performs checked integer increments.
- `selectRepositoryVersion({latestPublishedVersion, epics, bugs}): {version, change_class, rationale}` distinguishes published-product bugs from unreleased-feature defects.

- [ ] Write table-driven tests for `2.1.2 -> 2.1.3` patch, `2.1.2 -> 2.2.0` minor, `2.1.2 -> 3.0.0` major, zero versions, overflow, non-canonical versions, mixed scopes, and unreleased-only bug exclusion.
- [ ] Run `node --test test/core-semver.test.js` and verify the missing module failure.
- [ ] Implement strict SemVer parsing with `/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u`; reject values above `Number.MAX_SAFE_INTEGER`.
- [ ] Implement classification precedence as `breaking -> major`, then `backward_compatible_feature -> minor`, then published-product `bug|fix -> patch`; reject an empty or exclusively unreleased-defect release.

```js
export function nextVersion(currentVersion,changeClass) {
  const current=parseSemVer(currentVersion);
  if (changeClass==="major") return `${checkedAdd(current.major)}.0.0`;
  if (changeClass==="minor") return `${current.major}.${checkedAdd(current.minor)}.0`;
  if (changeClass==="patch") return `${current.major}.${current.minor}.${checkedAdd(current.patch)}`;
  throw new CoreValidationError("CORE_CHANGE_CLASS_INVALID",`Unknown change class: ${changeClass}`);
}
```

- [ ] Return a rationale array listing the exact scope IDs and rule that determined the version; preserve this data in the program manifest.
- [ ] Add the test to `fast`, run it plus existing release-version tests, and commit.

```bash
git add src/core/release/semver.js test/core-semver.test.js scripts/test-manifest.json
git commit -m "feat(core): select independent repository semantic versions"
```

### Task 3: Select coherent program scope and dependency stages

**Files:**

- Create: `src/core/release/planner.js`
- Create: `test/core-release-planner.test.js`
- Create: `test/fixtures/core/program-candidates.json`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `eligibleEpic(epic, activeAssignments): {eligible, reasons}` exposes every failed eligibility condition.
- `planReleaseProgram({programId, candidates, completed, repositories, activePrograms, clock}): ReleaseProgram` returns selected/deferred epics, repository tracks, dependency stages, versions, and rationale.
- Candidate fields are exact: `{id, repository, approved, version, decomposed, priority, risk, outcome, change_class, dependencies}`.

- [ ] Write planner tests for registered/unregistered repositories, approved/unapproved scope, already-versioned scope, incomplete decomposition, another-plan assignment, dependency closure, completed prior dependency, same-program earlier stage, and an unsatisfied missing dependency.
- [ ] Add determinism tests showing shuffled candidates yield identical canonical manifests and ties resolve by priority, dependency fan-out, risk, then stable epic ID.
- [ ] Run `node --test test/core-release-planner.test.js` and verify the missing module failure.
- [ ] Implement eligibility as a pure report, then compute the transitive mandatory dependency closure before selecting any outcome group.
- [ ] Create stages from the validated dependency DAG. Cross-repository dependencies order tracks; they must not change any release/epic branch-base calculation.
- [ ] Group selected scope by repository and call `selectRepositoryVersion` separately. Omit repositories with no selected scope; never manufacture a shared program version.

```js
export function candidateOrder(left,right) {
  return right.priority-left.priority ||
    right.dependency_fanout-left.dependency_fanout ||
    riskRank(left.risk)-riskRank(right.risk) ||
    left.id.localeCompare(right.id);
}
```

- [ ] For every deferred epic record `{epic_id, reason_code, explanation, blocking_ids}`; for every selected epic record the eligibility facts and selected outcome.
- [ ] When no epic is eligible, return one `WAITING_FOR_EPIC` program with empty repository tracks and no milestone/branch operations.
- [ ] Add the test to `fast`, run fast lane, and commit.

```bash
git add src/core/release/planner.js test/core-release-planner.test.js test/fixtures/core/program-candidates.json scripts/test-manifest.json
git commit -m "feat(core): plan coordinated explainable release scope"
```

### Task 4: Activate release tracks and assign work

**Files:**

- Create: `src/core/release/operations.js`
- Create: `src/core/commands/release.js`
- Create: `src/core/commands/program.js`
- Create: `test/core-release-activation.test.js`
- Modify: `src/core/commands/router.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `release plan` snapshots eligible epics and stores a Draft manifest; no milestone or branch operation is emitted.
- `release activate <PROGRAM-ID> [<OWNER/REPO>]` creates exact milestone `vX.Y.Z`, branch `release/vX.Y.Z`, release-PR intent, epic assignments, and ready epic branches.
- `release status <OWNER/REPO>` returns phase, scope, gates, checks, patch link, and next command.
- `program status [<PROGRAM-ID>]` aggregates repository tracks and cross-repository stages.
- `activationOperations(program, repository, snapshot): Operation[]` uses verified current default-branch head as the release-branch source.

- [ ] Write command tests proving plan is mutation-preview-only, a Draft has no remote milestone/branch, activation checks one-active-release concurrency, and different repositories in an allowed stage can activate independently.
- [ ] Add activation tests for exact `main` head source, same-version milestone conflict, existing matching branch idempotency, assignment of epic and governed children, epic branch from release branch, and Project Ready/DEPENDENCY_REQUIRED derivation.
- [ ] Run `node --test test/core-release-activation.test.js` and verify the missing handlers.
- [ ] Implement `release plan` from live normalized snapshots and commit the Draft manifest only after apply confirmation; treat the program manifest revision as the expected revision for activation.
- [ ] Implement activation operations in dependency order: milestone, release branch, release-PR intent receipt, epic/child milestone assignment, epic physical branch, Project fields. Open a Draft release PR only when compare reports a material diff.

```js
export function releaseBranch(version) {
  parseSemVer(version);
  return `release/v${version}`;
}

export function releaseMilestone(version) {
  parseSemVer(version);
  return `v${version}`;
}
```

- [ ] Persist a release-PR intent even when GitHub rejects an equal-head PR; include exact head/base and let the plan 4 reconciler create it after the first material change.
- [ ] Route `release.*` and `program.status`, add the test to `integration`, run fast/integration, and commit.

```bash
git add src/core/release/operations.js src/core/commands/release.js src/core/commands/program.js src/core/commands/router.js test/core-release-activation.test.js scripts/test-manifest.json
git commit -m "feat(core): activate repository release tracks"
```

### Task 5: Interrupt an active feature release with a production patch

**Files:**

- Create: `src/core/release/patch.js`
- Create: `test/core-patch-interruption.test.js`
- Modify: `src/core/commands/issue.js`
- Modify: `src/core/commands/release.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `planPatchInterruption({bug, latestPublished, activeFeatureProgram, snapshot}): {patchProgram, pauseOperations, patchOperations}`.
- `completePatchInterruption({patchProgram, pausedProgram, publication, snapshot}): Operation[]` merges current default branch into the paused feature branch, stales affected reviews, requests checks, and resumes only after reconciliation.
- A bounded production bug cannot start until its patch release is Active.

- [ ] Write the required scenario: latest published `2.1.2`, active feature `2.2.0`, production bug selects `2.1.3`, pauses 2.2.0 while retaining its branch, creates `release/v2.1.3` from verified `main`, and creates the bug branch from it.
- [ ] Add negative tests for a bug only in unreleased 2.2.0 code, a second Active patch, wrong affected version, main advancing after preview, and resume before the patch merge/check reconciliation.
- [ ] Run `node --test test/core-patch-interruption.test.js` and verify the missing module failure.
- [ ] Implement patch-program creation linked to the exact paused program/release revision. The feature program becomes Paused before any patch release branch write.
- [ ] Implement version selection from latest verified published version, not from the paused feature version.

```js
export function patchVersionFor(latestPublishedVersion) {
  return Object.freeze({
    version:nextVersion(latestPublishedVersion,"patch"),
    change_class:"patch",
    based_on:latestPublishedVersion,
  });
}
```

- [ ] On verified patch publication, create a merge operation from current `main` into the paused feature release branch, mark review results STALE when their reviewed SHA is no longer current, set `REVIEW_REQUIRED`, and request required checks.
- [ ] Resume the feature release only after snapshot proves the patch commit is an ancestor of its branch head, no reconcile drift exists, and required checks for the new head have started or completed per policy.
- [ ] Add the test to `e2e`, run fast/integration/e2e lanes, and commit.

```bash
git add src/core/release/patch.js src/core/commands/issue.js src/core/commands/release.js test/core-patch-interruption.test.js scripts/test-manifest.json
git commit -m "feat(core): interrupt feature releases with production patches"
```

### Task 6: Approve, verify, complete, and roll the program forward

**Files:**

- Create: `src/core/release/verification.js`
- Create: `test/core-release-completion.test.js`
- Modify: `src/core/commands/release.js`
- Modify: `src/core/commands/program.js`
- Modify: `scripts/test-manifest.json`
- Modify: `scripts/test-boundaries.json`

**Interfaces:**

- `release approve <OWNER/REPO@VERSION> --authority <FILE>` verifies exact release PR head, all scope Done, current independent review, required checks, rules, and authority before merge/tag workflow initiation.
- `verifyPublication(release, evidence): {verified, failures}` checks exact tag/commit/package/GitHub Release/evidence identities.
- `completeProgram(program, releases, candidates, clock): {program, nextProgram}` marks Released only after every track verifies and produces the next Draft or WAITING_FOR_EPIC.

- [ ] Write approval tests for incomplete scope, stale review, changes requested, failing/pending checks, changed repository rules, wrong authority binding, and exact eligible current head.
- [ ] Write publication tests for tag at wrong commit, missing package, wrong package version, draft/prerelease GitHub Release, mismatched evidence hash, successful verification, and idempotent repeated verification.
- [ ] Write next-program tests for one completed multi-repository program, remaining eligible epics producing a Draft, and no eligible epics producing WAITING_FOR_EPIC without branch/milestone operations.
- [ ] Run `node --test test/core-release-completion.test.js` and verify missing verification functions.
- [ ] Implement approval authority binding with program/release IDs, manifest revision/hash, PR ID/head/base, review record revision, check-suite IDs/conclusions, repository-rules revision, version, and policy revision.
- [ ] Emit operations to merge exact release PR head and initiate the existing repository publication workflow. Move to PUBLISHING, not RELEASED.
- [ ] Implement publication verification without trusting workflow success alone; compare tag target, expected package identity/version, GitHub Release state/assets, and immutable evidence content.

```js
export function publicationComplete(failures) {
  return Object.freeze({
    verified:failures.length===0,
    failures:Object.freeze([...failures].sort((a,b) => a.code.localeCompare(b.code))),
  });
}
```

- [ ] After all tracks are RELEASED, close the program and call the pure planner on a fresh eligible snapshot. Commit either the next Draft manifest or WAITING_FOR_EPIC record in the same reconciled operation, with zero remote branch/milestone writes.
- [ ] Add the test to `e2e`, add `core.release-independent-semver`, `core.release-one-active-per-repository`, `core.release-patch-interruption`, and `core.release-publication-verification` guarantees to their test owners, then run all non-package lanes.
- [ ] Commit the release-program lifecycle.

```bash
git add src/core/release/verification.js src/core/commands/release.js src/core/commands/program.js test/core-release-completion.test.js scripts/test-manifest.json scripts/test-boundaries.json
git commit -m "feat(core): approve and verify release programs"
```

## Plan 3 Completion Gate

- [ ] Run `npm run test:fast`, `npm run test:integration`, and `npm run test:e2e` from a clean worktree.
- [ ] Inspect canonical fixtures and confirm one program contains no shared product version field and at most one track per included repository.
- [ ] Re-run the `2.1.2 -> 2.1.3` patch interruption scenario twice and confirm the second run produces only recorded skips/idempotent receipts.
- [ ] Confirm WAITING_FOR_EPIC produces no milestone, branch, tag, or release PR operation.
- [ ] Run `git diff --check` and record the release-program commit SHA in plan 4 execution notes.
