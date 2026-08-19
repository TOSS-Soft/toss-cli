# @toss-software/cli

Global TOSS project bootstrap CLI.

## Install

```bash
npm install -g @toss-software/cli
```

Then:

```bash
toss init
```

Fill `project-brief.yaml`, then:

```bash
toss create project-brief.yaml
```

## Quick Start

`init` and `create` remain the supported bootstrap flow. They create the
project governance files and are separate from the lifecycle artifact store.
Run the lifecycle commands from the generated project root.

```bash
toss project create --from project-input.yaml
toss project analyze --continue
toss project prepare --continue
```

`--from <FILE>` reads JSON or YAML only for commands that show that option.
The standalone CLI requires `--from` for input-requiring commands. Interactive
prompting is available only to an embedding host that injects a prompt service.
Use `--non-interactive` in automation to fail closed instead of being prompted.

## Project Lifecycle

Project commands persist and verify local lifecycle artifacts. `project create`
accepts initial project input, `project analyze` advances the verified input,
and `project prepare` continues the project through its local PM, architecture,
plan, and audit work when its gates permit it.

```bash
# Direct file-driven preparation is also valid.
toss project prepare --from project-input.yaml

# Inspect the current verified state and its next command.
toss project status

# Recover only from the last independently verified revision.
toss project resume --continue
```

When a project has unanswered decisions or unapproved ADRs, preparation stops
with the responsible owner and next command rather than choosing a value. A
non-interactive stopped command has a nonzero blocked exit; it never supplies a
default on your behalf. `--continue` resumes verified work and never skips
validation.

## Feature Lifecycle

Features are immutable deltas over one verified `READY_FOR_ISSUES` project;
they never rewrite the project artifacts they reference.

```bash
toss feature add --from feature.yaml
toss feature analyze --continue
toss feature prepare --continue
toss feature status
```

`feature prepare` reports readiness, blocking owner, and the next command. A
stale or not-ready project base remains a nonzero gate outcome rather than a
silent rebase.

## When Design Is Required

Design is applicable when a project or feature targets `WEB`, `MOBILE`, or
`DESKTOP`, or affects a UI surface such as a screen, flow, component,
interaction, prototype, or accessibility behavior. A scope limited to `API`,
`CLI`, or `BACKEND` with no affected UI surface is `NOT_APPLICABLE`. A
UI-affecting scope cannot request `NOT_APPLICABLE`.

The PM classification is stored in the exact Design Brief revision. It is not
inferred later from a filename, a design-tool link, or caller-supplied status.
Project design uses a `project` classification scope. A prepared feature starts
its own design state from the exact immutable `feature-delta` revision and its
verified `READY_FOR_ISSUES` project base.

## Lite, Standard and Critical Design Levels

`requested_level: AUTO` selects a level from delivery targets, affected
surfaces, and risk signals:

| Level | Selection | Exact design graph |
| --- | --- | --- |
| `NOT_APPLICABLE` | No UI target or affected UI surface; source must also be `NOT_APPLICABLE` | Design Brief only; no fabricated audit or approval |
| `LITE` | UI work without Standard or Critical risk signals | Design Brief, user flow, Design System, screen spec, Design Audit, final design approval |
| `STANDARD` | `MULTI_SCREEN`, `NEW_INFORMATION_ARCHITECTURE`, `NEW_DESIGN_SYSTEM`, `PROTOTYPE_REQUIRED`, or `USER_RESEARCH` | Lite depth plus UX analysis, information architecture, wireframe plan, visual direction, and prototype manifest |
| `CRITICAL` | `SAFETY_REGULATORY`, `SECURITY_PRIVACY`, `FINANCIAL`, `ACCESSIBILITY_HIGH`, `IRREVERSIBLE`, or `FAILURE_RECOVERY` | Standard depth plus structured usability, research, security, and privacy evidence |

An explicit applicable level selects that level for non-Critical recommendations.
A Critical recommendation cannot be silently lowered: a lower requested level
remains Critical and enters the **Critical downgrade** gate until an exact,
signed `CRITICAL_DOWNGRADE` approval binds the source and full candidate graph.

```bash
toss design approve
```

The approved lower level then becomes effective. Changing the source revision,
graph, level, or payload invalidates that approval instead of reusing it.

## Existing Company Design System vs New System

Use `source: company_system` when a verified company design system exists. Its
exact version and binding rules are authoritative: project work may add rules
with `origin: project_extension` to fill gaps, but **project extensions** cannot
silently replace a binding company rule. A departure needs an exact, scoped,
unexpired approved exception tied to the affected rule, screens, states, and
components.

Use `source: new_system` only when the work intentionally creates a new system.
All artifacts in one graph must share that source and the Design Brief's exact
source revision and SHA-256. `AUTO` is an unresolved input value, not permission
to mix company and new-system artifacts.

## UI/UX Design Lifecycle

The lifecycle stores immutable repository artifacts and a closed
`design-orchestration-state.v1`. Each response reports the verified level,
state, gate, persisted revisions, and `next_action`. Follow that exact next
action; command names do not synthesize missing design work or bypass gates.

The illustrative filename `design-brief.yaml` below must contain the full
closed `design-command-input.v1` replay package: identity and provenance,
classification input, the exact level-aware artifact graph, and the ordered
approval records. It is not a lone Design Brief document.

### UI project example

After the project source is prepared, collect the complete project-scoped
design package and start the design state. Replay the same exact package as
gates advance.

```bash
toss project prepare --from project-input.yaml --non-interactive
toss design init --from design-brief.yaml --non-interactive
toss design status
toss design prepare --from design-brief.yaml
toss readiness check
toss issues preview
```

`issues preview` is available only after both Project PDoR and UI Design DoR
are ready. Preview remains read-only.

### UI feature example

A feature is an immutable delta over one verified project. Its `design_impact`
drives classification, and `feature prepare` creates or verifies the initial
feature design state against that exact feature revision.

```yaml
design_impact:
  delivery_targets: [WEB]
  affected_surfaces: [SCREEN, FLOW, ACCESSIBILITY]
  risk_signals: [MULTI_SCREEN]
  requested_level: AUTO
  source: company_system
  purpose: Add the account recovery flow.
  success_criteria: [Every recovery state is specified and accessible.]
  approval_owner: {role: USER, identity: verified-user}
```

```bash
toss feature prepare --from feature.yaml
toss feature status
toss design status
toss design prepare --from design-brief.yaml --non-interactive
toss readiness check
```

### Backend-only N/A example

For a backend-only feature, keep both UI collections empty and use the explicit
N/A source. Preparation records a reasoned N/A Design Brief and state; it does
not fabricate Design Audit or approval authority.

```yaml
design_impact:
  delivery_targets: [BACKEND]
  affected_surfaces: []
  risk_signals: []
  requested_level: AUTO
  source: NOT_APPLICABLE
  purpose: Rotate an internal cache key.
  success_criteria: [No user-facing behavior changes.]
  approval_owner: {role: USER, identity: verified-user}
```

```bash
toss feature prepare --from backend-feature.yaml --non-interactive
toss design status
toss readiness check
```

`design prepare` and `feature prepare` create or reuse local verified
artifacts; they **do not write GitHub**. Only the separately gated
`toss issues publish --apply` path can request a remote write.

## Design Quick Commands

These are the parser-supported design paths and the labels returned in
`next_action`. The standalone executable requires `--from <FILE>` for any path
that needs input; the bare forms below do not promise an interactive prompt.

```bash
toss design init
toss design analyze
toss design prepare --from design-brief.yaml
toss design status
toss design flows
toss design wireframes
toss design direction
toss design system
toss design screens
toss design prototype
toss design audit
toss design review
toss design approve
```

All mutating design paths also accept the declared lifecycle options
`--from`, `--non-interactive`, `--json`, `--continue`, and `--project`. Do not
combine `--from` and `--continue`. `design status` is read-only and accepts
only `--json` and `--project`; there is no `design export` command and no
design-specific `--apply` flag.

## Figma, Pencil and Code-Native Assets

Repository artifacts are canonical for intent, entity identities, rules,
versions, provenance, integrity, gates, and approvals. Figma, Pencil, and
code-native **production assets** are external or repository files referenced
by an exact `prototype-manifest`; the tool file itself is not the governance
source of truth.

Each manifest asset records `asset_id`, `tool` (`figma`, `pencil`, or
`code_native`), `version`, SHA-256 integrity, and either a safe repository path
or URI. Screens are linked through exact `screen_refs`. Moving or changing a
production asset requires a new manifest revision and hash; editing a link in
place cannot retarget an approved graph. The older bootstrap Project Brief also
accepts `claude_design` as a production-work preference, but governed prototype
manifests do not treat it as an asset tool.

## Design Review and Approval

Applicable design moves through three ordered human gates:

1. **Visual direction approval** binds the exact direction-stage payload.
2. **Design System approval** binds the exact system-stage payload. Only after
   it passes may the approved non-final artifacts be persisted.
3. **Final design approval** binds the full exact graph manifest and root after
   the non-final graph is persisted.

Use the reported `next_action`; a typical gate/replay sequence is:

```bash
toss design direction --from design-brief.yaml --non-interactive
toss design approve --from design-brief.yaml --non-interactive
toss design system --from design-brief.yaml --non-interactive
toss design approve --from design-brief.yaml --non-interactive
toss design prepare --from design-brief.yaml --non-interactive
toss design review --from design-brief.yaml --non-interactive
toss design approve --from design-brief.yaml --non-interactive
toss design status --json
```

Approval records use independently verified A3 CEO or USER authority and bind
the source, level, selected artifact references, and full payload commitments.
They form an immutable ordered history. Missing, replayed, reordered, stale, or
cross-source approval material fails closed.

The standalone executable supplies only a local artifact store. It does not
discover a trusted authority registry from project files, so approval-bearing
commands and readiness checks that require that independent capability fail
closed. An embedding host must inject the constructor-bound trusted authority;
there is no README configuration shortcut that turns caller data into trust.

## UI Design Definition of Ready

`toss readiness check` reports Project PDoR and UI Design DoR separately. UI
issue generation is ready only when the exact current level graph is canonical
and linked, users and needs are evidenced where required, normal and exception
states are traversed, responsive coverage spans 320–1440 px, WCAG 2.2 AA is
recorded, binding system rules hold, Critical evidence is complete, the latest
independent audit has no blocking finding, final approval matches the exact
graph root, and every UI issue has current design trace references.

Required screen state names are `empty`, `error`, `loading`, `main`,
`permission`, and `recovery`. P0–P2 findings block; P3–P4 findings remain visible
as warnings. Backend-only work with no UI issues can pass with an explicit N/A
state and no fabricated audit or approval.

### Failed UI Design DoR example

Project readiness can pass while UI readiness blocks issue generation. The
process exit remains nonzero and identifies the rule and evidence; visible
project success is not permission to publish.

```yaml
project_readiness:
  ready_for_issue_generation: true
ui_design_readiness:
  ready_for_ui_issue_generation: false
  failures:
    - rule_id: UIDOR-030-FLOWS-AND-STATES
      message: Required normal and exception states are incomplete.
      evidence:
        - artifact: screen-spec:screen-spec:DESIGN-RECOVERY@1#<sha256>
          path: /content/states
          message: The recovery state is missing.
blocked: true
command_exit_code: 4
```

Correct the source-owned artifact, produce a new exact revision and graph,
rerun the audit and approval gates, then run readiness again. Do not edit a
persisted hash or suppress the failing rule.

## Adding a UI Feature

Start from a verified `READY_FOR_ISSUES` project and provide a complete
`feature-command-input.v1`. Use `toss feature add --from feature.yaml` when
capturing a new delta, then advance it with the normal feature lifecycle. The
required one-step preparation form is also supported:

```bash
toss feature prepare --from feature.yaml
toss design status --json
```

For UI work, the feature's `design_impact` must name the targets, affected
surfaces, risk signals, requested level, source, purpose, success criteria, and
approval owner. `feature prepare` verifies the exact project base and starts
design from the resulting `PREPARED` feature delta. A changed or newer project
base, feature source, or Design Brief is stale; it is never silently rebased.

## Frontend Issue Traceability

Every UI issue in the canonical `issue-plan` carries one `ui_design_trace`.
Each entry selects an exact artifact identity, revision, content hash, and—when
applicable—entity ID. The Design System reference selects the exact artifact;
the remaining references select the flow, screen, component, state, responsive
target, and accessibility criterion used by that issue.

```yaml
ui_design_trace:
  design_system_ref:
    {document_type: design-system, artifact_id: design-system:DESIGN-RECOVERY, revision: 3, content_sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}
  flow_refs:
    - {document_type: user-flow, artifact_id: user-flow:DESIGN-RECOVERY, revision: 2, content_sha256: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, entity_id: FLOW-RECOVERY}
  screen_refs:
    - {document_type: screen-spec, artifact_id: screen-spec:DESIGN-RECOVERY, revision: 4, content_sha256: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc, entity_id: SCREEN-RECOVERY}
  component_refs:
    - {document_type: design-system, artifact_id: design-system:DESIGN-RECOVERY, revision: 3, content_sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, entity_id: COMP-RECOVERY-FORM}
  state_refs:
    - {document_type: screen-spec, artifact_id: screen-spec:DESIGN-RECOVERY, revision: 4, content_sha256: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc, entity_id: STATE-RECOVERY-ERROR}
  responsive_refs:
    - {document_type: screen-spec, artifact_id: screen-spec:DESIGN-RECOVERY, revision: 4, content_sha256: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc, entity_id: RESPONSIVE-MOBILE}
  accessibility_refs:
    - {document_type: screen-spec, artifact_id: screen-spec:DESIGN-RECOVERY, revision: 4, content_sha256: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc, entity_id: ACCESSIBILITY-ERROR-LIVE}
```

All six entity-reference arrays are non-empty. A stale revision, wrong hash,
missing entity, N/A design with a UI trace, or mismatch between the issue plan
and design source blocks `ready_for_ui_issue_generation` and therefore blocks
publication.

## Decisions and ADRs

Use the recorded package to see what is pending, then submit an exact
authority-backed answer or ADR approval. Approval files are inputs to the
command; they must bind the current verified package and pass independent
authority validation.

```bash
toss decisions list
toss decisions answer Q-001 --from decision-answer.json --non-interactive
toss architecture review --continue
toss architecture approve ADR-001 --from adr-approval.json --non-interactive
```

`decisions list` and `architecture review` are views. A missing, invalid,
stale, or replayed authority record blocks the answer or approval without
altering the PM or ADR source artifact.

## Audit and Readiness

Inspect the generated issue plan, run its deterministic audit, and then check
the readiness evidence. An audit can complete with findings and a nonzero
validation exit; the findings remain available for correction.

```bash
toss plan show
toss audit run --continue
toss readiness check
```

Readiness returns exact failing or warning rules with a suggested owner and
next command. It is not an approval override.

## Publishing

Generate an issue-operation preview before requesting any publication. Both
preview and the default publish path are read-only.

```bash
toss issues preview
toss issues publish

# This is the only path allowed to request publication after every gate passes.
toss issues publish --apply --from publication-approval.json --non-interactive
```

Prepare can create or reuse local verified artifacts, but it has no GitHub
writer. **prepare does not write GitHub; publish is dry-run unless --apply.**
Only `issues publish --apply` may reach GitHub, and only after readiness,
audit, state, decision, ADR, authority, approval, repository, and writer gates
all pass. A blocked, stale, or partial publication remains nonzero and does not
turn into an unchecked retry.

The standalone executable supplies a local verified artifact store only. It
does not discover a trusted authority registry, repository identity, GitHub
adapter, or writer from project files. Commands that need those independently
configured services fail closed locally; this README does not provide a trust
or writer configuration shortcut.

## Automation and JSON

Use `--json` when another program needs one machine-readable result. Every
routed lifecycle success or failure writes one `command-result.v1` document to
stdout; routed JSON failures leave stderr empty and retain their nonzero exit.

```bash
toss project prepare --from project-input.yaml --non-interactive --json
toss project status --json
toss readiness check --json
```

Some gates deliberately preserve structured data while exiting nonzero. For
example, a blocked non-interactive preparation can return its decision or ADR
package with `blocked: true` and `command_exit_code: 4`; automation must honor
the process exit instead of treating visible data as completion.

## Resume and Recovery

Use the next command in `project status`, feature status, or readiness output.
For an interrupted or retryable project, recovery begins at the last verified
revision and still validates every required input and gate.

```bash
toss project status --json
toss project resume --continue --non-interactive --json
toss design status --json
toss design prepare --from design-brief.yaml --non-interactive --json
```

Do not combine `--continue` with `--from`: one resumes verified history and the
other supplies new input. If recovery evidence is missing or invalid, the
command fails closed rather than reconstructing it. For design, `status`
reconciles the latest independently verified state and exact persisted graph.
If a run stopped after partial local persistence, replay the same complete
`design-command-input.v1` with `--from`; verified revisions are reused and the
remaining topological revisions continue. If the source revision, feature base,
artifact hash, classification, or approval payload is stale, recovery stops
with a nonzero conflict instead of repairing history or accepting a replacement.

## Command Reference

Use `toss --help` for the complete current command tree and per-command help
for any lifecycle path, for example `toss issues publish --help`. The lifecycle
families are:

- `project create|analyze|prepare|status|resume`
- `feature add|analyze|prepare|status`
- `design init|analyze|prepare|status|flows|wireframes|direction|system|screens|prototype|audit|review|approve`
- `decisions list|answer`, `architecture review|approve`, and `plan show`
- `audit run`, `readiness check`, and `issues preview|publish`

The normative grammar, allowed options, safety classes, exit codes, and JSON
envelope are in the [Lifecycle Command Contract](docs/contracts/cli-lifecycle-v1.md).
Project and feature state behavior is specified in the
[Project and Feature Commands Contract](docs/contracts/project-feature-commands-v1.md);
decision, approval, readiness, and publication gates are specified in the
[Gate and Publish Commands Contract](docs/contracts/gate-publish-commands-v1.md).

## Safety Gates

Read-only commands do not write artifacts, repositories, or external services.
Commands classified as locally mutating still require their domain gates and
cannot grant unrelated authority. `--apply` is valid only for `issues publish`;
it is not a bypass for any gate.

For lifecycle commands, exit `2` means usage, `3` invalid input, `4` blocked,
`5` validation failure, `6` conflict, `69` unavailable implementation, and
`70` internal failure. Use the linked lifecycle contract for the complete
stable exit-code table and machine-result schema.

## Legacy Compatibility

Existing bootstrap and scaffold entry points are unchanged:

```bash
toss init
toss create project-brief.yaml
toss "Project Name"
```

`init`, `create`, and the quoted fast scaffold retain their established human
output rather than gaining a `command-result.v1` wrapper. The raw compatibility
form `toss trace <ENTITY-ID> [--json]` also retains its legacy trace result;
use the lifecycle command surface when a `command-result.v1` envelope is
required.

## What it creates

- TOSS PM Governance v2.0.0 Core profile by default
- root `AGENTS.md` shared agent bootstrap
- root `CLAUDE.md` `@AGENTS.md` compatibility bridge for Claude Code
- root `SUPERPOWERS.md` technical execution capability contract
- Core governance at `project-management/GOVERNANCE.md`,
  `project-management/WORK.md`, `project-management/QUALITY.md`,
  `project-management/PROJECT_STATE.md`, and
  `project-management/AGENT_REGISTRY.md`
- compact Objective, Task, decision, risk, and waiver record templates
- structured Project Brief context
- hybrid Design Brief discovery and governed Design System templates
- Global Agent Catalog
- main ruleset payload

The Core profile is mandatory and is the only governance profile installed by
default. It covers intent, authority, work, project state, agents, quality, and
evidence acceptance. It does not install production operations or incomplete
evaluation and certification integrations.

## Governance profiles

Enable the optional Delivery profile only with an explicit Project Brief
setting:

```yaml
governance:
  delivery: true
```

Delivery adds `project-management/policies/DELIVERY.md`,
`project-management/policies/OPERATIONS.md`, and the Release, Incident, and
Datafix record templates. These records do not grant production authority.
Main-branch merge, production deployment, and production data mutation require
their own explicit verified CEO authorization. Only an exact, previously
verified recovery scope may use narrower pre-authorized recovery authority.

Assurance is unavailable in v2. TOSS CLI will not offer it until a complete,
versioned external module supplies its runtime, evaluator, configuration,
workflows, datasets, and tests together.

## Agent startup

Start a supported agent host in the repository root. Generated `AGENTS.md`
provides the shared bootstrap, `CLAUDE.md` is only an `@AGENTS.md`
compatibility bridge, and `SUPERPOWERS.md` defines the required technical
execution workflow.

## Required Superpowers capability

Superpowers is the required technical method for planning, implementation,
debugging, review, verification, and development-branch completion. TOSS owns
intent, scope, authority, state, and evidence acceptance; it does not duplicate
the technical method or install provider plugins automatically. If the active
provider cannot invoke a required capability, technical execution enters
`BLOCKED_SUPERPOWERS_MISSING`; project discovery and governance work may
continue.

## Fast scaffold

```bash
toss "Project Name"
```

## Design Brief workflow

Known design decisions can be supplied in the Project Brief. Leave unresolved
values as `AUTO`; during first bootstrap, the PM/Orchestrator asks only for
the missing decisions and assigns Design System production to an approved
design specialist.

```yaml
design:
  required: true
  source: company_system
  company_design_system:
    name: TOSS Brand System
    references:
      - docs/brand-guidelines.md
    binding_rules:
      - Preserve approved logo and brand colors
  production_tool: pencil
  users_and_accessibility:
    target_devices: [desktop, mobile]
    responsive: true
    accessibility_level: WCAG_2_2_AA
  deliverables:
    component_library: true
    responsive_rules: true
    key_screens:
      - Dashboard
      - Settings
  approval:
    owner: CEO
```

Supported production tools are `figma`, `pencil`, `claude_design`, and
`code_native`. A verified company design system is the primary source; the
project system fills gaps without silently overriding binding brand rules.

New projects include:

- `project-management/design/DESIGN_BRIEF.md`
- `project-management/design/DESIGN_SYSTEM.md`

These repository documents remain canonical for intent, rules, versions, and
approval. Tool-specific files are referenced production artifacts. When design
is required, product UI implementation remains locked until the exact Design
System version is approved.

## Delivery and remote options

Delivery governance and remote GitHub operations are configured separately.
For example:

```yaml
governance:
  delivery: true
delivery:
  required_status_checks:
    - ci
    - security
  github_owner: toss-software
  visibility: private
  create_github_repository: true
  create_github_project: true
  apply_main_ruleset: true
```

The CLI adds a main-ruleset required check only when its exact context is
listed in `delivery.required_status_checks`. It does not invent or assume a
certification check. GitHub operations use the authenticated `gh` CLI.

## Migrating an existing project

Version 2 changes the generated governance file contract and never rewrites an
existing project automatically. Back up populated records and follow the
[manual governance v2 migration guide](docs/migrations/governance-v2.md).

## Requirements

- Node.js 20+
- git for normal repository initialization
- `gh` only when creating GitHub resources

## Publish

For a public scoped package:

```bash
npm publish --access public
```

The package also sets:

```json
"publishConfig": {
  "access": "public"
}
```

Publishing requires authorization for the npm `@toss-software` scope.

## Security

The CLI never requires API keys as command-line arguments and does not create
production credentials or production resources.


## Source Repository

Canonical source:

`TOSS-Soft/toss-cli`

The GitHub repository is the version source of truth.

Release model:

```text
PR → main → SemVer version/tag → GitHub Actions → npm @toss-software/cli
```

npm publication uses GitHub Actions Trusted Publishing/OIDC rather than a
long-lived npm automation token.
