# npm Publish v1.2.1 Fix Design

**Status:** APPROVED FOR IMPLEMENTATION
**Date:** 2026-08-14
**Target:** TOSS CLI v1.2.1

## Purpose

Restore automated npm publication after the `v1.2.0` tag reached GitHub but
the `Publish npm package` workflow failed at the final `npm publish` step.

## Observed Failure

GitHub Actions run `31817877806` proved that checkout, version/tag validation,
dependency installation, smoke testing, and package inspection all passed.
Publication failed with npm `E404` while attempting to publish
`@toss/cli@1.2.0`.

The repository currently declares `@toss/cli`, while the approved npm Trusted
Publisher is configured for `@toss-software/cli`. The same run also reported
that npm removed the `toss` executable because `bin[toss]` used the invalid
publish path `./bin/toss.js`.

## Approaches Considered

1. **Align the repository with `@toss-software/cli` (selected).** Reuse the
   existing Trusted Publisher, correct the executable path, and publish a new
   patch release. This keeps OIDC publishing and avoids a long-lived token.
2. **Keep `@toss/cli` and create a new Trusted Publisher.** This depends on
   control of the separate npm `@toss` scope and duplicates publisher setup.
3. **Publish manually with an npm token.** This bypasses the established OIDC
   release path and introduces credential-management risk.

## Design

The patch release will change the public npm package identity to
`@toss-software/cli`, set the executable mapping to `bin/toss.js`, and bump the
package and lockfile version to `1.2.1`. README install, publish, and release
examples will use the same package identity.

The existing tag-triggered workflow remains unchanged. After the fix PR is
merged, a new annotated `v1.2.1` tag will trigger Trusted Publishing. The
failed `v1.2.0` tag will remain immutable and will not be moved or reused.

## Files

- `package.json`: package name, patch version, and executable path.
- `package-lock.json`: root package name, patch version, and executable path.
- `README.md`: package heading, installation, scope authorization, and release
  flow examples.
- `REPOSITORY_SETUP.md`: operator-facing package and installation guidance.
- `src/cli.js`: `toss --help` global-install guidance.
- `scripts/smoke-test.js`: package-publication contract assertions.

## Test Strategy

The smoke test will first fail against the current metadata by asserting the
consumer-visible package contract:

- package name is exactly `@toss-software/cli`;
- the `toss` executable maps to exactly `bin/toss.js`;
- lockfile root metadata matches `package.json` for name, version, and bin.
- `toss --help` recommends `@toss-software/cli` and does not mention the
  obsolete `@toss/cli` identity.

After the minimal metadata and documentation changes, the full smoke test and
`npm pack --dry-run` must pass. The generated tarball inspection must identify
`@toss-software/cli@1.2.1` and must not report removal of the `toss` executable.

## Release Flow

1. Merge the verified fix PR into `main`.
2. Confirm `main/package.json` reports `@toss-software/cli@1.2.1`.
3. Create and push annotated tag `v1.2.1` on the merge commit.
4. Confirm the `Publish npm package` workflow succeeds.
5. Confirm npm resolves `@toss-software/cli@1.2.1` and the installed `toss`
   executable reports version `1.2.1`.

## Success Criteria

- The publication contract is protected by the smoke test.
- The complete local test and pack checks pass without package-metadata errors.
- The fix is merged through a PR; no existing tag is rewritten.
- GitHub Actions publishes `@toss-software/cli@1.2.1` through Trusted
  Publishing.
- A clean global install exposes the `toss` command.

## Out of Scope

- Changing the generated project format or Superpowers workflow.
- Rewriting or deleting the failed `v1.2.0` tag.
- Adding npm automation tokens or other long-lived publish credentials.
- Refactoring unrelated CLI behavior.
