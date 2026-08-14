# @toss/cli

Global TOSS project bootstrap CLI.

## Install

```bash
npm install -g @toss/cli
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

- TOSS PM Governance v1.6.0
- root `AGENTS.md` shared agent bootstrap
- root `CLAUDE.md` `@AGENTS.md` compatibility bridge for Claude Code
- root `SUPERPOWERS.md` technical execution capability contract
- structured Project Brief context
- hybrid Design Brief discovery and governed Design System templates
- Global Agent Catalog
- project Agent Registry/bootstrap plan
- GitHub governance workflows
- trusted evaluator integration
- LangSmith configuration context
- main ruleset payload

## Agent startup

Start a supported agent host in the repository root. Generated `AGENTS.md`
provides the shared bootstrap, `CLAUDE.md` is only an `@AGENTS.md`
compatibility bridge, and `SUPERPOWERS.md` defines the required technical
execution workflow.

## Required Superpowers capability

Generated projects require Superpowers for technical planning, implementation,
debugging, review, verification, and development-branch completion. TOSS does
not install provider plugins automatically and does not fall back to its former
development method. If the active provider cannot invoke a required capability,
technical execution enters `BLOCKED_SUPERPOWERS_MISSING`; project discovery and
governance work may continue.

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

## Remote options

Project Brief can opt into:

```yaml
delivery:
  github_owner: toss-software
  visibility: private
  create_github_repository: true
  create_github_project: true
  apply_main_ruleset: true
```

GitHub operations use the authenticated `gh` CLI.

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

Publishing requires authorization for the npm `@toss` scope.

## Security

The CLI never requires API keys as command-line arguments and does not create
production credentials or production resources.


## Source Repository

Canonical source:

`TOSS-Soft/toss-cli`

The GitHub repository is the version source of truth.

Release model:

```text
PR → main → SemVer version/tag → GitHub Actions → npm @toss/cli
```

npm publication uses GitHub Actions Trusted Publishing/OIDC rather than a
long-lived npm automation token.
