# TOSS CLI Test Performance Baseline

## Reference environment

- Runner ID: `toss-reference-macos-node26`
- Platform: macOS
- Architecture: arm64
- Node.js: 26.6.0
- Dependencies: warm `node_modules` from the committed `package-lock.json`
- Network: no install, fetch, registry, or application network access

## Capture

Run `npm run test:benchmark -- --runs 3 --lane full --runner-id
toss-reference-macos-node26 --update-baseline
docs/performance/v2.1.1-baseline.json` from a clean issue #84 checkout.

The command runs the unchanged canonical `npm test` three times. Ordinary
benchmark execution does not update the tracked baseline.

## Budgets

- Fast-lane wall median: at most 15000 ms.
- Full-suite wall median: at most 70 percent of the lower of the historical
  134960 ms observation and the captured three-run median.
- Correctness and timing-budget outcomes are separate.

## Refresh boundary

Only an approved intentional test-topology change may refresh the baseline.
Use `--update-baseline`, review the complete JSON diff, and record the exact
runner, commit, Node version, platform, architecture, and lock hash. A slower
capture cannot relax an existing budget.

## Diagnostics

`PERFORMANCE_BUDGET_OK` passes. `FAST_WALL_BUDGET_EXCEEDED`,
`FULL_WALL_BUDGET_EXCEEDED`, `INCOMPATIBLE_PERFORMANCE_ENVIRONMENT`, invalid
process evidence, and a failed sample exit nonzero without changing baseline.
