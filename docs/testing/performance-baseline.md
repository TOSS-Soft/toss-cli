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

The command runs the unchanged canonical `npm test` three times and records the
actual executable plus arguments in the report's closed `command` field.

For an ordinary fast-lane measurement, first create an ignored evidence
directory, then capture the report used by the comparison:

```sh
node --input-type=module -e "import {mkdirSync} from 'node:fs'; mkdirSync('.superpowers/sdd/2026-08-20-v2.1.1-issue-85-explicit-test-lanes',{recursive:true})"
npm run test:benchmark -- --runs 3 --lane fast --runner-id toss-reference-macos-node26 --output .superpowers/sdd/2026-08-20-v2.1.1-issue-85-explicit-test-lanes/fast-report.json
npm run test:performance-budget -- --baseline docs/performance/v2.1.1-baseline.json --report .superpowers/sdd/2026-08-20-v2.1.1-issue-85-explicit-test-lanes/fast-report.json --lane fast
```

The report records the truthful canonical `npm run test:fast` command. The
comparison derives the expected fast command from the locked full-origin
baseline executable; it does not treat that full-origin baseline as a fast
report.

Ordinary benchmark execution does not update the tracked baseline.
Only `--update-baseline` accepts the full lane.

## Budgets

- Fast-lane wall median: at most 15000 ms.
- Full-suite wall median: at most 70 percent of the lower of the historical
  134960 ms observation and the captured three-run median.
- Correctness and timing-budget outcomes are separate.

## Refresh boundary

Only an approved intentional test-topology change may refresh the baseline.
Use `--update-baseline`, review the complete JSON diff, and record the exact
runner, commit, Node version, platform, architecture, and lock hash. A slower capture cannot relax an existing budget.

## Diagnostics

`PERFORMANCE_BUDGET_OK` passes. `FAST_WALL_BUDGET_EXCEEDED`,
`FULL_WALL_BUDGET_EXCEEDED`, `INCOMPATIBLE_PERFORMANCE_ENVIRONMENT`, invalid
process evidence, and a failed sample exit nonzero without changing baseline.
