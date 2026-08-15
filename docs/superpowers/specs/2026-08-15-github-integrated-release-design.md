# GitHub-Integrated Release Design

**Date:** 2026-08-15

**Status:** Approved for planning

## Goal

Make a version tag the single release trigger for TOSS CLI. A successful run
must publish the same tested source to npmjs and GitHub Packages, then create a
GitHub Release that is visible as the repository's latest release. The GitHub
repository sidebar must consequently show both the current release and a linked
package.

## Package Identities

The established public npm package remains `@toss-software/cli`; changing it
would break the existing install path and Trusted Publishing configuration.

The GitHub Packages copy is owned by the repository organization and uses
`@toss-soft/cli`. It contains the same CLI payload and version as the npmjs
package. Its package metadata continues to link to `TOSS-Soft/toss-cli`, so the
package is associated with the repository.

## Release Trigger and Version Contract

The release workflow runs only for semantic version tags matching `v*.*.*`.
Before any publication it must prove all of the following:

- the tag version exactly equals `package.json.version`;
- the tag resolves to the checked-out release commit;
- the release commit is contained in `main`;
- the complete test suite passes;
- one canonical npm tarball can be built and inspected.

The first release under this design is `v2.0.0` from the merge result of pull
request #8.

## Workflow Architecture

`.github/workflows/publish.yml` remains the release entry point. It is split
into explicit ordered jobs:

1. **Validate and package** checks the version/main ancestry contract, installs
   dependencies, runs the complete test suite, builds one canonical tarball,
   and uploads that tarball as a workflow artifact.
2. **Publish npmjs** downloads the verified artifact and publishes
   `@toss-software/cli` through npm Trusted Publishing.
3. **Publish GitHub Packages** downloads the verified artifact, prepares an
   ephemeral package tree whose only package-identity change is the name
   `@toss-soft/cli`, and publishes it to `https://npm.pkg.github.com` with the
   workflow `GITHUB_TOKEN`.
4. **Create GitHub Release** runs only after both registries succeed, creates a
   non-draft, non-prerelease release for the existing tag, generates release
   notes, attaches the canonical npm tarball, and marks the release as latest.

The repository source and committed `package.json` are never rewritten to the
GitHub Packages identity. The alternate name exists only in an ephemeral
workflow directory.

## Permissions and Authentication

Workflow permissions are explicit and minimal for the required operations:

- `contents: write` for the GitHub Release;
- `packages: write` for GitHub Packages;
- `id-token: write` for npm Trusted Publishing.

No npm automation token or cross-account GitHub personal access token is
introduced. npmjs authentication stays OIDC-based, and GitHub Packages uses the
repository-scoped `GITHUB_TOKEN`.

## Idempotence and Failure Handling

Each registry job checks whether its exact package version already exists.
When it exists, the job verifies the version and records a safe skip instead of
attempting a duplicate publish. This supports recovery from partial workflow
failure without overwriting immutable package versions.

The GitHub Release job is gated on successful completion of both publication
jobs. It creates the release only after both package versions are available. A
rerun detects an existing release for the same tag and verifies or updates its
metadata and attached canonical tarball instead of creating a duplicate.

Any version mismatch, non-main tag, test failure, package-build failure,
registry rejection, or permission failure stops the chain. A failure before the
final job cannot produce a successful GitHub Release.

## Pull Request and Merge Sequence

The workflow change and its tests are added to pull request #8 before merge.
The pull request must remain on the approved
`agent/modular-governance-v2-design` branch and preserve its existing commit
history. After the updated CI succeeds, the pull request is merged to `main`
with a merge commit.

The `v2.0.0` tag is created only after the merge, at the exact resulting
`main` commit. Pushing that tag starts the release workflow.

## Verification

Automated tests must validate the workflow contract without publishing:

- semantic tag trigger and version validation;
- main-ancestry gate;
- required permissions;
- ordered dependency graph;
- distinct npmjs and GitHub Packages identities and registries;
- canonical tarball reuse;
- duplicate-version handling;
- GitHub Release gating, latest status, generated notes, and tarball attachment.

Before merge, the complete existing `node --run test` chain, the new workflow
contract test, package dry-run/packed-artifact checks, YAML parsing, and
`git diff --check` must pass. After merge, the main-branch CI must succeed
before `v2.0.0` is tagged. After the tag workflow completes, verification must
confirm both registry versions and the GitHub Release URL/status.

## Out of Scope

- Renaming or removing the public npmjs package.
- Publishing container images.
- Adding a personal access token.
- Creating a release before both package publications succeed.
- Automatically publishing a new version from every merge to `main`.
