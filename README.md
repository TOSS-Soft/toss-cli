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
