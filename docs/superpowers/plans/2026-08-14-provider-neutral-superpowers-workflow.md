# Provider-Neutral Superpowers Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a single provider-neutral Superpowers execution contract while preserving TOSS governance, project bootstrap, design governance, and provider auto-discovery.

**Architecture:** `SUPERPOWERS.md` becomes the canonical technical lifecycle contract. `AGENTS.md` becomes the shared provider-neutral project bootstrap, and the generated `CLAUDE.md` is reduced to the one-line `@AGENTS.md` discovery bridge. TOSS continues to own intent, authority, Task Contracts, state, evidence acceptance, and release authorization; Superpowers owns technical planning and execution methods.

**Tech Stack:** Node.js 20+, ECMAScript modules, built-in `node:assert`, YAML 2.x, Markdown templates, npm smoke tests.

## Global Constraints

- Superpowers is required for implementation, debugging, review, verification, and branch completion.
- There is no fallback to the former TOSS development method.
- Missing required capability sets `BLOCKED_SUPERPOWERS_MISSING`.
- Project and Design Brief discovery may continue while technical execution is blocked.
- `SUPERPOWERS.md` contains provider-neutral capability identifiers, never provider-specific invocation syntax.
- `CLAUDE.md` contains exactly `@AGENTS.md` plus the final newline.
- `AGENTS.md` contains shared bootstrap behavior and points to the canonical Superpowers contract without reproducing the lifecycle table.
- TOSS governance remains authoritative for intent, authority, evidence acceptance, release, deployment, rollout, and production mutation.
- Do not change package version, npm scope, publication workflow, or generated-project migration behavior in this feature.
- Existing Project Brief and Design Brief behavior must remain backward compatible.

## File Map

- Create `templates/SUPERPOWERS.md`: canonical provider-neutral technical lifecycle and missing-capability behavior.
- Create `templates/AGENTS.md`: provider-neutral TOSS session/bootstrap instructions, adapted from the existing `templates/CLAUDE.md` content.
- Replace `templates/CLAUDE.md`: one-line Claude Code import bridge.
- Modify `templates/project.json`: initial structured Superpowers state.
- Modify `templates/governance/project-management/PROJECT_STATE.md`: human-readable Superpowers runtime state.
- Modify `src/cli.js`: copy the new root templates and emit provider-neutral next-step output.
- Modify `scripts/smoke-test.js`: regression coverage for files, exact bridge content, routing, state, and no-fallback behavior.
- Modify `templates/governance/project-management/PM_AGENT.md`: TOSS/Superpowers authority boundary and routing.
- Modify `templates/governance/project-management/policies/AGENTS.md`: specialist compliance and missing-capability reporting.
- Modify `templates/governance/project-management/policies/TASKS.md`: Task execution delegation and blocked state.
- Modify `templates/governance/project-management/policies/QUALITY.md`: Superpowers evidence sources without weakening TOSS gates.
- Modify `templates/governance/project-management/policies/RELEASES.md`: branch completion delegation while preserving release authority.
- Modify `templates/README.project.md`: provider-neutral project startup.
- Modify `README.md`: installation contract and generated-file documentation.
- Modify `package.json`: replace the Claude-only discovery keyword with provider-neutral Superpowers keywords; do not change the version.

---

### Task 1: Generate the canonical Superpowers bootstrap and initial state

**Files:**
- Create: `templates/SUPERPOWERS.md`
- Create: `templates/AGENTS.md`
- Modify: `templates/CLAUDE.md`
- Modify: `templates/project.json`
- Modify: `templates/governance/project-management/PROJECT_STATE.md`
- Modify: `src/cli.js`
- Test: `scripts/smoke-test.js`

**Interfaces:**
- Consumes: `createFromConfig(a, briefData)` and the root `files` copy list in `src/cli.js`.
- Produces: generated root files `SUPERPOWERS.md`, `AGENTS.md`, and `CLAUDE.md`; `project.json.superpowers`; `PROJECT_STATE.md` section `## Superpowers State`.

- [ ] **Step 1: Add failing generated-contract assertions**

In `scripts/smoke-test.js`, add these entries to the generated-file loop immediately after `"CLAUDE.md"`:

```js
  "AGENTS.md",
  "SUPERPOWERS.md",
```

After the generated-file loop, add:

```js
const claudeBridge=fs.readFileSync(path.join(project,"CLAUDE.md"),"utf8");
assert.equal(claudeBridge,"@AGENTS.md\n");

const agentsBootstrap=fs.readFileSync(path.join(project,"AGENTS.md"),"utf8");
assert.match(agentsBootstrap,/SUPERPOWERS\.md/);
assert.match(agentsBootstrap,/project-management\/PM_AGENT\.md/);
assert.match(agentsBootstrap,/BLOCKED_SUPERPOWERS_MISSING/);

const superpowersContract=fs.readFileSync(path.join(project,"SUPERPOWERS.md"),"utf8");
for (const capability of [
  "superpowers:brainstorming",
  "superpowers:using-superpowers",
  "superpowers:writing-plans",
  "superpowers:using-git-worktrees",
  "superpowers:test-driven-development",
  "superpowers:systematic-debugging",
  "superpowers:subagent-driven-development",
  "superpowers:executing-plans",
  "superpowers:verification-before-completion",
  "superpowers:requesting-code-review",
  "superpowers:receiving-code-review",
  "superpowers:finishing-a-development-branch",
  "superpowers:writing-skills",
]) {
  assert.match(superpowersContract,new RegExp(capability.replaceAll("-","\\-")));
}
assert.match(superpowersContract,/no TOSS execution fallback/i);
assert.doesNotMatch(superpowersContract,/\$superpowers|\/superpowers/);
```

Extend the existing `projectState` assertions with:

```js
assert.deepEqual(projectState.superpowers,{
  requirement:"REQUIRED",
  provider:"UNKNOWN",
  availability:"PENDING_VERIFICATION",
  active_capability:"NONE",
  execution_state:"READY",
  evidence_references:{
    plan:[],
    tests:[],
    reviews:[],
    verification:[],
    branches:[],
    commits:[],
  },
});

const canonicalState=fs.readFileSync(
  path.join(project,"project-management/PROJECT_STATE.md"),
  "utf8",
);
assert.match(canonicalState,/## Superpowers State/);
assert.match(canonicalState,/Availability: PENDING_VERIFICATION/);
assert.match(canonicalState,/Execution State: READY/);
```

- [ ] **Step 2: Run the smoke test and verify RED**

Run:

```bash
npm test
```

Expected: FAIL at `Missing AGENTS.md` because the CLI does not generate the new bootstrap files yet.

- [ ] **Step 3: Create the provider-neutral Superpowers contract**

Create `templates/SUPERPOWERS.md` with this structure and exact routing table:

```markdown
# TOSS Superpowers Execution Contract

Status: REQUIRED

## Boundary

TOSS owns verified intent, scope, authority, Task Contracts, project state,
evidence acceptance, release authorization, and production boundaries.
Superpowers owns the method used for technical discovery, planning,
implementation, debugging, review, verification, and branch completion.

## Required Routing

| Trigger | Capability |
| --- | --- |
| Agent session start or skill-routing decision | `superpowers:using-superpowers` |
| New feature, creative work, or behavior change | `superpowers:brainstorming` |
| Approved design requiring an implementation plan | `superpowers:writing-plans` |
| Implementation workspace setup | `superpowers:using-git-worktrees` |
| Feature or bug-fix implementation | `superpowers:test-driven-development` |
| Unexpected behavior or test failure | `superpowers:systematic-debugging` |
| Plan execution with supported subagents | `superpowers:subagent-driven-development` |
| Plan execution without supported subagents | `superpowers:executing-plans` |
| Completion claim | `superpowers:verification-before-completion` |
| Work ready for review | `superpowers:requesting-code-review` |
| Review feedback received | `superpowers:receiving-code-review` |
| Verified development branch ready to conclude | `superpowers:finishing-a-development-branch` |
| Reusable skill creation or modification | `superpowers:writing-skills` |

Use the active host's native skill mechanism. Capability identifiers are
canonical; invocation syntax is host-owned.

## Missing Capability

If a required capability is unavailable:

1. Set execution state to `BLOCKED_SUPERPOWERS_MISSING`.
2. Record the missing capability and active provider.
3. Preserve completed discovery and governance artifacts.
4. Provide provider-appropriate installation or enablement guidance when known.
5. Do not imitate the missing workflow: there is no TOSS execution fallback.
6. Do not mark the Task complete.

`superpowers:executing-plans` is the permitted Superpowers alternative when
subagents are unsupported.

## Evidence Handoff

Superpowers outputs are technical evidence, not TOSS authorization. Return the
applicable plan, tests, review findings, verification output, branch, commit,
and exact artifact identity to the PM. Only the PM may accept that evidence
against the governed Definition of Done.
```

- [ ] **Step 4: Move shared bootstrap behavior to `AGENTS.md` and reduce the Claude bridge**

Create `templates/AGENTS.md` by moving the provider-neutral instructions from
the existing `templates/CLAUDE.md`. Preserve these behaviors:

- automatic session startup and canonical-state hydration;
- first-project initialization and implementation lock;
- Project Brief precedence;
- Design Brief and Design System bootstrap;
- Global Agent Catalog selection;
- concise CEO communication.

Convert the four leading Claude-specific `@path` imports into this
provider-neutral source list; `AGENTS.md` MUST NOT use `@path` import syntax:

```markdown
## Required Governance Sources

Read these files before the relevant governance or execution work:

- `project-management/PM_AGENT.md`
- `project-management/GOVERNANCE.md`
- `project-management/PROJECT_STATE.md`
- `project-management/AGENT_REGISTRY.md`
```

Change the title to `# TOSS Provider-Neutral Agent Bootstrap`, replace
Claude-specific session wording with `agent session`, and add this section after
the required governance source list:

```markdown
## Required Technical Execution Contract

Before technical discovery, planning, implementation, debugging, review,
verification, or branch completion:

1. Read `SUPERPOWERS.md`.
2. Invoke the matching canonical Superpowers capability through the active
   provider's native skill mechanism.
3. Keep TOSS authority and evidence gates around the Superpowers workflow.
4. If the capability is missing, record `BLOCKED_SUPERPOWERS_MISSING` and stop
   technical execution. Do not use a legacy TOSS workflow.
```

Replace `templates/CLAUDE.md` with exactly:

```markdown
@AGENTS.md
```

- [ ] **Step 5: Add structured and human-readable initial state**

Add this top-level object after `governance` in `templates/project.json`:

```json
"superpowers": {
  "requirement": "REQUIRED",
  "provider": "UNKNOWN",
  "availability": "PENDING_VERIFICATION",
  "active_capability": "NONE",
  "execution_state": "READY",
  "evidence_references": {
    "plan": [],
    "tests": [],
    "reviews": [],
    "verification": [],
    "branches": [],
    "commits": []
  }
},
```

Add this section before `## LangSmith State` in
`templates/governance/project-management/PROJECT_STATE.md`:

```markdown
## Superpowers State

Requirement: REQUIRED
Provider: UNKNOWN
Availability: PENDING_VERIFICATION
Active Capability: NONE
Execution State: READY
Evidence References: NONE
```

- [ ] **Step 6: Wire the templates into project creation**

In the `files` array in `createFromConfig` in `src/cli.js`, add:

```js
    ["AGENTS.md","AGENTS.md"],
    ["SUPERPOWERS.md","SUPERPOWERS.md"],
```

Keep `CLAUDE.md` in the same copy list. Replace the final startup output:

```js
  console.log("  start your supported agent host in the project root");
  console.log("TOSS bootstrap starts from AGENTS.md; Claude Code imports it through CLAUDE.md.");
```

- [ ] **Step 7: Run the smoke test and verify GREEN**

Run:

```bash
npm test
```

Expected: `TOSS CLI smoke test: PASS`.

- [ ] **Step 8: Commit the generated contract**

```bash
git add templates/SUPERPOWERS.md templates/AGENTS.md templates/CLAUDE.md templates/project.json templates/governance/project-management/PROJECT_STATE.md src/cli.js scripts/smoke-test.js
git commit -m "feat: generate provider-neutral Superpowers contract"
```

---

### Task 2: Delegate PM and specialist execution methods to Superpowers

**Files:**
- Modify: `templates/governance/project-management/PM_AGENT.md`
- Modify: `templates/governance/project-management/policies/AGENTS.md`
- Test: `scripts/smoke-test.js`

**Interfaces:**
- Consumes: generated `SUPERPOWERS.md`, Task Contract, assignment envelope.
- Produces: PM routing rule, required canonical capability in assignments, specialist evidence handoff, missing-capability escalation.

- [ ] **Step 1: Add failing governance assertions**

After the canonical-state assertions in `scripts/smoke-test.js`, add:

```js
const pmConstitution=fs.readFileSync(
  path.join(project,"project-management/PM_AGENT.md"),
  "utf8",
);
for (const phrase of [
  "Superpowers Execution Boundary",
  "ROUTE SUPERPOWERS",
  "verification-before-completion",
  "BLOCKED_SUPERPOWERS_MISSING",
]) {
  assert.match(pmConstitution,new RegExp(phrase));
}

const agentPolicy=fs.readFileSync(
  path.join(project,"project-management/policies/AGENTS.md"),
  "utf8",
);
assert.match(agentPolicy,/AGENT-018 — Superpowers Contract/);
assert.match(agentPolicy,/AGENT-019 — Missing Superpowers Capability/);
assert.match(agentPolicy,/AGENT-020 — Evidence Handoff/);
```

- [ ] **Step 2: Run the smoke test and verify RED**

Run `npm test`.

Expected: FAIL because `PM_AGENT.md` does not contain `Superpowers Execution Boundary`.

- [ ] **Step 3: Add the PM execution boundary**

In `PM_AGENT.md`, remove `create execution plans` from PM Authority and replace
it with:

```markdown
- capture governed execution constraints and accept Superpowers plans as evidence;
```

Add this section immediately before `## Operating Loop`:

```markdown
## Superpowers Execution Boundary

The PM owns authorization, orchestration, contracts, state, and evidence
acceptance. The PM MUST route technical method selection through the canonical
root `SUPERPOWERS.md` contract.

The PM MUST NOT recreate Superpowers planning, implementation, debugging,
review, verification, or branch-completion procedures inside TOSS governance.

Before technical assignment, the PM MUST identify the required canonical
Superpowers capability in the assignment envelope. If that capability is
unavailable, the Task MUST enter `BLOCKED_SUPERPOWERS_MISSING`; discovery and
governance records remain valid, but technical execution stops.
```

Replace the operating loop with:

```markdown
`RECEIVE → AUTHENTICATE → HYDRATE → CLASSIFY → CAPTURE OBJECTIVE → DISCOVER → RESOLVE OR ESCALATE AMBIGUITY → FREEZE CONTRACT → ROUTE SUPERPOWERS → ASSIGN → MONITOR EVIDENCE → ACCEPT OR REJECT → DELIVER → OBSERVE → CLOSE → CHECKPOINT`
```

Add `required canonical Superpowers capability` to the Specialist Assignment
list. In Agent Failure Recovery, require
`superpowers:systematic-debugging` before retry or reassignment when the trigger
matches. In Completion and Verification, require fresh
`superpowers:verification-before-completion` evidence while preserving PM-only
`DONE` authority.

- [ ] **Step 4: Extend specialist policy**

Append to `policies/AGENTS.md`:

```markdown
## AGENT-018 — Superpowers Contract
Technical work MUST follow the canonical root `SUPERPOWERS.md` contract and the
capability named in the assignment envelope.

## AGENT-019 — Missing Superpowers Capability
If the required capability is unavailable, the specialist MUST stop technical
execution, report the missing capability and provider, and request
`BLOCKED_SUPERPOWERS_MISSING`. The specialist MUST NOT imitate the workflow.

## AGENT-020 — Evidence Handoff
The specialist MUST return applicable Superpowers plan, test, review,
verification, branch, commit, and exact-artifact evidence. This evidence does
not grant authority or set Task state by itself.
```

- [ ] **Step 5: Run the smoke test and verify GREEN**

Run `npm test`.

Expected: `TOSS CLI smoke test: PASS`.

- [ ] **Step 6: Commit PM and specialist delegation**

```bash
git add templates/governance/project-management/PM_AGENT.md templates/governance/project-management/policies/AGENTS.md scripts/smoke-test.js
git commit -m "refactor: delegate technical workflow to Superpowers"
```

---

### Task 3: Preserve TOSS task, quality, and release gates around Superpowers evidence

**Files:**
- Modify: `templates/governance/project-management/policies/TASKS.md`
- Modify: `templates/governance/project-management/policies/QUALITY.md`
- Modify: `templates/governance/project-management/policies/RELEASES.md`
- Test: `scripts/smoke-test.js`

**Interfaces:**
- Consumes: canonical capability output and exact artifact identity.
- Produces: governed Task transition rules, quality evidence requirements, branch/release separation.

- [ ] **Step 1: Add failing policy assertions**

Add to `scripts/smoke-test.js`:

```js
const taskPolicy=fs.readFileSync(
  path.join(project,"project-management/policies/TASKS.md"),"utf8",
);
assert.match(taskPolicy,/TASK-021 — Superpowers Execution/);
assert.match(taskPolicy,/TASK-022 — Missing Superpowers Block/);

const qualityPolicy=fs.readFileSync(
  path.join(project,"project-management/policies/QUALITY.md"),"utf8",
);
assert.match(qualityPolicy,/QUAL-021 — Test-Driven Implementation/);
assert.match(qualityPolicy,/QUAL-022 — Systematic Debugging/);
assert.match(qualityPolicy,/QUAL-023 — Completion Verification/);
assert.match(qualityPolicy,/QUAL-024 — Code Review Workflow/);

const releasePolicy=fs.readFileSync(
  path.join(project,"project-management/policies/RELEASES.md"),"utf8",
);
assert.match(releasePolicy,/REL-051 — Development Branch Completion/);
assert.match(releasePolicy,/finishing-a-development-branch/);
assert.match(releasePolicy,/MUST NOT grant merge, release, deployment, rollout, or production authority/);
```

- [ ] **Step 2: Run the smoke test and verify RED**

Run `npm test`.

Expected: FAIL because `TASK-021` is absent.

- [ ] **Step 3: Extend Task policy without creating a parallel method**

Append to `policies/TASKS.md`:

```markdown
## TASK-021 — Superpowers Execution
Once the frozen Task Contract authorizes technical work, execution MUST use the
matching capability in the canonical root `SUPERPOWERS.md`. TOSS Task policy
defines scope and state; it does not replace the capability's method.

## TASK-022 — Missing Superpowers Block
If a required capability is unavailable, the Task MUST enter
`BLOCKED_SUPERPOWERS_MISSING`. Completed discovery and governance evidence MUST
be preserved. No legacy TOSS execution fallback is permitted.

## TASK-023 — Superpowers Output Is Evidence
A Superpowers completion result is a specialist claim. `TASK-011`, `TASK-012`,
and the Global Definition of Done remain binding.
```

- [ ] **Step 4: Extend Quality policy with capability-owned methods**

Append to `policies/QUALITY.md`:

```markdown
## QUAL-021 — Test-Driven Implementation
Feature and bug-fix implementation MUST use
`superpowers:test-driven-development`. Resulting tests remain subject to exact
candidate, applicability, and trustworthiness requirements in this policy.

## QUAL-022 — Systematic Debugging
Unexpected behavior, test failure, or unexplained validation failure MUST use
`superpowers:systematic-debugging` before a fix or retry is accepted.

## QUAL-023 — Completion Verification
A completion claim MUST include fresh evidence produced under
`superpowers:verification-before-completion`. The PM still determines whether
the governed gate is VERIFIED.

## QUAL-024 — Code Review Workflow
Work ready for review MUST use `superpowers:requesting-code-review`; received
review feedback MUST use `superpowers:receiving-code-review`. Finding severity,
lifecycle, waiver, and re-review rules remain governed by this policy.

## QUAL-025 — Superpowers Availability
If a required quality capability cannot run or cannot produce trustworthy
evidence, the corresponding gate remains UNKNOWN or BLOCKED and the Task uses
`BLOCKED_SUPERPOWERS_MISSING` when the capability itself is absent.
```

- [ ] **Step 5: Separate development-branch completion from release authority**

Append to `policies/RELEASES.md`:

```markdown
## REL-051 — Development Branch Completion
After required technical verification and review, development-branch conclusion
MUST use `superpowers:finishing-a-development-branch`.

Its output MAY propose merge, pull request, retention, or cleanup actions. It
MUST NOT grant merge, release, deployment, rollout, or production authority.
All existing TOSS approval, exact-artifact, manifest, and production gates
remain binding.
```

- [ ] **Step 6: Run the smoke test and verify GREEN**

Run `npm test`.

Expected: `TOSS CLI smoke test: PASS`.

- [ ] **Step 7: Commit the evidence-bound governance gates**

```bash
git add templates/governance/project-management/policies/TASKS.md templates/governance/project-management/policies/QUALITY.md templates/governance/project-management/policies/RELEASES.md scripts/smoke-test.js
git commit -m "docs: bind governance gates to Superpowers evidence"
```

---

### Task 4: Make user-facing startup and package metadata provider-neutral

**Files:**
- Modify: `README.md`
- Modify: `templates/README.project.md`
- Modify: `package.json`
- Test: `scripts/smoke-test.js`

**Interfaces:**
- Consumes: generated bootstrap files and Superpowers required-state semantics.
- Produces: provider-neutral startup instructions and discoverable package metadata.

- [ ] **Step 1: Add failing documentation assertions**

Add to `scripts/smoke-test.js` after the generated contract assertions:

```js
const generatedReadme=fs.readFileSync(path.join(project,"README.md"),"utf8");
assert.match(generatedReadme,/Superpowers: REQUIRED/);
assert.match(generatedReadme,/AGENTS\.md/);
assert.doesNotMatch(generatedReadme,/Start Claude Code/);

const packageMetadata=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
assert.equal(packageMetadata.version,packageVersion);
assert.ok(packageMetadata.keywords.includes("superpowers"));
assert.ok(packageMetadata.keywords.includes("agent-governance"));
```

- [ ] **Step 2: Run the smoke test and verify RED**

Run `npm test`.

Expected: FAIL because the generated README does not contain
`Superpowers: REQUIRED`.

- [ ] **Step 3: Update the generated project README**

Replace `## PM Startup` in `templates/README.project.md` with:

```markdown
## Agent Startup

Superpowers: REQUIRED

Start a supported agent host in the repository root. The shared bootstrap is
`AGENTS.md`; Claude Code loads the same bootstrap through the one-line
`CLAUDE.md` bridge. Technical work follows `SUPERPOWERS.md`.

The agent hydrates:

1. `project-management/PM_AGENT.md`
2. `project-management/GOVERNANCE.md`
3. `project-management/PROJECT_STATE.md`
4. `SUPERPOWERS.md` when technical work is requested
5. relevant GitHub Project state
```

- [ ] **Step 4: Update the package README**

In root `README.md`:

- describe generated `AGENTS.md`, `CLAUDE.md`, and `SUPERPOWERS.md`;
- add a `## Required Superpowers capability` section explaining required status,
  no automatic installation, no TOSS fallback, and
  `BLOCKED_SUPERPOWERS_MISSING`;
- replace Claude-only startup wording with supported-host wording;
- state that `CLAUDE.md` is only an `@AGENTS.md` compatibility bridge;
- preserve current Project Brief, Design Brief, remote options, requirements,
  publishing, security, and release-model documentation.

Use this exact dependency text:

```markdown
## Required Superpowers capability

Generated projects require Superpowers for technical planning, implementation,
debugging, review, verification, and development-branch completion. TOSS does
not install provider plugins automatically and does not fall back to its former
development method. If the active provider cannot invoke a required capability,
technical execution enters `BLOCKED_SUPERPOWERS_MISSING`; project discovery and
governance work may continue.
```

- [ ] **Step 5: Update package keywords without changing version**

In `package.json`, replace the `claude-code` keyword with:

```json
"agent-governance",
"superpowers"
```

Keep `"version": "1.1.0"` unchanged.

- [ ] **Step 6: Run the smoke test and verify GREEN**

Run `npm test`.

Expected: `TOSS CLI smoke test: PASS`.

- [ ] **Step 7: Commit provider-neutral documentation**

```bash
git add README.md templates/README.project.md package.json scripts/smoke-test.js
git commit -m "docs: explain provider-neutral Superpowers startup"
```

---

### Task 5: Verify the complete feature and package contents

**Files:**
- Verify: all files changed by Tasks 1-4
- Verify: `package-lock.json` remains unchanged unless npm itself rewrites metadata during an explicitly required install

**Interfaces:**
- Consumes: complete branch state.
- Produces: fresh verification evidence for review and PR handoff.

- [ ] **Step 1: Run the complete automated test suite**

```bash
npm test
```

Expected: `TOSS CLI smoke test: PASS`.

- [ ] **Step 2: Run package prepack verification**

```bash
npm pack --dry-run
```

Expected: exit code 0; package contents include `templates/AGENTS.md`,
`templates/CLAUDE.md`, and `templates/SUPERPOWERS.md`.

- [ ] **Step 3: Verify formatting and prohibited placeholders**

```bash
git diff origin/main...HEAD --check
rg -n "T[B]D|T[O]DO|PLACE[H]OLDER" templates/SUPERPOWERS.md templates/AGENTS.md templates/CLAUDE.md templates/governance/project-management/PM_AGENT.md templates/governance/project-management/policies/AGENTS.md templates/governance/project-management/policies/TASKS.md templates/governance/project-management/policies/QUALITY.md templates/governance/project-management/policies/RELEASES.md README.md templates/README.project.md
```

Expected: `git diff --check` exits 0; `rg` exits 1 with no matches.

- [ ] **Step 4: Verify single-source and exact-bridge invariants**

```bash
test "$(cat templates/CLAUDE.md)" = "@AGENTS.md"
test "$(rg -l "superpowers:brainstorming" templates/*.md | tr '\n' ' ')" = "templates/SUPERPOWERS.md "
```

Expected: both commands exit 0. If `AGENTS.md` needs to name only the entry
capability, keep detailed lifecycle identifiers exclusively in
`SUPERPOWERS.md` and adjust the assertion to the approved single-source rule.

- [ ] **Step 5: Inspect final diff and commits**

```bash
git status --short --branch
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: only the approved spec, plan, templates, governance documents, CLI,
tests, README files, and keyword metadata are changed; no release version or
workflow files are modified.

- [ ] **Step 6: Request code review**

Invoke `superpowers:requesting-code-review` with the approved design spec,
this plan, the full branch diff, and fresh verification output.

- [ ] **Step 7: Process findings and re-verify**

If findings are returned, invoke `superpowers:receiving-code-review`, apply only
validated in-scope changes, and rerun Steps 1-5. Do not claim completion from
stale test output.

- [ ] **Step 8: Conclude the development branch**

After review findings are resolved and verification is fresh, invoke
`superpowers:finishing-a-development-branch`. Preserve TOSS merge and release
authorization gates; do not bump the version in this feature branch.
