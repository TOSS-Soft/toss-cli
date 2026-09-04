# TOSS Core Repository Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the reviewed Core implementation and its relevant Git history from `TOSS-Soft/toss-cli` into an independently testable private `TOSS-Soft/toss-core` package.

**Architecture:** Filter only Core-owned history into the empty target repository, then normalize the extracted tree so Core owns its protocol, output, tests, package, and workflows without importing `toss-cli`. Preserve the v2.1.2 production baseline and add migration documentation on top in ordinary commits.

**Tech Stack:** Node.js 20+, ESM, Ajv 8.20.0, YAML 2.8.x, Git, git-filter-repo, npm, GitHub Packages

**Spec:** `docs/superpowers/specs/2026-09-04-toss-core-extraction-design.md`

**Plan sequence:** 1 of 4. Continue with the v2.1.3 removal, GitHub App adapter, and `toss-cli` pilot plans in that order.

## Global Constraints

- The production source baseline is exact `TOSS-Soft/toss-cli` tag `v2.1.2`, commit `62bd4aa581e11cfc3da6d7a599710209ebab7420`.
- Never rewrite or force-push `TOSS-Soft/toss-cli` history.
- The target package is private `@toss-software/core`; the executable remains `toss-core`.
- Product repositories contain no Core source, configuration, SDK dependency, or embedded runtime.
- `TOSS-Soft/toss-os-control` remains separate from application source.
- No stable `1.0.0` release is allowed until the GitHub App adapter and `toss-cli` pilot pass.
- Existing Core contracts retain their published `$id` URIs.
- Every change uses TDD, focused tests, full tests, independent review, and a separate commit.

---

## File Structure

The extraction retains these source paths before normalization:

- `bin/toss-core.js` — executable entry point
- `LICENSE` — retained source license
- `src/core/**` — Core application
- `contracts/core/**` — Core JSON schemas
- `src/contracts/{acp,schema-catalog,validator,validator-runtime,yaml-projection}.js` — required shared protocol primitives
- `src/output/command-result.js` — command result rendering
- `contracts/pipeline/command-result.v1.schema.json` — retained public result schema URI
- `test/core-*.test.js` — Core tests
- `test/fixtures/core/**` — Core fixtures
- `test/support/core-github-fixture.js` — stateful fake
- `docs/contracts/authority-severity-mapping.md` — Core authority policy mapping
- `docs/superpowers/specs/2026-08-31-toss-core-organizational-lifecycle-design.md` — original lifecycle design
- `docs/superpowers/specs/2026-09-01-toss-core-bootstrap-snapshot-validation-repair-design.md` — control-store repair design
- `docs/superpowers/plans/2026-09-01-toss-core-*.md` — original Core implementation plans
- `docs/superpowers/specs/2026-09-04-toss-core-extraction-design.md` — approved design
- `docs/superpowers/plans/2026-09-04-toss-core-repository-extraction.md` — extraction plan
- `docs/superpowers/plans/2026-09-04-toss-cli-core-removal-v2.1.3.md` — product-removal plan
- `docs/superpowers/plans/2026-09-04-toss-core-github-app-adapter.md` — live-adapter plan
- `docs/superpowers/plans/2026-09-04-toss-cli-core-pilot-onboarding.md` — pilot plan

The normalized target owns:

- `src/protocol/**` — canonical JSON, schema catalog/validator, YAML projection
- `src/output/**` — command result rendering
- `src/{commands,control,domain,operations,release,review,runtime,work}/**` — Core modules
- `scripts/test-{manifest,runner}.mjs` — Core-only test lanes
- `.github/workflows/{pull-request,publish}.yml` — Core package gates

### Task 1: Create the history-filtered target clone

**Files:**
- Preserve: all paths listed in the File Structure section
- Verify: `docs/superpowers/specs/2026-09-04-toss-core-extraction-design.md`

**Interfaces:**
- Consumes: source tag `v2.1.2`, source design branch `docs/toss-core-extraction-design`, empty target repository `git@github.com:TOSS-Soft/toss-core.git`
- Produces: local filtered branch `migration/core-extraction` with no target push yet

- [ ] **Step 1: Verify immutable source and empty target identities**

Run:

```bash
SOURCE_ROOT="$(git rev-parse --show-toplevel)"
git -C "$SOURCE_ROOT" fetch origin --tags
test "$(git -C "$SOURCE_ROOT" rev-parse v2.1.2^{commit})" = "62bd4aa581e11cfc3da6d7a599710209ebab7420"
test -z "$(git ls-remote git@github.com:TOSS-Soft/toss-core.git HEAD refs/heads/main)"
```

Expected: both commands exit 0; the target has no `HEAD` or `main` ref.

- [ ] **Step 2: Clone into a disposable migration directory**

Run:

```bash
SOURCE_ROOT="$(git rev-parse --show-toplevel)"
MIGRATION_ROOT="$(mktemp -d -t toss-core-extraction.XXXXXX)"
git clone --no-local "$SOURCE_ROOT" "$MIGRATION_ROOT/toss-core"
git -C "$MIGRATION_ROOT/toss-core" switch docs/toss-core-extraction-design
```

Expected: the disposable clone is on the approved design branch.

- [ ] **Step 3: Filter only the approved paths**

Run:

```bash
git -C "$MIGRATION_ROOT/toss-core" filter-repo --force \
  --path bin/toss-core.js \
  --path LICENSE \
  --path src/core \
  --path contracts/core \
  --path src/contracts/acp.js \
  --path src/contracts/schema-catalog.js \
  --path src/contracts/validator.js \
  --path src/contracts/validator-runtime.js \
  --path src/contracts/yaml-projection.js \
  --path src/output/command-result.js \
  --path contracts/pipeline/command-result.v1.schema.json \
  --path-glob 'test/core-*.test.js' \
  --path test/fixtures/core \
  --path test/support/core-github-fixture.js \
  --path docs/contracts/authority-severity-mapping.md \
  --path docs/superpowers/specs/2026-08-31-toss-core-organizational-lifecycle-design.md \
  --path docs/superpowers/specs/2026-09-01-toss-core-bootstrap-snapshot-validation-repair-design.md \
  --path-glob 'docs/superpowers/plans/2026-09-01-toss-core-*.md' \
  --path docs/superpowers/specs/2026-09-04-toss-core-extraction-design.md \
  --path docs/superpowers/plans/2026-09-04-toss-core-repository-extraction.md \
  --path docs/superpowers/plans/2026-09-04-toss-cli-core-removal-v2.1.3.md \
  --path docs/superpowers/plans/2026-09-04-toss-core-github-app-adapter.md \
  --path docs/superpowers/plans/2026-09-04-toss-cli-core-pilot-onboarding.md
git -C "$MIGRATION_ROOT/toss-core" branch -M migration/core-extraction
```

Expected: `git status --short` is empty and no product source path remains.

- [ ] **Step 4: Verify the production baseline survived filtering**

Run:

```bash
git -C "$MIGRATION_ROOT/toss-core" log --all --oneline -- src/core/release/state.js
git -C "$MIGRATION_ROOT/toss-core" show v2.1.2:src/core/release/state.js >/dev/null
git -C "$MIGRATION_ROOT/toss-core" ls-tree -r --name-only HEAD | \
  rg '^(src/core|contracts/core|bin/toss-core\.js|test/core-|test/fixtures/core|test/support/core-github-fixture\.js|docs/superpowers/)'
```

Expected: Core history and the v2.1.2 file are readable; every retained path is allowlisted.

- [ ] **Step 5: Point the disposable clone at the empty target**

Run:

```bash
git -C "$MIGRATION_ROOT/toss-core" remote remove origin
git -C "$MIGRATION_ROOT/toss-core" remote add origin git@github.com:TOSS-Soft/toss-core.git
git -C "$MIGRATION_ROOT/toss-core" remote -v
```

Expected: only `TOSS-Soft/toss-core` is configured as `origin`.

Do not push yet.

### Task 2: Establish the independent package boundary

**Files:**
- Create: `package.json`
- Create: `README.md`
- Create: `.gitignore`
- Move: `src/core/**` to `src/**`
- Move: `src/contracts/**` to `src/protocol/**`
- Modify: `bin/toss-core.js`
- Modify: all imports under `src/**` and `test/**`
- Test: `test/package-boundary.test.js`

**Interfaces:**
- Consumes: filtered Core tree from Task 1
- Produces: package `@toss-software/core@0.1.0` with bin `toss-core`, no import outside the repository

- [ ] **Step 1: Write the failing package-boundary test**

Create `test/package-boundary.test.js`:

```js
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import test from "node:test";

const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url)));

test("the extracted package owns one toss-core executable",() => {
  assert.equal(pkg.name,"@toss-software/core");
  assert.equal(pkg.version,"0.1.0");
  assert.deepEqual(pkg.bin,{"toss-core":"bin/toss-core.js"});
  assert.equal(pkg.repository.url,"git+https://github.com/TOSS-Soft/toss-core.git");
});

test("production imports do not reference toss-cli or the former src/core root",() => {
  const scan=spawnSync("rg",[
    "-n","from\\s+['\\\"](?:@toss-software/cli|[^'\\\"]*src/core|\\.\\./\\.\\./(?:output|contracts)/)",
    "src","bin",
  ],{encoding:"utf8"});
  assert.equal(scan.status,1,scan.stdout+scan.stderr);
  assert.equal(scan.stdout,"");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/package-boundary.test.js`

Expected: FAIL because `package.json` and the independent source layout do not exist.

- [ ] **Step 3: Move source into Core-owned paths**

Run:

```bash
mkdir -p src/protocol
git mv src/contracts/*.js src/protocol/
rmdir src/contracts
for path in src/core/*; do git mv "$path" src/; done
rmdir src/core
```

Then update imports mechanically:

```text
../contracts/acp.js                       -> ../protocol/acp.js
../../contracts/acp.js                    -> ../../protocol/acp.js
../contracts/validator.js                 -> ../protocol/validator.js
../contracts/yaml-projection.js           -> ../protocol/yaml-projection.js
../output/command-result.js                -> ../output/command-result.js
../../output/command-result.js             -> ../../output/command-result.js
../src/core/<path>                         -> ../src/<path>
../src/contracts/acp.js                    -> ../src/protocol/acp.js
../src/contracts/validator.js              -> ../src/protocol/validator.js
../../src/contracts/acp.js                 -> ../../src/protocol/acp.js
```

- [ ] **Step 4: Create package metadata**

Create `package.json`:

```json
{
  "name": "@toss-software/core",
  "version": "0.1.0",
  "description": "TOSS Software organizational lifecycle control plane",
  "type": "module",
  "bin": {"toss-core": "bin/toss-core.js"},
  "files": ["bin", "contracts", "src", "README.md", "LICENSE"],
  "engines": {"node": ">=20"},
  "dependencies": {"ajv": "8.20.0", "yaml": "^2.8.1"},
  "scripts": {
    "test": "npm run test:full",
    "test:fast": "node ./scripts/test-runner.mjs fast",
    "test:integration": "node ./scripts/test-runner.mjs integration",
    "test:e2e": "node ./scripts/test-runner.mjs e2e",
    "test:package": "node ./scripts/test-runner.mjs package",
    "test:full": "node ./scripts/test-runner.mjs full",
    "prepack": "npm test"
  },
  "publishConfig": {"registry": "https://npm.pkg.github.com"},
  "repository": {"type": "git", "url": "git+https://github.com/TOSS-Soft/toss-core.git"},
  "license": "MIT"
}
```

Create `.gitignore` with `node_modules/`, `*.tgz`, `.toss-core-control/`, and test-output directories. Create a README that states the package is a central control plane and must not be installed in product repositories.

- [ ] **Step 5: Install dependencies and repair executable imports**

Run:

```bash
npm install
chmod +x bin/toss-core.js
node --check bin/toss-core.js
node bin/toss-core.js --version
```

Expected: the CLI prints `0.1.0`.

- [ ] **Step 6: Run the package-boundary test**

Run: `node --test test/package-boundary.test.js`

Expected: PASS.

- [ ] **Step 7: Commit the independent package boundary**

```bash
git add package.json package-lock.json README.md .gitignore bin src test/package-boundary.test.js
git commit -m "refactor: establish standalone core package"
```

### Task 3: Reduce the protocol catalog to Core-owned contracts

**Files:**
- Modify: `src/protocol/schema-catalog.js`
- Modify: `src/protocol/acp.js`
- Preserve: `contracts/core/*.schema.json`
- Preserve: `contracts/pipeline/command-result.v1.schema.json`
- Test: `test/core-contracts.test.js`
- Test: `test/protocol-catalog.test.js`

**Interfaces:**
- Consumes: `validateContractSchemaCatalog(catalog)` and existing public Core schema IDs
- Produces: `CORE_SCHEMA_CATALOG`, containing exactly the 12 Core schemas plus `command-result.v1`

- [ ] **Step 1: Write the failing catalog ownership test**

Create `test/protocol-catalog.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {CORE_SCHEMA_CATALOG} from "../src/protocol/schema-catalog.js";

test("the standalone catalog owns only core and command-result schemas",() => {
  const ids=CORE_SCHEMA_CATALOG.map(row => row.schemaId);
  assert.deepEqual(ids,[
    "authority-record.v1","command-result.v1","dependency-edge.v1","epic-plan.v1",
    "operation-intent.v1","operation-receipt.v1","organization-config.v1",
    "publication-evidence.v1","release-program.v1","repository-config.v1",
    "repository-release.v1","review-result.v1","work-item.v1",
  ]);
  assert.equal(CORE_SCHEMA_CATALOG.every(row =>
    row.relativePath.startsWith("../../contracts/core/") ||
    row.relativePath==="../../contracts/pipeline/command-result.v1.schema.json"),true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/protocol-catalog.test.js`

Expected: FAIL because the extracted catalog still exports the product-wide catalog.

- [ ] **Step 3: Implement the closed Core catalog**

Rename the export in `src/protocol/schema-catalog.js` to `CORE_SCHEMA_CATALOG` and replace `definitions` with the 13 IDs asserted above. Update `src/protocol/validator.js` to import `CORE_SCHEMA_CATALOG`. Do not copy the product ACP document registry; it does not own Core schema definitions. Preserve every retained Core `schema_version`, `document_type`, `$id`, and external Core-to-Core `$ref`.

- [ ] **Step 4: Run contract tests**

Run:

```bash
node --test test/protocol-catalog.test.js test/core-contracts.test.js test/core-release-state.test.js
```

Expected: PASS with every Core document still schema- and semantics-valid.

- [ ] **Step 5: Commit the protocol boundary**

```bash
git add src/protocol contracts test/protocol-catalog.test.js
git commit -m "refactor: own core protocol catalog"
```

### Task 4: Create independent Core test lanes

**Files:**
- Create: `scripts/test-manifest.mjs`
- Create: `scripts/test-runner.mjs`
- Create: `scripts/test-manifest.json`
- Create: `test/test-manifest.test.js`
- Modify: all retained Core tests

**Interfaces:**
- Consumes: every `test/core-*.test.js`, `test/package-boundary.test.js`, `test/protocol-catalog.test.js`
- Produces: unique `fast`, `integration`, `e2e`, `package`, and `full` lanes

- [ ] **Step 1: Write the failing manifest-closure test**

Create `test/test-manifest.test.js`:

```js
import assert from "node:assert/strict";
import {readdirSync,readFileSync} from "node:fs";
import test from "node:test";

test("every standalone test has exactly one owning lane",() => {
  const manifest=JSON.parse(readFileSync(new URL("../scripts/test-manifest.json",import.meta.url)));
  const eligible=readdirSync(new URL("./",import.meta.url))
    .filter(name => name.endsWith(".test.js")).map(name => `test/${name}`).sort();
  const owned=[...manifest.lanes.fast,...manifest.lanes.integration,
    ...manifest.lanes.e2e,...manifest.lanes.package].sort();
  assert.deepEqual(owned,eligible);
  assert.equal(new Set(owned).size,owned.length);
  assert.deepEqual(manifest.lanes.full,owned);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/test-manifest.test.js`

Expected: FAIL because the independent manifest does not exist.

- [ ] **Step 3: Add Core-only test infrastructure**

Port the existing manifest validator and runner, but set the new manifest to contain only retained tests. Assign pure domain and contract tests to `fast`, real Git control-store and runner tests to `integration`, CLI lifecycle tests to `e2e`, and packed-artifact tests to `package`. Define `full` as the exact sorted union.

- [ ] **Step 4: Run every lane**

Run:

```bash
npm run test:fast
npm run test:integration
npm run test:e2e
npm run test:package
npm run test:full
```

Expected: every command exits 0 and each eligible test executes exactly once in `full`.

- [ ] **Step 5: Commit the independent lanes**

```bash
git add scripts test package.json
git commit -m "test: establish standalone core verification lanes"
```

### Task 5: Prove the packed artifact is Core-only

**Files:**
- Create: `scripts/package-artifact-test.js`
- Modify: `scripts/test-manifest.json`
- Test: `test/package-boundary.test.js`

**Interfaces:**
- Consumes: `npm pack --json`, package file inventory
- Produces: proof that the package has one executable and no product files

- [ ] **Step 1: Write the failing artifact assertions**

Add to `test/package-boundary.test.js`:

```js
test("package files exclude product-only roots",() => {
  assert.equal(pkg.files.includes("templates"),false);
  assert.equal(pkg.files.includes("bin/toss.js"),false);
});
```

Create `scripts/package-artifact-test.js` to run `npm pack --ignore-scripts --json`, inspect the returned file list, require `bin/toss-core.js`, every `contracts/core/*.json`, and every production `src/**/*.js`, then reject `bin/toss.js`, `templates/**`, and package dependency `@toss-software/cli`.

- [ ] **Step 2: Run the package lane to verify it fails**

Run: `npm run test:package`

Expected: FAIL until the new script is registered and all inventory assertions pass.

- [ ] **Step 3: Register and satisfy the package test**

Add `scripts/package-artifact-test.js` as the sole `package` lane entry. Ensure the packed executable has an executable mode and that `node <extracted>/bin/toss-core.js --version` prints `0.1.0`.

- [ ] **Step 4: Run package and full tests**

Run:

```bash
npm run test:package
npm run test:full
```

Expected: PASS.

- [ ] **Step 5: Commit the artifact boundary**

```bash
git add scripts/package-artifact-test.js scripts/test-manifest.json test/package-boundary.test.js
git commit -m "test: lock standalone core package contents"
```

### Task 6: Add pull-request and private package workflows

**Files:**
- Create: `.github/workflows/pull-request.yml`
- Create: `.github/workflows/publish.yml`
- Create: `test/workflow-contract.test.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**
- Consumes: Node 20, npm lockfile, GitHub Packages `packages: write`
- Produces: full PR gate and tag-driven private `@toss-software/core` publication

- [ ] **Step 1: Write the failing workflow contract test**

Create `test/workflow-contract.test.js` to parse both workflow files as YAML and assert:

```js
assert.equal(pullRequest.jobs.test.steps.some(step => step.run==="npm test"),true);
assert.equal(publish.on.push.tags.includes("v*"),true);
assert.equal(publish.permissions.contents,"read");
assert.equal(publish.permissions.packages,"write");
assert.equal(publish.jobs.publish.steps.some(step => step.run==="npm publish"),true);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/workflow-contract.test.js`

Expected: FAIL because the workflows do not exist.

- [ ] **Step 3: Add the PR workflow**

Create `.github/workflows/pull-request.yml` with `pull_request` and `push` to `main`, the same reviewed major versions of `actions/checkout` and `actions/setup-node` used by the source repository, Node 20 and npm cache, followed by `npm ci` and `npm test`. Grant `contents: read` only.

- [ ] **Step 4: Add the private publish workflow**

Create `.github/workflows/publish.yml` for tags `v*`. It must verify `package.json` version equals the tag without `v`, run `npm ci`, `npm test`, and `npm publish`, configure `registry-url: https://npm.pkg.github.com`, set `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, and grant only `contents: read` plus `packages: write`.

- [ ] **Step 5: Run workflow, package, and full tests**

Run:

```bash
node --test test/workflow-contract.test.js
npm run test:package
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit workflows**

```bash
git add .github/workflows test/workflow-contract.test.js scripts/test-manifest.json
git commit -m "ci: verify and publish standalone core"
```

### Task 7: Final extraction audit and first target push

**Files:**
- Modify: `README.md`
- Create: `docs/migrations/from-toss-cli-v2.1.2.md`
- Test: all retained tests

**Interfaces:**
- Consumes: Tasks 1–6 and empty target repository
- Produces: reviewed target branch `migration/core-extraction`

- [ ] **Step 1: Document provenance and migration boundary**

Create `docs/migrations/from-toss-cli-v2.1.2.md` with the exact source tag and commit, the filter path allowlist, the filtered `HEAD`, and a statement that product history was not rewritten. Update README with package installation from GitHub Packages and the warning that the local runtime remains read-only until the GitHub App plan lands.

- [ ] **Step 2: Run final source and artifact verification**

Run:

```bash
npm ci
npm test
npm pack --dry-run --json
git diff --check
rg -n '@toss-software/cli|bin/toss\.js|templates/' src bin contracts package.json
```

Expected: tests pass, the diff check is clean, and the final search has no matches.

- [ ] **Step 3: Commit provenance documentation**

```bash
git add README.md docs/migrations/from-toss-cli-v2.1.2.md
git commit -m "docs: record standalone core provenance"
git status --short
```

Expected: the documentation commit succeeds and status is clean.

- [ ] **Step 4: Verify history and target scope**

Run:

```bash
git log --follow --oneline -- src/release/state.js
git fsck --full
git ls-files | rg -v '^(\.github/|bin/|contracts/|docs/|scripts/|src/|test/|\.gitignore$|LICENSE$|README\.md$|package(-lock)?\.json$)'
```

Expected: the Core file has pre-extraction history, Git is healthy, and the last command prints nothing.

- [ ] **Step 5: Request independent review**

Review must compare the filtered v2.1.2 Core bytes with the source, audit import and package boundaries, and rerun `npm test` plus `npm run test:package`. Fix any accepted Critical or Important finding using a new failing test.

- [ ] **Step 6: Push the reviewed migration branch**

Run:

```bash
git push --set-upstream origin migration/core-extraction
```

Expected: the first target ref is created without force push.

- [ ] **Step 7: Bootstrap the target default branch from the reviewed commit**

Run:

```bash
REVIEWED_SHA="$(git rev-parse migration/core-extraction)"
git push origin "$REVIEWED_SHA:refs/heads/main"
test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$REVIEWED_SHA"
```

This is the one empty-repository bootstrap exception: the same independently reviewed commit becomes `main` without rewriting history. Set `main` as the default branch and protect it before any subsequent change; all later changes use pull requests.
