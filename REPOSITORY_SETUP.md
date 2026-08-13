# Repository Setup

Target repository:

`TOSS-Soft/toss-cli`

## Repository

Recommended initial visibility: **private** while the package is being validated.

If public npm provenance is desired later, making the source repository public
allows npm Trusted Publishing to attach public provenance attestations.

## Default branch

`main`

## Ruleset

Apply:

`.github/rulesets/main-protection.json`

It enforces:

- pull request before merge;
- no force push;
- no branch deletion;
- stale review dismissal;
- resolved review threads;
- required `test` status check;
- branch must be up to date.

## npm package

Package:

`@toss/cli`

Installation after publication:

```bash
npm install -g @toss/cli
```

## npm Trusted Publisher

In npm package settings configure a GitHub Actions trusted publisher for:

- Organization/User: `TOSS-Soft`
- Repository: `toss-cli`
- Workflow: `publish.yml`

No long-lived `NPM_TOKEN` is required.

The workflow requires:

```yaml
permissions:
  contents: read
  id-token: write
```

## Release

Create a version:

```bash
npm run release:version -- patch
```

or:

```bash
npm run release:version -- minor
npm run release:version -- major
```

Then:

```bash
git push origin main --follow-tags
```

Tag `vX.Y.Z` triggers `.github/workflows/publish.yml`.

The workflow refuses to publish when the Git tag version and
`package.json` version differ.

## First release

Current package version:

`1.0.0`

Initial repository import should be tagged:

`v1.0.0`

Only create/push the tag after npm Trusted Publisher configuration is ready,
unless an intentionally failed first publish is acceptable.
