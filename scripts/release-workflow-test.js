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
