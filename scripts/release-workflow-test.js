import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync
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
  const publishFixture = join(fixture, 'publish-shell');
  const fakeBin = join(publishFixture, 'bin');
  const publishArgument = join(publishFixture, 'publish-argument.txt');
  const publishedMarker = join(publishFixture, 'published');
  mkdirSync(join(publishFixture, 'dist'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(publishFixture, 'dist', 'fixture.tgz'), 'fixture');
  const fakeNpm = join(fakeBin, 'npm');
  writeFileSync(fakeNpm, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "view" ]]; then
  if [[ -f "$NPM_FAKE_PUBLISHED" ]]; then printf '%s\\n' "$VERSION"; fi
  exit 0
fi
if [[ "$1" == "publish" ]]; then
  printf '%s\\n' "$2" > "$NPM_FAKE_ARGUMENT"
  : > "$NPM_FAKE_PUBLISHED"
  exit 0
fi
if [[ "$1" == "pack" ]]; then
  destination=""
  for ((index = 1; index <= $#; index++)); do
    if [[ "\${!index}" == "--pack-destination" ]]; then
      next=$((index + 1))
      destination="\${!next}"
      break
    fi
  done
  test -n "$destination"
  mkdir -p "$destination"
  tar -czf "$destination/toss-soft-cli-$VERSION.tgz" -C "$2" .
  printf '%s\\n' "toss-soft-cli-$VERSION.tgz"
  exit 0
fi
exit 1
`);
  chmodSync(fakeNpm, 0o755);
  const publishStep = jobs.publish_npm.steps.find((step) => step.name === 'Publish to npm with Trusted Publishing');
  execFileSync('bash', ['-c', publishStep.run], {
    cwd: publishFixture,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      VERSION: '2.0.0',
      NPM_FAKE_ARGUMENT: publishArgument,
      NPM_FAKE_PUBLISHED: publishedMarker
    },
    stdio: 'pipe'
  });
  assert.equal(
    readFileSync(publishArgument, 'utf8').trim(),
    join(publishFixture, 'dist', 'fixture.tgz'),
    'npm publish must receive an absolute tarball path'
  );

  const githubPublishFixture = join(fixture, 'github-publish-shell');
  const githubPublishArgument = join(githubPublishFixture, 'publish-argument.txt');
  const githubPublishedMarker = join(githubPublishFixture, 'published');
  const sourceRoot = join(githubPublishFixture, 'source-root');
  mkdirSync(join(githubPublishFixture, 'dist'), { recursive: true });
  mkdirSync(join(githubPublishFixture, 'scripts'), { recursive: true });
  mkdirSync(join(sourceRoot, 'package', 'bin'), { recursive: true });
  copyFileSync(
    new URL('./prepare-github-package.mjs', import.meta.url),
    join(githubPublishFixture, 'scripts', 'prepare-github-package.mjs')
  );
  writeFileSync(join(sourceRoot, 'package', 'package.json'), JSON.stringify({
    name: '@toss-software/cli',
    version: '2.0.0',
    bin: { toss: 'bin/toss.js' },
    publishConfig: { access: 'public' }
  }, null, 2));
  writeFileSync(join(sourceRoot, 'package', 'bin', 'toss.js'), 'console.log("toss");\n');
  execFileSync('tar', [
    '-czf', join(githubPublishFixture, 'dist', 'source.tgz'),
    '-C', sourceRoot,
    'package'
  ]);
  const githubPublishStep = jobs.publish_github_packages.steps.find(
    (step) => step.name === 'Publish to GitHub Packages'
  );
  execFileSync('bash', ['-c', githubPublishStep.run], {
    cwd: githubPublishFixture,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      VERSION: '2.0.0',
      NPM_FAKE_ARGUMENT: githubPublishArgument,
      NPM_FAKE_PUBLISHED: githubPublishedMarker
    },
    stdio: 'pipe'
  });
  assert.equal(
    readFileSync(githubPublishArgument, 'utf8').trim(),
    join(githubPublishFixture, 'github-dist', 'toss-soft-cli-2.0.0.tgz'),
    'GitHub Packages publish must receive an absolute tarball path'
  );

  const releaseFixture = join(fixture, 'release-shell');
  const releaseArgument = join(releaseFixture, 'release-argument.txt');
  const releaseMarker = join(releaseFixture, 'released');
  mkdirSync(join(releaseFixture, 'dist'), { recursive: true });
  writeFileSync(join(releaseFixture, 'dist', 'fixture.tgz'), 'fixture');
  const fakeGh = join(fakeBin, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
if [[ -z "\${GH_REPO:-}" ]]; then
  git rev-parse --show-toplevel >/dev/null
fi
test "\${GH_REPO:-}" = "TOSS-Soft/toss-cli"
if [[ "$1 $2" == "release view" ]]; then
  if [[ " $* " == *" --json "* ]]; then
    printf '%s\\n' '{"tagName":"v2.0.0","isDraft":false,"isPrerelease":false,"url":"https://example.invalid/v2.0.0","assets":[{"name":"fixture.tgz"}]}'
    exit 0
  fi
  test -f "$RELEASE_FAKE_PUBLISHED"
  exit 0
fi
if [[ "$1 $2" == "release create" ]]; then
  test -f "$4"
  printf '%s\\n' "$4" > "$RELEASE_FAKE_ARGUMENT"
  : > "$RELEASE_FAKE_PUBLISHED"
  exit 0
fi
exit 1
`);
  chmodSync(fakeGh, 0o755);
  const releaseStep = jobs.release.steps.find((step) => step.name === 'Create or update GitHub Release');
  execFileSync('bash', ['-c', releaseStep.run], {
    cwd: releaseFixture,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      GITHUB_REF_NAME: 'v2.0.0',
      GH_TOKEN: 'fixture-token',
      GH_REPO: releaseStep.env?.GH_REPO === '${{ github.repository }}'
        ? 'TOSS-Soft/toss-cli'
        : '',
      RELEASE_FAKE_ARGUMENT: releaseArgument,
      RELEASE_FAKE_PUBLISHED: releaseMarker
    },
    stdio: 'pipe'
  });
  assert.equal(
    readFileSync(releaseArgument, 'utf8').trim(),
    join(releaseFixture, 'dist', 'fixture.tgz'),
    'GitHub Release must be created outside a git checkout using explicit repository context'
  );

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
