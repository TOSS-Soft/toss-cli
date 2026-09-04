# TOSS CLI Core Removal v2.1.3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the incorrectly embedded Core implementation and `toss-core` executable from `@toss-software/cli`, while preserving the complete `toss` product CLI and publishing the correction as v2.1.3.

**Architecture:** Treat the standalone Core extraction as a hard prerequisite, then delete only Core-owned package surfaces from `toss-cli`. Lock the negative package boundary in tests so Core cannot silently return to a product repository.

**Tech Stack:** Node.js 20+, ESM, npm, existing TOSS CLI test runner and release workflow

**Spec:** `docs/superpowers/specs/2026-09-04-toss-core-extraction-design.md`

**Plan sequence:** 2 of 4. Requires independent acceptance of the extracted `toss-core` package; continue with the GitHub App adapter.

## Global Constraints

- Begin from exact `TOSS-Soft/toss-cli` v2.1.2 commit `62bd4aa581e11cfc3da6d7a599710209ebab7420` plus the approved design/plan documentation.
- Do not begin removal until the standalone `toss-core` extraction pull request passes its complete test and package review.
- Publish the removal as `@toss-software/cli@2.1.3`, as explicitly approved.
- Remove the embedded implementation immediately; do not add a shim, forwarding binary, or dependency on `@toss-software/core`.
- Retain product-owned canonical JSON, validator, YAML, output, and test infrastructure still used by `toss`.
- Do not change `toss` command behavior or generated project templates.
- Every task uses a separate TDD cycle and commit.

---

## File Structure

Delete:

- `bin/toss-core.js`
- `src/core/**`
- `contracts/core/**`
- `test/core-*.test.js`
- `test/fixtures/core/**`
- `test/support/core-github-fixture.js`
- `docs/contracts/authority-severity-mapping.md`
- `docs/superpowers/specs/2026-08-31-toss-core-organizational-lifecycle-design.md`
- `docs/superpowers/specs/2026-09-01-toss-core-bootstrap-snapshot-validation-repair-design.md`
- `docs/superpowers/specs/2026-09-04-toss-core-extraction-design.md`
- `docs/superpowers/plans/2026-09-01-toss-core-*.md`
- `docs/superpowers/plans/2026-09-04-toss-*-core-*.md`
- `docs/superpowers/plans/2026-09-04-toss-core-*.md`

Modify:

- `package.json`, `package-lock.json` — remove `toss-core`, set v2.1.3
- `src/contracts/schema-catalog.js` — remove Core-only schema ownership
- `scripts/test-manifest.json` — remove deleted test ownership
- `scripts/test-boundaries.json` — remove Core-only guarantees and owners
- `scripts/package-artifact-test.js` — assert the product artifact excludes Core
- `test/test-lanes.test.js` — retain closed lane ownership after deletion
- `test/release-v2.1.3.test.js` — v2.1.3 metadata and boundary
- `docs/releases/v2.1.3.md` — correction notes

### Task 1: Lock the negative product boundary

**Files:**
- Create: `test/core-removal-boundary.test.js`
- Modify: `scripts/test-manifest.json`
- Test: `test/core-removal-boundary.test.js`

**Interfaces:**
- Consumes: current `package.json`, tracked repository paths
- Produces: failing proof that `toss-cli` must expose only `toss` and contain no Core roots

- [ ] **Step 1: Write the failing removal test**

Create `test/core-removal-boundary.test.js`:

```js
import assert from "node:assert/strict";
import {existsSync,readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import test from "node:test";

const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url)));

test("the product package does not own Core",() => {
  assert.deepEqual(pkg.bin,{toss:"bin/toss.js"});
  assert.equal(Object.hasOwn(pkg.dependencies,"@toss-software/core"),false);
  for (const path of ["bin/toss-core.js","src/core","contracts/core","test/fixtures/core"])
    assert.equal(existsSync(new URL(`../${path}`,import.meta.url)),false,path);
  const tracked=execFileSync("git",["ls-files"],{encoding:"utf8"}).split("\n");
  assert.equal(tracked.some(path => /^test\/core-.*\.test\.js$/u.test(path) &&
    path!=="test/core-removal-boundary.test.js"),false);
  assert.equal(tracked.includes("test/support/core-github-fixture.js"),false);
  assert.equal(tracked.some(path => /^docs\/superpowers\/(?:plans|specs)\/.*(?:toss-core|toss-cli-core)/u.test(path)),false);
  assert.equal(tracked.includes("docs/contracts/authority-severity-mapping.md"),false);
});
```

- [ ] **Step 2: Add the test to the fast lane and verify RED**

Add `test/core-removal-boundary.test.js` in ASCII order to `fast` and `full`.

Run: `node --test test/core-removal-boundary.test.js`

Expected: FAIL because the v2.1.2 package still contains Core.

- [ ] **Step 3: Commit the RED boundary test**

```bash
git add test/core-removal-boundary.test.js scripts/test-manifest.json
git commit -m "test: define product core-removal boundary"
```

### Task 2: Delete Core-owned source and test surfaces

**Files:**
- Delete: `bin/toss-core.js`
- Delete: `src/core/**`
- Delete: `contracts/core/**`
- Delete: `test/core-*.test.js`
- Delete: `test/fixtures/core/**`
- Delete: `test/support/core-github-fixture.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/contracts/schema-catalog.js`
- Modify: `scripts/test-manifest.json`
- Modify: `scripts/test-boundaries.json`
- Modify: `test/common-contracts.test.js`
- Modify: `test/test-boundaries.test.js`
- Modify: `test/test-manifest.test.js`
- Create: `docs/releases/v2.1.3.md`

**Interfaces:**
- Consumes: standalone extraction acceptance evidence from the preceding plan
- Produces: product repository with only the `toss` executable

- [ ] **Step 1: Create the correction notes and record the accepted extraction identity**

Create `docs/releases/v2.1.3.md` with `Correction`, `Core extraction`, `Compatibility`, and `Verification` headings. Record the merged `TOSS-Soft/toss-core` commit SHA and reviewed package dry-run digest in `Core extraction`. Do not delete source until both values resolve in the target repository and package evidence.

- [ ] **Step 2: Remove the Core paths**

Run:

```bash
git rm bin/toss-core.js
git rm -r src/core contracts/core test/fixtures/core
git ls-files 'test/core-*.test.js' |
while IFS= read -r path; do
  test "$path" = "test/core-removal-boundary.test.js" || git rm -- "$path"
done
git rm test/support/core-github-fixture.js
git rm docs/contracts/authority-severity-mapping.md \
  docs/superpowers/specs/2026-08-31-toss-core-organizational-lifecycle-design.md \
  docs/superpowers/specs/2026-09-01-toss-core-bootstrap-snapshot-validation-repair-design.md \
  docs/superpowers/specs/2026-09-04-toss-core-extraction-design.md
git rm docs/superpowers/plans/2026-09-01-toss-core-*.md \
  docs/superpowers/plans/2026-09-04-toss-cli-core-*.md \
  docs/superpowers/plans/2026-09-04-toss-core-*.md
```

- [ ] **Step 3: Remove Core package and lane ownership**

Change `package.json` from:

```json
"bin": {"toss": "bin/toss.js", "toss-core": "bin/toss-core.js"}
```

to:

```json
"bin": {"toss": "bin/toss.js"}
```

Remove every deleted Core test from all arrays in `scripts/test-manifest.json`, leaving `test/core-removal-boundary.test.js` as the only Core-named product boundary test. Do not remove shared `src/contracts/**`, `src/output/**`, or `contracts/pipeline/**` paths used by product commands.

Remove the 12 Core schema definitions from `src/contracts/schema-catalog.js`, leaving the independent ACP document registry and shared product contracts byte-compatible. Remove every `core.*` guarantee from `scripts/test-boundaries.json`. Update only the exact inventory/count assertions in `test/common-contracts.test.js`, `test/test-boundaries.test.js`, and `test/test-manifest.test.js`; retain their closed-set behavior.

Run `npm install --package-lock-only --ignore-scripts` so the lockfile root loses the removed `toss-core` bin mapping without changing dependency versions.

- [ ] **Step 4: Run the boundary and manifest tests**

Run:

```bash
node --test test/core-removal-boundary.test.js test/common-contracts.test.js \
  test/test-boundaries.test.js test/test-manifest.test.js test/test-lanes.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the removal**

```bash
git add package.json package-lock.json src/contracts/schema-catalog.js \
  scripts/test-manifest.json scripts/test-boundaries.json \
  test/common-contracts.test.js test/test-boundaries.test.js test/test-manifest.test.js \
  docs/releases/v2.1.3.md
git commit -m "fix: remove embedded toss-core implementation"
```

### Task 3: Make the packed artifact reject Core regressions

**Files:**
- Modify: `scripts/package-artifact-test.js`
- Test: `scripts/package-artifact-test.js`

**Interfaces:**
- Consumes: `npm pack --json` file inventory
- Produces: artifact proof for exactly one product executable and no Core files

- [ ] **Step 1: Change the existing package test to RED against v2.1.2 assumptions**

Replace the two-bin assertion with:

```js
assert.deepEqual(packedManifest.bin,{toss:"bin/toss.js"});
assert.equal(packedFiles.some(file => file?.path==="bin/toss-core.js"),false);
assert.equal(packedFiles.some(file => file?.path.startsWith("src/core/")),false);
assert.equal(packedFiles.some(file => file?.path.startsWith("contracts/core/")),false);
```

Remove `runPackedCoreCli` and all assertions that execute or inventory Core. Keep every packed `toss` create/scaffold test unchanged.

- [ ] **Step 2: Run the package test**

Run: `npm run test:package`

Expected: PASS after Task 2; a deliberately restored Core file or bin entry makes it fail.

- [ ] **Step 3: Commit the artifact guard**

```bash
git add scripts/package-artifact-test.js
git commit -m "test: exclude core from the toss artifact"
```

### Task 4: Prepare v2.1.3 release metadata

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/releases/v2.1.3.md`
- Move: `test/release-v2.1.2.test.js` to `test/release-v2.1.3.test.js`
- Modify: `scripts/test-manifest.json`

**Interfaces:**
- Consumes: v2.1.2 version roots and current release workflow
- Produces: consistent v2.1.3 package, notes, and release test

- [ ] **Step 1: Write the failing v2.1.3 metadata test**

Move the current-version metadata test with `git mv test/release-v2.1.2.test.js test/release-v2.1.3.test.js`. Retain its isolated annotated-tag behavior test, change its current version/tag/notes fixtures to v2.1.3, and make the package-root test assert:

```js
assert.equal(pkg.version,"2.1.3");
assert.equal(lock.version,"2.1.3");
assert.equal(lock.packages[""].version,"2.1.3");
assert.deepEqual(pkg.bin,{toss:"bin/toss.js"});
assert.equal(notes.includes("@toss-software/core"),true);
assert.equal(notes.includes("TOSS-Soft/toss-core"),true);
```

Replace the v2.1.2 manifest entry with the v2.1.3 path so the moved test is the only current version-specific release owner. Historical v2.1.2 metadata coverage remains in `test/release-metadata.test.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/release-v2.1.3.test.js`

Expected: FAIL because version roots and notes still describe v2.1.2.

- [ ] **Step 3: Set the package version without creating a tag**

Run:

```bash
npm version 2.1.3 --no-git-tag-version
```

Complete `docs/releases/v2.1.3.md`. State that the `toss` CLI is unchanged, while the incorrectly embedded `toss-core` executable moved to private package `@toss-software/core`.

- [ ] **Step 4: Run release metadata tests**

Run:

```bash
node --test test/release-v2.1.3.test.js test/release-metadata.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit release metadata**

```bash
git add package.json package-lock.json docs/releases/v2.1.3.md test/release-v2.1.3.test.js scripts/test-manifest.json
git commit -m "chore: prepare v2.1.3 core extraction correction"
```

### Task 5: Verify and release the product correction

**Files:**
- Test: complete repository and packed artifact

**Interfaces:**
- Consumes: Tasks 1–4
- Produces: reviewed v2.1.3 release candidate containing no Core implementation

- [ ] **Step 1: Run focused product regression tests**

Run:

```bash
node --test test/cli-contract.test.js test/feature-commands.test.js \
  test/project-commands.test.js test/readme-lifecycle.test.js \
  test/core-removal-boundary.test.js test/release-v2.1.3.test.js
```

Expected: PASS.

- [ ] **Step 2: Run every official gate**

Run:

```bash
npm run test:fast
npm run test:integration
npm run test:e2e
npm run test:package
npm run test:release
npm test
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Audit exact removal scope**

Run:

```bash
if git ls-files | rg '^(bin/toss-core\.js|src/core/|contracts/core/|test/core-)' | \
  rg -v '^test/core-removal-boundary\.test\.js$'; then exit 1; fi
if npm pack --dry-run --json | rg 'toss-core|src/core|contracts/core'; then exit 1; fi
```

Expected: both searches print nothing.

- [ ] **Step 4: Request independent review**

The reviewer must verify the accepted standalone extraction identity, the negative product boundary, the packed artifact, version 2.1.3, and unchanged `toss` behavior. Resolve accepted findings with failing regressions before release.

- [ ] **Step 5: Create the release commit and annotated tag**

After merge to `main`, create the annotated `v2.1.3` tag using the repository's existing canonical release-evidence procedure. Push `main` and the tag only after package and release workflows pass on the exact commit.
