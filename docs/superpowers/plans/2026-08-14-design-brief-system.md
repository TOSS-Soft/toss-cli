# Design Brief and Design System Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hybrid Design Brief workflow that carries known design decisions from the project brief and directs the PM wizard to complete missing decisions and govern Design System creation.

**Architecture:** Extend the existing YAML brief and generated JSON context without introducing a new runtime dependency. Keep the CLI tool-neutral: it validates and propagates design inputs and installs governed Markdown templates, while `CLAUDE.md` and PM bootstrap state define the conditional wizard, specialist assignment, lifecycle, and UI implementation lock.

**Tech Stack:** Node.js 20+, ECMAScript modules, `yaml` 2.x, Markdown/YAML templates, integration tests using `node:child_process` and `node:assert`.

## Global Constraints

- Existing briefs without `design` remain valid and behave as `design.required: AUTO` during PM discovery.
- Existing company design systems are the primary source and binding rules may not be silently overridden.
- Supported production tools are exactly `figma`, `pencil`, `claude_design`, `code_native`, and `AUTO`.
- The PM collects and governs design intent but does not create visual designs or implement UI components.
- Required UI implementation is locked until the exact Design System version reaches `APPROVED`.
- No new npm runtime dependencies.
- Release version is `1.1.0` with Git tag `v1.1.0`.

---

## File Structure

- `src/cli.js`: validate design decision enums and include design context/state during project generation.
- `templates/project-brief.yaml`: expose the complete optional design input schema.
- `templates/PROJECT_BRIEF_GUIDE.md`: explain design fields, `AUTO`, source priority, and tool neutrality.
- `templates/DESIGN_BRIEF.md`: canonical design discovery and approval record installed into new projects.
- `templates/DESIGN_SYSTEM.md`: governed Design System structure installed into new projects.
- `templates/CLAUDE.md`: run the conditional wizard and enforce design lifecycle rules.
- `templates/PM_BOOTSTRAP_STATE.md`: track design discovery in the bootstrap checklist and state summary.
- `templates/project.json`: add independent `design_system` bootstrap state.
- `scripts/smoke-test.js`: integration coverage for propagation, compatibility, validation, and generated artifacts.
- `README.md`: user-facing hybrid workflow and generated artifact documentation.
- `package.json`, `package-lock.json`: minor version metadata.

### Task 1: Design Schema Propagation and Validation

**Files:**
- Modify: `templates/project-brief.yaml`
- Modify: `src/cli.js`
- Modify: `scripts/smoke-test.js`

**Interfaces:**
- Consumes: parsed YAML object passed to `validateBrief(data)` and `writeBriefContext(dest, data)`.
- Produces: `validateEnum(data, keys, allowed)` validation behavior and `PROJECT_BRIEF.json.design` preserving explicit inputs or `{ required: "AUTO" }` for legacy briefs.

- [ ] **Step 1: Add failing integration assertions for the emitted schema and JSON propagation**

Add `node:assert/strict`, a reusable `runCli(args, options)` helper, and assertions equivalent to:

```js
import assert from "node:assert/strict";

const initialized=fs.readFileSync(brief,"utf8");
assert.match(initialized,/^design:\n/m);
assert.match(initialized,/^  production_tool: AUTO$/m);

text=text
  .replace("  production_tool: AUTO", "  production_tool: pencil")
  .replace("    name: \"\"", "    name: \"TOSS Brand System\"");

const context=JSON.parse(fs.readFileSync(
  path.join(project,"project-management/bootstrap/PROJECT_BRIEF.json"),
  "utf8"
));
assert.equal(context.design.production_tool,"pencil");
assert.equal(context.design.company_design_system.name,"TOSS Brand System");
```

- [ ] **Step 2: Run the smoke test and verify the new assertions fail**

Run: `npm test`

Expected: FAIL because `project-brief.yaml` has no `design` section and generated JSON has no `design` property.

- [ ] **Step 3: Add the complete design schema to the YAML template**

Append the exact schema approved in the spec, including `required`, `source`, `company_design_system`, `production_tool`, `design_direction`, `users_and_accessibility`, `deliverables`, and `approval`. Preserve `AUTO` as an unquoted YAML string and use empty arrays for optional list inputs.

- [ ] **Step 4: Implement design propagation and enum validation**

Add these constants and helper near `validateBrief`:

```js
const DESIGN_ENUMS = [
  [["design","required"],[true,false,"AUTO"]],
  [["design","source"],["company_system","new_system","AUTO"]],
  [["design","production_tool"],["figma","pencil","claude_design","code_native","AUTO"]],
  [["design","users_and_accessibility","responsive"],[true,false,"AUTO"]],
];

function validateEnum(data, keys, allowed) {
  const value=nested(data,keys,undefined);
  if (value===undefined) return;
  if (!allowed.includes(value)) {
    die(`Project Brief invalid value for ${keys.join(".")}: ${String(value)}. Allowed: ${allowed.join(", ")}`);
  }
}
```

Call every `DESIGN_ENUMS` entry from `validateBrief`. Extend the context object in `writeBriefContext` with:

```js
design:data.design||{required:"AUTO"},
```

- [ ] **Step 5: Add failing invalid-enum and legacy-brief tests**

Create a second temporary brief with `production_tool: photoshop` and assert the CLI exits non-zero and stderr contains `design.production_tool`. Create a legacy brief by removing the entire `design` YAML block and assert project creation succeeds with:

```js
assert.deepEqual(legacyContext.design,{required:"AUTO"});
```

- [ ] **Step 6: Run tests and confirm all schema behaviors pass**

Run: `npm test`

Expected: `TOSS CLI smoke test: PASS` with explicit-design, invalid-enum, and legacy compatibility checks passing.

- [ ] **Step 7: Commit the schema unit**

```bash
git add src/cli.js templates/project-brief.yaml scripts/smoke-test.js
git commit -m "feat: add design inputs to project brief"
```

### Task 2: Governed Design Templates and Conditional Wizard

**Files:**
- Create: `templates/DESIGN_BRIEF.md`
- Create: `templates/DESIGN_SYSTEM.md`
- Modify: `src/cli.js`
- Modify: `templates/CLAUDE.md`
- Modify: `templates/PM_BOOTSTRAP_STATE.md`
- Modify: `templates/project.json`
- Modify: `scripts/smoke-test.js`

**Interfaces:**
- Consumes: `briefData.design` in `createFromConfig(a, briefData)` and the existing template-copying convention.
- Produces: `project-management/design/DESIGN_BRIEF.md`, `project-management/design/DESIGN_SYSTEM.md`, and `bootstrap_state.design_system` with `PENDING`, `NOT_APPLICABLE`, or `DISCOVERY_REQUIRED` initial state.

- [ ] **Step 1: Write failing generated-artifact and initial-state tests**

Add assertions for:

```js
for (const rel of [
  "project-management/design/DESIGN_BRIEF.md",
  "project-management/design/DESIGN_SYSTEM.md",
]) assert.ok(fs.existsSync(path.join(project,rel)),`Missing ${rel}`);

const projectJson=JSON.parse(fs.readFileSync(path.join(project,"project.json"),"utf8"));
assert.equal(projectJson.bootstrap_state.design_system,"DISCOVERY_REQUIRED");
```

Create a `required: false` brief and assert `design_system` is `NOT_APPLICABLE`. Assert both template documents are still installed so design can later be activated through a verified Objective without reinstalling governance.

- [ ] **Step 2: Run the smoke test and verify it fails on missing design artifacts**

Run: `npm test`

Expected: FAIL with `Missing project-management/design/DESIGN_BRIEF.md`.

- [ ] **Step 3: Create the canonical Design Brief template**

The document must contain YAML metadata with `status: PENDING`, `version: 1`, and sections for:

```markdown
# Design Brief

## Purpose and Success Criteria
## Users and Context
## Source Hierarchy
## Company Design System
## Production Tool
## Design Direction
## Devices, Responsive Scope, and Accessibility
## Required Deliverables
## Key Screens and Components
## Constraints and Avoided Patterns
## Acceptance Criteria
## Open Questions
## Approval
```

State that explicit Project Brief choices are binding, company-system rules take priority, and unknowns remain `AUTO`/`UNKNOWN` until resolved.

- [ ] **Step 4: Create the governed Design System template**

The document must contain YAML metadata with `status: PENDING`, `version: 1`, `approved_version: NONE`, and sections for:

```markdown
# Design System

## Source and Authority
## Foundations
## Semantic Tokens
## Color
## Typography
## Spacing and Sizing
## Grid and Layout
## Iconography and Imagery
## Components and States
## Responsive Behavior
## Accessibility
## Content and Voice
## Usage Guidance
## Artifact References
## Validation Evidence
## Version and Approval
```

Require every component to specify default, hover, focus, active, disabled, loading, empty, error, and success behavior where applicable.

- [ ] **Step 5: Install templates and initialize design bootstrap state**

In `createFromConfig`, create `project-management/design`, copy both templates, and after loading brief data set:

```js
const designRequired=nested(briefData,["design","required"],"AUTO");
const designState=designRequired===false
  ? "NOT_APPLICABLE"
  : designRequired===true
    ? "DISCOVERY_REQUIRED"
    : "PENDING";
updateProjectJson(dest,{design_system:designState});
```

Keep `templates/project.json` default as `"design_system": "PENDING"` for the legacy fast scaffold path.

- [ ] **Step 6: Add the conditional wizard and implementation lock to PM startup**

Add a `Design Brief and Design System Bootstrap` section to `templates/CLAUDE.md` requiring the PM to:

- skip and record `NOT_APPLICABLE` for explicit `false`;
- decide applicability from verified UI scope when `AUTO`;
- ask only missing/`AUTO` fields, one question at a time, in the seven-step order from the spec;
- preserve company-system source priority;
- assign production to an approved design specialist rather than designing itself;
- use `PENDING`, `DISCOVERY`, `READY`, `APPROVED`, `BLOCKED`, and `NOT_APPLICABLE`;
- block product UI implementation until the exact Design System version is `APPROVED`;
- report inaccessible references and conflicting binding rules as `BLOCKED`.

- [ ] **Step 7: Extend bootstrap state and smoke assertions**

Add these checklist entries to `PM_BOOTSTRAP_STATE.md`:

```markdown
- [ ] Design applicability reconciled
- [ ] Design Brief state reconciled
- [ ] Design System state reconciled
```

Add a Design section with `Status: PENDING`, `Brief: PENDING`, `System: PENDING`, and the six valid lifecycle values. In the smoke test, read generated `CLAUDE.md` and assert it contains `DISCOVERY`, `APPROVED`, `company design system`, and the UI implementation lock text.

- [ ] **Step 8: Run tests and commit the governed workflow**

Run: `npm test`

Expected: PASS for generated templates, true/false/AUTO state behavior, PM instructions, and previous schema coverage.

```bash
git add src/cli.js templates/DESIGN_BRIEF.md templates/DESIGN_SYSTEM.md templates/CLAUDE.md templates/PM_BOOTSTRAP_STATE.md templates/project.json scripts/smoke-test.js
git commit -m "feat: add governed design system bootstrap"
```

### Task 3: User Documentation and Package Coverage

**Files:**
- Modify: `templates/PROJECT_BRIEF_GUIDE.md`
- Modify: `README.md`
- Modify: `scripts/smoke-test.js`

**Interfaces:**
- Consumes: approved schema and lifecycle names from Tasks 1-2.
- Produces: public documentation that exactly matches the installed templates and packed npm artifact checks.

- [ ] **Step 1: Add failing documentation and package-content assertions**

In the smoke test, assert the Project Brief Guide contains all supported tool values and `company_system`. Run `npm pack --dry-run --json`, parse the output, and assert the packed file list contains:

```js
for (const file of [
  "templates/DESIGN_BRIEF.md",
  "templates/DESIGN_SYSTEM.md",
  "templates/project-brief.yaml",
]) assert.ok(packedFiles.has(file),`Package missing ${file}`);
```

- [ ] **Step 2: Run tests and verify the documentation assertion fails**

Run: `npm test`

Expected: FAIL because the guide does not yet document the design workflow.

- [ ] **Step 3: Document the Design Brief schema and hybrid flow**

Update `PROJECT_BRIEF_GUIDE.md` with:

- when to use `required: true`, `false`, or `AUTO`;
- company-system priority and conflict blocking;
- production-tool enum values;
- the wizard's one-question-at-a-time behavior;
- the two generated repository documents;
- Design System approval and UI implementation lock.

- [ ] **Step 4: Update README examples and created-artifact list**

Add a compact YAML example containing `required`, `source`, company references,
`production_tool`, target devices, accessibility, and key screens. State that
Figma/Pencil/Claude Design/code-native are production options and not governance
sources of truth.

- [ ] **Step 5: Run tests and commit documentation**

Run: `npm test`

Expected: PASS including dry-run package inspection.

```bash
git add README.md templates/PROJECT_BRIEF_GUIDE.md scripts/smoke-test.js
git commit -m "docs: explain hybrid design brief workflow"
```

### Task 4: Minor Version and Release Verification

**Files:**
- Modify: `package.json`
- Create or modify: `package-lock.json` only if npm generates it.

**Interfaces:**
- Consumes: fully tested Tasks 1-3.
- Produces: exact package version `1.1.0`, Git tag `v1.1.0`, pushed main branch, and the trusted-publishing release trigger.

- [ ] **Step 1: Verify the pre-release worktree and baseline tests**

Run:

```bash
git status --short
npm test
npm pack --dry-run
```

Expected: clean worktree, all tests pass, and both design templates appear in the package file list.

- [ ] **Step 2: Create the minor version commit and tag**

Run:

```bash
npm run release:version -- minor
```

Expected: `package.json` (and lockfile if present) become `1.1.0`, npm creates commit `1.1.0`, and Git creates tag `v1.1.0`.

- [ ] **Step 3: Verify the exact tagged artifact**

Run:

```bash
git status --short
git show --stat --oneline v1.1.0
npm test
npm pack --dry-run
```

Expected: clean worktree, tag resolves to version commit, tests pass, and package metadata reports `@toss/cli@1.1.0`.

- [ ] **Step 4: Push branch and tag**

Run:

```bash
git push origin main --follow-tags
```

Expected: `main` and `v1.1.0` are accepted by `TOSS-Soft/toss-cli`.

- [ ] **Step 5: Verify remote and release workflow**

Run read-only GitHub checks through the connected app or available git remote refs. Confirm `origin/main` resolves to local `HEAD`, `refs/tags/v1.1.0` exists remotely, and the trusted-publishing workflow has started or completed. If the workflow fails, stop and report its exact check/log evidence before proposing a fix.

---

## Plan Self-Review

- Spec coverage: schema, hybrid wizard, company-system priority, tool options, templates, lifecycle, implementation lock, compatibility, tests, documentation, and minor release are each mapped to a task.
- Placeholder scan: implementation steps contain concrete fields, commands, expected states, and assertions; no unresolved placeholders remain.
- Type consistency: design enum names, file paths, JSON keys, and lifecycle names match the approved specification throughout all tasks.
