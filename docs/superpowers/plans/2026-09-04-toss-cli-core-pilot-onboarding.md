# TOSS CLI Core Pilot Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the standalone `toss-core` control plane against `TOSS-Soft/toss-cli` from registration through one complete feature and release lifecycle, without putting Core code or configuration back into the product repository.

**Architecture:** Operate only from `TOSS-Soft/toss-core` central workflows through the GitHub App and the private `TOSS-Soft/toss-os-control` ledger. Close the remaining public reconciliation and health-command seams before cutover, register `toss-cli` with an exact receipt-backed boundary, leave all pre-cutover work unmanaged, and use one deliberately small post-cutover feature as the pilot.

**Tech Stack:** Node.js 20+, ESM, GitHub App installation tokens, GitHub Actions protected environments, GitHub Projects v2, Git Data/REST/GraphQL APIs, private `@toss-software/core`

**Spec:** `docs/superpowers/specs/2026-09-04-toss-core-extraction-design.md`

**Plan sequence:** 4 of 4. Requires all three preceding plans and is the gate for stable `@toss-software/core@1.0.0` plus additional repository onboarding.

## Global Constraints

- Start only after the extraction plan, `toss-cli` v2.1.3 removal plan, and GitHub App adapter plan are complete and independently accepted.
- The pilot uses `TOSS-Soft/toss-cli` only. Do not register `toss-agent-runtime` or `toss-console` before pilot acceptance.
- Core source, package dependencies, policy files, and repository-local Core configuration remain absent from `toss-cli`.
- Existing open issues, pull requests, branches, milestones, and Project items are never adopted or rewritten. Core owns only work carrying an exact post-registration managed marker.
- The registration receipt timestamp and bound default-branch revision form the forward-only cutover boundary.
- The GitHub App installation is restricted to `toss-core`, `toss-os-control`, and `toss-cli`; it receives no ruleset bypass.
- All mutations are previewed first. Gated mutations use a separately signed authority record tied to the exact preview, targets, revisions, policy, and expiry.
- A failed or partial receipt blocks the next mutation until reconciliation succeeds.
- The first pilot product change is documentation-only; it must not add Core files or package references to `toss-cli`.
- Do not publish `@toss-software/core@1.0.0` until every pilot acceptance criterion passes.

---

## File Structure

In `TOSS-Soft/toss-core`:

- `src/commands/sync.js` — receipt and release-readiness reconciliation
- `src/commands/audit.js` — read-only ledger/GitHub consistency audit
- `src/commands/doctor.js` — read-only runtime, permission, Project, and policy diagnostics
- `src/commands/router.js` — route the three already-declared commands
- `src/reconciliation/release.js` — pure release-PR/readiness projection
- `scripts/run-command-input.mjs` — shell-free workflow command launcher from the adapter plan
- `scripts/pilot/build-epic-plan.mjs` — deterministic empty-scope pilot plan builder
- `.github/workflows/toss-cli-pilot.yml` — protected central pilot workflow
- `test/core-reconciliation-commands.test.js` — public sync/audit/doctor coverage
- `test/pilot-command-input.test.js` — closed workflow input and plan-builder coverage
- `test/pilot-acceptance.test.js` — complete fake and stateless-restart pilot
- `docs/operations/toss-cli-pilot.md` — exact operator runbook and evidence template

Runtime data remains only in `TOSS-Soft/toss-os-control`:

- `config/organization.yaml`
- `config/repositories/TOSS-Soft/toss-cli.yaml`
- `policies/{lifecycle,release}.yaml`
- `programs/**/manifest.yaml`
- `operations/intents/**`
- `operations/receipts/**`

No pilot file is added to `TOSS-Soft/toss-cli` except the ordinary documentation change created by the managed pilot feature.

### Task 1: Implement public health and reconciliation commands

**Files:**
- Create: `src/commands/sync.js`
- Create: `src/commands/audit.js`
- Create: `src/commands/doctor.js`
- Create: `src/reconciliation/release.js`
- Modify: `src/commands/router.js`
- Modify: `scripts/test-manifest.json`
- Test: `test/core-reconciliation-commands.test.js`

**Interfaces:**
- Produces: `toss-core doctor`
- Produces: `toss-core audit [<PROGRAM-ID|OWNER/REPO>]`
- Produces: `toss-core sync [<PROGRAM-ID|OWNER/REPO>]`
- Consumes: existing control planning state, GitHub status snapshots, unresolved intent/receipt evidence, and release-PR intent

- [ ] **Step 1: Write failing public-router tests**

Add tests that call the already-declared commands through `runCoreCli`. `doctor` and `audit` must be read-only and make zero writes. `sync` without `--apply` must return a deterministic preview. The initial expected failure is `COMMAND_NOT_IMPLEMENTED`.

- [ ] **Step 2: Write failing pure release-reconciliation tests**

Cover these exact cases:

1. Draft PR absent with material release-branch difference: create the PR from the persisted intent.
2. Exact PR already present: no duplicate operation.
3. Release scope incomplete: remain `ACTIVE`.
4. Scope complete, exact release PR present, and current required checks available: apply `SCOPE_DONE` and enter `READY_FOR_APPROVAL`.
5. Default head, release head, PR identity, Project identity, manifest revision, or completed receipt drift: typed conflict before a write.
6. Failed/partial receipt: return `RECONCILE_REQUIRED` and only the safe continuation operations.

- [ ] **Step 3: Implement `doctor` and `audit`**

`doctor` reports closed checks for live configuration, App installation, control repository reachability, organization Project #2 fields, policy revision agreement, and registered-repository permissions. `audit` compares immutable ledger identities to fresh GitHub snapshots and emits sorted findings with severity `ERROR | WARNING | INFO`; it never repairs state.

- [ ] **Step 4: Implement one-phase `sync`**

Each invocation may complete only one immutable reconciliation phase. It must use the ordinary operation runner, planned receipt, preflight inspection, semantic ordering, partial-failure receipt, and replay logic. A retry consumes the stored receipt rather than generating different work.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test test/core-reconciliation-commands.test.js \
  test/core-release-activation.test.js test/core-release-completion.test.js \
  test/core-operation-runner.test.js test/core-control-store.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit the command seams**

```bash
git add src/commands/sync.js src/commands/audit.js src/commands/doctor.js \
  src/commands/router.js src/reconciliation/release.js \
  scripts/test-manifest.json test/core-reconciliation-commands.test.js
git commit -m "feat: reconcile and audit core state"
```

### Task 2: Verify central workflow command input for the pilot

**Files:**
- Create: `test/pilot-command-input.test.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**
- Consumes: `argv_json`, an exact JSON array of CLI argument strings
- Consumes: optional public `input_json`, optional public `authority_json`, and exact `expected_control_revision`
- Produces: one shell-free `toss-core` process and one canonical JSON result artifact

- [ ] **Step 1: Write the failing launcher tests**

Test valid preview/apply arrays with optional `input_json` and `authority_json`. Reject strings, objects, nested arrays, unknown options, duplicate options, embedded NUL/newline tokens, user-supplied `--from`/`--authority` paths, `--apply` in preview mode, missing `--apply` in apply mode, missing `--non-interactive`, missing `--json`, control-revision mismatch, and any attempt to invoke a shell metacharacter as syntax. Assert the child process is spawned with `shell:false`, a secure temporary cwd, and one exact argv array.

- [ ] **Step 2: Verify the adapter-plan launcher and workflows**

Require the adapter-plan workflows to execute only:

```yaml
- run: node scripts/run-command-input.mjs preview "$ARGV_JSON"
  env:
    ARGV_JSON: ${{ inputs.argv_json }}
```

and the equivalent `apply` mode. The apply workflow remains protected by the `production` environment and `toss-core-control` concurrency group. `authority_json` is approval evidence, not a secret; no private signing key enters Actions.

- [ ] **Step 3: Run workflow tests and commit**

```bash
node --test test/pilot-command-input.test.js test/live-workflow-contract.test.js
git add test/pilot-command-input.test.js scripts/test-manifest.json
git commit -m "ci: close central core command input"
```

### Task 3: Add a deterministic pilot plan builder

**Files:**
- Create: `scripts/pilot/build-epic-plan.mjs`
- Create: `test/pilot-plan-builder.test.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**
- Consumes: canonical repository identity, managed epic ID, exact `epic-prepare` snapshot, and RFC3339 creation time
- Produces: one canonical `epic-plan.v1` with no children or dependency edges

- [ ] **Step 1: Write the failing builder test**

Use a snapshot whose epic is `TOSS-Soft/toss-cli#401`. Require:

```json
{
  "schema_version": "epic-plan.v1",
  "plan_id": "EPIC-PLAN-TOSS-SOFT-TOSS-CLI-0401",
  "children": [],
  "edges": []
}
```

The remaining `source`, `epic`, `created_at`, and `content_sha256` fields must come from the exact closed snapshot and the existing `normalizeEpicPlan` hash rules. Hostile, stale, non-epic, cross-repository, and already-parented snapshots fail typed and produce no file.

- [ ] **Step 2: Implement the builder**

The script composes the live runtime, requests `{kind:"epic-prepare",id}`, projects only the immutable epic/source fields, calls the existing normalizer, and writes canonical JSON to stdout. It must not call `inspect`, `apply`, or the control commit port.

- [ ] **Step 3: Run and commit**

```bash
node --test test/pilot-plan-builder.test.js test/core-dependencies.test.js
git add scripts/pilot/build-epic-plan.mjs test/pilot-plan-builder.test.js scripts/test-manifest.json
git commit -m "feat: build deterministic pilot epic plans"
```

### Task 4: Provision the least-privilege pilot boundary

**Files:**
- Create: `docs/operations/toss-cli-pilot.md`
- Test: GitHub settings and live read-only preflight

**Interfaces:**
- Consumes: `TOSS-Soft/toss-core`, empty private `TOSS-Soft/toss-os-control`, `TOSS-Soft/toss-cli`, organization Project #2 (`PVT_kwDOEoXciM4BgvYM`)
- Produces: selected-repository GitHub App installation and protected pilot prerequisites

- [ ] **Step 1: Create the private control repository without an initial commit**

An organization owner creates `TOSS-Soft/toss-os-control` as private with README, license, and `.gitignore` initialization disabled. The repository therefore has no branch or commit. Add it to the GitHub App installation before Core bootstrap.

- [ ] **Step 2: Restrict the App installation**

Select exactly:

```text
TOSS-Soft/toss-core
TOSS-Soft/toss-os-control
TOSS-Soft/toss-cli
```

Grant only the permissions enumerated and contract-tested by the GitHub App adapter plan. Do not grant organization administration, secrets, environments, members, or ruleset bypass.

- [ ] **Step 3: Protect `toss-cli` main**

Create an organization ruleset targeting `refs/heads/main` in `TOSS-Soft/toss-cli`. Require pull requests, one independent approval, conversation resolution, and the exact required test checks used by the current `pull-request.yml`. Do not permit force push, deletion, or App bypass.

- [ ] **Step 4: Verify Project and repository identities**

Run the central preview workflow with:

```json
["doctor","--json"]
```

Require the Project node ID `PVT_kwDOEoXciM4BgvYM`, Project number `2`, required `Status` and `Gate` fields, private uninitialized control repository, protected `toss-cli` default branch, and exact selected-repository installation. Stop on any `ERROR` finding.

- [ ] **Step 5: Complete and review the operator runbook**

Document the App ID, installation ID, public authority key IDs, required environment names, Project node/number, ruleset ID, control repository identity, rollback procedure, and evidence locations. Never record the App private key or authority private key.

- [ ] **Step 6: Commit the runbook**

```bash
git add docs/operations/toss-cli-pilot.md
git commit -m "docs: define toss-cli core pilot operations"
```

### Task 5: Bootstrap control state and register `toss-cli`

**Files:**
- Create at runtime: control bootstrap configuration, policies, intent, and receipt
- Create at runtime: `config/repositories/TOSS-Soft/toss-cli.yaml`
- Create under runner temp only: `toss-cli-repository.json`
- Modify after execution: `docs/operations/toss-cli-pilot.md`

**Interfaces:**
- Consumes: separately signed `init` and `repo.add` authority records
- Produces: immutable bootstrap and registration receipts

- [ ] **Step 1: Preview and bootstrap the control ledger**

Dispatch preview argv:

```json
["init","--json"]
```

Review the exact Project/policy/repository operations, obtain an independent Ed25519 authority record for that preview, then dispatch:

```json
["init","--apply","--non-interactive","--json"]
```

Require one bootstrap intent and one completed receipt in the new control repository. Repeat the same apply and require a zero-write `already-initialized` result.

- [ ] **Step 2: Create the central registration input**

Write this exact JSON to runner temp, not to `toss-cli`:

```json
{
  "default_branch": "main",
  "project_owner": "TOSS-Soft",
  "project_number": 2,
  "publication": {
    "package_name": "@toss-software/cli",
    "workflow": "publish.yml",
    "required_assets": []
  }
}
```

- [ ] **Step 3: Preview and apply repository registration**

Preview:

```json
["repo","add","TOSS-Soft/toss-cli","--json"]
```

Supply the registration document through the workflow's `input_json`. After independent authority, apply the same command with `--apply --non-interactive`, supplying both `input_json` and `authority_json`. Require exact repository node/default-branch/Project/rules/publication evidence and one completed receipt.

- [ ] **Step 4: Freeze the cutover identity**

Define the cutover as the registration receipt's `created_at`, its exact intent/receipt SHA-256, and the bound `toss-cli` default-branch revision. Add these values to the operator runbook after execution. Inventory all open `toss-cli` issues and PRs at that revision and prove none contains a valid Core-managed request/child/review marker.

- [ ] **Step 5: Verify idempotency and read-only state**

Run the same `repo add` apply again, then:

```json
["repo","list","--json"]
["audit","TOSS-Soft/toss-cli","--json"]
```

Require one registered repository, zero second-run operations, zero audit errors, and no changes to pre-cutover issues, PRs, branches, milestones, or Project fields.

- [ ] **Step 6: Record bootstrap evidence**

Append the exact control revision, intent IDs, receipt IDs, cutover timestamp/revision, ruleset ID, App installation ID, and audit artifact hashes to `docs/operations/toss-cli-pilot.md`, then commit only the public identifiers and hashes.

### Task 6: Execute one post-cutover managed feature lifecycle

**Files:**
- Create under runner temp only: `pilot-feature.json`, `pilot-epic-plan.json`, and authority records
- Create in `toss-cli` through ordinary product development: `docs/core-governed-development.md`
- Modify after execution: `docs/operations/toss-cli-pilot.md`

**Interfaces:**
- Consumes: live GitHub App adapter and completed registration receipt
- Produces: one managed epic, exact review evidence, and completed release program

Every central-workflow invocation in this task includes `--json`; every apply invocation also includes `--apply --non-interactive`. The workflow appends `--from input.json` and `--authority authority.json` only from the separately supplied JSON inputs, so no operator-controlled filesystem path enters argv.

- [ ] **Step 1: Add the pilot feature through Core**

Use this exact feature input:

```json
{
  "title": "Document Core-governed product development",
  "description": "Add a concise contributor guide proving the standalone TOSS Core pilot without adding Core code or configuration to this product repository.",
  "priority": 100,
  "change_class": "backward_compatible_feature"
}
```

Supply the document as workflow `input_json`, then preview and apply logical argv `feature add TOSS-Soft/toss-cli`. Resolve the created epic by the deterministic managed-feature marker, not by assuming an issue number.

Store that canonical work-item identity as `EPIC_ID`. After submission, store its pull-request reference as `EPIC_PR_REFERENCE="TOSS-Soft/toss-cli#<resolved-pr-number>"`; neither value is guessed or hard-coded.

- [ ] **Step 2: Prepare and approve empty governed scope**

Generate `pilot-epic-plan.json` with `build-epic-plan.mjs`, supply it as workflow `input_json`, preview/apply logical argv `epic prepare "$EPIC_ID"`, and require `Backlog / EPIC_APPROVAL_REQUIRED`. Obtain independent authority for the exact approval preview, apply `epic approve "$EPIC_ID"`, and require `Backlog / RELEASE_PLANNING`.

- [ ] **Step 3: Plan and activate the release**

Preview/apply `release plan`, capture the returned `PROGRAM_ID` and independently selected `PILOT_VERSION`, then preview/apply `release activate "$PROGRAM_ID" TOSS-Soft/toss-cli`. Require milestone `v$PILOT_VERSION`, branch `release/v$PILOT_VERSION`, release-PR intent, assignment, and `epic/<N>-document-core-governed-product-development` branch.

- [ ] **Step 4: Make the ordinary product change**

Commit only `docs/core-governed-development.md` on the Core-created epic branch. The document explains that new work is requested centrally and contains no Core config, dependency, generated marker, credential, or workflow. Push the branch normally.

- [ ] **Step 5: Submit, review, and accept the epic**

Preview/apply `epic submit "$EPIC_ID"`. Resolve and persist `EPIC_PR_REFERENCE` from the resulting managed pull request. An independent reviewer approves the exact current PR head after required checks pass. Create the closed `review-result.v1` document from that review, supply it as workflow `input_json`, run logical argv `review record "$EPIC_PR_REFERENCE"`, verify `review status "$EPIC_PR_REFERENCE"`, obtain authority for `epic accept "$EPIC_ID"`, and apply. Require merge to the release branch, closed epic, and Project `Done / NONE` in one receipt-backed sequence.

- [ ] **Step 6: Reconcile release readiness**

Run `sync "$PROGRAM_ID"` one phase at a time until the release PR exists and the manifest reaches `READY_FOR_APPROVAL`. Every apply uses the exact preceding preview and produces one completed receipt; no invocation may skip a phase.

- [ ] **Step 7: Approve and publish the release**

After an independent release-PR review and exact required checks, set `RELEASE_TARGET="TOSS-Soft/toss-cli@$PILOT_VERSION"`, obtain authority, and apply `release approve "$RELEASE_TARGET"`. Re-enter the same command for each later publication phase as directed by `next_command`, without reusing authority where the command no longer accepts it. Require exact merge SHA, annotated tag `v$PILOT_VERSION`, package `@toss-software/cli@$PILOT_VERSION`, GitHub Release, workflow target SHA, package integrity, and publication receipt before the release/program becomes `RELEASED`.

- [ ] **Step 8: Prove terminal replay and preserved legacy work**

Repeat `release approve`, `sync`, `feature add`, and `repo add`; require zero new operations. Compare the pre-cutover inventory hashes and prove no legacy open issue, PR, branch, milestone, or Project item changed.

### Task 7: Run pilot acceptance and authorize wider onboarding

**Files:**
- Create: `test/pilot-acceptance.test.js`
- Modify: `scripts/test-manifest.json`
- Modify: `docs/operations/toss-cli-pilot.md`
- Create: `docs/releases/v1.0.0.md`

**Interfaces:**
- Consumes: complete pilot evidence and all prior plans
- Produces: explicit go/no-go result for `@toss-software/core@1.0.0` and additional repository registration

- [ ] **Step 1: Write the complete fake-to-live acceptance test before production execution**

The test uses only public CLI/runtime boundaries and a stateless adapter restart between every command. Cover bootstrap, registration, managed feature, empty epic plan, approval, release activation, ordinary branch change, review, acceptance, sync, release approval/publication, replay, and final audit. Include stale head, wrong Project, cross-repository identity, expired authority, partial receipt, missing check, pre-cutover marker absence, and product-local Core file rejection.

- [ ] **Step 2: Run all package gates**

```bash
npm run test:fast
npm run test:integration
npm run test:e2e
npm run test:package
npm test
git diff --check
```

Expected: PASS.

- [ ] **Step 3: Request independent security and lifecycle review**

The reviewer must verify the exact GitHub App installation, no App ruleset bypass, no long-lived token, authority separation, control CAS, marker-based forward-only ownership, receipt completeness, stateless replay, product package boundary, and live pilot evidence. Accepted findings receive failing regressions before closure.

- [ ] **Step 4: Run final live audit**

Run:

```json
["doctor","--json"]
["audit","TOSS-Soft/toss-cli","--json"]
["program","status","--json"]
["release","status","TOSS-Soft/toss-cli","--json"]
```

Require zero `ERROR` findings, a `RELEASED` pilot track, exact publication evidence, and no unresolved intent or failed receipt.

- [ ] **Step 5: Publish the acceptance record**

Fill `docs/operations/toss-cli-pilot.md` with the reviewed commit, package, program, release, intent, receipt, tag, Project, ruleset, workflow-run, and audit hashes. Commit the acceptance test, manifest ownership, runbook evidence, and `docs/releases/v1.0.0.md` preparation separately.

- [ ] **Step 6: Gate expansion and stable version**

Only after the independent review is accepted, publish private `@toss-software/core@1.0.0`. Then create separate preview/apply registrations for `TOSS-Soft/toss-agent-runtime` and `TOSS-Soft/toss-console`; neither registration is part of this pilot commit or transaction.

## Pilot Completion Gate

- [ ] `toss-cli` contains no Core source, dependency, configuration, policy, or embedded executable.
- [ ] The App installation is limited to the three approved repositories and has no ruleset bypass.
- [ ] The registration receipt provides an exact forward-only cutover timestamp and default-branch revision.
- [ ] Every pre-cutover item is byte/revision unchanged.
- [ ] One post-cutover feature reaches a verified `RELEASED` product version through public Core commands.
- [ ] Every mutation has a preflighted intent and immutable completed receipt; no unresolved or failed receipt remains.
- [ ] `doctor`, `audit`, status, replay, package, and full test gates pass.
- [ ] Only then may Core become `1.0.0` and the other product repositories enter separate onboarding plans.
