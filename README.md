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
- root `CLAUDE.md` with automatic PM startup
- structured Project Brief context
- Global Agent Catalog
- project Agent Registry/bootstrap plan
- GitHub governance workflows
- trusted evaluator integration
- LangSmith configuration context
- main ruleset payload

## Fast scaffold

```bash
toss "Project Name"
```

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
