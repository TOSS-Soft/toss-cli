# Task 5 implementation report — organization bootstrap and repository registry

## RED / GREEN

- RED: `node --test test/core-foundation-commands.test.js` failed with the expected missing `src/core/input.js` module. Later RED cycles proved the missing atomic `commitBootstrap` store seam, the original command-schema incompatibility with `init`/single-segment commands, router dispatch absence, and hidden-port acceptance.
- GREEN: the focused foundation suite now covers closed input reading, bootstrap preview/apply/idempotency/incomplete state, repository registration/idempotency/conflict, read-only revision-aware listing, runtime hardening, and exit-69 later commands.

## Delivered

- Closed, descriptor-safe local input and authority reader with no-follow file access, regular-file/size checks, safe relative paths, canonical JSON/YAML parsing, and YAML duplicate/alias/merge rejection.
- Explicit runtime assembly for Git control store, operation runner, GitHub, clock, IDs, policy revision, and input reader.
- `init`, `repo add`, and `repo list` handlers are wired into the independent core router. No legacy feature router is imported.
- Bootstrap uses the narrow `commitBootstrap({expectedHead:null, files})` seam: organization config, both policies, authority-bound intent, and receipt are committed in one unborn-repository CAS. A remotely existing control repo with no matching local transaction blocks as reconcile-required.
- Repository registration accepts every canonical owner/repository identity, writes the approved reversible `%2F` config path, and preserves atomic organization/repository configuration updates.
- Single-segment normalized command names are now valid in authority and intent contracts; malformed dot/hyphen forms remain rejected.

## Verification

- `node --test test/core-foundation-commands.test.js test/core-contracts.test.js test/core-control-store.test.js test/core-operation-runner.test.js`
- `npm run test:fast`
- `npm run test:integration`
- `node scripts/test-boundaries.mjs`
- Syntax checks for all changed core modules and `git diff --check`

All commands passed on 2026-09-01.

## Interface decision / risks

- The approved bootstrap requirement cannot use the ordinary runner sequence because it would persist intent and receipt separately. `commitBootstrap` is limited to an unborn control repository, exactly five closed files, one `init` intent, and one bound receipt.
- Runtime requires an explicit `policyRevision` function. This avoids embedding a production policy constant; callers must supply the explicit configured policy revision.
- Live GitHub provisioning remains adapter-injected by design. The new command tests use closed fake adapters and make no network or GitHub mutations.
