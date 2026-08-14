# Design Brief and Design System Bootstrap

## Purpose

Extend TOSS project bootstrap with a tool-neutral design discovery flow. Known
design decisions are captured in `project-brief.yaml`; missing or delegated
decisions are completed by the Project Manager/Orchestrator during first
bootstrap. The resulting brief directs an approved design specialist to create
an implementable design system.

## Goals

- Capture design intent without forcing every project to require UI/UX work.
- Treat an existing company design system as the primary, binding source.
- Support Figma, Pencil, Claude Design, and code-native production without
  coupling governance to one tool.
- Ask only for missing or `AUTO` decisions during bootstrap.
- Produce canonical, repository-backed Design Brief and Design System records.
- Prevent UI implementation from starting before required design approval.

## Non-Goals

- The PM does not create visual designs or implement UI components.
- The CLI does not call Figma, Pencil, Claude Design, or another design service.
- External design files do not replace repository governance or approval state.
- Design discovery does not create product scope beyond verified CEO intent.

## Project Brief Schema

The project brief gains an optional `design` object. Existing briefs without
this object remain valid and behave as `design.required: AUTO` so the PM can
determine applicability during discovery without inventing product scope.

```yaml
design:
  required: AUTO
  source: AUTO
  company_design_system:
    name: ""
    references: []
    binding_rules: []
  production_tool: AUTO
  design_direction:
    personality: []
    visual_style: ""
    tone: ""
    references: []
    avoid: []
  users_and_accessibility:
    target_users: []
    target_devices: []
    responsive: AUTO
    accessibility_level: AUTO
  deliverables:
    tokens: true
    color: true
    typography: true
    spacing: true
    grid: true
    iconography: AUTO
    component_library: true
    responsive_rules: true
    key_screens: []
    additional: []
  approval:
    owner: CEO
```

Allowed decision values are:

- `required`: `true`, `false`, or `AUTO`.
- `source`: `company_system`, `new_system`, or `AUTO`.
- `production_tool`: `figma`, `pencil`, `claude_design`, `code_native`, or
  `AUTO`.
- `responsive`: `true`, `false`, or `AUTO`.
- `accessibility_level`: a concrete target such as `WCAG_2_2_AA`, or `AUTO`.

References may be repository paths, Library-backed document identifiers, or
external URLs. A reference does not grant authority and must be accessible and
verified before use.

## Generated Project Structure

Every bootstrapped project receives:

```text
project-management/design/
  DESIGN_BRIEF.md
  DESIGN_SYSTEM.md
```

`DESIGN_BRIEF.md` records intent, users, constraints, source hierarchy,
production tool, required artifacts, acceptance criteria, owner, open questions,
and approval state.

`DESIGN_SYSTEM.md` is initially a governed template. The assigned design
specialist fills it with foundations, semantic tokens, typography, spacing,
layout, iconography, components and states, responsive behavior, accessibility,
usage guidance, artifact references, version, and approval state.

External tool files are implementation artifacts. The repository documents
remain canonical for intent, rules, decisions, approval, and traceability.

## Bootstrap Data Flow

1. The CLI copies the complete `design` object into
   `project-management/bootstrap/PROJECT_BRIEF.json`.
2. The PM reads explicit design choices before repository inference.
3. If `design.required` is `false`, it records design state as
   `NOT_APPLICABLE` and does not run the wizard.
4. If `design.required` is `true`, or is `AUTO` and discovery shows a user
   interface is in verified scope, the PM starts design discovery.
5. The PM preserves all explicit values and asks only for missing or `AUTO`
   decisions.
6. The PM updates `DESIGN_BRIEF.md`, then assigns Design System creation to an
   approved specialist selected from the Global Agent Catalog.
7. The specialist produces `DESIGN_SYSTEM.md` and any tool-specific artifacts
   under a frozen Task Contract.
8. The PM verifies required sections and references, then records the approval
   decision.

The wizard question order is:

1. Design purpose and success criteria.
2. Existing company/brand system and binding rules.
3. Production tool.
4. Visual direction, tone, references, and avoided patterns.
5. Target devices, responsive scope, and accessibility target.
6. Required screens, components, and deliverables.
7. Approval owner.

Questions are presented one at a time. Explicit answers are not requested
again unless evidence shows a material contradiction.

## Existing Company Design System

When `source` is `company_system`, the company system is the primary source.
The project Design System may fill gaps but must not silently override binding
brand rules. Conflicts, inaccessible references, or ambiguous authority place
design discovery in `BLOCKED` until the approval owner resolves them.

## Lifecycle and Governance

Design bootstrap states are:

- `PENDING`: applicability or required inputs are unresolved.
- `DISCOVERY`: the wizard is collecting missing decisions.
- `READY`: the brief and system satisfy structural checks and await approval.
- `APPROVED`: the named approval owner accepted the exact design-system version.
- `BLOCKED`: a required reference, conflict, or protected decision is unresolved.
- `NOT_APPLICABLE`: verified project scope does not require a design system.

When design is required, product UI implementation must not begin before
`APPROVED`. Discovery, brief preparation, specialist assignment, and design
artifact creation are allowed before approval. Approval applies to the exact
recorded Design System version; material changes return it to `READY`.

The bootstrap report includes design applicability, source, production tool,
state, material gaps, and any CEO decision required. `project.json` tracks the
design bootstrap state independently from the existing Project Brief state.

## Failure Handling

- Missing `design` in an older brief is accepted and resolved during discovery.
- Unknown enum values fail brief validation with the exact invalid field.
- Inaccessible company-system references cause `BLOCKED`; they are not ignored.
- Conflicting binding rules cause `BLOCKED` and require the approval owner.
- Missing approved design capability triggers the existing Agent Proposal flow.
- A design tool outage does not erase the brief or approval history; the task is
  paused or reassigned under normal governance.

## Testing

Automated tests cover:

- the default design section emitted by `toss init`;
- propagation of the complete design object to `PROJECT_BRIEF.json`;
- backward compatibility for briefs without `design`;
- validation of supported enum values;
- `required: false`, `required: true`, and `required: AUTO` scenarios;
- generated Design Brief and Design System templates;
- PM bootstrap instructions, lifecycle states, and implementation lock;
- company-system source priority and blocked conflict behavior;
- package smoke tests and packed-file inspection.

## Documentation and Release

The README and Project Brief Guide document the schema, hybrid workflow,
supported production tools, company-system priority, and generated artifacts.
The release is a SemVer minor release, changing `@toss/cli` from `1.0.0` to
`1.1.0`. After all tests pass, the implementation is committed, pushed with the
`v1.1.0` tag, and published by the existing GitHub Actions trusted-publishing
workflow.
