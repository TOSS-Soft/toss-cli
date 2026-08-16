# GitHub-Integrated Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish TOSS CLI from one verified version tag to npmjs, GitHub Packages, and a latest GitHub Release while preserving the current npm identity and PR history.

**Architecture:** A tag-triggered workflow validates main ancestry, runs the full test/package chain, and shares one canonical npm tarball. Separate least-privilege jobs publish the original tarball to npmjs, derive the organization-scoped GitHub Packages copy, and create a GitHub Release only after both registries contain the version.

**Tech Stack:** Node.js 24, npm/OIDC Trusted Publishing, GitHub Actions, GitHub Packages npm registry, GitHub CLI, `yaml`, `actions/upload-artifact@v7`, `actions/download-artifact@v8`

## Global Constraints

- npmjs identity remains `@toss-software/cli`.
- GitHub Packages identity is `@toss-soft/cli`, owned by `TOSS-Soft`.
- First release is `v2.0.0`, matching package version `2.0.0`.
- Release tags must resolve to commits contained in `main`.
- Use npm Trusted Publishing and repository `GITHUB_TOKEN`; add no PAT or npm token.
- Never commit the GitHub Packages identity to the root `package.json`.
- Create the GitHub Release only after both registries report the exact version.
- Merge PR #8 with a merge commit, preserving its existing history.
- Do not tag until updated PR CI and merged-main CI both succeed.

---

## File Map

- Create `scripts/release-metadata.mjs`: read and validate tag, package version,
  checked-out commit, and main ancestry; emit workflow outputs.
- Create `scripts/prepare-github-package.mjs`: copy an extracted canonical npm
  package and change only its registry identity in an ephemeral directory.
- Create `scripts/release-workflow-test.js`: execute both release helpers
  against real temporary files/git history and validate only YAML wiring.
- Modify `.github/workflows/publish.yml`: validation, artifact, dual publication, release, and verification jobs.
- Modify `package.json`: append the behavioral release test to `npm test`.
- Modify `package-lock.json` only if npm updates root script metadata; change no dependency versions.

### Task 1: Release Workflow Contract and Implementation

**Files:**
- Create: `scripts/release-metadata.mjs`
- Create: `scripts/prepare-github-package.mjs`
- Create: `scripts/release-workflow-test.js`
- Modify: `.github/workflows/publish.yml`
- Modify: `package.json`
- Modify if required: `package-lock.json`
- Test: `scripts/release-workflow-test.js`

**Interfaces:**
- Consumes: `package.json.version`, tag `github.ref_name`, `GITHUB_TOKEN`, npm Trusted Publishing.
- Produces: `readReleaseMetadata({ cwd, tag, mainRef })`,
  `prepareGitHubPackage({ sourceDir, destinationDir })`, jobs `validate`,
  `publish_npm`, `publish_github_packages`, `release`, and workflow outputs
  `version`, `artifact_name`.

- [ ] **Step 1: Write the failing behavioral and wiring test**

Create `scripts/release-workflow-test.js`:

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { readReleaseMetadata } from './release-metadata.mjs';
import { prepareGitHubPackage } from './prepare-github-package.mjs';

const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'));
const jobs = workflow.jobs ?? {};
assert.deepEqual(workflow.on?.push?.tags, ['v*.*.*']);
assert.equal(workflow.concurrency?.['cancel-in-progress'], false);
for (const name of ['validate', 'publish_npm', 'publish_github_packages', 'release']) {
  assert.ok(jobs[name], `missing job: ${name}`);
}
assert.equal(jobs.validate.permissions?.contents, 'read');
assert.equal(jobs.publish_npm.permissions?.['id-token'], 'write');
assert.equal(jobs.publish_github_packages.permissions?.packages, 'write');
assert.equal(jobs.release.permissions?.contents, 'write');
assert.deepEqual(jobs.publish_npm.needs, ['validate']);
assert.deepEqual(jobs.publish_github_packages.needs, ['validate']);
assert.deepEqual(jobs.release.needs, ['validate', 'publish_npm', 'publish_github_packages']);
assert.doesNotMatch(JSON.stringify(jobs.publish_npm), /NODE_AUTH_TOKEN/);
assert.ok(jobs.validate.steps.some((step) => step.uses === 'actions/upload-artifact@v7'));
assert.ok(jobs.publish_npm.steps.some((step) => step.uses === 'actions/download-artifact@v8'));
assert.ok(jobs.publish_github_packages.steps.some((step) => step.uses === 'actions/download-artifact@v8'));
assert.ok(jobs.release.steps.some((step) => step.uses === 'actions/download-artifact@v8'));
assert.match(JSON.stringify(jobs.validate), /release-metadata\.mjs/);
assert.match(JSON.stringify(jobs.publish_github_packages), /prepare-github-package\.mjs/);

const fixture = mkdtempSync(join(tmpdir(), 'toss-release-test-'));
try {
  const runGit = (...args) => execFileSync('git', args, { cwd: fixture, stdio: 'pipe' });
  runGit('init', '-b', 'main');
  runGit('config', 'user.name', 'Release Test');
  runGit('config', 'user.email', 'release-test@example.invalid');
  writeFileSync(join(fixture, 'package.json'), '{"name":"@toss-software/cli","version":"2.0.0"}\n');
  runGit('add', 'package.json');
  runGit('commit', '-m', 'release fixture');
  runGit('tag', 'v2.0.0');
  assert.deepEqual(readReleaseMetadata({ cwd: fixture, tag: 'v2.0.0', mainRef: 'main' }), {
    version: '2.0.0', artifactName: 'npm-package-2.0.0'
  });
  assert.throws(() => readReleaseMetadata({ cwd: fixture, tag: 'release-2.0.0', mainRef: 'main' }), /semantic version/);
  writeFileSync(join(fixture, 'package.json'), '{"name":"@toss-software/cli","version":"2.0.1"}\n');
  assert.throws(() => readReleaseMetadata({ cwd: fixture, tag: 'v2.0.0', mainRef: 'main' }), /does not match/);
  runGit('checkout', '-b', 'feature-release');
  runGit('add', 'package.json');
  runGit('commit', '-m', 'off-main release fixture');
  runGit('tag', 'v2.0.1');
  assert.throws(() => readReleaseMetadata({ cwd: fixture, tag: 'v2.0.1', mainRef: 'main' }), /not contained in main/);

  const source = join(fixture, 'source-package');
  const destination = join(fixture, 'github-package');
  mkdirSync(join(source, 'bin'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({
    name: '@toss-software/cli', version: '2.0.0',
    repository: { type: 'git', url: 'git+https://github.com/TOSS-Soft/toss-cli.git' },
    publishConfig: { access: 'public' }
  }, null, 2));
  writeFileSync(join(source, 'bin', 'toss.js'), 'console.log("toss");\n');
  const sourceBefore = readFileSync(join(source, 'package.json'), 'utf8');
  await prepareGitHubPackage({ sourceDir: source, destinationDir: destination });
  const prepared = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
  assert.equal(prepared.name, '@toss-soft/cli');
  assert.equal(prepared.publishConfig.registry, 'https://npm.pkg.github.com');
  assert.equal(readFileSync(join(destination, 'bin', 'toss.js'), 'utf8'), 'console.log("toss");\n');
  assert.equal(readFileSync(join(source, 'package.json'), 'utf8'), sourceBefore);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log('Release workflow contract test: PASS');
```

- [ ] **Step 2: Append the test to the standard chain**

Set `package.json.scripts.test` to the existing chain plus:

```text
 && node ./scripts/release-workflow-test.js
```

Run `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` only if the lockfile root metadata becomes inconsistent. Do not update dependencies.

- [ ] **Step 3: Verify RED**

Run `node ./scripts/release-workflow-test.js`.

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `release-metadata.mjs`; the
behavioral production modules do not exist yet.

- [ ] **Step 4: Implement the two behavioral release helpers**

Create `scripts/release-metadata.mjs` with `readReleaseMetadata({ cwd, tag,
mainRef })`. It must read `package.json`, resolve the tag and HEAD through
`git`, run `git merge-base --is-ancestor`, and return the exact object used in
the test. Its CLI writes `version` and `artifact_name` to `GITHUB_OUTPUT`:

```js
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export function readReleaseMetadata({ cwd = process.cwd(), tag, mainRef }) {
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag)) {
    throw new Error(`Tag must be an exact semantic version: ${tag}`);
  }
  const version = tag.slice(1);
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  if (pkg.version !== version) {
    throw new Error(`Tag ${tag} does not match package.json ${pkg.version}`);
  }
  const tagCommit = git(cwd, ['rev-list', '-n', '1', tag]);
  const checkedOutCommit = git(cwd, ['rev-parse', 'HEAD']);
  if (tagCommit !== checkedOutCommit) throw new Error('Tag does not resolve to the checked-out commit');
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', checkedOutCommit, mainRef], { cwd });
  if (ancestry.status !== 0) throw new Error('Release commit is not contained in main');
  return { version, artifactName: `npm-package-${version}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const metadata = readReleaseMetadata({ tag: process.argv[2], mainRef: process.argv[3] });
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${metadata.version}\nartifact_name=${metadata.artifactName}\n`);
}
```

Create `scripts/prepare-github-package.mjs`. It must copy rather than mutate
the source and reject an unexpected source identity:

```js
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareGitHubPackage({ sourceDir, destinationDir }) {
  await cp(sourceDir, destinationDir, { recursive: true, errorOnExist: true, force: false });
  const packagePath = join(destinationDir, 'package.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  if (pkg.name !== '@toss-software/cli') throw new Error(`Unexpected source package: ${pkg.name}`);
  pkg.name = '@toss-soft/cli';
  pkg.publishConfig = { ...pkg.publishConfig, registry: 'https://npm.pkg.github.com' };
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  return { name: pkg.name, version: pkg.version, packagePath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareGitHubPackage({ sourceDir: process.argv[2], destinationDir: process.argv[3] });
}
```

Run `node ./scripts/release-workflow-test.js` again. Expected: helper behavior
passes, then the test fails at `missing job: validate` because YAML wiring is
still absent. This is the second RED gate before configuration implementation.

- [ ] **Step 5: Implement workflow header and validate job**

Replace the workflow name/event, add tag-scoped concurrency, and create `validate` with the following exact contract:

```yaml
name: Publish npm packages and GitHub Release
on:
  push:
    tags: ['v*.*.*']
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
jobs:
  validate:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions: { contents: read }
    outputs:
      version: ${{ steps.metadata.outputs.version }}
      artifact_name: ${{ steps.metadata.outputs.artifact_name }}
```

Use `actions/checkout@v7` with `fetch-depth: 0` and `actions/setup-node@v7`
with Node 24. Before the metadata step, fetch main with the exact refspec below;
then invoke the tested helper:

```bash
set -euo pipefail
git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'
node ./scripts/release-metadata.mjs "$GITHUB_REF_NAME" refs/remotes/origin/main
```

Then run `npm ci --no-audit --no-fund`, `npm test`, build exactly one tarball with `npm pack --json --ignore-scripts --pack-destination dist`, verify its SHA-256, and upload `dist/*.tgz` with `actions/upload-artifact@v7`, `if-no-files-found: error`, and `compression-level: 0`.

- [ ] **Step 6: Implement npmjs publication**

Create `publish_npm` with `needs: [validate]`, `contents: read`, and `id-token: write`. Use setup-node v7 for `https://registry.npmjs.org` and download-artifact v8 for `${{ needs.validate.outputs.artifact_name }}`.

The publication step must contain:

```bash
set -euo pipefail
PUBLISHED="$(npm view "@toss-software/cli@$VERSION" version --registry=https://registry.npmjs.org 2>/dev/null || true)"
if [[ "$PUBLISHED" == "$VERSION" ]]; then
  echo "@toss-software/cli@$VERSION already exists; verified."
  exit 0
fi
TARBALL="$(find dist -maxdepth 1 -name '*.tgz' -type f -print -quit)"
test -n "$TARBALL"
npm publish "$TARBALL" --access public --provenance
test "$(npm view "@toss-software/cli@$VERSION" version --registry=https://registry.npmjs.org)" = "$VERSION"
```

Set `VERSION` from `needs.validate.outputs.version`. Do not set `NODE_AUTH_TOKEN` in this job.

- [ ] **Step 7: Implement GitHub Packages publication**

Create `publish_github_packages` with `needs: [validate]`, `contents: read`, and `packages: write`. Setup Node 24 with registry `https://npm.pkg.github.com`, scope `@toss-soft`, and download the same artifact.

Set `NODE_AUTH_TOKEN: ${{ github.token }}` and `VERSION`. Begin the step with this exact idempotence gate:

```bash
set -euo pipefail
PUBLISHED="$(npm view "@toss-soft/cli@$VERSION" version --registry=https://npm.pkg.github.com 2>/dev/null || true)"
if [[ "$PUBLISHED" == "$VERSION" ]]; then
  echo "@toss-soft/cli@$VERSION already exists; verified."
  exit 0
fi
```

If the version is absent, derive and publish the organization-scoped tarball:

```bash
SOURCE_TARBALL="$(find dist -maxdepth 1 -name '*.tgz' -type f -print -quit)"
mkdir -p github-package github-dist
tar -xzf "$SOURCE_TARBALL" -C github-package
node ./scripts/prepare-github-package.mjs github-package/package github-package/prepared
npm pack ./github-package/prepared --ignore-scripts --pack-destination github-dist
GITHUB_TARBALL="$(find github-dist -maxdepth 1 -name '*.tgz' -type f -print -quit)"
npm publish "$GITHUB_TARBALL" --registry=https://npm.pkg.github.com --ignore-scripts
test "$(npm view "@toss-soft/cli@$VERSION" version --registry=https://npm.pkg.github.com)" = "$VERSION"
```

The root package file must remain byte-identical; only the extracted temporary package changes identity.

- [ ] **Step 8: Implement gated GitHub Release creation**

Create `release` with:

```yaml
needs: [validate, publish_npm, publish_github_packages]
permissions: { contents: write }
```

Download the canonical artifact. With `GH_TOKEN: ${{ github.token }}`, run:

```bash
set -euo pipefail
TARBALL="$(find dist -maxdepth 1 -name '*.tgz' -type f -print -quit)"
if gh release view "$GITHUB_REF_NAME" >/dev/null 2>&1; then
  gh release edit "$GITHUB_REF_NAME" --title "$GITHUB_REF_NAME" --draft=false --prerelease=false --latest
  gh release upload "$GITHUB_REF_NAME" "$TARBALL" --clobber
else
  gh release create "$GITHUB_REF_NAME" "$TARBALL" --verify-tag --generate-notes --latest --title "$GITHUB_REF_NAME"
fi
gh release view "$GITHUB_REF_NAME" --json tagName,isDraft,isPrerelease,url,assets > release.json
```

Parse `release.json` with Node and fail unless tag matches, draft/prerelease are false, and an `.tgz` asset exists.

- [ ] **Step 9: Verify GREEN and the complete payload**

Run:

```bash
node ./scripts/release-workflow-test.js
node --run test
node ./scripts/package-artifact-test.js
npm pack --dry-run
git diff --check
```

Expected: all exit 0; the full chain ends with `Release workflow contract test: PASS`; no token, PAT, or committed root package rename appears in the diff.

- [ ] **Step 10: Commit**

```bash
git add .github/workflows/publish.yml scripts/release-metadata.mjs scripts/prepare-github-package.mjs scripts/release-workflow-test.js package.json
git add package-lock.json # only when changed
git diff --cached --check
git commit -m "ci: integrate GitHub release publishing"
```

### Task 2: Update PR #8 and Pass Remote CI

**Files:** No source changes; update PR #8 body through GitHub.

**Interfaces:** Consumes clean tested branch; produces matching remote head and successful PR CI.

- [ ] **Step 1: Reverify before push**

Run `git status -sb`, `git log --oneline origin/main..HEAD`, `node --run test`, and `git diff --check origin/main...HEAD`. Require clean worktree and exit 0.

- [ ] **Step 2: Fast-forward the remote branch**

Run `git push origin agent/modular-governance-v2-design`. Never force-push. If this environment cannot authenticate, create a verified incremental bundle and have the user perform the equivalent push.

- [ ] **Step 3: Update the PR body**

Append:

```markdown
## Release integration

- A `v*.*.*` tag validates package version and main ancestry.
- One tested tarball publishes as `@toss-software/cli` on npmjs and `@toss-soft/cli` on GitHub Packages.
- GitHub Release creation is gated on both publications and attaches the canonical tarball.
- Recovery is idempotent and uses only `GITHUB_TOKEN` plus npm Trusted Publishing.
```

- [ ] **Step 4: Verify the exact remote head**

Through GitHub confirm base `main`, expected head branch/SHA, `draft: false`, `mergeable: true`, and CI `conclusion: success`. If CI fails, invoke `github:gh-fix-ci` and do not merge.

### Task 3: Merge PR #8 and Verify Main

**Files:** No source changes.

**Interfaces:** Consumes green mergeable PR; produces merge commit on `main` and green main CI.

- [ ] **Step 1: Re-run the merge gate**

Immediately re-fetch PR #8 and its CI. Stop if head SHA, open state, mergeability, or successful conclusion changed.

- [ ] **Step 2: Merge preserving history**

Use GitHub merge with method `merge`, exact expected head SHA, and title `Merge pull request #8 from TOSS-Soft/agent/modular-governance-v2-design`. Require `merged: true` and record the returned merge SHA.

- [ ] **Step 3: Verify main CI**

Confirm the PR is merged, returned merge SHA is current `main`, and the push-triggered CI for that exact SHA concludes `success`. Do not tag while missing, pending, cancelled, or failed.

### Task 4: Tag and Verify v2.0.0

**Files:** No source changes.

**Interfaces:** Consumes exact green merge SHA; produces both packages and latest GitHub Release.

- [ ] **Step 1: Prove the tag is unused**

```bash
git fetch origin main --tags
git rev-parse refs/tags/v2.0.0
```

Expected: `rev-parse` fails. If the tag exists, stop; never overwrite or move it.

- [ ] **Step 2: Create and verify the annotated tag**

```bash
MERGE_SHA="$(gh pr view 8 --repo TOSS-Soft/toss-cli --json mergeCommit --jq '.mergeCommit.oid')"
test -n "$MERGE_SHA"
git tag -a v2.0.0 "$MERGE_SHA" -m "Release v2.0.0"
test "$(git rev-parse 'v2.0.0^{commit}')" = "$MERGE_SHA"
```

The `mergeCommit.oid` value must equal the concrete merge SHA recorded and
validated in Task 3 before the tag command is allowed to run.

- [ ] **Step 3: Push only the tag**

Run `git push origin refs/tags/v2.0.0`.

- [ ] **Step 4: Require all workflow jobs to succeed**

Monitor the tag run and require successful jobs: `Validate, test, and package`, `Publish npmjs package`, `Publish GitHub Packages copy`, and `Create and verify GitHub Release`. Preserve the immutable tag on failure; fix via a new PR/patch version rather than moving a tag after publication.

- [ ] **Step 5: Verify every release surface**

```bash
npm view @toss-software/cli@2.0.0 version --registry=https://registry.npmjs.org
gh release view v2.0.0 --repo TOSS-Soft/toss-cli --json tagName,isDraft,isPrerelease,url,assets
gh api /orgs/TOSS-Soft/packages/npm/cli/versions --jq '.[].name'
```

Require npmjs and GitHub Packages version `2.0.0`, release tag `v2.0.0`, draft/prerelease false, and at least one `.tgz` asset. Confirm the repository sidebar shows `v2.0.0` as **Latest** under Releases and `@toss-soft/cli` under Packages; record release and workflow URLs.

## Final Verification Gate

Before claiming completion, freshly run the full local suite/diff check and re-read the PR merge state, main CI, tag workflow, npmjs version, GitHub Packages version, GitHub Release fields/assets, and tag-to-merge-SHA relationship. Any missing or stale evidence blocks completion.
