# Modular Governance v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the oversized default governance scaffold with a mandatory lean Core profile, an explicit optional Delivery profile, and one canonical Superpowers technical-execution contract.

**Architecture:** Parse and validate governance profile input before destination creation, then copy profile assets from validated JSON manifests. Core owns authority, work state, and evidence outcomes; Delivery adds production operations; `SUPERPOWERS.md` alone owns technical method routing. Incomplete Assurance, LangSmith, and Trusted Evaluator assets are removed rather than copied or silently activated.

**Tech Stack:** Node.js 20+ ESM, built-in `assert`, `fs`, `path`, and `child_process`, YAML 2.x, Markdown templates, JSON profile manifests, Git.

## Global Constraints

- TOSS CLI target version is `2.0.0` and governance version is `2.0.0`.
- Superpowers remains `REQUIRED`; no TOSS technical-execution fallback may be added.
- Canonical `superpowers:*` capability identifiers may appear only in root `SUPERPOWERS.md`.
- Core is mandatory; Delivery is installed only for Boolean `governance.delivery: true`.
- The v2 Project Brief default is Boolean `governance.delivery: false`; `AUTO` is not valid for this field.
- Assurance is not selectable in v2; `governance.assurance: true` must fail before destination mutation.
- Core output must not contain LangSmith, `Klinik360`, `o3-mini`, Claude trajectory, Trusted Evaluator, or `governance-certification` content.
- Required status checks are emitted only from explicit `delivery.required_status_checks` values.
- Existing generated projects are not modified automatically.
- Do not tag, publish, or open a release as part of implementation.
- Design source: `docs/superpowers/specs/2026-08-15-modular-governance-v2-design.md`.

## File Structure

### Create

- `src/governance-config.js` — validate and resolve Core/Delivery input and explicit required checks.
- `src/profile-assets.js` — load, validate, and copy profile manifests.
- `src/reference-integrity.js` — validate generated local references and ownership boundaries.
- `scripts/governance-config-test.js` — focused configuration and pre-write failure tests.
- `scripts/profile-assets-test.js` — profile manifest and source-asset tests.
- `scripts/reference-integrity-test.js` — generated-output ownership and local-reference tests.
- `templates/governance/core/manifest.json` — exact Core governance asset list.
- `templates/governance/core/project-management/GOVERNANCE.md` — authority, truth, precedence, and PM constitution.
- `templates/governance/core/project-management/WORK.md` — Objective, Task, assignment, and state rules.
- `templates/governance/core/project-management/QUALITY.md` — evidence and quality outcome rules.
- `templates/governance/core/project-management/PROJECT_STATE.md` — compact recovery state.
- `templates/governance/core/project-management/AGENT_REGISTRY.md` — selected specialist inventory.
- `templates/governance/core/project-management/templates/OBJECTIVE.md` — Objective record.
- `templates/governance/core/project-management/templates/TASK.md` — Task lifecycle record.
- `templates/governance/core/project-management/templates/DECISION.md` — protected decision record.
- `templates/governance/core/project-management/templates/RISK.md` — risk record.
- `templates/governance/core/project-management/templates/WAIVER.md` — scoped waiver record.
- `templates/governance/profiles/delivery/manifest.json` — exact Delivery asset list.
- `templates/governance/profiles/delivery/project-management/policies/DELIVERY.md` — release, deployment, infrastructure, and advanced delivery-security rules.
- `templates/governance/profiles/delivery/project-management/policies/OPERATIONS.md` — data remediation and incident rules.
- `templates/governance/profiles/delivery/project-management/templates/RELEASE.md` — release record.
- `templates/governance/profiles/delivery/project-management/templates/INCIDENT.md` — incident record.
- `templates/governance/profiles/delivery/project-management/templates/DATAFIX.md` — data-remediation record.
- `docs/migrations/governance-v2.md` — manual v1-to-v2 migration guide.

### Modify

- `src/cli.js` — preflight configuration, manifest-driven copying, v2 state, ruleset checks, and LangSmith removal.
- `scripts/smoke-test.js` — Core, Delivery, invalid-input, state, and ruleset scenarios.
- `templates/project-brief.yaml` — `governance.delivery: false`, remove LangSmith, add explicit required-check list.
- `templates/project.json` — v2 profile state; remove LangSmith and trusted-evaluator state.
- `templates/AGENTS.md` — concise provider-neutral bootstrap.
- `templates/SUPERPOWERS.md` — retain sole routing ownership and remove any stale governance paths.
- `templates/README.project.md` — document Core and optional Delivery output.
- `templates/PROJECT_BRIEF_GUIDE.md` — document governance fields and remove LangSmith guidance.
- `templates/GLOBAL_AGENT_CATALOG.md` — governance version 2.0.0.
- `templates/GLOBAL_AGENT_CATALOG.json` — governance version 2.0.0.
- `README.md` — v2 behavior, profile selection, and removed incomplete integrations.
- `package.json` — version 2.0.0, test chain, and keywords.
- `package-lock.json` — package version synchronization.

### Delete

- `templates/governance/.claude/`
- `templates/governance/.github/`
- `templates/governance/project-management/`
- `templates/.env.example`
- `templates/PM_BOOTSTRAP_STATE.md`
- `templates/AGENT_CAPABILITY_PLAN.md`
- `templates/AGENT_PROPOSAL.md`

The new `templates/governance/core/` and `templates/governance/profiles/` trees are created before deleting the legacy sibling tree.

---

### Task 1: Governance Configuration Preflight

**Files:**
- Create: `src/governance-config.js`
- Create: `scripts/governance-config-test.js`
- Modify: `src/cli.js`
- Modify: `templates/project-brief.yaml`
- Modify: `package.json`

**Interfaces:**
- Produces: `resolveGovernanceProfiles(brief: object): Readonly<{core: true, delivery: boolean}>`.
- Consumes: the parsed Project Brief object before `createFromConfig()` is called.

- [ ] **Step 1: Write focused failing configuration tests**

Create `scripts/governance-config-test.js` with tests that assert:

```js
import assert from "node:assert/strict";
import { resolveGovernanceProfiles } from "../src/governance-config.js";

assert.deepEqual(resolveGovernanceProfiles({}), { core:true, delivery:false });
assert.deepEqual(
  resolveGovernanceProfiles({ governance:{ delivery:true } }),
  { core:true, delivery:true },
);
assert.throws(
  () => resolveGovernanceProfiles({ governance:{ delivery:"AUTO" } }),
  /governance\.delivery must be true or false/,
);
assert.throws(
  () => resolveGovernanceProfiles({ governance:{ assurance:true } }),
  /governance\.assurance is not supported/,
);
assert.throws(
  () => resolveGovernanceProfiles({ governance:{ unknown:true } }),
  /unknown governance key: unknown/,
);

console.log("Governance configuration test: PASS");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node ./scripts/governance-config-test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/governance-config.js`.

- [ ] **Step 3: Implement the configuration resolver**

Create `src/governance-config.js` with this behavior:

```js
const ALLOWED_GOVERNANCE_KEYS = new Set(["delivery"]);

export function resolveGovernanceProfiles(brief={}) {
  const governance=brief.governance ?? {};
  if (typeof governance !== "object" || governance === null || Array.isArray(governance)) {
    throw new TypeError("Project Brief governance must be an object.");
  }
  if (governance.assurance === true) {
    throw new TypeError(
      "Project Brief governance.assurance is not supported in TOSS CLI 2.0.",
    );
  }
  for (const key of Object.keys(governance)) {
    if (!ALLOWED_GOVERNANCE_KEYS.has(key)) {
      throw new TypeError(`Project Brief contains unknown governance key: ${key}`);
    }
  }
  const delivery=governance.delivery ?? false;
  if (typeof delivery !== "boolean") {
    throw new TypeError("Project Brief governance.delivery must be true or false.");
  }
  return Object.freeze({core:true,delivery});
}
```

In `src/cli.js`, import the resolver. In the `create` branch, resolve profiles immediately after `validateBrief(data)` and before `createFromConfig()`. Convert thrown validation errors to `die(error.message)`. Pass the result as `a.governanceProfiles`. Set legacy fast-scaffold input to `{core:true,delivery:false}`.

Add this exact Project Brief block after `security`:

```yaml
governance:
  delivery: false
```

Add the focused test before the smoke test in `package.json`:

```json
"test": "node ./scripts/governance-config-test.js && node ./scripts/smoke-test.js"
```

- [ ] **Step 4: Add CLI no-mutation regression cases**

Extend `scripts/governance-config-test.js` to create complete temporary briefs, spawn `toss create`, and verify both invalid cases return nonzero without creating their project slug directories:

```js
assert.equal(fs.existsSync(path.join(tmp,"invalid-governance-project")),false);
assert.equal(fs.existsSync(path.join(tmp,"unsupported-assurance-project")),false);
```

The invalid briefs must otherwise contain all fields required by `validateBrief`, ensuring governance validation is the observed failure.

- [ ] **Step 5: Run Task 1 tests and verify GREEN**

Run: `node ./scripts/governance-config-test.js && node ./scripts/smoke-test.js`

Expected: both scripts print `PASS` and exit 0.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/governance-config.js src/cli.js scripts/governance-config-test.js templates/project-brief.yaml package.json
git commit -m "feat: validate governance profiles before generation"
```

---

### Task 2: Lean Core Profile Assets

**Files:**
- Create: `src/profile-assets.js`
- Create: `scripts/profile-assets-test.js`
- Create: `templates/governance/core/manifest.json`
- Create: all ten Core `project-management` files listed in File Structure.
- Modify: `package.json`

**Interfaces:**
- Produces: `loadProfileManifest(profileRoot: string): {profile: string, version: string, files: string[]}`.
- Produces: `copyProfileAssets(profileRoot: string, destination: string, manifest?: object): void`.
- Consumes: profile-relative file paths containing neither absolute paths nor `..` traversal.

- [ ] **Step 1: Write failing manifest tests**

Create `scripts/profile-assets-test.js`. It must assert that:

```js
const EXPECTED_CORE_FILES=[
  "project-management/GOVERNANCE.md",
  "project-management/WORK.md",
  "project-management/QUALITY.md",
  "project-management/PROJECT_STATE.md",
  "project-management/AGENT_REGISTRY.md",
  "project-management/templates/OBJECTIVE.md",
  "project-management/templates/TASK.md",
  "project-management/templates/DECISION.md",
  "project-management/templates/RISK.md",
  "project-management/templates/WAIVER.md",
];
```

- The real Core manifest has profile `core`, version `2.0.0`, and exactly the file list above.
- Every listed source is a regular file.
- Duplicate paths, absolute paths, traversal paths, missing files, and non-array `files` values throw descriptive errors.
- Copying a temporary valid manifest reproduces exact relative paths in a temporary destination.

- [ ] **Step 2: Run the manifest test and verify RED**

Run: `node ./scripts/profile-assets-test.js`

Expected: FAIL because `src/profile-assets.js` or the Core manifest does not exist.

- [ ] **Step 3: Implement safe manifest loading and copying**

Create `src/profile-assets.js` using `fs` and `path`. Apply these checks before copying:

```js
function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new TypeError("Profile manifest file paths must be non-empty strings.");
  }
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new TypeError(`Unsafe profile asset path: ${relativePath}`);
  }
}
```

`loadProfileManifest(profileRoot)` reads `manifest.json`, validates `profile`, exact version `2.0.0`, a unique `files` array, and the existence of every regular source file. `copyProfileAssets()` accepts a previously validated manifest or calls the loader when one is omitted, then creates only destination parent directories and copies each file.

- [ ] **Step 4: Create the exact Core manifest**

Create `templates/governance/core/manifest.json`:

```json
{
  "profile": "core",
  "version": "2.0.0",
  "files": [
    "project-management/GOVERNANCE.md",
    "project-management/WORK.md",
    "project-management/QUALITY.md",
    "project-management/PROJECT_STATE.md",
    "project-management/AGENT_REGISTRY.md",
    "project-management/templates/OBJECTIVE.md",
    "project-management/templates/TASK.md",
    "project-management/templates/DECISION.md",
    "project-management/templates/RISK.md",
    "project-management/templates/WAIVER.md"
  ]
}
```

- [ ] **Step 5: Write the five Core canonical documents**

Create the Core documents with these exact responsibility sections and invariants:

- `GOVERNANCE.md`: Purpose; Normative Language; Precedence; Truth Rules; Verified CEO Authority; Untrusted Content; PM Authority; Prohibited Actions; A1/A2/A3 Ambiguity; Protected Decisions; Superpowers Boundary; Production Boundary Summary; Self-Modification; Cold Start.
- `WORK.md`: Objective Capture; Readiness; Task States; Frozen Scope; Incidental Work; Change Control; Agent Selection; Assignment Boundary; Failure and Blocking; Evidence Handoff; Completion Authority; State Checkpointing.
- `QUALITY.md`: Risk-Based Validation Outcomes; Applicable Test Classes; Exact Candidate; Evidence States; Freshness; Conflicts; Review Findings; Security and Secret Hygiene; Data Safety; Compatibility; Documentation; Definition of Done; Waivers.
- `PROJECT_STATE.md`: Project Identity; Bootstrap State; Active Objectives; Active Tasks; Blocked Work; Pending CEO Decisions; Risks; Waivers; Environment State; Delivery Profile State; Agent State; Superpowers State; Next Actions; Known Unknowns.
- `AGENT_REGISTRY.md`: Status Vocabulary; Active Specialist table; Capability; Environment; Allowed Actions; Prohibited Actions; assignment and Task Contract requirement.

Preserve these exact truth invariants in `GOVERNANCE.md`:

```text
FAIL MUST NOT be represented as PASS.
UNKNOWN MUST NOT be represented as VERIFIED.
CLAIMED MUST NOT be represented as EVIDENCED without evidence.
Authority MUST NOT rewrite evidence.
```

Preserve these exact boundary statements across the canonical documents:

```text
Technical execution MUST follow the root SUPERPOWERS.md contract.
TOSS governance defines required outcomes and authority; it does not recreate the technical method.
A Superpowers result is technical evidence, not TOSS authorization or Task closure.
```

Do not include any `superpowers:*` capability identifier in `project-management` files.

- [ ] **Step 6: Write the five compact record templates**

Use YAML front matter with `governance_version: 2.0.0` and the following complete section contracts:

- `OBJECTIVE.md`: identity/status, verified source, CEO intent, outcome, scope, exclusions, constraints, acceptance conditions, dependencies, risks, decisions, Task links, closure evidence.
- `TASK.md`: identity/status/revision, Objective, outcome, scope, exclusions, acceptance criteria, assigned specialist, authority, prohibited actions, dependencies, risk impacts, required evidence, change history, completion evidence, PM disposition.
- `DECISION.md`: identity/status, authority source, context, options, decision, rationale, scope, consequences, supersession.
- `RISK.md`: identity/status, description, likelihood, impact, severity, owner, mitigation, trigger, evidence, residual risk, closure.
- `WAIVER.md`: identity/status, exact rule/gate, exact scope, current failed or unknown evidence, accepting authority, reason, risk, compensating controls, expiration, follow-up, final disposition.

Each template must use concrete empty fields such as `Status: DRAFT` and `Evidence: NONE` rather than unresolved markers.

- [ ] **Step 7: Add Core asset tests to the test chain and verify GREEN**

Set the `test` script to:

```json
"test": "node ./scripts/governance-config-test.js && node ./scripts/profile-assets-test.js && node ./scripts/smoke-test.js"
```

Run: `npm test`

Expected: all three scripts print `PASS` and exit 0; the existing smoke test still uses legacy generation until Task 3.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/profile-assets.js scripts/profile-assets-test.js templates/governance/core package.json
git commit -m "feat: define lean core governance profile"
```

---

### Task 3: Manifest-Driven Core Generation

**Files:**
- Modify: `src/cli.js`
- Modify: `scripts/smoke-test.js`
- Modify: `templates/project.json`
- Modify: `templates/AGENTS.md`
- Modify: `templates/SUPERPOWERS.md`
- Modify: `templates/README.project.md`
- Modify: `templates/PROJECT_BRIEF_GUIDE.md`
- Modify: `templates/GLOBAL_AGENT_CATALOG.md`
- Modify: `templates/GLOBAL_AGENT_CATALOG.json`
- Delete: legacy governance, LangSmith environment, bootstrap-state, capability-plan, and agent-proposal assets listed in File Structure.

**Interfaces:**
- Consumes: `a.governanceProfiles` from Task 1.
- Consumes: `copyProfileAssets(profileRoot, destination)` from Task 2.
- Produces: generated `project.json.governance.profiles` matching installed assets.

- [ ] **Step 1: Rewrite smoke expectations for Core and verify RED**

Change the primary generated-project assertions in `scripts/smoke-test.js` to require:

```js
const coreFiles=[
  "AGENTS.md",
  "CLAUDE.md",
  "SUPERPOWERS.md",
  "project-management/GOVERNANCE.md",
  "project-management/WORK.md",
  "project-management/QUALITY.md",
  "project-management/PROJECT_STATE.md",
  "project-management/AGENT_REGISTRY.md",
  "project-management/templates/OBJECTIVE.md",
  "project-management/templates/TASK.md",
  "project-management/templates/DECISION.md",
  "project-management/templates/RISK.md",
  "project-management/templates/WAIVER.md",
];
```

Assert former files such as `PM_AGENT.md`, `policies/LANGSMITH.md`,
`PM_BOOTSTRAP_STATE.md`, and `.github/workflows/pm-governance-certification.yml`
do not exist. Assert `project.json.governance.version === "2.0.0"`, Core is true,
Delivery is false, and neither top-level `langsmith` nor
`bootstrap_state.langsmith` exists.

Run: `node ./scripts/smoke-test.js`

Expected: FAIL because generation still copies legacy governance.

- [ ] **Step 2: Switch CLI generation to the Core manifest**

In `src/cli.js`:

- set `GOVERNANCE_VERSION = "2.0.0"`;
- import `loadProfileManifest` and `copyProfileAssets`;
- remove `copyTree()` and the unconditional `templates/governance` copy;
- resolve the Core profile root and call `loadProfileManifest(coreRoot)` before `ensureDir(dest)` so a missing source asset cannot create or partially mutate the destination;
- after destination checks and `ensureDir(dest)`, call `copyProfileAssets(coreRoot,dest,coreManifest)` with the validated manifest;
- remove LangSmith value rendering, state hydration, console output, Project Brief context, and legacy `--langsmith-project` parsing;
- remove `.env.example`, `PM_BOOTSTRAP_STATE.md`, `AGENT_CAPABILITY_PLAN.md`, and `AGENT_PROPOSAL.md` copy operations;
- preserve Project Brief, Design Brief, Design System, and Global Agent Catalog copying;
- update `hydrateProjectState(dest,name,remote,projectUrl)` to handle only project and repository state;
- write the resolved profile object into generated project state.

Update `templates/project.json` to this governance shape:

```json
"governance": {
  "version": "2.0.0",
  "root": "project-management",
  "execution_ssot": "GitHub Projects",
  "verified_ceo_github": "@toss-software",
  "profiles": {
    "core": true,
    "delivery": false
  },
  "global_agent_catalog": "project-management/GLOBAL_AGENT_CATALOG.json"
}
```

Retain the existing Superpowers state object. Remove trusted-evaluator and LangSmith bootstrap fields.

- [ ] **Step 3: Remove the legacy generated assets**

Run these exact repository removals after confirming the new Core tree exists:

```bash
git rm -r templates/governance/project-management
git rm -r templates/governance/.github templates/governance/.claude
git rm templates/.env.example templates/PM_BOOTSTRAP_STATE.md
git rm templates/AGENT_CAPABILITY_PLAN.md templates/AGENT_PROPOSAL.md
```

Do not remove `templates/governance/core` or root `templates/AGENTS.md`, `CLAUDE.md`, and `SUPERPOWERS.md`.

- [ ] **Step 4: Update retained bootstrap documents**

- Rewrite `templates/AGENTS.md` to approximately 40–60 lines. It must load `GOVERNANCE.md`, `WORK.md`, `QUALITY.md`, and `PROJECT_STATE.md` as applicable; load root `SUPERPOWERS.md` before technical work; block missing required capabilities; use Project Brief and Design Brief during first bootstrap; keep canonical state in repository records; and ask the CEO only for protected intent or authority decisions.
- Keep `templates/CLAUDE.md` exactly `@AGENTS.md` plus newline. Keep the canonical routing table only in `templates/SUPERPOWERS.md`, updating stale governance paths if present.
- Update `templates/README.project.md` to load `GOVERNANCE.md`, `WORK.md`, `QUALITY.md`, `PROJECT_STATE.md`, and `SUPERPOWERS.md`; remove certification and LangSmith claims.
- Update `templates/PROJECT_BRIEF_GUIDE.md` with Boolean `governance.delivery` behavior and remove LangSmith guidance.
- Set governance version `2.0.0` in both Global Agent Catalog files.
- In `writeBriefContext()`, include `governance:data.governance ?? {delivery:false}` and omit `langsmith`.

- [ ] **Step 5: Run Core generation tests and verify GREEN**

Run: `npm test`

Expected: configuration, asset, and smoke tests all pass. Generated Core output contains the new canonical files, omits legacy governance, and records Core true / Delivery false.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/cli.js scripts/smoke-test.js templates docs/superpowers/specs/2026-08-15-modular-governance-v2-design.md
git commit -m "feat: generate modular core governance"
```

---

### Task 4: Optional Delivery Profile

**Files:**
- Create: Delivery manifest and five Delivery files listed in File Structure.
- Modify: `src/cli.js`
- Modify: `scripts/profile-assets-test.js`
- Modify: `scripts/smoke-test.js`
- Modify: `templates/README.project.md`

**Interfaces:**
- Consumes: resolved `{delivery:boolean}` from Task 1.
- Consumes: `copyProfileAssets()` from Task 2.
- Produces: Delivery policy and record files only when Delivery is true.

- [ ] **Step 1: Write failing Delivery manifest and generation tests**

Add this exact expected list to `scripts/profile-assets-test.js`:

```js
const EXPECTED_DELIVERY_FILES=[
  "project-management/policies/DELIVERY.md",
  "project-management/policies/OPERATIONS.md",
  "project-management/templates/RELEASE.md",
  "project-management/templates/INCIDENT.md",
  "project-management/templates/DATAFIX.md",
];
```

Extend `scripts/smoke-test.js` with a second complete brief using
`governance.delivery: true`. Assert every Delivery file exists and
`project.json.governance.profiles.delivery === true`. Keep the Core scenario's
assertions that every Delivery file is absent.

Run: `npm test`

Expected: FAIL because the Delivery profile is not present or copied.

- [ ] **Step 2: Create the Delivery manifest**

Create `templates/governance/profiles/delivery/manifest.json`:

```json
{
  "profile": "delivery",
  "version": "2.0.0",
  "files": [
    "project-management/policies/DELIVERY.md",
    "project-management/policies/OPERATIONS.md",
    "project-management/templates/RELEASE.md",
    "project-management/templates/INCIDENT.md",
    "project-management/templates/DATAFIX.md"
  ]
}
```

- [ ] **Step 3: Write the Delivery policies and record templates**

Create `DELIVERY.md` with: Profile Scope; Merge vs Deployment; Explicit Merge Authority; Exact Artifact; Required Validation; Release Record; Manifest Freeze; Approval Invalidation; Deployment Authority; Change Windows; Infrastructure Preview; Configuration Safety; Rollout; Observation; Rollback; Provenance.

Create `OPERATIONS.md` with: Data Classification; Datafix Authority; Dry Run; Backup/Recovery; Incident Definition and Severity; Containment; Evidence Preservation; Stabilization vs Resolution; Post-Incident Review; Corrective Work.

Create record templates with `governance_version: 2.0.0`:

- `RELEASE.md`: exact artifact/SHA, scope, validations, migrations, infrastructure, rollout, approval, deployment, observation, rollback, final state.
- `INCIDENT.md`: severity, impact, facts, unknowns, timeline, containment, recovery, verification, root cause, corrective work, closure.
- `DATAFIX.md`: target/data class, current and expected state, exact mutation, dry run, backup, recovery, approval, executor, evidence, final state.

Do not include a `superpowers:*` identifier or Assurance-provider content.

- [ ] **Step 4: Enable conditional Delivery copying**

In `createFromConfig()`, after copying Core:

```js
if (a.governanceProfiles.delivery) {
  copyProfileAssets(deliveryRoot,dest,deliveryManifest);
}
```

Resolve `deliveryRoot` and `deliveryManifest` before `ensureDir(dest)` whenever
Delivery is enabled. Do not validate or copy Delivery assets when Delivery is
false.

Write the exact resolved profile object into `project.json` before repository initialization. Update the generated README to state whether Delivery is installed without claiming production authority.

- [ ] **Step 5: Run profile matrix tests and verify GREEN**

Run: `npm test`

Expected: both Core-only and Core-plus-Delivery fixtures pass exact presence/absence and state assertions.

- [ ] **Step 6: Commit Task 4**

```bash
git add templates/governance/profiles/delivery src/cli.js scripts/profile-assets-test.js scripts/smoke-test.js templates/README.project.md
git commit -m "feat: add optional delivery governance profile"
```

---

### Task 5: Explicit Ruleset Status Checks

**Files:**
- Modify: `src/governance-config.js`
- Modify: `scripts/governance-config-test.js`
- Modify: `src/cli.js`
- Modify: `scripts/smoke-test.js`
- Modify: `templates/project-brief.yaml`

**Interfaces:**
- Produces: `resolveRequiredStatusChecks(brief: object): string[]`.
- Consumes: top-level `delivery.required_status_checks` as an array of unique non-empty strings.
- Produces: a ruleset without `required_status_checks` when the resolved list is empty.

- [ ] **Step 1: Write failing required-check tests**

Add to `scripts/governance-config-test.js`:

```js
assert.deepEqual(resolveRequiredStatusChecks({}),[]);
assert.deepEqual(
  resolveRequiredStatusChecks({delivery:{required_status_checks:["ci","security"]}}),
  ["ci","security"],
);
assert.throws(
  () => resolveRequiredStatusChecks({delivery:{required_status_checks:"ci"}}),
  /delivery\.required_status_checks must be an array/,
);
assert.throws(
  () => resolveRequiredStatusChecks({delivery:{required_status_checks:["ci",""]}}),
  /non-empty strings/,
);
assert.throws(
  () => resolveRequiredStatusChecks({delivery:{required_status_checks:["ci","ci"]}}),
  /must not contain duplicates/,
);
```

Run: `node ./scripts/governance-config-test.js`

Expected: FAIL because the export does not exist.

- [ ] **Step 2: Implement required-check resolution**

Implement and export `resolveRequiredStatusChecks()`. Return a new array and do not mutate the brief. Add the default field:

```yaml
delivery:
  required_status_checks: []
```

Resolve checks in the `create` branch before calling `createFromConfig()` and store them as `a.requiredStatusChecks`. Legacy scaffold input uses an empty list.

- [ ] **Step 3: Make the ruleset conditional**

Change the signature to:

```js
function writeRulesetPayload(projectDir, requiredChecks=[]) {
```

Build deletion, non-fast-forward, and pull-request rules first. Append a `required_status_checks` rule only when `requiredChecks.length > 0`, mapping each name to `{context:name}`. Call it with `a.requiredStatusChecks`.

- [ ] **Step 4: Add generated ruleset assertions**

In the Core smoke fixture, parse `project-management/bootstrap/main-ruleset.json` and assert no rule has type `required_status_checks`. In another fixture with `required_status_checks: [ci, security]`, assert the exact contexts are `ci` and `security` and `governance-certification` is absent.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/governance-config.js scripts/governance-config-test.js src/cli.js scripts/smoke-test.js templates/project-brief.yaml
git commit -m "fix: require only configured status checks"
```

---

### Task 6: Generated Reference and Ownership Integrity

**Files:**
- Create: `src/reference-integrity.js`
- Create: `scripts/reference-integrity-test.js`
- Modify: `package.json`
- Modify: generated templates only when the new test finds a real dangling reference or forbidden owner duplication.

**Interfaces:**
- Consumes: generated Core and Core-plus-Delivery fixture directories.
- Produces: `validateGeneratedProject(projectRoot: string): void`.
- Produces: deterministic failure naming the source document and invalid token.

- [ ] **Step 1: Write the failing integrity test**

Create `scripts/reference-integrity-test.js` importing the not-yet-created
`validateGeneratedProject()` helper. Generate Core and Delivery fixtures from
complete temporary Project Briefs and call the helper for both.

Add a deliberately broken temporary fixture containing:

```markdown
See `scripts/missing.js`.
```

Assert `validateGeneratedProject()` throws an error containing both the source
Markdown filename and `scripts/missing.js`.

Run: `node ./scripts/reference-integrity-test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/reference-integrity.js`.

- [ ] **Step 2: Implement the integrity helper**

Create `src/reference-integrity.js`. Recursively scan generated `.md`, `.json`,
and `.yml` files.

For local-reference checks, inspect backtick tokens only when they:

- contain no whitespace;
- begin with `/project-management/`, `project-management/`, `.github/`, `scripts/`, `evaluators/`, or `trusted-evaluator-repo/`;
- contain no glob character or angle-bracket variable.

Strip a leading slash and optional `#fragment`, resolve from the generated project root, and assert the target exists.

For ownership checks, concatenate `project-management/**/*.md` and assert:

```js
assert.doesNotMatch(governanceText,/superpowers:[a-z0-9-]+/i);
```

For Assurance residue, scan the entire Core fixture and reject these patterns:

```js
const forbidden=[
  /LangSmith/i,
  /Klinik360/i,
  /o3-mini/i,
  /Claude Code Trajectory/i,
  /Trusted Evaluator/i,
  /governance-certification/i,
];
```

Also require root `SUPERPOWERS.md` to contain every canonical capability identifier already listed by the smoke test and `CLAUDE.md === "@AGENTS.md\n"`.

- [ ] **Step 3: Run the integrity test and fix only reported generated-output defects**

Run: `node ./scripts/reference-integrity-test.js`

Expected: the deliberately broken fixture is rejected, while generated Core
and Delivery fixtures pass. If a generated fixture fails, update the specific
template containing the reported token.

Do not weaken the scanner or add broad exclusions. External URLs remain
allowed because they do not match local prefixes.

- [ ] **Step 4: Add integrity validation to the full test chain**

Set:

```json
"test": "node ./scripts/governance-config-test.js && node ./scripts/profile-assets-test.js && node ./scripts/smoke-test.js && node ./scripts/reference-integrity-test.js"
```

Run: `npm test`

Expected: all four scripts print `PASS` and exit 0.

- [ ] **Step 5: Commit Task 6**

```bash
git add src/reference-integrity.js scripts/reference-integrity-test.js package.json templates
git commit -m "test: enforce governance reference integrity"
```

---

### Task 7: v2 Documentation, Migration, and Package Metadata

**Files:**
- Create: `docs/migrations/governance-v2.md`
- Modify: `README.md`
- Modify: `templates/README.project.md`
- Modify: `templates/PROJECT_BRIEF_GUIDE.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/smoke-test.js`

**Interfaces:**
- Produces: package version `2.0.0` without a tag.
- Produces: a manual migration map that preserves populated legacy records.

- [ ] **Step 1: Add failing v2 documentation and package assertions**

Extend `scripts/smoke-test.js` to assert:

```js
assert.equal(packageMetadata.version,"2.0.0");
assert.equal(lockMetadata.version,"2.0.0");
assert.equal(lockMetadata.packages[""].version,"2.0.0");
assert.equal(packageMetadata.keywords.includes("langsmith"),false);
assert.ok(packageMetadata.keywords.includes("modular-governance"));
assert.ok(fs.existsSync(path.join(root,"docs/migrations/governance-v2.md")));
```

Run: `node ./scripts/smoke-test.js`

Expected: FAIL on version `1.2.1` or missing migration guide.

- [ ] **Step 2: Write the migration guide**

Create `docs/migrations/governance-v2.md` with:

- audience and v2 breaking-change warning;
- a backup/branch prerequisite;
- mapping from `PM_AGENT + GOVERNANCE + AUTHORITY` to new `GOVERNANCE.md`;
- mapping from Objective/Task/Agent policies to `WORK.md`;
- mapping from Evidence/Quality policies to `QUALITY.md`;
- mapping from five Task lifecycle templates to `TASK.md`;
- Delivery mappings for Release/Infrastructure/Security/Data/Incidents;
- removal list for LangSmith, benchmark, certification, and Trusted Evaluator assets;
- warning to preserve populated `PROJECT_STATE`, decision, risk, release, incident, datafix, and waiver records;
- instruction to remove `governance-certification` from required checks unless a real external evaluator supplies it;
- verification commands `npm test` and `npm pack --dry-run` for the CLI repository;
- explicit statement that there is no automatic `toss migrate` in v2.

- [ ] **Step 3: Update user-facing documentation**

Rewrite README sections to describe:

- Core as default;
- `governance.delivery: true` as explicit opt-in;
- Superpowers as required technical method;
- Assurance as unavailable until a complete external module exists;
- removal of LangSmith and trusted-evaluator claims;
- explicit `delivery.required_status_checks` configuration;
- v2 migration guide link.

Ensure the generated README and Project Brief guide use the same terms and paths.

- [ ] **Step 4: Set package version without creating a tag**

Run:

```bash
npm version 2.0.0 --no-git-tag-version
```

Remove `langsmith` from keywords and add `modular-governance`. Confirm package and lock versions are both 2.0.0.

- [ ] **Step 5: Run complete verification**

Run each command and inspect the full output:

```bash
npm test
npm pack --dry-run
git diff --check
git status --short
```

Expected:

- all four test scripts print `PASS`;
- pack dry-run includes `bin`, `src`, `templates`, `README.md`, and `LICENSE` and exits 0;
- diff check emits no errors;
- status contains only intended Task 7 changes.

- [ ] **Step 6: Commit Task 7**

```bash
git add docs/migrations/governance-v2.md README.md templates/README.project.md templates/PROJECT_BRIEF_GUIDE.md package.json package-lock.json scripts/smoke-test.js
git commit -m "docs: prepare modular governance v2"
```

## Final Review Checklist

Before branch completion:

1. Compare every Success Criterion in the design spec with a passing assertion or inspected file.
2. Run `rg -n -i 'LangSmith|Klinik360|o3-mini|Trusted Evaluator|governance-certification' templates src scripts README.md` and confirm any result is limited to intentional negative tests or migration documentation outside generated Core assets.
3. Run `rg -n 'superpowers:[a-z0-9-]+' templates/governance` and expect no matches.
4. Run `npm test` and require exit 0.
5. Run `npm pack --dry-run` and require exit 0.
6. Run `git diff --check origin/main...HEAD` and require no output.
7. Use `superpowers:requesting-code-review` before integration.
8. Use `superpowers:finishing-a-development-branch` only after review findings are resolved and verification is fresh.
