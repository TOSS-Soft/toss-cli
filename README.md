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
Without `--from`, prompt-capable commands run interactively; use
`--non-interactive` in automation to fail closed instead of being prompted.

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
```

Do not combine `--continue` with `--from`: one resumes verified history and the
other supplies new input. If recovery evidence is missing or invalid, the
command fails closed rather than reconstructing it.

## Command Reference

Use `toss --help` for the complete current command tree and per-command help
for any lifecycle path, for example `toss issues publish --help`. The lifecycle
families are:

- `project create|analyze|prepare|status|resume`
- `feature add|analyze|prepare|status`
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
