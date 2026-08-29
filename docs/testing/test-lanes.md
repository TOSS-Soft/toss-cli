# Contributor test lanes

`scripts/test-manifest.json` is the single source of truth for executable test
entry ownership. It assigns every entry to exactly one lane; `full` is the
stable union of those ownership lanes, not an owner itself.

| Lane | Responsibility | Command |
| --- | --- | --- |
| `fast` | Pure contracts, parsers, and in-memory behavior | `npm run test:fast` |
| `integration` | Filesystem, artifact-store, orchestration, and composed-service behavior | `npm run test:integration` |
| `e2e` | Real CLI process and environment boundaries | `npm run test:e2e` |
| `package` | Packed-artifact contents and execution | `npm run test:package` |
| `release` | Release metadata and workflow behavior | `npm run test:release` |
| `full` | The ordered union of every lane | `npm test` |

## Manifest rules

An eligible entry is a **direct regular file** matching exactly
`scripts/*-test.js` or `test/*.test.js`. Paths use repository-relative forward
slashes. `test/support/**` and `test/fixtures/**` are import-only modules, so
they never belong to a lane and must not be invoked as standalone tests.

Before a lane runs, the runner validates the manifest and fails closed. It
rejects an unsupported schema, lane, or field; invalid concurrency; unsafe or
noncanonical paths; unstable ordering or duplicate rows; missing, unknown, or
multiply owned entries; symlinks; and unexpected nested test candidates. Run
the integrity check directly when editing test ownership:

```sh
node ./scripts/test-manifest.mjs
```

## Local development

For a focused edit, use Node's explicit-file command. These commands
deliberately bypass lane aggregation and its manifest-integrity check; they
are not a substitute for a lane or full run.

```sh
node --test test/common-contracts.test.js
node --test --test-name-pattern="closed-shape" test/common-contracts.test.js
```

Use the focused lane that owns the changed entry, then use the full suite when
the change crosses boundaries:

```sh
npm run test:fast
npm run test:integration
npm run test:e2e
npm run test:package
npm run test:release
npm test
```

`npm test` is the canonical full-suite command. It is the required pre-push
check and the same full correctness gate used for pull requests, `prepack`, and
release validation. Verify the package path with:

```sh
npm pack --dry-run
```

`npm pack --dry-run` runs `prepack`, which runs `npm test`; `npm run
test:release` is a focused release-maintenance check, not a replacement for
the full release validation.

## Benchmarking and concurrency

Follow the [performance baseline protocol](performance-baseline.md) for a
truthful three-run fast-lane capture on the named reference runner:

```sh
npm run test:benchmark -- --runs 3 --lane fast --runner-id toss-reference-macos-node26
```

Fast and full timing budgets are measured separately from ordinary correctness
and are assessed on `toss-reference-macos-node26`, not asserted by routine
test runs. Ordinary captures write to stdout or ignored `.superpowers/`
evidence and do not update the tracked baseline. The checked-in manifest
concurrency is `1`; only issue #87 may change it after measurements of values
1 through 4.
