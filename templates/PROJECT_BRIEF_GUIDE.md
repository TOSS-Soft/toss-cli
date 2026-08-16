# Project Brief Guide

The Project Brief is CEO-authored bootstrap input.

## Required

- `project.name`
- `project.description`
- `business.problem`
- `business.primary_goal`

## Recommended

- target users
- MVP scope
- out-of-scope items
- known platform requirements
- known technology decisions
- security/data sensitivity
- known design decisions and company design-system references
- constraints

## AUTO

Use `AUTO` when the decision is intentionally delegated to PM/architecture
discovery.

`AUTO` does not authorize arbitrary scope. If resolving an AUTO field creates
a genuine A3/product/authority ambiguity, PM escalates it.

## Governance Profiles

`governance.delivery` is Boolean. It defaults to `false`, which installs only
the mandatory Core profile. Core uses `project-management/GOVERNANCE.md`,
`project-management/WORK.md`, `project-management/QUALITY.md`,
`project-management/PROJECT_STATE.md`, and
`project-management/AGENT_REGISTRY.md`. Superpowers is the required technical
method through root `SUPERPOWERS.md`.

Set `governance.delivery` to `true` only when the project needs the Delivery
profile's release, operations, incident, and production controls. Delivery adds
Delivery and Operations policies plus Release, Incident, and Datafix records.
Those records do not confer production authority.

Profile selection is deterministic at creation time. Delivery intent elsewhere
in the brief does not implicitly enable the Delivery governance profile.

`delivery.required_status_checks` is an explicit list of exact check contexts.
Leave it empty to omit required-status-check rules. A check is never inferred
from profile selection or from an unavailable integration.

## Design

The `design` section supports a hybrid workflow: record known decisions before
project creation and leave unknown decisions as `AUTO`. During first bootstrap,
the PM/Orchestrator asks only for missing or `AUTO` values, one question at a
time, and maintains:

- `project-management/design/DESIGN_BRIEF.md`
- `project-management/design/DESIGN_SYSTEM.md`

Set `design.required` to:

- `true` when verified project scope requires UI/UX design;
- `false` when design work is not applicable;
- `AUTO` when applicability must be reconciled from verified scope.

`design.source` accepts `company_system`, `new_system`, or `AUTO`. When
`company_system` is selected, verified company design-system and brand rules
are the primary, binding source. Project decisions may fill gaps but cannot
silently override those rules. Inaccessible references or conflicting binding
rules block design discovery until the approval owner resolves them.

`design.production_tool` accepts:

- `figma`
- `pencil`
- `claude_design`
- `code_native`
- `AUTO`

The production tool creates implementation artifacts; it is not the canonical
source for intent, governance, or approval. External artifacts are referenced
from the repository documents.

The PM collects design intent and assigns an approved design specialist. It does
not create visual designs or implement UI components. When design is required,
product UI implementation begins only after the named approval owner approves
the exact Design System version.

## Initial Objective

If `initial_objective.title` and `initial_objective.outcome` are populated,
they are treated as CEO-authored Objective input after bootstrap reconciliation.

If empty, PM waits for the first CEO Objective.

## Authority

The brief defines initial intent and constraints. It does not override
governance, merge/deploy approval, production authority, or evidence.
