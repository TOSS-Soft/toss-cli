# npm Publish v1.2.1 Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a tested `@toss-software/cli@1.2.1` package whose global installation exposes the `toss` executable through the existing npm Trusted Publisher.

**Architecture:** Protect the npm-facing package contract in the existing smoke test, then make the smallest metadata and documentation changes required to satisfy it. Preserve the current tag-triggered GitHub Actions workflow and publish a new patch version rather than rewriting the failed `v1.2.0` tag.

**Tech Stack:** Node.js 20+, npm, GitHub Actions, npm Trusted Publishing/OIDC

## Global Constraints

- The public package name is exactly `@toss-software/cli`.
- The release version is exactly `1.2.1` in `package.json` and both lockfile root version fields.
- The `toss` executable path is exactly `bin/toss.js`, without a leading `./`.
- The failed `v1.2.0` tag remains immutable and is not deleted, moved, or reused.
- `.github/workflows/publish.yml` remains unchanged.
- No npm token or other long-lived publish credential is introduced.
- Existing generated-project and Superpowers behavior remains unchanged.

---

### Task 1: Protect and Correct the npm Publication Contract

**Files:**
- Modify: `scripts/smoke-test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Test: `scripts/smoke-test.js`

**Interfaces:**
- Consumes: npm package metadata from `package.json` and the root package entry at `package-lock.json.packages[""]`.
- Produces: the published package `@toss-software/cli@1.2.1` with executable mapping `{ "toss": "bin/toss.js" }` and matching install documentation.

- [ ] **Step 1: Write the failing package-contract assertions**

Replace the existing single `packageVersion` read in `scripts/smoke-test.js` with independently parsed package and lock metadata:

```js
const packageMetadata=JSON.parse(
  fs.readFileSync(path.join(root,"package.json"),"utf8"),
);
const lockMetadata=JSON.parse(
  fs.readFileSync(path.join(root,"package-lock.json"),"utf8"),
);
const packageVersion=packageMetadata.version;
```

Before the first CLI invocation, add the consumer-visible publication contract:

```js
assert.equal(packageMetadata.name,"@toss-software/cli");
assert.equal(packageMetadata.bin?.toss,"bin/toss.js");
assert.equal(lockMetadata.name,packageMetadata.name);
assert.equal(lockMetadata.version,packageMetadata.version);
assert.equal(lockMetadata.packages[""].name,packageMetadata.name);
assert.equal(lockMetadata.packages[""].version,packageMetadata.version);
assert.deepEqual(lockMetadata.packages[""].bin,packageMetadata.bin);
```

These assertions catch a package-scope mismatch, an npm-invalid executable
path, or package/lockfile drift before a release tag is created.

- [ ] **Step 2: Run the smoke test to verify RED**

Use the already-installed dependency directory without modifying the worktree:

```bash
ln -s ../provider-neutral-superpowers/node_modules node_modules
node ./scripts/smoke-test.js
status=$?
unlink node_modules
exit $status
```

Expected: FAIL at the package-name assertion because the actual value is
`@toss/cli` and the expected value is `@toss-software/cli`. This proves the
test reproduces the observed publishing mismatch before the fix.

- [ ] **Step 3: Apply the minimal package metadata fix**

Set these exact fields in `package.json`:

```json
{
  "name": "@toss-software/cli",
  "version": "1.2.1",
  "bin": {
    "toss": "bin/toss.js"
  }
}
```

Set the matching root metadata in `package-lock.json`:

```json
{
  "name": "@toss-software/cli",
  "version": "1.2.1",
  "packages": {
    "": {
      "name": "@toss-software/cli",
      "version": "1.2.1",
      "bin": {
        "toss": "bin/toss.js"
      }
    }
  }
}
```

Do not change dependencies, scripts, workflow files, or generated templates.

- [ ] **Step 4: Align public documentation**

Update only these npm identity references in `README.md`:

```markdown
# @toss-software/cli

npm install -g @toss-software/cli

Publishing requires authorization for the npm `@toss-software` scope.

PR → main → SemVer version/tag → GitHub Actions → npm @toss-software/cli
```

- [ ] **Step 5: Run the smoke test to verify GREEN**

```bash
ln -s ../provider-neutral-superpowers/node_modules node_modules
node ./scripts/smoke-test.js
status=$?
unlink node_modules
exit $status
```

Expected: `TOSS CLI smoke test: PASS` with exit status `0`.

- [ ] **Step 6: Verify CLI version and npm package payload**

```bash
node ./bin/toss.js --version
```

Expected: `1.2.1`.

Then inspect the package payload with the same prepack test used by CI:

```bash
ln -s ../provider-neutral-superpowers/node_modules node_modules
npm_config_cache=/tmp/toss-cli-npm-cache npm pack --dry-run
status=$?
unlink node_modules
exit $status
```

Expected: exit status `0`, package identity `@toss-software/cli@1.2.1`,
filename `toss-software-cli-1.2.1.tgz`, and no warning that `bin[toss]` was
removed.

- [ ] **Step 7: Verify the exact diff**

```bash
git diff --check
git status -sb
git diff -- package.json package-lock.json README.md scripts/smoke-test.js
```

Expected: no whitespace errors and no production files outside the four
approved paths.

- [ ] **Step 8: Commit the tested fix**

```bash
git add package.json package-lock.json README.md scripts/smoke-test.js
git commit -m "fix: align npm package publication"
```

Expected: one implementation commit containing the RED/GREEN regression test,
the package identity and executable fix, the patch version, and matching docs.

---

## Completion

After Task 1 passes, use `superpowers:verification-before-completion`,
`superpowers:requesting-code-review`, and
`superpowers:finishing-a-development-branch`. Push
`agent/fix-npm-publish-v1.2.1` and open a draft PR against `main`. Only after
that PR is reviewed, merged, and `main` is freshly verified may an annotated
`v1.2.1` tag be created and pushed.
