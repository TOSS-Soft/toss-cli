# TOSS Core v2.1.2 Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and safely execute the v2.1.2 backlog rebaseline, ship the dual-executable package as the first post-cutover minor release, and hand future program operation to the published `toss-core` command.

**Architecture:** A pure migration classifier turns a fresh organization inventory into a complete immutable snapshot and field-level diff. The migration command uses the same preview, authority, intent, receipt, conflict, reconciliation, and idempotency boundaries as ordinary operations. Packaging and release validation prove the existing `toss` executable is unchanged while `toss-core` is present. Production rollout is a separately gated sequence that stops before any mutation until v2.1.2 release closure is verified.

**Tech Stack:** Node.js 20+ ESM, `node:test`, Ajv 2020 JSON Schema, npm pack/publish workflow, GitHub gateway/reconciler, core release planner.

**Spec:** `docs/superpowers/specs/2026-08-31-toss-core-organizational-lifecycle-design.md`

**Plan sequence:** 5 of 5. Requires all completion gates in the preceding four plans.

**Global Constraints:**

- Do not apply any production rebaseline before TOSS CLI v2.1.2 is fully published, its exact evidence verifies, and its milestone is closed.
- Treat the 2026-08-31 count of 69 future assignments (36 CLI, 12 future runtime, 21 Console) as comparison evidence only. Recompute and review the exact apply-time inventory.
- Preserve all completed TOSS CLI releases, v2.1.2 as the final user-managed CLI release, the proven Active toss-agent-runtime v1.0.0 release, and any other independently proven Active release unless authority explicitly changes scope.
- Remove future release/milestone assignment from approved open epics and their governed open children. Keep issues open and in the TOSS OS Project; do not delete issues, milestones, branches, tags, releases, merged PRs, or completed work.
- Remove release-target wording only when classified as planning-only. Preserve technical compatibility references and block ambiguous prose/checklist/native-child relationships.
- Adding public `toss-core` is backward-compatible feature scope and therefore targets TOSS CLI v2.2.0 after v2.1.2, never v2.1.2 or v2.1.3.
- Bootstrap the first program from verified source bytes; after v2.2.0 publication and evidence verification, use the published command for all later programs.

## File Structure

- Create `contracts/core/migration-snapshot.v1.schema.json` and `migration-result.v1.schema.json`.
- Create `src/core/migrations/classify.js`, `rebaseline.js`, and `wording.js`.
- Create `src/core/commands/migrate.js`.
- Create `test/core-migration-classifier.test.js`, `core-rebaseline.test.js`, `core-acceptance.test.js`, and `release-v2.2.0.test.js`.
- Create `docs/migrations/toss-core-v2.1.2-rebaseline.md` and `docs/releases/v2.2.0.md` during the release-candidate task.
- Modify `src/contracts/schema-catalog.js`, `src/core/commands/router.js`, `package.json`, `package-lock.json`, `README.md`, `scripts/package-artifact-test.js`, `scripts/prepare-github-package.mjs`, `scripts/release-workflow-test.js`, `.github/workflows/publish.yml`, `scripts/test-manifest.json`, and `scripts/test-boundaries.json`.

### Task 1: Define migration snapshot/result contracts and pure classification

**Files:**

- Create: `contracts/core/migration-snapshot.v1.schema.json`
- Create: `contracts/core/migration-result.v1.schema.json`
- Modify: `src/contracts/schema-catalog.js`
- Create: `src/core/migrations/classify.js`
- Create: `src/core/migrations/wording.js`
- Create: `test/core-migration-classifier.test.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `classifyReleaseAssignment(item, context): {classification, reasons}` returns `PRESERVE_COMPLETED | PRESERVE_ACTIVE | REBASELINE_FUTURE | BLOCK_AMBIGUOUS | OUT_OF_SCOPE`.
- `classifyPlanningWording({title, body, managedSections, compatibilityReferences}): {edits, blocked}` emits exact byte-range or managed-field edits; it never broadly rewrites prose.
- `createMigrationSnapshot({cutover, github, control, clock}): MigrationSnapshot` records every inspected issue, Project item, milestone, branch, PR, release, and revision.
- `migrationSnapshotHash(snapshot): string` is the authority/apply binding.

- [ ] Write classification fixtures for completed issues, merged PRs, active physical release branches, runtime v1.0.0, approved future epics, governed children, ungoverned issues, body checklists, native subissues, planning title versions, and technical compatibility references.
- [ ] Add exact comparison facts for 36 CLI, 12 future runtime, 21 Console, and total 69; assert differences are reported, not silently coerced to these historical counts.
- [ ] Run `node --test test/core-migration-classifier.test.js` and verify the missing contracts/modules.
- [ ] Register both schemas in stable ASCII order. Require snapshot source revisions, inventory counts by repository/milestone/classification, complete item rows, proposed field diffs, blocked ambiguities, and canonical SHA-256.
- [ ] Implement preservation precedence: completed/merged/released first, independently proven active second, approved future open assignment third, ambiguity before mutation, otherwise out of scope.

```js
export function classifyReleaseAssignment(item,context) {
  if (item.completed || item.pull_request?.merged || item.release?.published) {
    return decision("PRESERVE_COMPLETED","Completed release history is immutable");
  }
  if (context.activeReleaseIds.has(item.release_id)) {
    return decision("PRESERVE_ACTIVE","Release is independently proven Active");
  }
  if (item.ambiguous_relationships.length>0 || item.ambiguous_version_text.length>0) {
    return decision("BLOCK_AMBIGUOUS","Human review is required");
  }
  if (item.open && context.approvedFutureMilestoneIds.has(item.milestone_id)) {
    return decision("REBASELINE_FUTURE","Open future assignment is approved for rebaseline");
  }
  return decision("OUT_OF_SCOPE","Item is outside approved migration scope");
}
```

- [ ] Implement wording edits only for structured planning metadata and uniquely identified managed planning sections. A title/body token also referenced by compatibility evidence makes the item BLOCK_AMBIGUOUS.
- [ ] Add the test to `fast`, run the fast lane, and commit.

```bash
git add contracts/core src/contracts/schema-catalog.js src/core/migrations test/core-migration-classifier.test.js scripts/test-manifest.json
git commit -m "feat(core): classify v2.1.2 rebaseline inventory"
```

### Task 2: Implement dry-run, authority-bound apply, and idempotent rebaseline

**Files:**

- Create: `src/core/migrations/rebaseline.js`
- Create: `src/core/commands/migrate.js`
- Create: `test/core-rebaseline.test.js`
- Modify: `src/core/commands/router.js`
- Modify: `scripts/test-manifest.json`
- Modify: `scripts/test-boundaries.json`

**Interfaces:**

- `migrate rebaseline --cutover v2.1.2` snapshots and previews by default.
- `migrate rebaseline --cutover v2.1.2 --apply --non-interactive --authority <FILE>` requires exact snapshot authority and zero unresolved ambiguities.
- `rebaselineOperations(snapshot): Operation[]` removes approved future assignment/wording, updates Project fields, and closes newly empty future milestones without deleting them.
- `verifyCutoverPrerequisite(snapshot): true` proves v2.1.2 published evidence and closed milestone.

- [ ] Write an end-to-end fake-gateway test for a mixed CLI/runtime/Console inventory containing preserved completed, preserved active runtime v1.0.0, future epic/children, ambiguous issue, emptied milestone, and a milestone retaining out-of-scope open work.
- [ ] Assert the initial run writes no remote state, exposes complete field-level diff/counts, and stores the snapshot only when explicitly applied to the private control repository.
- [ ] Add apply tests for absent v2.1.2 release, open v2.1.2 milestone, changed inventory hash, unresolved ambiguity, wrong authority, partial failure, reconciliation, successful apply, and a second zero-operation run.
- [ ] Run `node --test test/core-rebaseline.test.js` and verify missing handler/operations.
- [ ] Implement prerequisites by verifying exact v2.1.2 tag/commit/package/GitHub Release/evidence and closed milestone through the plan 3 publication verifier plus GitHub snapshot.
- [ ] Emit operations only for `REBASELINE_FUTURE`: clear milestone/release fields from open epic and governed children, apply approved wording edits, set `Backlog` plus `EPIC_PREPARATION_REQUIRED`, `EPIC_APPROVAL_REQUIRED`, or `RELEASE_PLANNING`, and retain Project membership/open issue state.
- [ ] Close an emptied future milestone with description `Rebaselined after v2.1.2`; never delete it. Leave a milestone open when any preserved or out-of-scope open issue remains.

```js
export function rebaselineMilestoneUpdate(milestone,remainingOpen) {
  if (remainingOpen>0) return null;
  return Object.freeze({
    state:"closed",
    description:"Rebaselined after v2.1.2",
    expected_revision:milestone.revision,
  });
}
```

- [ ] Bind authority to cutover `v2.1.2`, full snapshot hash, exact classified item/milestone IDs, proposed diff hash, policy revision, actor, and expiry. Require a new preview/authority on any revision change.
- [ ] Persist `migrations/<migration-id>/snapshot.json` before remote writes and `result.json` after reconciliation; prove a second run returns the same result identity with no operations.
- [ ] Route `migrate.rebaseline`, add the test to `e2e`, add `core.migration-preservation` and `core.migration-idempotency` guarantees, run fast/integration/e2e, and commit.

```bash
git add src/core/migrations/rebaseline.js src/core/commands/migrate.js src/core/commands/router.js test/core-rebaseline.test.js scripts/test-manifest.json scripts/test-boundaries.json
git commit -m "feat(core): apply authority-bound backlog rebaseline"
```

### Task 3: Harden the dual-executable package and v2.2.0 release metadata

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/package-artifact-test.js`
- Modify: `scripts/prepare-github-package.mjs`
- Modify: `scripts/release-workflow-test.js`
- Modify: `.github/workflows/publish.yml`
- Create: `test/release-v2.2.0.test.js`
- Create: `docs/releases/v2.2.0.md`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- npm and GitHub Packages contain `bin.toss` and `bin.toss-core` after package preparation.
- Version/tag is exactly `2.2.0`/`v2.2.0` after verified v2.1.2; release metadata, notes, tarball, packages, and evidence agree.
- Existing legacy/project-local `toss` smoke behavior remains byte/behavior compatible except for the package version.

- [ ] Extend package tests to inspect both source and prepared GitHub package manifests, execute both packed shims, and verify all core contracts/workflow templates are present.
- [ ] Write `test/release-v2.2.0.test.js` by generalizing version assertions from `test/release-v2.1.1.test.js`; assert current manifest/lock roots, release notes categories, dual binaries, and scoped TOSS Core epic/children.
- [ ] Run package/release lanes and verify the new test initially fails while the manifest is still 2.1.1/2.1.2 staging state.
- [ ] After the verified v2.1.2 tag exists on the base branch, update both package versions to `2.2.0` without using a command that creates an unreviewed tag. Preserve `engines.node: ">=20"`.
- [ ] Generalize hard-coded v2.1.1 evidence workspace paths in `.github/workflows/publish.yml` to a path derived from validated metadata version; keep tag/main ancestry, annotated evidence, Trusted Publishing, GitHub Packages, and GitHub Release evidence checks.
- [ ] Update `prepare-github-package.mjs` so bin mappings are copied as a closed object and both executable files are required regular files in the prepared tree.

```js
assert.deepEqual(preparedManifest.bin,{
  toss:"bin/toss.js",
  "toss-core":"bin/toss-core.js",
});
for (const executable of Object.values(preparedManifest.bin)) {
  const stat=lstatSync(join(preparedRoot,executable));
  assert.equal(stat.isFile(),true,`${executable} must be a regular packed file`);
  assert.equal(stat.isSymbolicLink(),false,`${executable} must not be a symlink`);
}
```

- [ ] Write `docs/releases/v2.2.0.md` with command surface, migration/cutover behavior, security model, compatibility, verification, closed issues, and a clearly marked evidence section populated only from final captured reports.
- [ ] Add the new release test to `release` in stable ASCII order, run package/release lanes, and commit without tagging.

```bash
git add package.json package-lock.json scripts/package-artifact-test.js scripts/prepare-github-package.mjs scripts/release-workflow-test.js .github/workflows/publish.yml test/release-v2.2.0.test.js docs/releases/v2.2.0.md scripts/test-manifest.json
git commit -m "build(core): prepare dual executable v2.2.0 release"
```

### Task 4: Add the complete acceptance and regression suite

**Files:**

- Create: `test/core-acceptance.test.js`
- Modify: `scripts/test-manifest.json`
- Modify: `scripts/test-boundaries.json`
- Modify: `README.md`
- Create: `docs/migrations/toss-core-v2.1.2-rebaseline.md`

**Interfaces:**

- Acceptance suite covers the entire fake-GitHub lifecycle and uses only public command/runtime boundaries.
- README documents approved commands, exact preview/apply usage, status/gates, branch hierarchy, SemVer ownership, and cutover safety.

- [ ] Write one fake-organization acceptance flow: init/register repositories, feature add, epic prepare/approve, multi-repository dependency staging, minor release planning/activation, issue PRs, epic PRs, current-head reviews, release approval/publication, and next WAITING_FOR_EPIC.
- [ ] Extend the flow with a published-product production bug that interrupts a feature release with a patch, publishes, merges current main into the paused branch, stales reviews, reconciles, and resumes.
- [ ] Add failure assertions for direct issue/epic PR to main, cross-repository base, two active releases in one repository, stale review, missing authority, Project drift, changed apply revision, partial receipt, and automatic epic creation for expanded bug scope.
- [ ] Run `node --test test/core-acceptance.test.js` and verify the first missing integration behavior.
- [ ] Fix only public boundary integration defects exposed by the scenario; retain pure rules and gateway behavior already covered by focused tests.

```js
test("organization lifecycle reaches the next planning state",async () => {
  const fixture=createCoreOrganizationFixture();
  const result=await fixture.runApprovedLifecycle();
  assert.equal(result.release.phase,"RELEASED");
  assert.ok(["DRAFT","WAITING_FOR_EPIC"].includes(result.next_program.phase));
  assert.equal(result.invalid_direct_main_prs.length,0);
  assert.equal(result.cross_repository_pr_bases.length,0);
  assert.equal(result.project_drift.length,0);
});
```

- [ ] Update README with `toss-core` quick start and the complete approved command table. State that release planning/version choice/next-draft preparation are TOSS Core responsibilities while the user supplies epics and explicit gated approvals.
- [ ] Document rebaseline preview, authority, preserved active/completed work, exact second-run no-op verification, rollback/partial reconciliation, and the prohibition on running before v2.1.2 closure.
- [ ] Add acceptance to `e2e`, assign `core.acceptance-organizational-lifecycle` as a real-cli guarantee, run `npm run test:full`, and commit.

```bash
git add test/core-acceptance.test.js scripts/test-manifest.json scripts/test-boundaries.json README.md docs/migrations/toss-core-v2.1.2-rebaseline.md
git commit -m "test(core): prove organizational lifecycle acceptance"
```

### Task 5: Execute the gated v2.1.2 production cutover

**Files:**

- Create at runtime in private control repository: `config/organization.yaml`
- Create at runtime in private control repository: `config/repositories/*.yaml`
- Create at runtime in private control repository: `policies/lifecycle.yaml`
- Create at runtime in private control repository: `policies/release.yaml`
- Create at runtime in private control repository: `migrations/<migration-id>/snapshot.json`
- Create at runtime in private control repository: `migrations/<migration-id>/result.json`

**Interfaces:**

- All production mutation commands use verified source-built `bin/toss-core.js` from the reviewed release candidate and exact commit SHA.
- Bootstrap/rebaseline approvals are separate authority records and separate previews.

- [ ] Stop and verify v2.1.2: milestone closed, annotated tag points to main, npm/GitHub packages and GitHub Release evidence match, and no user-managed release work remains open.
- [ ] From reviewed source bytes, run `toss-core doctor --json` and `toss-core init --dry-run --json`; review the exact private `TOSS-Soft/toss-os-control` creation, Project fields, registered repositories, policies, and workflow operations.
- [ ] Obtain bootstrap authority bound to the preview hash, apply with `--apply --non-interactive`, then run doctor/audit. Stop on any partial receipt or permission/schema drift.
- [ ] Run `toss-core migrate rebaseline --cutover v2.1.2 --dry-run --json`; compare fresh repository/milestone/item counts with the 36/12/21/69 design evidence and investigate every difference.
- [ ] Resolve every BLOCK_AMBIGUOUS item by explicit scope/wording decision, regenerate the full snapshot, and obtain migration authority bound to that exact snapshot/diff hash.
- [ ] Apply the migration once, run `toss-core sync --apply --non-interactive --json`, then run audit and the identical migration command again. Require zero second-run operations.
- [ ] Verify runtime v1.0.0 active branch/work is unchanged, all completed releases/tags/PRs are unchanged, approved future epics/children are unversioned Backlog, emptied milestones are closed not deleted, and no issue left the TOSS OS Project.
- [ ] Commit no credentials or secret values. Preserve bootstrap/migration intent and receipt IDs in the rollout record.

### Task 6: Bootstrap TOSS-OS-R0001, publish v2.2.0, and switch to self-hosting

**Files:**

- Create at runtime in private control repository: `programs/TOSS-OS-R0001/manifest.yaml`
- Finalize: `docs/releases/v2.2.0.md`
- Create from workflow: `release-evidence.json`

**Interfaces:**

- `TOSS-OS-R0001` selects the user-provided TOSS Core organizational lifecycle epic as the priority toss-cli scope and independently computes toss-cli `2.2.0`.
- Release approval binds the exact release PR head/review/check/rules/evidence prerequisites.
- Published smoke uses `npx --package @toss-software/cli@2.2.0 toss-core` or the globally installed equivalent, not source checkout.

- [ ] Using source-built `toss-core`, run `release plan --dry-run --json`; verify the TOSS Core epic is selected, unrelated runtime/Wiki/remote-approval/Console epics remain unversioned, and toss-cli rationale selects minor `2.2.0`.
- [ ] Apply the Draft, activate the toss-cli track, and verify milestone `v2.2.0`, branch `release/v2.2.0`, epic branch, native children, dependency graph, and Project machine fields.
- [ ] Complete child issue branches/PRs into the epic branch, record exact-head reviews in PR details, accept the epic into the release branch, and reconcile after every merge.
- [ ] Capture final fast/full benchmark reports and tarball SHA-256, finalize the v2.2.0 release notes/evidence, open or update the release PR to main, and record an independent current-head release review.
- [ ] Obtain `release approve` authority, merge the exact release PR head, create the canonical annotated `v2.2.0` tag through the verified release procedure, and let the existing publication workflow run.
- [ ] Verify npm `@toss-software/cli@2.2.0`, GitHub Packages, GitHub Release, tag target, assets, and immutable release evidence before marking the release/program Released.
- [ ] Install/use the published package and run `toss-core doctor`, `program status`, `audit`, and next-program preparation. Require the next state to be a valid Draft or WAITING_FOR_EPIC with no empty branch/milestone.
- [ ] Record the source-to-published handoff receipt; all later release programs must use the published `toss-core` command.

## Plan 5 Completion Gate

- [ ] Run `npm run test:full`, `npm run test:package`, and `npm run test:release` on the exact v2.2.0 release commit.
- [ ] Verify the packed npm artifact exposes working `toss` and `toss-core` binaries on supported Node versions and existing `toss` compatibility smoke tests pass.
- [ ] Verify production audit has zero ERROR findings, migration rerun has zero operations, and every governed GitHub Project item displays current Status/Gate/branch/base/last-reconciled data.
- [ ] Verify v2.1.2 remains the last user-managed release and v2.2.0 is the first TOSS Core-managed release.
- [ ] Store final bootstrap, migration, program, release, and self-host handoff receipt identities in the private control repository.
