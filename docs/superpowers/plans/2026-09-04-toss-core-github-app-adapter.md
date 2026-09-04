# TOSS Core GitHub App Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the production GitHub App and remote control-ledger adapters required for `toss-core` to govern registered TOSS Software repositories from central CI or an authorized operator machine.

**Architecture:** Keep the existing `github.snapshot`, `github.inspect`, and `github.apply` ports unchanged. Authenticate with short-lived GitHub App installation tokens, implement remote control commits with Git Data API compare-and-swap semantics, and compose both adapters only in a new live runtime; pure domain and command modules remain network-free.

**Tech Stack:** Node.js 20+, ESM, native Web API, `@octokit/auth-app@8.3.1`, `@octokit/request@10.0.16`, GitHub REST/GraphQL APIs, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-09-04-toss-core-extraction-design.md`

**Plan sequence:** 3 of 4. Requires the accepted standalone repository and v2.1.3 product removal; continue with the `toss-cli` pilot.

## Global Constraints

- Implement only in `TOSS-Soft/toss-core`; product repositories receive no code, package, or configuration.
- Use a GitHub App installation token; personal access tokens cannot authorize production mutations.
- Persist no token or private key in `toss-os-control`.
- Preserve the exact existing `snapshot(query)`, `inspect(operations)`, and `apply(operations,{idempotencyKey})` port methods.
- Every snapshot and observation is closed, canonical, detached, repository-bound, and revision-bound.
- Dry-run and preview make zero mutation API calls.
- Stale preconditions stop before the first mutation.
- Remote control commits use non-force Git reference updates and exact expected-head CAS.
- Partial GitHub application returns exact observations so the runner can persist a failed receipt.
- Do not publish `@toss-software/core@1.0.0` in this plan.

The reviewed App permission ceiling is:

- Repository: `metadata:read`, `administration:read`, `actions:write`, `checks:write`, `statuses:read`, `contents:write`, `issues:write`, and `pull_requests:write`.
- Organization: `organization_projects:write` and `members:read`.
- Explicitly absent: repository or organization `administration:write`, `workflows:write`, secrets, environments, hooks, deployments, security-product permissions, and ruleset bypass.

Tests must map every allowlisted REST/GraphQL operation to one permission above and fail if an endpoint introduces a permission outside this ceiling.

---

## File Structure

- `src/adapters/github-app/auth.js` — installation authentication
- `src/adapters/github-app/client.js` — closed REST/GraphQL request facade
- `src/adapters/github-app/snapshot/*.js` — query-family projections
- `src/adapters/github-app/inspect.js` — precondition observations
- `src/adapters/github-app/apply.js` — mutation operations
- `src/adapters/github-app/index.js` — exact three-method GitHub port
- `src/adapters/control-remote-git/repository.js` — Git Data API repository port
- `src/runtime/environment.js` — live environment validation
- `src/runtime/live-runtime.js` — production composition
- `scripts/run-command-input.mjs` — shell-free workflow launcher
- `test/adapters/github-app-*.test.js` — HTTP contract tests
- `test/adapters/control-remote-git.test.js` — remote CAS tests
- `test/live-runtime.test.js` — executable composition
- `.github/workflows/core-preview.yml` — read/preview workflow
- `.github/workflows/core-apply.yml` — protected mutation workflow

### Task 1: Close live runtime configuration and GitHub App authentication

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/runtime/environment.js`
- Create: `src/adapters/github-app/auth.js`
- Test: `test/live-environment.test.js`
- Test: `test/adapters/github-app-auth.test.js`

**Interfaces:**
- Produces: `loadLiveEnvironment(env) -> FrozenLiveEnvironment`
- Produces: `createInstallationAuth({appId,privateKey,installationId,request,clock}) -> async authorizedRequest(route,parameters)`
- Consumes: exact environment names listed below

- [ ] **Step 1: Write failing environment tests**

Create `test/live-environment.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {loadLiveEnvironment} from "../src/runtime/environment.js";

const valid={
  TOSS_CORE_GITHUB_APP_ID:"12345",
  TOSS_CORE_GITHUB_INSTALLATION_ID:"67890",
  TOSS_CORE_GITHUB_PRIVATE_KEY:"-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n",
  TOSS_CORE_CONTROL_REPOSITORY:"TOSS-Soft/toss-os-control",
  TOSS_CORE_CONTROL_BRANCH:"main",
  TOSS_CORE_AUTHORITY_REGISTRY_PATH:"config/authority-registry.json",
  TOSS_CORE_POLICY_REVISION:"POLICY-0001",
};

test("live environment closes exact runtime identities",() => {
  const result=loadLiveEnvironment(valid);
  assert.equal(result.appId,12345);
  assert.equal(result.installationId,67890);
  assert.equal(result.controlRepository,"TOSS-Soft/toss-os-control");
  assert.equal(result.controlBranch,"main");
  assert.equal(Object.isFrozen(result),true);
});

for (const key of Object.keys(valid)) test(`live environment requires ${key}`,() => {
  assert.throws(() => loadLiveEnvironment({...valid,[key]:""}),TypeError);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node --test test/live-environment.test.js test/adapters/github-app-auth.test.js
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Add exact dependencies**

Run:

```bash
npm install @octokit/auth-app@8.3.1 @octokit/request@10.0.16
```

- [ ] **Step 4: Implement environment normalization**

`loadLiveEnvironment` must read only own data descriptors for the seven declared names, parse IDs as positive safe integers, require canonical `OWNER/REPO`, require branch `main`, require safe relative authority-registry path, require `POLICY-[0-9]{4,}`, and return a detached frozen object. It must not enumerate or clone unrelated `process.env` values. The environment policy value is only an expected public pin; the live runtime must compare it with the policy revision loaded from the exact control head and fail before command execution on mismatch.

- [ ] **Step 5: Implement cached installation authentication**

Use `createAppAuth` from `@octokit/auth-app` and inject `@octokit/request`:

```js
const auth=createAppAuth({appId,privateKey,installationId,request});
const credential=await auth({type:"installation"});
const authorized=request.defaults({headers:{authorization:`token ${credential.token}`}});
```

Cache only until five minutes before `credential.expiresAt`; concurrent callers share one pending token request. Never expose the token in returned errors or observations.

- [ ] **Step 6: Run auth and hostile-boundary tests**

Tests must prove one token request under concurrency, refresh near expiry, no cache after auth failure, and typed rejection of proxy/accessor configuration without invoking traps.

Run:

```bash
node --test test/live-environment.test.js test/adapters/github-app-auth.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit authentication**

```bash
git add package.json package-lock.json src/runtime/environment.js src/adapters/github-app/auth.js test/live-environment.test.js test/adapters/github-app-auth.test.js
git commit -m "feat: authenticate the core GitHub App"
```

### Task 2: Implement remote Git control repository CAS

**Files:**
- Create: `src/adapters/control-remote-git/repository.js`
- Test: `test/adapters/control-remote-git.test.js`
- Modify: `src/runtime/live-runtime.js`

**Interfaces:**
- Produces: `createRemoteGitControlRepository({repository,branch,request,clock})`
- Produces exact repository methods: `head`, `readDocument`, `documentBlobAt`, `listDocuments`, `rootSnapshotAt`, `commitFiles`
- Consumes: GitHub Git Data API and existing `createCoreControlStore({repository})`

- [ ] **Step 1: Write failing CAS tests with a deterministic HTTP fake**

The test fake must model refs, commits, trees, and blobs. Add assertions:

```js
const control=createRemoteGitControlRepository({
  repository:"TOSS-Soft/toss-os-control",branch:"main",request:fake.request,clock:() => 0,
});
const INITIAL_SHA="a".repeat(40);
assert.equal(await control.head(),INITIAL_SHA);
const committed=await control.commitFiles({
  expectedHead:INITIAL_SHA,message:"core: test",files:{"config/test.json":{ok:true}},
});
assert.match(committed.commit_sha,/^[a-f0-9]{40}$/u);
await assert.rejects(control.commitFiles({
  expectedHead:INITIAL_SHA,message:"core: stale",files:{"config/test.json":{ok:false}},
}),error => error.code==="CORE_CONTROL_CONFLICT");
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test test/adapters/control-remote-git.test.js`

Expected: FAIL because the remote repository adapter is absent.

- [ ] **Step 3: Implement read methods through immutable Git objects**

Use:

- `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` for `head`
- `GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1` for path inventory
- `GET /repos/{owner}/{repo}/git/blobs/{file_sha}` for bytes
- YAML/JSON parsing through the same canonical projection rules as the local Git adapter

Cache trees and blobs by immutable SHA only; never cache a mutable branch ref.

- [ ] **Step 4: Implement `commitFiles` using Git object CAS**

For one request:

1. Read the branch ref and require equality with `expectedHead`.
2. Read the expected commit and base tree.
3. Canonically encode and create one blob per file.
4. Create a tree with `base_tree` equal to the expected tree.
5. Create a commit whose only parent is `expectedHead`.
6. Update `refs/heads/main` with `force:false`.
7. Map any non-fast-forward or changed-ref response to `CORE_CONTROL_CONFLICT`.

For bootstrap, require `expectedHead:null`, verify the ref is absent, create the first commit, then create `refs/heads/main`. Never force-update a ref.

- [ ] **Step 5: Prove remote conflicts and byte identity**

Add tests for concurrent writers, missing paths, immutable `at` reads, YAML canonical bytes, unsafe paths, symlink-mode tree entries, truncated recursive trees, and an API failure after commit creation but before ref update. The last case must leave the branch unchanged.

Run: `node --test test/adapters/control-remote-git.test.js test/core-control-store.test.js`

Expected: PASS.

- [ ] **Step 6: Commit remote control CAS**

```bash
git add src/adapters/control-remote-git/repository.js test/adapters/control-remote-git.test.js
git commit -m "feat: commit the control ledger with remote CAS"
```

### Task 3: Add the closed GitHub request facade

**Files:**
- Create: `src/adapters/github-app/client.js`
- Test: `test/adapters/github-app-client.test.js`

**Interfaces:**
- Produces: `createGitHubClient({request}) -> {rest,graphql,paginate}`
- Consumes: installation-authorized request function

- [ ] **Step 1: Write failing request-facade tests**

Test canonical repository parsing, REST route allowlisting, GraphQL variable closure, pagination order, rate-limit mapping, response JSON closure, and redaction of `authorization` headers from thrown errors.

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test test/adapters/github-app-client.test.js`

Expected: FAIL because `client.js` does not exist.

- [ ] **Step 3: Implement the facade**

Expose only:

```js
Object.freeze({
  rest:async (route,parameters) => closedResponse(await request(route,parameters)),
  graphql:async (document,variables) => closedResponse(await request("POST /graphql",{query:document,variables})),
  paginate:async (route,parameters) => Object.freeze(await collectAllPages(route,parameters)),
});
```

Reject unknown routes, non-plain parameters, response proxies/accessors, pagination loops, and more than 100 pages. Map 401/403 to `CORE_BLOCKED`, 404 identity absence to closed null evidence where the caller permits it, 409/412/422 revision failures to `CORE_CONFLICT`, and 429/5xx to `CORE_REMOTE_FAILURE` without exposing credentials.

- [ ] **Step 4: Run tests and commit**

```bash
node --test test/adapters/github-app-client.test.js
git add src/adapters/github-app/client.js test/adapters/github-app-client.test.js
git commit -m "feat: close GitHub API requests"
```

### Task 4: Implement bootstrap and repository snapshots

**Files:**
- Create: `src/adapters/github-app/snapshot/bootstrap.js`
- Create: `src/adapters/github-app/snapshot/repository.js`
- Create: `src/adapters/github-app/snapshot/index.js`
- Test: `test/adapters/github-app-foundation.test.js`

**Interfaces:**
- Consumes query kinds: `bootstrap`, `repository-registration`, `repository-list`
- Produces exact snapshots consumed by `commands/init.js` and `commands/repository.js`

- [ ] **Step 1: Write failing contract tests from existing command fixtures**

Run each real command handler against the HTTP fake rather than the stateful GitHub fixture. Assert bootstrap discovers organization Project fields, repository existence/revision, default-branch protection, admin access, Project membership, and repository-list revisions.

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test test/adapters/github-app-foundation.test.js`

Expected: FAIL with unsupported snapshot kinds.

- [ ] **Step 3: Implement the three projections**

Use repository node IDs and default branch object IDs as revisions; use Project node IDs and `updatedAt` plus field configuration IDs as Project revision material. Compute each source `sha256` from the exact closed semantic body. Sort repository-list results by canonical repository identity and include exactly one result per requested repository.

Support the least-privilege bootstrap path where `TOSS-Soft/toss-os-control` already exists as a private repository but has no commit or branch. Extend the closed bootstrap snapshot with exact physical-repository and ledger-initialization state, make `init` omit repository creation for that case, and let remote `commitFiles({expectedHead:null})` create the first commit/ref. Reject a nonempty uninitialized repository, a public repository, or any unexpected default ref.

- [ ] **Step 4: Prove permission and drift failures**

Add tests for absent admin permission, unprotected default branch, wrong Project, missing `Status`/`Gate` fields, duplicate Project items, repository rename, and a head update between repeated reads.

Run: `node --test test/adapters/github-app-foundation.test.js test/core-foundation-commands.test.js`

Expected: PASS.

- [ ] **Step 5: Commit foundation snapshots**

```bash
git add src/adapters/github-app/snapshot test/adapters/github-app-foundation.test.js
git commit -m "feat: observe core repository foundations"
```

### Task 5: Implement work, dependency, and review snapshots

**Files:**
- Create: `src/adapters/github-app/snapshot/work.js`
- Create: `src/adapters/github-app/snapshot/dependency.js`
- Create: `src/adapters/github-app/snapshot/review.js`
- Modify: `src/adapters/github-app/snapshot/index.js`
- Test: `test/adapters/github-app-work.test.js`

**Interfaces:**
- Consumes query kinds: `feature-by-marker`, `issue-by-marker`, `work-item`, `issue-start`, `issue-submit`, `dependency-mutation`, `dependency-graph`, `review`
- Produces exact snapshots accepted by existing Work and review command validators

- [ ] **Step 1: Write one failing real-handler test per query kind**

Use existing canonical fixtures as expected values, but construct them from mocked GitHub REST/GraphQL responses. For markers, scan issue bodies and require at most one exact managed identity. For review, include complete commits, authors, formal review, checks, Project item, reservations, and current PR head.

- [ ] **Step 2: Run to verify RED**

Run: `node --test test/adapters/github-app-work.test.js`

Expected: FAIL with unsupported query kinds.

- [ ] **Step 3: Implement work and dependency projection**

Project GitHub issues, labels, milestone, parent markers, branches, PRs, and Project fields into the existing closed Work documents. Reconstruct dependency edges only from exact Core-managed markers; reject duplicate, dangling, tombstoned-active, or cross-identity evidence before returning a graph.

- [ ] **Step 4: Implement review projection**

Bind `native_revision`, composite snapshot revision, base/head SHAs, complete commit list digest, implementation authors, formal review ID/state, stored review result, required checks, and Project reservations. Never infer independence from display names; return complete immutable identities for the domain validator.

- [ ] **Step 5: Add hostile and pagination tests**

Cover more than one page of issues/commits, reordered API results, deleted branches, force-pushed PRs, duplicate managed markers, incomplete check suites, Unicode identity substitutions, and accessor/proxy response objects. Expected outcomes are deterministic typed failures with zero mutation requests.

- [ ] **Step 6: Run and commit**

```bash
node --test test/adapters/github-app-work.test.js test/core-work-commands.test.js test/core-review.test.js
git add src/adapters/github-app/snapshot test/adapters/github-app-work.test.js
git commit -m "feat: observe governed work and reviews"
```

### Task 6: Implement epic and release snapshots

**Files:**
- Create: `src/adapters/github-app/snapshot/epic.js`
- Create: `src/adapters/github-app/snapshot/release.js`
- Modify: `src/adapters/github-app/snapshot/index.js`
- Test: `test/adapters/github-app-release.test.js`

**Interfaces:**
- Consumes epic kinds: `epic-prepare`, `epic-approval`, `epic-submit`, `epic-accept`, `epic-status`
- Consumes release kinds: `release-plan`, `release-activation`, `release-status`, `program-status`, `release-approval`, `release-publication`, `patch-interruption`, `patch-completion`
- Produces exact snapshots consumed by existing epic/release projectors

- [ ] **Step 1: Write failing stateless restart tests**

For every query kind, construct a fresh adapter instance over the same HTTP state and require byte-identical snapshots. Include the exact query descriptor in aggregate release snapshots; no `lastRequest` or in-memory planning body may be required for replay.

- [ ] **Step 2: Run to verify RED**

Run: `node --test test/adapters/github-app-release.test.js`

Expected: FAIL with unsupported query kinds.

- [ ] **Step 3: Implement epic projections**

Return complete approved plan scope, child evidence, dependency targets, active release assignment, physical branch, PR, current review/check evidence, and Project identity. Bind every child and edge revision to the same repository and approved plan.

- [ ] **Step 4: Implement release planning/status projections**

Read every registered repository named by the query, published tags/packages/releases, open managed work, milestones, release branches, PRs, Project items, and checks. Return results in canonical repository/program/release order. Reject live published-version regression below immutable Released history.

- [ ] **Step 5: Implement approval/publication and patch projections**

Bind exact approval PR base/head, independent review, implementation identity, required checks, branch rules, workflow definition, workflow run target SHA, package integrity, GitHub Release assets, complete assigned-work inventory, and phase evidence. Publication workflow observations must target the approved merge SHA rather than the workflow-definition revision.

- [ ] **Step 6: Run release and restart tests**

```bash
node --test test/adapters/github-app-release.test.js \
  test/core-epic-lifecycle.test.js test/core-release-activation.test.js \
  test/core-patch-interruption.test.js test/core-release-completion.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit release snapshots**

```bash
git add src/adapters/github-app/snapshot test/adapters/github-app-release.test.js
git commit -m "feat: observe epic and release programs"
```

### Task 7: Implement exact precondition inspection

**Files:**
- Create: `src/adapters/github-app/inspect.js`
- Test: `test/adapters/github-app-inspect.test.js`

**Interfaces:**
- Produces: `inspect(operations) -> FrozenObservedRevision[]`
- Consumes: canonically ordered operations from the existing runner

- [ ] **Step 1: Write failing inspection tests**

Cover every resource class: repository, issue, branch, pull request, project, milestone, review/check, workflow, release, package, and aggregate precondition. Each test mutates one remote revision after preview and asserts inspection reports the changed revision without making a write.

- [ ] **Step 2: Run to verify RED**

Run: `node --test test/adapters/github-app-inspect.test.js`

Expected: FAIL because `inspect.js` is absent.

- [ ] **Step 3: Implement verify-only and mutation preflight**

Dispatch by the closed `(resource, action, payload.kind)` tuple. Reconstruct aggregate queries solely from serialized operation payloads. Return exactly `{operation_id,repository,revision}` for each operation, ordered by operation ID. Verify-only operations are inspected and receipt-covered but never forwarded to apply.

- [ ] **Step 4: Prove zero-write conflicts**

Run runner integration tests where default branch, existing branch, milestone, PR, Project item, check, workflow target, or aggregate source changes after confirmation. Assert `github.apply` call count remains zero and no manifest advances.

- [ ] **Step 5: Run and commit**

```bash
node --test test/adapters/github-app-inspect.test.js test/core-operation-runner.test.js
git add src/adapters/github-app/inspect.js test/adapters/github-app-inspect.test.js
git commit -m "feat: inspect GitHub preconditions before mutation"
```

### Task 8: Implement semantically ordered GitHub mutation application

**Files:**
- Create: `src/adapters/github-app/apply.js`
- Test: `test/adapters/github-app-apply.test.js`

**Interfaces:**
- Produces: `apply(operations,{idempotencyKey}) -> {status:"completed",observed_revisions}` or throws a closed remote error containing exact applied observations
- Consumes: non-verify operations after successful inspection

- [ ] **Step 1: Write failing mutation tests by resource/action/payload tuple**

Test repository creation/protection, issue creation/update/close, branch creation, PR creation/update/merge, milestone creation, Project membership/field updates, managed review body/result writes, check requests, workflow dispatch, GitHub Release creation, and exact no-op replay.

- [ ] **Step 2: Run to verify RED**

Run: `node --test test/adapters/github-app-apply.test.js`

Expected: FAIL because `apply.js` is absent.

- [ ] **Step 3: Implement closed mutation dispatch**

Use one explicit dispatch table keyed by `${resource}:${action}:${payload.kind}`. Unknown tuples throw `CORE_VALIDATION_FAILED` before a request. Send `Idempotency-Key` where GitHub accepts it and embed the Core operation ID in managed issue/PR markers where API idempotency is unavailable.

- [ ] **Step 4: Implement post-write observation**

After each mutation, read the resource again and return its immutable revision. If mutation N fails, stop immediately and throw a `CORE_REMOTE_FAILURE` carrying observations for operations `0..N-1`; never report an unapplied operation as observed.

- [ ] **Step 5: Prove semantic order and replay**

Tests must assert milestone before release branch, intent before remote writes, branch before PR, merge before workflow, remote publication before manifest, epic merge before close before Project Done, and patch review stale PR update paired with its Project update. Replay returns matching revisions without duplicate resources.

- [ ] **Step 6: Run and commit**

```bash
node --test test/adapters/github-app-apply.test.js test/core-operation-runner.test.js
git add src/adapters/github-app/apply.js test/adapters/github-app-apply.test.js
git commit -m "feat: apply governed GitHub operations"
```

### Task 9: Compose the live runtime and executable

**Files:**
- Create: `src/adapters/github-app/index.js`
- Create: `src/runtime/live-runtime.js`
- Modify: `bin/toss-core.js`
- Test: `test/live-runtime.test.js`
- Modify: `src/cli.js`

**Interfaces:**
- Produces: `createLiveCoreRuntimeProvider({env,request,clock,idGenerator})`
- Consumes: exact live environment, GitHub App adapter, remote Git control repository, authority registry file

- [ ] **Step 1: Write the failing executable composition test**

Spawn `bin/toss-core.js repo list --json` with a fake authorized request transport injected through the exported live provider. Assert the control state and repository snapshots come from remote adapters, not the former local unavailable adapter.

- [ ] **Step 2: Run to verify RED**

Run: `node --test test/live-runtime.test.js`

Expected: FAIL because the executable still composes only the local runtime.

- [ ] **Step 3: Compose exact live services**

`createLiveCoreRuntimeProvider` must:

1. Normalize live environment.
2. Create installation auth and authorized request facade.
3. Create remote Git control repository and `createCoreControlStore`.
4. Read the authority registry from `TOSS_CORE_AUTHORITY_REGISTRY_PATH` through the closed input reader.
5. Build the exact GitHub port from snapshot, inspect, and apply.
6. Load the policy revision from the same verified control head and require exact equality with the `TOSS_CORE_POLICY_REVISION` environment pin before using it for authority binding.
7. Return the existing CLI service shape.

The executable selects live runtime only when all seven live environment values are present. With none present, it retains the explicit read-only local runtime. A partial live configuration fails with exit 5; it never silently falls back.

- [ ] **Step 4: Prove preview, apply, and confirmation paths**

Tests cover read-only status, preview, dry-run, interactive decline, non-interactive apply, authority-required apply, stale remote control head, and redacted authentication failure.

- [ ] **Step 5: Run and commit**

```bash
node --test test/live-runtime.test.js test/core-cli-boundary.test.js
git add bin/toss-core.js src/adapters/github-app/index.js src/runtime/live-runtime.js src/cli.js test/live-runtime.test.js
git commit -m "feat: run toss-core through the live GitHub App"
```

### Task 10: Add central preview and protected apply workflows

**Files:**
- Create: `.github/workflows/core-preview.yml`
- Create: `.github/workflows/core-apply.yml`
- Create: `scripts/run-command-input.mjs`
- Create: `test/live-workflow-contract.test.js`
- Create: `test/workflow-command-input.test.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**
- Consumes: GitHub App secrets, authority registry, exact `argv_json`, optional public `input_json`, optional public `authority_json`, expected control revision
- Produces: central serialized preview/apply entry points

- [ ] **Step 1: Write failing workflow contract tests**

Assert both workflows use Node 20, `npm ci`, and a concurrency group named `toss-core-control`. Preview has read-only GitHub workflow permissions and rejects `--apply`. Apply uses `workflow_dispatch`, a protected `production` environment, `cancel-in-progress:false`, optional public authority JSON, an exact expected control revision, and invokes one shell-free launcher process.

In `test/workflow-command-input.test.js`, reject non-array/nested input, unknown or duplicate options, embedded NUL/newline bytes, user-supplied `--from`/`--authority` paths, missing required workflow-mode flags, malformed input/authority JSON, and control-revision mismatch. Assert one child process is spawned with `shell:false` and that temporary files are removed after success and failure.

- [ ] **Step 2: Run to verify RED**

Run: `node --test test/live-workflow-contract.test.js`

Expected: FAIL because the workflows are absent.

- [ ] **Step 3: Implement the shell-free launcher**

`scripts/run-command-input.mjs` parses `argv_json` as a dense JSON array of strings, rejects user-supplied `--from`/`--authority` paths and shell-control bytes, and creates a mode-0700 working directory under `RUNNER_TEMP`. If `input_json` or `authority_json` is present, it writes mode-0600 `input.json` or `authority.json`, appends the corresponding `--from` or `--authority` option exactly once, and then passes the resulting argv through `parseCoreCommand`. It spawns `process.execPath` plus the absolute `bin/toss-core.js` path with `shell:false` and the secure directory as cwd, then removes the directory in `finally`. Preview mode rejects `--apply`; apply mode requires `--apply --non-interactive --json`.

- [ ] **Step 4: Create the preview workflow**

Accept `argv_json` and optional `input_json` as dispatch inputs. Materialize the public-key-only authority registry from a protected repository-environment variable into the launcher's secure temporary directory. Mint an installation token at runtime, run the launcher in preview mode, upload the canonical JSON preview artifact, and discard the token and temporary files when the job ends.

- [ ] **Step 5: Create the apply workflow**

Require the `production` environment, `argv_json`, optional `input_json`, optional `authority_json`, and exact expected control revision. Materialize the same public-key-only authority registry from the protected environment; no authority private key enters CI. Set `concurrency.group: toss-core-control` and `cancel-in-progress:false`. Mint the installation token, run the launcher once, then upload the result and receipt identity even on failure. No workflow step evaluates command text through a shell.

- [ ] **Step 6: Run complete verification**

Run:

```bash
node --test test/live-workflow-contract.test.js test/workflow-command-input.test.js
npm run test:fast
npm run test:integration
npm run test:e2e
npm run test:package
npm test
git diff --check
```

Expected: PASS.

- [ ] **Step 7: Commit workflows**

```bash
git add .github/workflows/core-preview.yml .github/workflows/core-apply.yml \
  scripts/run-command-input.mjs test/live-workflow-contract.test.js \
  test/workflow-command-input.test.js scripts/test-manifest.json
git commit -m "ci: operate core through protected workflows"
```

### Task 11: Run live-adapter acceptance and publish a private prerelease

**Files:**
- Create: `docs/operations/github-app.md`
- Create: `docs/releases/v0.2.0.md`
- Test: complete package

**Interfaces:**
- Consumes: Tasks 1–10, dedicated GitHub test organization resources
- Produces: reviewed private `@toss-software/core@0.2.0`

- [ ] **Step 1: Document exact GitHub App permissions and secrets**

Document every requested permission with the operation tuples that use it, cross-checked against GitHub's official [permission-to-endpoint table](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) and [installation-token rules](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app). Restrict the sandbox installation to `TOSS-Soft/toss-core`, `TOSS-Soft/toss-os-control`, the dedicated private test repository, and `TOSS-Soft/toss-cli`; do not select all organization repositories. Installation tokens must additionally request only the repository IDs needed for the current command.

- [ ] **Step 2: Execute sandbox E2E**

Against a dedicated private test repository and test Project, run bootstrap preview, repository registration preview/apply/replay, feature intake, epic lifecycle, release lifecycle, stale-revision failure, and partial-failure reconciliation. Preserve the resulting control ledger as encrypted CI evidence, not in the application repository.

- [ ] **Step 3: Run final package gates**

```bash
npm ci
npm test
npm pack --dry-run --json
git diff --check
```

Expected: PASS and a clean diff check; the two new documentation files remain the only planned changes.

- [ ] **Step 4: Request independent security and lifecycle review**

The review must inspect permission minimization, credential redaction, remote control CAS, zero-write stale behavior, exact partial receipts, stateless replay, cross-repository isolation, and package contents. Accepted findings require direct failing regressions.

- [ ] **Step 5: Version and publish the prerelease**

Run:

```bash
npm version 0.2.0 --no-git-tag-version
npm test
git add package.json package-lock.json docs/releases/v0.2.0.md docs/operations/github-app.md
git commit -m "chore: prepare core v0.2.0"
git status --short
git tag -a v0.2.0 -m "TOSS Core v0.2.0"
git push origin main --follow-tags
```

Run the tag and push commands only after the independent review is explicitly accepted and the release operator authorizes publication. Expected: the tag-driven workflow publishes `@toss-software/core@0.2.0` only to GitHub Packages.
