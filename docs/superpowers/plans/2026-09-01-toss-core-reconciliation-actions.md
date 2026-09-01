# TOSS Core Reconciliation and Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the domain lifecycle to GitHub, continuously derive current Project state, repair machine-owned drift, expose audit/doctor diagnostics, and install least-privilege event/schedule reconciliation workflows.

**Architecture:** A typed GitHub gateway translates closed operations into validated REST/GraphQL requests through an injected `gh` transport. A pure reconciler compares authoritative GitHub state with control intent, derives expected machine fields and relationships, and emits an ordered repair plan. Interactive `sync`, read-only `audit`/`doctor`, repository event workflows, and scheduled drift checks all call the same reconciler; no always-on service is introduced.

**Tech Stack:** Node.js 20+ ESM, `node:test`, GitHub REST/GraphQL through `gh api`, GitHub Actions YAML templates, existing core intent/receipt runner.

**Spec:** `docs/superpowers/specs/2026-08-31-toss-core-organizational-lifecycle-design.md`

**Plan sequence:** 4 of 5. Requires `2026-09-01-toss-core-release-program.md`; continue with `2026-09-01-toss-core-cutover.md`.

**Global Constraints:**

- Treat GitHub as authoritative for Project membership/fields, issue state and hierarchy, milestone, branches, PRs, reviews, checks, merge, tag, release, and publication evidence.
- Treat the private control repository as authoritative for registry, Project field IDs, policies, program/release intent, approvals, immutable receipts, and migration evidence.
- Correct manual edits only for machine-owned fields: Status, Gate, branch, base branch, and last reconciled. Never overwrite human-authored issue/PR content outside managed markers.
- Validate permissions and Project schema before the first remote write. Credentials come from the execution environment, never command arguments, config contents, logs, previews, or receipts.
- Partial operations remain `Blocked / RECONCILE_REQUIRED`; resume succeeded steps from receipts and compensate only when the original intent explicitly declares a safe compensation.
- Use isolated test repositories/Projects for optional live tests. Production TOSS OS data is never a fixture.

## File Structure

- Create `src/core/github/transport.js`, `gateway.js`, `queries.js`, `normalizers.js`, and `operations.js`.
- Create `src/core/reconcile/snapshot.js`, `derive.js`, `plan.js`, and `runner.js`.
- Create `src/core/audit.js`, `src/core/doctor.js`, and `src/core/commands/operations.js`.
- Create `templates/core/toss-core-sync.yml` and `src/core/actions/template.js`.
- Create `test/core-github-gateway.test.js`, `core-reconciler.test.js`, `core-audit-doctor.test.js`, `core-actions.test.js`, and `core-live-github.test.js`.
- Modify `src/core/runtime.js`, `src/core/commands/router.js`, `scripts/test-manifest.json`, `scripts/test-boundaries.json`, and `scripts/package-artifact-test.js`.

### Task 1: Implement the validated GitHub transport and gateway

**Files:**

- Create: `src/core/github/transport.js`
- Create: `src/core/github/queries.js`
- Create: `src/core/github/normalizers.js`
- Create: `src/core/github/operations.js`
- Create: `src/core/github/gateway.js`
- Create: `test/core-github-gateway.test.js`
- Modify: `src/core/runtime.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `createGhTransport({execFile, cwd}): {request}` produces `request({method, endpoint, fields, paginate})` without accepting credentials as values.
- `createGitHubGateway({transport, clock})` produces own enumerable `{snapshot, inspect, apply}` functions required by the core runtime.
- `snapshot(query): Promise<GitHubSnapshot>` accepts explicit organization, Project, and repository IDs.
- `inspect(operations): Promise<ObservedOperation[]>` resolves current revisions before apply.
- `apply(operations, {idempotencyKey}): Promise<OperationResult[]>` applies in input order and returns succeeded/skipped/failed states.

- [ ] Write gateway tests with a fake transport for Project V2 fields/items, native parent/subissues, issues, milestones, refs, compare, PRs, reviews, check suites, rules, tags, workflow runs, releases, and package evidence.
- [ ] Add hostile-response cases for unknown fields, missing node IDs, duplicate paginated nodes, invalid cursors, branch names outside the requested repository, PR base mismatch, and an issue URL pointing to another repository.
- [ ] Run `node --test test/core-github-gateway.test.js` and verify the missing module failure.
- [ ] Implement `createGhTransport` with `execFile("gh", ["api", endpoint, ...args], {input, cwd})`. Inherit authentication from the process environment; redact environment-derived headers from every thrown error.
- [ ] Keep GraphQL documents as exported constants with explicit variables; require every page to advance `endCursor`, reject repeated cursors, and cap pages according to organization policy.
- [ ] Normalize every remote object to a closed plain record before domain use. Preserve node ID, database number, URL, updated revision, and exact repository identity for optimistic checks.
- [ ] Map operation resources/actions to explicit handlers. Use stable managed markers/idempotency keys to inspect before create; return `skipped` only when the full desired payload and relationship match.

```js
export function createGitHubGateway({transport,clock}) {
  return Object.freeze({
    snapshot:query => loadSnapshot(transport,query,clock),
    inspect:operations => inspectOperations(transport,operations),
    apply:(operations,options) => applyOperations(transport,operations,options),
  });
}
```

- [ ] Bind this gateway in `createCoreRuntime` when a fake was not explicitly injected. Add the test to `integration`, run integration lane, and commit.

```bash
git add src/core/github src/core/runtime.js test/core-github-gateway.test.js scripts/test-manifest.json
git commit -m "feat(core): add typed GitHub organization gateway"
```

### Task 2: Build the pure desired-state reconciler

**Files:**

- Create: `src/core/reconcile/snapshot.js`
- Create: `src/core/reconcile/derive.js`
- Create: `src/core/reconcile/plan.js`
- Create: `test/core-reconciler.test.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `normalizeReconcileSnapshot({organization, project, repositories, control}): ReconcileSnapshot` joins by stable node/issue IDs, not titles.
- `deriveDesiredOrganizationState(snapshot): DesiredState` calls the same work/release/review rules from plans 2 and 3.
- `planReconciliation(snapshot, desired): {findings, operations}` emits only drift repairs and missing declared artifacts.
- Finding severity: `ERROR | WARNING | INFO`; repairability: `AUTO | AUTHORITY_REQUIRED | MANUAL`.

- [ ] Write pure tests for correct state, manual Status/Gate edit, wrong branch/base field, missing Project membership, missing native parent, stale review after push, wrong PR base, orphan physical branch, absent equal-head release PR, and a partially applied receipt.
- [ ] Add tests proving human issue text and PR text outside managed markers never produce an update operation.
- [ ] Run `node --test test/core-reconciler.test.js` and verify the missing module failure.
- [ ] Normalize GitHub and control snapshots with exact revision bindings. When the same stable ID appears with conflicting repositories or numbers, emit a non-repairable ERROR and no mutation.
- [ ] Derive desired work fields through `deriveWorkItemState`, dependency readiness through the graph module, review freshness through exact head SHA, and release state through the program transition rules.
- [ ] Sort findings by repository, entity kind, stable ID, then code; sort operations by dependency phase so schema/Project membership precedes fields, branches precede PRs, and PR verification precedes merge.

```js
export const RECONCILE_PHASE=Object.freeze({
  PROJECT_SCHEMA:10,
  MEMBERSHIP:20,
  RELATIONSHIP:30,
  MILESTONE:40,
  BRANCH:50,
  PULL_REQUEST:60,
  REVIEW:70,
  PROJECT_FIELDS:80,
  RELEASE_EVIDENCE:90,
});
```

- [ ] For partial receipts, mark already succeeded operations as recorded skips; resume only operations whose expected revisions still match. Otherwise emit `RECONCILE_REQUIRED` conflict.
- [ ] Add the test to `fast`, run fast lane, and commit.

```bash
git add src/core/reconcile test/core-reconciler.test.js scripts/test-manifest.json
git commit -m "feat(core): derive deterministic organization reconciliation"
```

### Task 3: Implement `sync` with partial receipt recovery

**Files:**

- Create: `src/core/reconcile/runner.js`
- Create: `src/core/commands/operations.js`
- Create: `test/core-sync.test.js`
- Modify: `src/core/commands/router.js`
- Modify: `scripts/test-manifest.json`
- Modify: `scripts/test-boundaries.json`

**Interfaces:**

- `sync` reads fresh GitHub/control snapshots, returns an exact repair preview by default, and applies through the plan 1 operation runner.
- `reconcileOnce({scope, services}): Promise<{snapshot_revision, findings, preview, final_state}>` never recursively retries a changed remote revision.
- `resumePartialReceipt(receipt, snapshot): {operations, blocked}` preserves succeeded operation evidence.

- [ ] Write integration tests for a no-op sync, repairable machine-field drift, interrupted multi-operation apply, second-run resume, stale revision conflict, safe declared compensation, failed compensation, and final Project status update.
- [ ] Run `node --test test/core-sync.test.js` and verify the missing runner/handler.
- [ ] Implement one fresh snapshot per preview. Include snapshot revision hashes in the intent; reject `--apply` when any current revision differs rather than silently recalculating.
- [ ] Implement partial receipt recovery from exact operation IDs and observed revisions. Never repeat a recorded success and never compensate an operation lacking an explicit `compensation` payload in its original intent.
- [ ] After apply, load a fresh observed snapshot, derive fields again, append a reconciliation receipt, and return the observed final state plus next command.

```js
export async function reconcileOnce({scope,services}) {
  const observed=await services.github.snapshot(scope);
  const normalized=normalizeReconcileSnapshot({
    organization:observed.organization,
    project:observed.project,
    repositories:observed.repositories,
    control:await services.control.loadOrganizationState(),
  });
  const desired=deriveDesiredOrganizationState(normalized);
  return services.operations.execute({
    command:scope.command,
    source:{revision:normalized.revision},
    operations:planReconciliation(normalized,desired).operations,
    authority:scope.authority,
  });
}
```

- [ ] Route `sync` through `src/core/commands/operations.js`; preserve read-only behavior without `--apply` and the global `--dry-run` guarantee.
- [ ] Add the test to `integration`, add `core.reconcile-partial-resume` and `core.reconcile-machine-fields` guarantees, run integration plus boundary validation, and commit.

```bash
git add src/core/reconcile/runner.js src/core/commands/operations.js src/core/commands/router.js test/core-sync.test.js scripts/test-manifest.json scripts/test-boundaries.json
git commit -m "feat(core): reconcile drift and partial operations"
```

### Task 4: Implement read-only `audit` and `doctor`

**Files:**

- Create: `src/core/audit.js`
- Create: `src/core/doctor.js`
- Create: `test/core-audit-doctor.test.js`
- Modify: `src/core/commands/operations.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `audit` returns invariant findings across Project, issue, parent/subissue, milestone, branch, PR, review, release, and control-ledger relationships; it emits no operation intent.
- `doctor` validates authentication, required scopes, organization Project schema, repository permissions/rules, installed workflows, control Git health, and policy revision.
- `runAudit(snapshot): {ok, findings, summary}` and `runDoctor(probes): {ok, checks, remediation}` are deterministic after probe input.

- [ ] Write tests covering each invariant: unregistered repository item, missing parent, cycle, branch/base mismatch, issue/epic PR to main, cross-repository PR, two active releases, stale review, release evidence mismatch, duplicate immutable receipt, and machine-field drift.
- [ ] Write doctor tests for missing `gh` authentication, insufficient Project scope, missing issue/review/content permission, absent required field/options, unexpected default branch, weak rules, missing workflow, dirty/diverged control repo, and healthy configuration.
- [ ] Run `node --test test/core-audit-doctor.test.js` and verify missing modules.
- [ ] Implement audit by reusing reconciler findings plus non-repairable invariant checks. Do not create an intent, update `last_reconciled_at`, or call gateway `apply`.
- [ ] Implement doctor probes as explicit own-data functions so tests cannot trigger the host credential store. Group checks as `AUTH`, `PROJECT`, `REPOSITORY`, `WORKFLOW`, `CONTROL`, and `POLICY`.
- [ ] Return stable remediation commands without tokens or secret values; use exit 5 for invalid configuration and exit 4 for a healthy configuration whose external permission gate blocks mutation.

```js
export function summarizeChecks(checks) {
  const failed=checks.filter(check => check.status==="FAIL");
  const blocked=checks.filter(check => check.status==="BLOCKED");
  return Object.freeze({
    ok:failed.length===0 && blocked.length===0,
    failed:failed.length,
    blocked:blocked.length,
    checks:Object.freeze(checks),
  });
}
```

- [ ] Wire `audit` and `doctor`, add the test to `fast`, run fast/integration, and commit.

```bash
git add src/core/audit.js src/core/doctor.js src/core/commands/operations.js test/core-audit-doctor.test.js scripts/test-manifest.json
git commit -m "feat(core): expose organization audit and health checks"
```

### Task 5: Package and install event/scheduled reconciliation workflows

**Files:**

- Create: `templates/core/toss-core-sync.yml`
- Create: `src/core/actions/template.js`
- Create: `test/core-actions.test.js`
- Modify: `src/core/commands/repository.js`
- Modify: `scripts/package-artifact-test.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `renderSyncWorkflow({controlRepository, nodeVersion, clientIdVariable, privateKeySecret}): string` returns stable YAML with no credential values.
- `repo add` validates or previews installation at `.github/workflows/toss-core-sync.yml` in the registered repository.
- Events: issue/PR/review/check/workflow changes, manual dispatch, and scheduled drift check; concurrency serializes by repository and scope.

- [ ] Write YAML-structure tests for declared triggers, exact permissions, concurrency, Node 20+, package invocation, non-interactive apply pair, secret-name interpolation, and absence of plaintext token/private-key patterns.
- [ ] Add tests proving event payload text cannot broaden scope: the workflow passes repository/event identifiers, and the CLI resolves registered scope from the control repository.
- [ ] Run `node --test test/core-actions.test.js` and verify the missing template/module.
- [ ] Implement the workflow with immutable `actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1` (`v3.2.0`), configured Client ID variable/private-key secret names, organization owner, and explicit registered repositories; then install the packed CLI and run `toss-core sync --apply --non-interactive --json`. Set built-in permissions read-only; the short-lived App token owns the separately validated Project/repository writes.

```yaml
permissions:
  contents: read
  issues: read
  pull-requests: read
  checks: read
steps:
  - id: app-token
    uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
    with:
      client-id: ${{ vars.TOSS_CORE_APP_CLIENT_ID }}
      private-key: ${{ secrets.TOSS_CORE_APP_PRIVATE_KEY }}
      owner: ${{ github.repository_owner }}
```

- [ ] Trigger on issue, pull request, pull-request review, check-suite completion, workflow-run completion, `workflow_dispatch`, and a daily schedule. Use `concurrency.group: toss-core-${{ github.repository }}-${{ github.event_name }}` and do not cancel in progress.
- [ ] Extend `repo add` operations to inspect/install the exact template and record its blob SHA in repository config. A changed installed workflow is drift; updating it uses a normal preview/apply intent.
- [ ] Extend packed-artifact tests to assert the template exists and `renderSyncWorkflow` imports from extracted bytes.
- [ ] Add the test to `e2e`, run e2e/package lanes, and commit.

```bash
git add templates/core src/core/actions src/core/commands/repository.js test/core-actions.test.js scripts/package-artifact-test.js scripts/test-manifest.json
git commit -m "feat(core): install event and schedule reconciliation"
```

### Task 6: Add isolated live verification without production fixtures

**Files:**

- Create: `test/core-live-github.test.js`
- Create: `docs/testing/toss-core-live-github.md`
- Modify: `scripts/test-manifest.json`
- Modify: `scripts/test-boundaries.json`

**Interfaces:**

- Live tests run only when `TOSS_CORE_TEST_ORG`, `TOSS_CORE_TEST_PROJECT_NUMBER`, `TOSS_CORE_TEST_REPOSITORY`, and `TOSS_CORE_LIVE_TEST=1` are all present.
- The repository and Project must carry a `toss-core-test-fixture` marker validated before any write.
- Cleanup closes/removes only resources created under the run-specific marker and records their IDs.

- [ ] Write the live test with an unconditional safe skip when any opt-in value is absent; assert that repository/project names cannot equal configured production TOSS OS identities.
- [ ] Run `node --test test/core-live-github.test.js` without environment values and verify a clean skip with zero transport calls.
- [ ] Implement a run marker `toss-core-live-${GITHUB_RUN_ID || process.pid}-${randomUUID()}` and preflight the fixture markers before creating an issue, Project item, branch, PR, formal review, and field updates.

```js
const enabled=process.env.TOSS_CORE_LIVE_TEST==="1";
test("isolated GitHub lifecycle",{skip:enabled ? false : "live fixture not enabled"},async t => {
  const fixture=assertIsolatedFixture(process.env);
  const runMarker=createLiveRunMarker(process.env.GITHUB_RUN_ID,process.pid);
  t.after(() => cleanupMarkedResources(fixture,runMarker));
  await verifyLiveLifecycle(fixture,runMarker);
});
```

- [ ] Verify parent/subissue, milestone, branch/PR base, review freshness, check snapshot, and idempotent second apply through the real gateway.
- [ ] In test teardown, query exact run markers, close PR/issues, delete run branches, remove Project items, and fail if any discovered target lacks the run marker. Do not delete repositories, Projects, milestones shared with other runs, tags, or releases.
- [ ] Document required GitHub App scopes, fixture setup, safe names, and recovery audit command.
- [ ] Add the test to `e2e`, add `core.github-isolated-live-boundary` as a real-cli guarantee, run e2e without opt-in and then once in the isolated fixture when credentials are available.
- [ ] Commit the reconciliation/Actions integration.

```bash
git add test/core-live-github.test.js docs/testing/toss-core-live-github.md scripts/test-manifest.json scripts/test-boundaries.json
git commit -m "test(core): verify isolated GitHub reconciliation"
```

## Plan 4 Completion Gate

- [ ] Run `npm run test:fast`, `npm run test:integration`, `npm run test:e2e`, and `npm run test:package` from a clean worktree.
- [ ] Run `toss-core doctor --json` against the isolated fixture and verify no secret values appear in stdout, stderr, preview, intent, or receipt.
- [ ] Manually edit one machine-owned fixture field and confirm scheduled/explicit sync restores it while preserving surrounding issue/PR text.
- [ ] Interrupt one fake apply after a successful branch operation and confirm the next sync records a skip for the branch and resumes the remaining PR/field operations.
- [ ] Run `git diff --check` and record the reconciliation commit SHA in plan 5 execution notes.
