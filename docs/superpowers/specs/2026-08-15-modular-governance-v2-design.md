# Modular Governance v2 Design

Date: 2026-08-15
Status: Approved design
Target: TOSS CLI 2.0.0 / TOSS Governance 2.0.0

## Purpose

Reduce the governance installed by TOSS CLI to the smallest useful default,
remove process duplication with Superpowers, and prevent incomplete optional
integrations from being presented as working governance capabilities.

Superpowers remains a required technical-execution dependency. TOSS remains
responsible for intent, scope, authority, state, and evidence acceptance.

## Current-State Findings

The current generated governance tree contains 47 non-hidden files and about
4,923 lines before counting its two GitHub workflows. The main problems are:

1. `SUPERPOWERS.md` correctly defines the technical execution boundary, but
   capability and process requirements are repeated in `PM_AGENT.md`,
   `policies/TASKS.md`, `policies/QUALITY.md`, `policies/AGENTS.md`, and
   `policies/RELEASES.md`.
2. `AGENTS.md` is intended to be a concise provider-neutral bootstrap but has
   grown to 195 lines and includes detailed bootstrap and governance behavior.
3. The default project includes a 792-line LangSmith policy plus benchmark,
   certification, and trusted-evaluator documentation regardless of project
   need.
4. Generated content contains project- or provider-specific values such as
   `Klinik360`, `claude-code`, and `openai:o3-mini`.
5. The governance workflows and documentation reference files that TOSS CLI
   does not generate, including evaluator modules, benchmark datasets, runner
   scripts, requirements files, and trusted-evaluator repository assets.
6. The generated main-branch ruleset requires `governance-certification` even
   though the complete certification runtime is not shipped.

These issues create cognitive load, conflicting sources of truth, and a
governance gate that can fail for missing implementation rather than for an
actual project defect.

## Design Principles

1. **One owner per responsibility.** TOSS owns governance outcomes;
   Superpowers owns technical method.
2. **Lean by default.** New projects receive only the required core.
3. **Explicit optionality.** Operational governance is installed only when the
   user explicitly enables it.
4. **No partial integrations.** An optional capability is not offered until
   all runtime assets and validation are present.
5. **Provider neutrality.** Core governance does not depend on Claude Code,
   Codex, LangSmith, or a model-provider-specific invocation syntax.
6. **Fail before writing.** Invalid or incomplete profile input must fail
   before the destination is mutated.
7. **No automatic legacy mutation.** Existing generated projects retain their
   data until their owner deliberately migrates them.

## Responsibility Boundary

### TOSS owns

- verified CEO intent and protected decisions;
- Project Brief and Design Brief state;
- Objectives, scope, constraints, and acceptance criteria;
- authority and approval boundaries;
- Task state and specialist assignment boundaries;
- active project state, risks, decisions, and waivers;
- evidence applicability and acceptance against the Definition of Done;
- merge, release, production, rollout, and data-mutation authority when the
  applicable governance profile is installed.

### Superpowers owns

- technical discovery and brainstorming;
- implementation planning;
- worktree and isolated-workspace method;
- test-driven implementation;
- systematic debugging;
- plan execution and supported subagent coordination;
- code-review method and review-feedback handling;
- completion verification;
- development-branch completion choices;
- reusable skill creation and validation.

The canonical capability identifiers and routing table live only in root
`SUPERPOWERS.md`. Other governance documents may require compliance with that
contract but must not reproduce its capability list or procedures.

## Profile Architecture

### Core profile

The Core profile is mandatory and cannot be disabled. It contains:

- provider-neutral agent startup;
- the Superpowers execution contract;
- intent and authority governance;
- Objective and Task governance;
- project state;
- agent registry;
- quality outcomes and evidence gates;
- compact records for Objectives, Tasks, decisions, risks, and waivers.

The Core profile does not include production operations, LangSmith,
governance benchmarks, trusted evaluation, or certification workflows.

### Delivery profile

The Delivery profile is optional and installed only when
`governance.delivery` is explicitly `true`. It adds:

- merge, release, and production delivery gates;
- deployment and rollback governance;
- infrastructure-change governance;
- material production data-remediation governance;
- incident management;
- advanced security review requirements related to delivery risk.

Basic secret hygiene, dependency safety, and data-safety expectations remain
in Core quality rules because they apply before production delivery exists.

### Assurance boundary

Assurance is a reserved future profile, not a selectable TOSS CLI 2.0 profile.
The existing incomplete LangSmith, benchmark, certification, and Trusted
Evaluator assets are removed from generated projects.

Assurance may be introduced later only as a complete, versioned module. A
future implementation should install its runtime, datasets, evaluator code,
workflow, configuration, and tests together. A trusted evaluator that must be
controlled outside the candidate repository should be delivered from its own
repository or package rather than copied as incomplete application-repository
documentation.

## Target File Structure

### Mandatory generated files

```text
AGENTS.md
CLAUDE.md
SUPERPOWERS.md

project-management/
├── GOVERNANCE.md
├── WORK.md
├── QUALITY.md
├── PROJECT_STATE.md
├── AGENT_REGISTRY.md
└── templates/
    ├── OBJECTIVE.md
    ├── TASK.md
    ├── DECISION.md
    ├── RISK.md
    └── WAIVER.md
```

This is an exact 13-file governance/bootstrap contract, excluding the existing
Project Brief, Design Brief, Design System, and Global Agent Catalog assets.

The existing Project Brief, Design Brief, Design System, and Global Agent
Catalog remain part of project bootstrap outside this governance consolidation.

### Optional Delivery files

```text
project-management/
├── policies/
│   ├── DELIVERY.md
│   └── OPERATIONS.md
└── templates/
    ├── RELEASE.md
    ├── INCIDENT.md
    └── DATAFIX.md
```

Source assets are organized by profile so selection does not depend on
post-copy deletion:

```text
templates/governance/core/
templates/governance/profiles/delivery/
```

Root bootstrap templates may remain at `templates/AGENTS.md`,
`templates/CLAUDE.md`, and `templates/SUPERPOWERS.md`. The CLI resolves an
explicit asset manifest before copying either governance profile.

## Consolidation Map

| Current content | Target |
| --- | --- |
| `PM_AGENT.md`, `GOVERNANCE.md`, `policies/AUTHORITY.md` | `GOVERNANCE.md` |
| `policies/OBJECTIVES.md`, `policies/TASKS.md`, `policies/AGENTS.md` | `WORK.md` |
| `policies/EVIDENCE.md`, `policies/QUALITY.md` | `QUALITY.md` |
| Bootstrap state fields | `PROJECT_STATE.md` |
| `TASK_CONTRACT.md`, `ASSIGNMENT.md`, `CHANGE_REQUEST.md`, `COMPLETION_REPORT.md`, `AGENT_HANDOVER.md` | lifecycle-oriented `TASK.md` |
| `policies/RELEASES.md`, `policies/INFRASTRUCTURE.md`, advanced delivery security rules | Delivery `policies/DELIVERY.md` |
| `policies/DATA.md`, `policies/INCIDENTS.md` | Delivery `policies/OPERATIONS.md` |
| `RELEASE_MANIFEST.md` | Delivery `templates/RELEASE.md` |

The combined documents must preserve material authority and truth invariants
without copying the Superpowers execution method.

## Files Removed from Default Generation

- `project-management/policies/LANGSMITH.md`
- `project-management/LANGSMITH_INTEGRATION.md`
- `project-management/LANGSMITH_EVAL_CATALOG.md`
- `project-management/CLAUDE_CODE_TRAJECTORY_EVAL.md`
- governance benchmark and certification documents
- Trusted Evaluator architecture and runbook documents
- LangSmith trace, evaluation-case, evaluation-suite, trajectory, and
  certification templates
- `.claude/settings.local.json.example`
- `pm-governance-certification.yml`
- `request-trusted-governance-evaluation.yml`
- governance `CHANGELOG.md` copied into generated projects
- all references to unshipped evaluator, benchmark, trusted-runner, and
  requirements files

Historical governance changes belong in the TOSS CLI repository history and
release notes, not in every generated application.

## Canonical Document Responsibilities

### `AGENTS.md`

`AGENTS.md` is a short provider-neutral bootstrap. It identifies the canonical
governance sources, requires `SUPERPOWERS.md` before technical work, defines
first-bootstrap entry conditions, and points to Project Brief and project-state
records. It does not contain a capability table or detailed policies.

Target length is approximately 40–60 lines. Length is a design guide rather
than a test assertion; semantic duplication checks are authoritative.

### `CLAUDE.md`

Claude Code compatibility remains a one-line bridge:

```markdown
@AGENTS.md
```

It contains no independent governance or execution behavior.

### `SUPERPOWERS.md`

`SUPERPOWERS.md` remains the sole technical lifecycle contract. It contains the
responsibility boundary, canonical capability routing table, missing-capability
behavior, no-fallback rule, and evidence handoff.

### `GOVERNANCE.md`

This document contains the PM mission, authority model, truth rules,
instruction precedence, ambiguity classes, protected decisions, production
boundary summary, and self-modification prohibition. It defines who may decide
and authorize, not how technical work is performed.

### `WORK.md`

This document defines Objective capture, Task readiness and lifecycle, frozen
scope, specialist assignment boundaries, change handling, blocking, and
completion authority. It treats Superpowers output as technical evidence.

### `QUALITY.md`

This document defines risk-based quality outcomes, applicable validation,
exact-artifact evidence, review findings, evidence states, freshness, and the
Definition of Done. It does not prescribe TDD, debugging, review, or
verification steps.

### `PROJECT_STATE.md`

This remains the concise recovery checkpoint for current project state. It
contains bootstrap, Objective, Task, risk, decision, environment, delivery,
agent, and Superpowers availability summaries. LangSmith and Trusted Evaluator
state are removed from Core.

## Project Brief and Generated State

The Project Brief adds:

```yaml
governance:
  delivery: false
```

The default is deliberately `false`, not `AUTO`. File selection must be
deterministic before generation and must not infer a large operational profile
from ambiguous future deployment intent.

The existing top-level `langsmith` input is removed from the v2 Project Brief,
CLI parsing, rendered `.env.example`, and generated state. A future Assurance
module will define its own provider configuration rather than reserving a
LangSmith-specific field in Core.

Generated `project.json` records installed profiles:

```json
{
  "governance": {
    "version": "2.0.0",
    "profiles": {
      "core": true,
      "delivery": false
    }
  },
  "superpowers": {
    "requirement": "REQUIRED",
    "availability": "PENDING_VERIFICATION"
  }
}
```

LangSmith and Trusted Evaluator state are removed. Superpowers availability is
not guessed by the CLI.

## Generation Flow

1. Read and parse the Project Brief.
2. Validate `governance.delivery` as a Boolean.
3. Resolve an exact profile manifest: Core plus optional Delivery.
4. Validate that every source asset in the manifest exists.
5. Validate that the destination can be created under existing overwrite
   rules.
6. Generate root bootstrap and Core governance files.
7. Generate Delivery files only when explicitly enabled.
8. Render project variables.
9. Write `project.json` with exact installed profile state.
10. Run or expose the existing repository/bootstrap completion behavior.

Profile resolution and source validation occur before destination mutation.

## Ruleset Behavior

TOSS CLI must stop creating a required status check for
`governance-certification`. A required check must correspond to a workflow that
actually exists and can run.

If the user requests a main ruleset, required CI checks are included only when
they are explicitly configured. The CLI must not invent a check name based on
an unavailable optional integration.

## Error Handling

- Unknown governance key or non-Boolean `delivery` value: fail validation
  before writing files.
- Missing profile source asset: fail before writing files and name the missing
  path.
- Requested `assurance: true`: reject as unsupported before writing files;
  explain that no complete Assurance module is installed.
- Existing non-empty destination without force: preserve current refusal
  behavior.
- Missing Superpowers host capability: project creation succeeds, but technical
  execution later enters `BLOCKED_SUPERPOWERS_MISSING` under the canonical
  contract.
- Dangling generated document reference: fail repository tests.

## Validation Strategy

The smoke suite must cover:

1. Core-only generation and its exact expected file allowlist.
2. Core-plus-Delivery generation and its exact expected file allowlist.
3. Default Project Brief behavior with `governance.delivery: false`.
4. Explicit Delivery enablement.
5. Rejection of invalid governance profile values before output mutation.
6. Rejection of unsupported Assurance input before output mutation.
7. Every generated local Markdown/code-path reference resolves to an installed
   file or an explicitly identified external resource.
8. Canonical `superpowers:*` capability identifiers do not appear under
   `project-management/`; they remain in root `SUPERPOWERS.md`.
9. Core output contains no LangSmith, `Klinik360`, `o3-mini`, Claude trajectory,
   Trusted Evaluator, or governance-certification content.
10. `CLAUDE.md` contains exactly `@AGENTS.md` plus its final newline.
11. The Core and Delivery profile state in `project.json` matches generated
    files.
12. Main-ruleset output does not require an unavailable certification check.
13. Existing Project Brief and Design Brief scenarios remain valid.
14. Package metadata, CLI help, full smoke tests, and `npm pack --dry-run` pass.

Tests should enforce behavior and ownership boundaries rather than brittle
line-count limits.

## Versioning and Migration

The governance version becomes `2.0.0` because canonical documents, policy
paths, and the default operating model change incompatibly.

The npm package target is also `2.0.0` because consumers may depend on the
generated file contract even though the CLI command syntax remains familiar.

Existing projects are not modified automatically. TOSS CLI will include a v2
migration guide at `docs/migrations/governance-v2.md` that maps old documents
to their new locations and explains which advanced assets are no longer
generated.

The guide must warn users not to delete populated project state, decision,
risk, release, incident, or data-remediation records blindly. Automated
`toss migrate` behavior is outside this change.

## Out of Scope

- implementing a new LangSmith integration;
- creating the Trusted Evaluator repository or GitHub App;
- implementing `toss add assurance`;
- implementing automatic migration of existing generated projects;
- changing the required Superpowers dependency or adding a TOSS fallback;
- changing product-specific Project Brief or Design Brief semantics beyond the
  governance profile field;
- weakening CEO, truth, evidence, or production authority boundaries.
- tagging or publishing the `2.0.0` npm release without separate release
  authorization.

## Success Criteria

The design is implemented when:

- default governance is reduced to the approved Core structure;
- Delivery files are generated only when explicitly enabled;
- technical lifecycle method exists only in `SUPERPOWERS.md`;
- Core files are provider-neutral and contain no assurance-provider residue;
- no generated workflow or document points to missing local assets;
- main ruleset output does not require an unavailable check;
- generated profile state exactly matches generated files;
- Core and Delivery test matrices pass;
- migration guidance exists for v1 projects;
- package validation and dry-run packaging pass.
