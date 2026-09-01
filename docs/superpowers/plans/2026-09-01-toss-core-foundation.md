# TOSS Core Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separately routed `toss-core` executable to `@toss-software/cli` with closed contracts, deterministic previews, authority-bound mutations, and a Git-backed private control-repository store.

**Architecture:** `toss-core` gets its own parser, CLI boundary, command handlers, and runtime under `src/core/`; it reuses only the existing canonical JSON and `command-result.v1` output primitives. Every mutation is first represented as an immutable operation intent, then applied through injected control-repository and GitHub ports, and finally recorded as a receipt. The existing project-local `toss` command tree remains unchanged.

**Tech Stack:** Node.js 20+ ESM, `node:test`, Ajv 2020 JSON Schema, Git CLI through `execFile`, existing canonical JSON/output helpers.

**Spec:** `docs/superpowers/specs/2026-08-31-toss-core-organizational-lifecycle-design.md`

**Plan sequence:** 1 of 5. Continue with `2026-09-01-toss-core-work-lifecycle.md`, `2026-09-01-toss-core-release-program.md`, `2026-09-01-toss-core-reconciliation-actions.md`, and `2026-09-01-toss-core-cutover.md` in that order.

**Global Constraints:**

- Keep `bin/toss.js`, `src/cli.js`, and `src/commands/**` behavior-compatible; `toss-core feature add` must never dispatch to the existing project-local `toss feature add` handler.
- Default every mutating command to an exact preview. Apply only after interactive confirmation or the explicit automation pair `--apply --non-interactive`; `--dry-run` must never mutate.
- Write an intent before remote mutation and an immutable receipt after it. Bind gated operations to an authority record, command, target IDs, expected revisions, policy revision, and expiry.
- Reject unknown fields, unsafe paths, accessors, proxies, duplicate operation IDs, and non-canonical input at every trust boundary.
- Add each new test entry exactly once to `scripts/test-manifest.json` and assign every new cross-boundary guarantee in `scripts/test-boundaries.json`.
- Use fakes for GitHub integration tests. Do not point tests at the production TOSS OS Project or a production repository.

## File Structure

- Create `bin/toss-core.js` as the second executable shim.
- Create `src/core/cli.js` for process-independent CLI execution and rendering.
- Create `src/core/commands/options.js`, `src/core/commands/router.js`, `src/core/commands/init.js`, and `src/core/commands/repository.js` for the independent command surface.
- Create `src/core/errors.js` for stable error codes and exit-code mapping.
- Create `src/core/contracts.js` and `contracts/core/*.schema.json` for control configuration, intents, receipts, and authority records.
- Create `src/core/control/git-repository.js` and `src/core/control/store.js` for safe Git-backed reads and atomic commits.
- Create `src/core/operations/plan.js` and `src/core/operations/runner.js` for deterministic preview/apply behavior.
- Create `src/core/input.js` for no-follow JSON/YAML input and authority loading.
- Create `src/core/runtime.js` for dependency assembly; keep GitHub access behind an injected port until the live adapter is added in plan 4.
- Create `test/core-contracts.test.js`, `test/core-command-contract.test.js`, `test/core-control-store.test.js`, `test/core-operation-runner.test.js`, and `test/core-cli-boundary.test.js`.
- Modify `src/contracts/schema-catalog.js`, `package.json`, `scripts/test-manifest.json`, and `scripts/test-boundaries.json`.

### Task 1: Register the core contract family and closed foundation schemas

**Files:**

- Modify: `src/contracts/schema-catalog.js`
- Create: `contracts/core/organization-config.v1.schema.json`
- Create: `contracts/core/repository-config.v1.schema.json`
- Create: `contracts/core/operation-intent.v1.schema.json`
- Create: `contracts/core/operation-receipt.v1.schema.json`
- Create: `contracts/core/authority-record.v1.schema.json`
- Create: `test/core-contracts.test.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `validateDocument(value, schemaId): {valid:boolean, errors:object[]}` consumes the new schema IDs through the existing validator.
- `organization-config.v1` produces `{schema_version, organization, project, control_repository, policy_revision, repositories}`.
- `operation-intent.v1` produces a closed, canonically ordered list of operations with optimistic revisions.
- `operation-receipt.v1` binds one completed or failed attempt to the exact intent and observed remote revisions.

- [ ] Write `test/core-contracts.test.js` with one valid fixture per schema and rejection cases for unknown fields, duplicate repositories, duplicate operation IDs, malformed authority expiry, and a receipt whose `intent_sha256` is not lowercase SHA-256.

```js
import assert from "node:assert/strict";
import test from "node:test";
import {validateDocument} from "../src/contracts/validator.js";
import {validateCoreDocument} from "../src/core/contracts.js";

test("core operation intent is closed and operation IDs are unique",async () => {
  const intent={
    schema_version:"operation-intent.v1",
    document_type:"operation-intent",
    intent_id:"INTENT-20260901-0001",
    command:"repo.add",
    created_at:"2026-09-01T08:00:00.000Z",
    policy_revision:"POLICY-0001",
    authority:null,
    operations:[{
      operation_id:"OP-0001",
      resource:"repository",
      action:"register",
      repository:"TOSS-Soft/toss-console",
      expected_revision:null,
      payload:{default_branch:"main"},
    }],
  };
  assert.equal(validateDocument(intent,"operation-intent.v1").valid,true);
  const duplicate={
    ...intent,
    operations:[intent.operations[0],{...intent.operations[0],action:"update"}],
  };
  assert.throws(
    () => validateCoreDocument(duplicate,"operation-intent.v1"),
    /duplicate operation_id/i,
  );
});
```

- [ ] Run `node --test test/core-contracts.test.js` and verify it fails because the core schemas are not registered.
- [ ] Extend both schema-catalog family patterns from `(agents|common|design|pipeline)` to `(agents|common|core|design|pipeline)`, then add the five core rows in stable ASCII `schemaId` order.
- [ ] Implement the schemas with `additionalProperties: false`, exact enums, anchored patterns, `uniqueItems` where scalar identity permits it, and JSON Schema `$data`-independent constraints. Use this operation item in `operation-intent.v1.schema.json`; optional compensation is itself closed and may only reverse the same declared resource identity:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["operation_id", "resource", "action", "repository", "expected_revision", "payload"],
  "properties": {
    "operation_id": {"type": "string", "pattern": "^OP-[0-9]{4,}$"},
    "resource": {"enum": ["branch", "issue", "milestone", "project", "pull_request", "repository", "workflow"]},
    "action": {"enum": ["close", "commit", "create", "merge", "register", "reopen", "update"]},
    "repository": {"type": ["string", "null"], "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"},
    "expected_revision": {"type": ["string", "null"], "minLength": 1},
    "payload": {"type": "object"},
    "compensation": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["action", "expected_revision", "payload"],
      "properties": {
        "action": {"enum": ["close", "delete", "reopen", "update"]},
        "expected_revision": {"type": ["string", "null"], "minLength": 1},
        "payload": {"type": "object"}
      }
    }
  }
}
```

- [ ] Add an explicit semantic duplicate-operation-ID check in `src/core/contracts.js` because JSON Schema cannot prove uniqueness by one object property; export `validateCoreDocument(value, schemaId)` and make it throw `CoreValidationError` with code `CORE_CONTRACT_INVALID`.
- [ ] Add `test/core-contracts.test.js` to the `fast` lane in stable ASCII order, run `node ./scripts/test-runner.mjs fast`, and commit.

```bash
git add contracts/core src/contracts/schema-catalog.js src/core/contracts.js src/core/errors.js test/core-contracts.test.js scripts/test-manifest.json
git commit -m "feat(core): define control operation contracts"
```

### Task 2: Build the independent parser, result boundary, and executable shim

**Files:**

- Create: `bin/toss-core.js`
- Create: `src/core/cli.js`
- Create: `src/core/commands/options.js`
- Create: `src/core/commands/router.js`
- Create: `test/core-command-contract.test.js`
- Modify: `package.json`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `parseCoreCommand(argv): CoreCommand` returns frozen `{name, args, options, readOnly, interactive}`.
- `dispatchCoreCommand(command, context): Promise<{exitCode, result}>` returns the existing `command-result.v1` envelope.
- `runCoreCli(argv, {cwd, stdin, stdout, stderr, runtimeProvider}): Promise<number>` never reads global process state except through its explicit wrapper.

- [ ] Write parser tests covering the complete foundation matrix: `init`, `repo add`, and `repo list`; also assert that `feature add` is recognized by the core parser as a declared later command and never imports `src/commands/feature.js`.
- [ ] Add option tests for normalized `--json`, `--apply`, `--dry-run`, `--non-interactive`, `--from <FILE>`, `--control <PATH>`, `--authority <FILE>`, and migration-only `--cutover <VERSION>`. Assert that `--apply --dry-run` and `--apply` without confirmation capability are rejected.
- [ ] Run `node --test test/core-command-contract.test.js` and verify the missing module failure.
- [ ] Implement `src/core/commands/options.js` with its own definitions and this exact approved command vocabulary. Foundation handlers exist only for `init` and `repo`; the router must return `COMMAND_NOT_IMPLEMENTED` with exit 69 for declared later commands.

```js
export const CORE_COMMAND_TOKENS=Object.freeze([
  ["init"],
  ["repo","add"], ["repo","list"],
  ["feature","add"], ["feature","status"],
  ["epic","prepare"], ["epic","status"], ["epic","approve"],
  ["epic","submit"], ["epic","accept"],
  ["issue","add"], ["issue","start"], ["issue","submit"], ["issue","status"],
  ["dependency","add"], ["dependency","remove"],
  ["dependency","graph"], ["dependency","check"],
  ["review","record"], ["review","status"],
  ["release","plan"], ["release","activate"],
  ["release","status"], ["release","approve"],
  ["program","status"],
  ["sync"], ["audit"], ["doctor"],
  ["migrate","rebaseline"],
].map(tokens => Object.freeze(tokens)));

export const CORE_COMMAND_ARGUMENTS=Object.freeze({
  init:Object.freeze([0,0]),
  "repo.add":Object.freeze([1,1]), "repo.list":Object.freeze([0,0]),
  "feature.add":Object.freeze([1,1]), "feature.status":Object.freeze([1,1]),
  "epic.prepare":Object.freeze([1,1]), "epic.status":Object.freeze([1,1]),
  "epic.approve":Object.freeze([1,1]), "epic.submit":Object.freeze([1,1]),
  "epic.accept":Object.freeze([1,1]),
  "issue.add":Object.freeze([1,1]), "issue.start":Object.freeze([1,1]),
  "issue.submit":Object.freeze([1,1]), "issue.status":Object.freeze([1,1]),
  "dependency.add":Object.freeze([2,2]), "dependency.remove":Object.freeze([2,2]),
  "dependency.graph":Object.freeze([0,1]), "dependency.check":Object.freeze([0,1]),
  "review.record":Object.freeze([1,1]), "review.status":Object.freeze([1,1]),
  "release.plan":Object.freeze([0,0]), "release.activate":Object.freeze([1,2]),
  "release.status":Object.freeze([1,1]), "release.approve":Object.freeze([1,1]),
  "program.status":Object.freeze([0,1]), sync:Object.freeze([0,1]),
  audit:Object.freeze([0,1]), doctor:Object.freeze([0,0]),
  "migrate.rebaseline":Object.freeze([0,0]),
});
```

```js
export const CORE_OPTION_DEFAULTS=Object.freeze({
  apply:false,
  authority:null,
  control:null,
  cutover:null,
  dryRun:false,
  from:null,
  json:false,
  nonInteractive:false,
});

export const CORE_EXIT_CODES=Object.freeze({
  SUCCESS:0, USAGE:2, INVALID_INPUT:3, BLOCKED:4,
  VALIDATION_FAILED:5, CONFLICT:6, NOT_IMPLEMENTED:69, INTERNAL:70,
});
```

- [ ] Implement `parseCoreCommand` without importing the legacy router. Set `readOnly` to true for status/list/audit/doctor/graph/check commands and for every mutation unless `options.apply === true`; set `interactive` only when a mutating command is not non-interactive.
- [ ] Implement `runCoreCli` with injected streams, existing `successResult`, `failureResult`, `renderCommandJson`, and `renderCommandHuman`. Make `bin/toss-core.js` only call this function and set `process.exitCode`.

```js
#!/usr/bin/env node
import {runCoreCli} from "../src/core/cli.js";

process.exitCode=await runCoreCli(process.argv.slice(2),{
  cwd:process.cwd(),
  stdin:process.stdin,
  stdout:process.stdout,
  stderr:process.stderr,
});
```

- [ ] Add `"toss-core": "bin/toss-core.js"` beside the existing `toss` bin, run the focused test, then add the test to the `fast` lane and commit.

```bash
git add bin/toss-core.js src/core/cli.js src/core/commands package.json test/core-command-contract.test.js scripts/test-manifest.json
git commit -m "feat(core): add independent toss-core command boundary"
```

### Task 3: Implement the safe Git-backed control repository

**Files:**

- Create: `src/core/control/git-repository.js`
- Create: `src/core/control/store.js`
- Create: `test/core-control-store.test.js`
- Modify: `scripts/test-manifest.json`
- Modify: `scripts/test-boundaries.json`

**Interfaces:**

- `createGitControlRepository({root, execFile, clock})` produces `{head, readDocument, commitFiles}`.
- `head(): Promise<string|null>` returns the exact 40-character commit or `null` for a new repository.
- `readDocument(relativePath, {at="HEAD"}={}): Promise<object|null>` parses closed `.yaml` or `.json` documents and rejects paths outside the root.
- `commitFiles({expectedHead, message, files}): Promise<{commit_sha:string}>` atomically checks expected head and commits canonical YAML/JSON according to each safe extension.
- `createCoreControlStore({repository})` produces `{loadOrganization, loadOrganizationState, loadRepository, listRepositories, commitIntent, commitReceipt, commitConfiguration}`.
- `loadOrganizationState(): Promise<{organization,repositories,policies,programs,receipts}>` returns one revision-consistent control snapshot for reconciliation.

- [ ] Write integration tests in a temporary Git repository for bootstrap, canonical serialization, exact-head conflict, path traversal rejection, symlink rejection, duplicate receipt immutability, and recovery after a failed pre-commit hook.
- [ ] Run `node --test test/core-control-store.test.js` and verify the missing module failure.
- [ ] Implement an own-data-function validator for the injected `execFile` port; invoke Git as `execFile("git", args, {cwd: root})`, never through a shell string.
- [ ] Implement safe relative paths that accept only `/`-separated segments matching `[A-Za-z0-9._-]+`, reject `.` and `..`, and verify every existing parent with `lstat` before writes.
- [ ] Implement `commitFiles` as: acquire `.toss-core.lock` with exclusive creation, verify `HEAD`, write canonical bytes to temporary files, rename, stage exact paths, commit, verify the new commit, and always remove the lock. Restore pre-operation bytes and index state if commit fails. Use `YAML.stringify` with sorted map entries for `.yaml` and the existing canonical JSON serializer for `.json`.
- [ ] Implement stable control layout in `src/core/control/store.js`:

```js
export const CONTROL_PATHS=Object.freeze({
  organization:"config/organization.yaml",
  repositories:"config/repositories",
  policies:"policies",
  programs:"programs",
  intents:"intents",
  receipts:"receipts",
  migrations:"migrations",
});

export function intentPath(intent) {
  const [year,month]=intent.created_at.slice(0,7).split("-");
  return `intents/${year}/${month}/${intent.intent_id}.json`;
}

export function receiptPath(receipt) {
  const [year,month]=receipt.created_at.slice(0,7).split("-");
  return `receipts/${year}/${month}/${receipt.receipt_id}.json`;
}
```

- [ ] Add `test/core-control-store.test.js` to `integration`, add `core.control-atomic-commit` and `core.control-immutable-receipt` store-integration guarantees, run integration plus boundary validation, and commit.

```bash
git add src/core/control test/core-control-store.test.js scripts/test-manifest.json scripts/test-boundaries.json
git commit -m "feat(core): persist immutable control repository ledger"
```

### Task 4: Implement deterministic operation previews and authority-bound apply

**Files:**

- Create: `src/core/operations/plan.js`
- Create: `src/core/operations/runner.js`
- Create: `src/core/authority.js`
- Create: `test/core-operation-runner.test.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `createOperationIntent(input): Promise<OperationIntent>` hashes canonical source input and assigns stable operation IDs after canonical sorting.
- `operationPreview(intent): {intent_id, intent_sha256, command, operations}` contains the complete exact changes.
- `verifyAuthority(record, binding, registry): AuthorityRecord` checks signature, actor independence, expiry, command, targets, revisions, and policy revision.
- `createOperationRunner({control, github, authorityRegistry, clock, idGenerator, policyRevision})` produces `preview(intent)`, `apply(intent, {authority})`, and `execute({command, source, operations, authority})`.
- `execute({command, source, operations, authority})` creates the deterministic intent, returns preview for default/`--dry-run`, and calls apply only for a confirmed `command.options.apply`.
- The GitHub port is an own-data-function object with `snapshot(query)`, `inspect(operations)`, and `apply(operations, {idempotencyKey})`.

- [ ] Write tests proving canonical input order yields identical intent hashes, different expected revisions yield different hashes, preview makes zero writes, apply writes intent before GitHub, apply writes receipt afterward, a retry returns the recorded receipt, and conflicting receipt or expired authority fails closed.
- [ ] Run `node --test test/core-operation-runner.test.js` and verify the missing module failure.
- [ ] Implement `createOperationIntent` so the caller supplies `intent_id`, `created_at`, `command`, `policy_revision`, `authority`, and operations; sort operations by `repository`, `resource`, `action`, then canonical payload before assigning `OP-0001` onward.

```js
export function operationPreview(intent) {
  return Object.freeze({
    schema_version:"operation-preview.v1",
    intent_id:intent.intent_id,
    intent_sha256:sha256Canonical(intent),
    command:intent.command,
    operations:intent.operations,
  });
}
```

- [ ] Implement `verifyAuthority` using the existing Node crypto public-key verification pattern from `src/commands/architecture.js`; sign canonical JSON containing `record_id`, `actor`, `command`, `targets`, `expected_revisions`, `policy_revision`, `issued_at`, and `expires_at`.
- [ ] Implement runner order exactly: validate intent, return preview when not applying, verify authority when intent declares one, check control ledger for same intent hash, commit intent, call GitHub with `intent_sha256` idempotency key, validate result, commit immutable receipt, return receipt.
- [ ] Implement `execute` as the only command-facing facade: obtain `intent_id` from `idGenerator`, timestamp from `clock`, policy revision from the injected provider, and require the caller to supply a closed source revision/hash record. Reject apply when `dryRun` is true or interactive/non-interactive confirmation rules are not satisfied.
- [ ] Convert stale expected revisions to `CoreConflictError`/exit 6, unmet gates to `CoreBlockedError`/exit 4, contract failures to exit 5, and remote transport failures to a failed receipt plus exit 70.
- [ ] Add the test to `integration`, run `node ./scripts/test-runner.mjs integration`, and commit.

```bash
git add src/core/operations src/core/authority.js test/core-operation-runner.test.js scripts/test-manifest.json
git commit -m "feat(core): execute authority-bound operation intents"
```

### Task 5: Implement `init`, repository registration, and runtime assembly

**Files:**

- Create: `src/core/runtime.js`
- Create: `src/core/input.js`
- Create: `src/core/commands/init.js`
- Create: `src/core/commands/repository.js`
- Create: `test/core-foundation-commands.test.js`
- Modify: `src/core/commands/router.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**

- `createCoreInputReader({cwd})` returns `readInput(path)` and `readAuthority(path)` with no-follow regular-file checks and JSON/YAML parsing.
- `createCoreRuntime({cwd, controlPath, execFile, github, clock, idGenerator, authorityRegistry, inputReader})` returns frozen `{control, github, operations, clock, idGenerator, readInput, readAuthority}`.
- `runInitCommand(command, services)` creates a preview for private `TOSS-Soft/toss-os-control`, organization config, project identity, and initial policy revision.
- `runRepositoryCommand(command, services)` supports `repo.add` and `repo.list` across current and future repositories.
- `repo add <OWNER/REPO> --from <FILE>` consumes `{default_branch, project_owner, project_number}` and never assumes a fixed future repository list.

- [ ] Write command tests with fake GitHub/control ports for an empty organization, repeated `init`, registration of toss-cli/runtime/console, addition of a future repository, duplicate registration conflict, and a read-only list that exposes current revisions.
- [ ] Run `node --test test/core-foundation-commands.test.js` and verify the missing handlers.
- [ ] Implement `src/core/input.js` with `O_NOFOLLOW`, regular-file and maximum-size checks, safe resolution from `cwd`, extension/content validation, and closed authority-contract validation. Inject this reader in tests; never read authority from an environment-provided path implicitly.
- [ ] Implement init operations for private control-repository creation, default-branch protection inspection, organization config commit, policy commit, and project field discovery. Keep organization/project identifiers in config, not constants outside test fixtures.
- [ ] Implement the bootstrap exception explicitly: compute/store the preview locally, verify bootstrap authority, create the private repository, and make its first commit contain organization configuration, lifecycle/release policies, bootstrap intent, and bootstrap receipt together. If repository creation succeeds but the first commit fails, mark initialization incomplete and block all other mutations behind reconciliation.
- [ ] Implement repository config as one file per normalized `OWNER/REPO`, including repository node ID, default branch, active release pointer, project item field mappings, and `registered_at`.
- [ ] Route only `init` and `repo.*` to these handlers; leave later declared families at exit 69 until their plan lands.
- [ ] Make repeated `init` and `repo add` idempotent when desired state and observed revisions match; return conflict when the same repository identity maps to different node IDs.
- [ ] Add the test to `fast`, run fast and integration lanes, and commit.

```bash
git add src/core/runtime.js src/core/input.js src/core/commands test/core-foundation-commands.test.js scripts/test-manifest.json
git commit -m "feat(core): initialize organization and repository registry"
```

### Task 6: Prove the real CLI and packed dual-binary boundary

**Files:**

- Create: `test/core-cli-boundary.test.js`
- Modify: `scripts/package-artifact-test.js`
- Modify: `scripts/test-manifest.json`
- Modify: `scripts/test-boundaries.json`

**Interfaces:**

- The real `bin/toss-core.js` process must emit only `command-result.v1` on stdout in `--json` mode.
- Packed `package.json.bin` must expose both `toss` and `toss-core`, and both shims must execute from the extracted tarball.

- [ ] Write a real-process test that initializes a temporary local control repo through fake-runtime injection, runs `repo list --json`, verifies status 0, and proves the legacy `toss feature status` result is unchanged.
- [ ] Run `node --test test/core-cli-boundary.test.js` and verify it fails before the runtime injection boundary exists.
- [ ] Add a trusted runtime-provider loader accepted only through `runCoreCli` options for tests; do not add an environment variable that can replace production authority or GitHub services.
- [ ] Extend `scripts/package-artifact-test.js` with `runPackedCoreCli`, assert both bin entries in the packed manifest, and run `toss-core --help` and `toss-core --version` from extracted bytes.

```js
function runPackedCoreCli(packageRoot,args,cwd) {
  return run(process.execPath,[path.join(packageRoot,"bin","toss-core.js"),...args],{cwd});
}

const packedManifest=JSON.parse(fs.readFileSync(
  path.join(packedRoot,"package.json"),"utf8",
));
assert.deepEqual(packedManifest.bin,{
  toss:"bin/toss.js",
  "toss-core":"bin/toss-core.js",
});
assertSuccess(runPackedCoreCli(packedRoot,["--help"],tmp),"packed toss-core help");
```

- [ ] Add `test/core-cli-boundary.test.js` to `e2e`; add `core.cli-process-boundary` as a real-cli guarantee and expand `package.packed-execution` assertions without creating a second package owner.
- [ ] Run `npm run test:fast`, `npm run test:integration`, `npm run test:e2e`, and `npm run test:package`.
- [ ] Commit the completed foundation.

```bash
git add test/core-cli-boundary.test.js scripts/package-artifact-test.js scripts/test-manifest.json scripts/test-boundaries.json
git commit -m "test(core): verify dual executable package boundary"
```

## Plan 1 Completion Gate

- [ ] Run `npm run test:full` and confirm every manifest lane passes.
- [ ] Run `npm pack --dry-run --json` and confirm `bin/toss.js`, `bin/toss-core.js`, and all `contracts/core` files are present.
- [ ] Run `git diff --check` and inspect that no production GitHub URL or token is embedded in test fixtures.
- [ ] Record the foundation commit SHA in the plan 2 execution notes before starting work-lifecycle implementation.
