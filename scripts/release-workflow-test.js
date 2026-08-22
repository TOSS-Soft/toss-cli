import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync,
  readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { readReleaseMetadata, writeReleaseMetadataJson } from './release-metadata.mjs';
import { prepareGitHubPackage } from './prepare-github-package.mjs';

function canonicalFixturePath(value) {
  return realpathSync(value);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(',')}}`;
}

const releaseMetadataScript = fileURLToPath(new URL('./release-metadata.mjs', import.meta.url));

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
assert.equal(jobs.release.permissions?.packages, 'read');
assert.deepEqual(jobs.publish_npm.needs, ['validate']);
assert.deepEqual(jobs.publish_github_packages.needs, ['validate']);
assert.deepEqual(jobs.release.needs, ['validate', 'publish_npm', 'publish_github_packages']);
assert.doesNotMatch(JSON.stringify(jobs.publish_npm), /NODE_AUTH_TOKEN/);
assert.ok(jobs.validate.steps.some((step) => step.uses === 'actions/upload-artifact@v7'));
assert.ok(jobs.publish_npm.steps.some((step) => step.uses === 'actions/download-artifact@v8'));
assert.ok(jobs.publish_github_packages.steps.some((step) => step.uses === 'actions/download-artifact@v8'));
assert.ok(jobs.release.steps.some((step) => step.uses === 'actions/download-artifact@v8'));
const releaseCheckout = jobs.release.steps.find((step) => step.uses === 'actions/checkout@v7');
assert.equal(releaseCheckout?.with?.ref, '${{ github.ref }}');
assert.equal(releaseCheckout?.with?.['fetch-depth'], 0);
assert.match(JSON.stringify(jobs.validate), /release-metadata\.mjs/);
assert.match(JSON.stringify(jobs.publish_github_packages), /prepare-github-package\.mjs/);
const artifactUpload = jobs.validate.steps.find((step) => step.uses === 'actions/upload-artifact@v7');
assert.match(artifactUpload?.with?.path ?? '', /release-metadata\.json/);
const releaseStep = jobs.release.steps.find(
  (step) => step.name === 'Create and verify GitHub Release evidence'
);
assert.ok(releaseStep, 'release job must create and verify machine-readable evidence');
assert.match(releaseStep.run, /--notes-file "\$NOTES_PATH"/);
assert.match(releaseStep.run, /npm view "@toss-software\/cli@\$VERSION" version/);
assert.match(releaseStep.run, /npm view "@toss-soft\/cli@\$VERSION" version/);
assert.match(releaseStep.run, /release-evidence\.mjs/);
assert.match(releaseStep.run, /release-evidence\.json/);
assert.match(releaseStep.run, /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$GITHUB_REF_NAME"/);
assert.doesNotMatch(releaseStep.run, /generate-notes/);

const fixture = mkdtempSync(join(tmpdir(), 'toss-release-test-'));
try {
  const canonicalFixtureRoot = canonicalFixturePath(fixture);
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
  if [[ -n "\${NPM_FAKE_VIEW_LOG:-}" ]]; then
    printf '%s\n' "$*" >> "$NPM_FAKE_VIEW_LOG"
    printf '%s\n' "$NPM_FAKE_VERSION"
    exit 0
  fi
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
    join(canonicalFixtureRoot, 'publish-shell', 'dist', 'fixture.tgz'),
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
    join(canonicalFixtureRoot, 'github-publish-shell', 'github-dist', 'toss-soft-cli-2.0.0.tgz'),
    'GitHub Packages publish must receive an absolute tarball path'
  );

  const fakeGh = join(fakeBin, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
test "\${GH_REPO:-}" = "TOSS-Soft/toss-cli"
printf '%s\\n' "$*" >> "$GH_FAKE_LOG"
if [[ "$1 $2" == "release view" ]]; then
  test -f "$GH_FAKE_RELEASED"
  exit 0
fi
if [[ "$1" == "api" ]]; then
  test "$2" = "repos/TOSS-Soft/toss-cli/releases/tags/v2.1.1"
  [[ " $* " == *" --jq "* ]]
  if [[ -f "$GH_FAKE_EVIDENCE_UPLOADED" ]]; then
    printf '{"tagName":"v2.1.1","url":"https://github.com/TOSS-Soft/toss-cli/releases/tag/v2.1.1","isDraft":%s,"isPrerelease":false,"assets":[{"name":"toss-software-cli-2.1.1.tgz","digest":"sha256:%s"},{"name":"release-evidence.json","digest":"sha256:%s"}]}\\n' "$GH_FAKE_DRAFT" "$GH_FAKE_TARBALL_DIGEST" "$(printf 'e%.0s' {1..64})"
  else
    printf '{"tagName":"v2.1.1","url":"https://github.com/TOSS-Soft/toss-cli/releases/tag/v2.1.1","isDraft":%s,"isPrerelease":false,"assets":[{"name":"toss-software-cli-2.1.1.tgz","digest":"sha256:%s"}]}\\n' "$GH_FAKE_DRAFT" "$GH_FAKE_TARBALL_DIGEST"
  fi
  exit 0
fi
if [[ "$1 $2" == "release create" ]]; then
  test "$3" = "v2.1.1"
  test -f "$4"
  for ((index = 1; index <= $#; index++)); do
    if [[ "\${!index}" == "--notes-file" ]]; then
      next=$((index + 1))
      test "\${!next}" = "$GH_FAKE_NOTES_PATH"
    fi
  done
  : > "$GH_FAKE_RELEASED"
  exit 0
fi
if [[ "$1 $2" == "release edit" ]]; then
  for ((index = 1; index <= $#; index++)); do
    if [[ "\${!index}" == "--notes-file" ]]; then
      next=$((index + 1))
      test "\${!next}" = "$GH_FAKE_NOTES_PATH"
    fi
  done
  exit 0
fi
if [[ "$1 $2" == "release upload" ]]; then
  test -f "$4"
  if [[ "$(basename "$4")" == "release-evidence.json" ]]; then
    : > "$GH_FAKE_EVIDENCE_UPLOADED"
  fi
  exit 0
fi
exit 1
`);
  chmodSync(fakeGh, 0o755);

  function createReleaseShellFixture(name) {
    const cwd = join(fixture, name);
    for (const directory of [
      'contracts', 'dist', 'docs/releases', 'scripts', 'src/contracts'
    ]) {
      mkdirSync(join(cwd, directory), { recursive: true });
    }
    copyFileSync(new URL('./release-evidence.mjs', import.meta.url), join(cwd, 'scripts', 'release-evidence.mjs'));
    copyFileSync(new URL('../src/contracts/acp.js', import.meta.url), join(cwd, 'src', 'contracts', 'acp.js'));
    copyFileSync(new URL('../contracts/registry.json', import.meta.url), join(cwd, 'contracts', 'registry.json'));
    writeFileSync(join(cwd, 'docs', 'releases', 'v2.1.1.md'), '# Exact release notes\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Release Workflow Test'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'workflow@example.invalid'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['add', 'contracts', 'docs', 'scripts', 'src'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'release workflow fixture'], { cwd, stdio: 'pipe' });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    writeFileSync(join(cwd, 'dist', 'toss-software-cli-2.1.1.tgz'), 'workflow tarball\n');
    writeFileSync(join(cwd, 'dist', 'release-metadata.json'), canonicalJson({
      version: '2.1.1',
      artifactName: 'npm-package-2.1.1',
      notesPath: 'docs/releases/v2.1.1.md',
      commit,
      benchmarks: {
        fast: { report_sha256: 'b'.repeat(64), median_ms: 5762.305292, limit_ms: 15000 },
        full: { report_sha256: 'c'.repeat(64), median_ms: 16566.500291, limit_ms: 90103 }
      }
    }));
    return { cwd, commit };
  }

  function runReleaseScenario(name, {
    digest = 'a4d6f8371fc5231d9a46c749e301d7f3716ed50faafa1b86e61756db1f064aee',
    draft = false
  } = {}) {
    const scenario = createReleaseShellFixture(name);
    const ghLog = join(scenario.cwd, 'gh.log');
    const npmLog = join(scenario.cwd, 'npm.log');
    const result = spawnSync('bash', ['-c', releaseStep.run], {
      cwd: scenario.cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        GITHUB_REF: 'refs/tags/v2.1.1',
        GITHUB_REF_NAME: 'v2.1.1',
        GITHUB_REPOSITORY: 'TOSS-Soft/toss-cli',
        GITHUB_RUN_ID: '123',
        VERSION: '2.1.1',
        NOTES_PATH: 'docs/releases/v2.1.1.md',
        RELEASE_COMMIT: scenario.commit,
        GH_TOKEN: 'fixture-gh-token-do-not-print',
        NODE_AUTH_TOKEN: 'fixture-packages-token-do-not-print',
        GH_REPO: releaseStep.env?.GH_REPO === '${{ github.repository }}'
          ? 'TOSS-Soft/toss-cli'
          : '',
        GH_FAKE_LOG: ghLog,
        GH_FAKE_RELEASED: join(scenario.cwd, 'released'),
        GH_FAKE_EVIDENCE_UPLOADED: join(scenario.cwd, 'evidence-uploaded'),
        GH_FAKE_NOTES_PATH: 'docs/releases/v2.1.1.md',
        GH_FAKE_TARBALL_DIGEST: digest,
        GH_FAKE_DRAFT: String(draft),
        NPM_FAKE_VIEW_LOG: npmLog,
        NPM_FAKE_VERSION: '2.1.1'
      }
    });
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /fixture-(?:gh|packages)-token-do-not-print/);
    return {...scenario, result, ghLog, npmLog};
  }

  const successfulRelease = runReleaseScenario('release-shell');
  assert.equal(
    successfulRelease.result.status,
    0,
    `${successfulRelease.result.stderr}\n${successfulRelease.result.stdout}`
  );
  const publishedEvidence = JSON.parse(readFileSync(
    join(successfulRelease.cwd, 'release-evidence.json'), 'utf8'
  ));
  assert.deepEqual(publishedEvidence.workflow, {
    repository: 'TOSS-Soft/toss-cli',
    run_id: '123',
    run_url: 'https://github.com/TOSS-Soft/toss-cli/actions/runs/123'
  });
  assert.deepEqual(publishedEvidence.packages, {
    npm: '@toss-software/cli@2.1.1',
    github: '@toss-soft/cli@2.1.1'
  });
  assert.deepEqual(publishedEvidence.release.assets, ['toss-software-cli-2.1.1.tgz']);
  assert.equal(
    publishedEvidence.tarball.sha256,
    'a4d6f8371fc5231d9a46c749e301d7f3716ed50faafa1b86e61756db1f064aee'
  );
  const ghCalls = readFileSync(successfulRelease.ghLog, 'utf8');
  assert.match(ghCalls, /release create v2\.1\.1 .*toss-software-cli-2\.1\.1\.tgz/);
  assert.match(ghCalls, /--notes-file docs\/releases\/v2\.1\.1\.md/);
  assert.match(ghCalls, /release upload v2\.1\.1 .*release-evidence\.json --clobber/);
  assert.equal((ghCalls.match(/api repos\/TOSS-Soft\/toss-cli\/releases\/tags\/v2\.1\.1/g) ?? []).length, 2);
  assert.deepEqual(readFileSync(successfulRelease.npmLog, 'utf8').trim().split('\n'), [
    'view @toss-software/cli@2.1.1 version --registry=https://registry.npmjs.org',
    'view @toss-soft/cli@2.1.1 version --registry=https://npm.pkg.github.com'
  ]);

  const digestMismatch = runReleaseScenario('release-digest-mismatch', { digest: 'd'.repeat(64) });
  assert.notEqual(digestMismatch.result.status, 0);
  assert.match(digestMismatch.result.stderr, /digest.*match|match.*digest/i);
  assert.equal(existsSync(join(digestMismatch.cwd, 'release-evidence.json')), false);

  const draftRelease = runReleaseScenario('release-draft', { draft: true });
  assert.notEqual(draftRelease.result.status, 0);
  assert.match(draftRelease.result.stderr, /draft/i);
  assert.equal(existsSync(join(draftRelease.cwd, 'release-evidence.json')), false);

  const runGit = (...args) => execFileSync('git', args, { cwd: fixture, stdio: 'pipe' });
  runGit('init', '-b', 'main');
  runGit('config', 'user.name', 'Release Test');
  runGit('config', 'user.email', 'release-test@example.invalid');
  writeFileSync(join(fixture, 'package.json'), '{"name":"@toss-software/cli","version":"2.0.0"}\n');
  mkdirSync(join(fixture, 'docs', 'releases'), { recursive: true });
  writeFileSync(join(fixture, 'docs', 'releases', 'v2.0.0.md'), '# Fixture release\n');
  runGit('add', 'package.json', 'docs/releases/v2.0.0.md');
  runGit('commit', '-m', 'release fixture');
  const releaseCommit = runGit('rev-parse', 'HEAD').toString().trim();
  const tagEvidence = {
    schema_version: 'toss-release-tag.v1',
    commit: releaseCommit,
    fast: { report_sha256: 'b'.repeat(64), median_ms: 5762.305292, limit_ms: 15000 },
    full: { report_sha256: 'c'.repeat(64), median_ms: 16566.500291, limit_ms: 90103 }
  };
  runGit('tag', '-a', 'v2.0.0', '-m', canonicalJson(tagEvidence));
  const metadata = readReleaseMetadata({ cwd: fixture, tag: 'v2.0.0', mainRef: 'main' });
  assert.deepEqual(metadata, {
    version: '2.0.0',
    artifactName: 'npm-package-2.0.0',
    notesPath: 'docs/releases/v2.0.0.md',
    commit: releaseCommit,
    benchmarks: { fast: tagEvidence.fast, full: tagEvidence.full }
  });
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(metadata.benchmarks.fast), true);

  const githubOutput = join(fixture, 'github-output.txt');
  execFileSync(process.execPath, [releaseMetadataScript, 'v2.0.0', 'main'], {
    cwd: fixture,
    env: { ...process.env, GITHUB_OUTPUT: githubOutput },
    stdio: 'pipe'
  });
  assert.equal(readFileSync(githubOutput, 'utf8'), [
    'version=2.0.0',
    'artifact_name=npm-package-2.0.0',
    'notes_path=docs/releases/v2.0.0.md',
    `release_commit=${releaseCommit}`,
    `fast_report_sha256=${'b'.repeat(64)}`,
    `full_report_sha256=${'c'.repeat(64)}`,
    ''
  ].join('\n'));

  const evidenceDirectory = join(
    fixture, '.superpowers', 'sdd', '2026-08-22-v2.1.1-issue-88-release'
  );
  const jsonOutputRelative = '.superpowers/sdd/2026-08-22-v2.1.1-issue-88-release/release-metadata.json';
  const jsonOutput = join(fixture, jsonOutputRelative);
  mkdirSync(evidenceDirectory, { recursive: true });
  const unignoredResult = spawnSync(
    process.execPath,
    [releaseMetadataScript, 'v2.0.0', 'main', '--json-output', jsonOutputRelative],
    { cwd: fixture, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } }
  );
  assert.notEqual(unignoredResult.status, 0);
  assert.match(unignoredResult.stderr, /ignored/i);
  assert.deepEqual(readdirSync(evidenceDirectory), []);
  writeFileSync(join(fixture, '.gitignore'), '/.superpowers/\n');

  const primaryOutputFailure = new Error('primary release metadata write failure');
  const cleanupFailure = new Error('release metadata temporary cleanup failure');
  let combinedFailure;
  try {
    writeReleaseMetadataJson(fixture, jsonOutputRelative, metadata, {
      writeTemporary: () => { throw primaryOutputFailure; },
      removeTemporary: () => { throw cleanupFailure; }
    });
  } catch (error) {
    combinedFailure = error;
  }
  assert.equal(
    combinedFailure,
    primaryOutputFailure,
    'temporary cleanup must not replace the primary output failure'
  );
  assert.equal(combinedFailure.message, 'primary release metadata write failure');
  assert.equal(combinedFailure.cleanupError, cleanupFailure);
  assert.deepEqual(readdirSync(evidenceDirectory), []);

  const cleanupOnlyFailure = new Error('standalone release metadata cleanup failure');
  assert.throws(
    () => writeReleaseMetadataJson(fixture, jsonOutputRelative, metadata, {
      writeTemporary: () => {},
      publishTemporary: () => {},
      removeTemporary: () => { throw cleanupOnlyFailure; }
    }),
    error => error === cleanupOnlyFailure
  );

  const jsonResult = spawnSync(
    process.execPath,
    [releaseMetadataScript, 'v2.0.0', 'main', '--json-output', jsonOutputRelative],
    { cwd: fixture, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } }
  );
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  assert.equal(readFileSync(jsonOutput, 'utf8'), canonicalJson(metadata));
  assert.deepEqual(JSON.parse(readFileSync(jsonOutput, 'utf8')), metadata);
  assert.deepEqual(
    readdirSync(evidenceDirectory),
    ['release-metadata.json'],
    'successful atomic output must not leave a temporary file'
  );

  const existingResult = spawnSync(
    process.execPath,
    [releaseMetadataScript, 'v2.0.0', 'main', '--json-output', jsonOutputRelative],
    { cwd: fixture, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } }
  );
  assert.notEqual(existingResult.status, 0);
  assert.match(existingResult.stderr, /already exists/i);
  assert.deepEqual(readdirSync(evidenceDirectory), ['release-metadata.json']);

  unlinkSync(jsonOutput);
  const outsideTarget = join(fixture, 'outside-release-metadata.json');
  writeFileSync(outsideTarget, 'do not replace\n');
  symlinkSync(outsideTarget, jsonOutput);
  const symlinkResult = spawnSync(
    process.execPath,
    [releaseMetadataScript, 'v2.0.0', 'main', '--json-output', jsonOutputRelative],
    { cwd: fixture, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } }
  );
  assert.notEqual(symlinkResult.status, 0);
  assert.match(symlinkResult.stderr, /symbolic link|symlink/i);
  assert.equal(readFileSync(outsideTarget, 'utf8'), 'do not replace\n');
  unlinkSync(jsonOutput);

  writeFileSync(jsonOutput, canonicalJson(metadata));
  runGit('add', '-f', jsonOutputRelative);
  unlinkSync(jsonOutput);
  const trackedResult = spawnSync(
    process.execPath,
    [releaseMetadataScript, 'v2.0.0', 'main', '--json-output', jsonOutputRelative],
    { cwd: fixture, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } }
  );
  assert.notEqual(trackedResult.status, 0);
  assert.match(trackedResult.stderr, /tracked/i);
  assert.deepEqual(readdirSync(evidenceDirectory), []);

  const unsafeResult = spawnSync(
    process.execPath,
    [releaseMetadataScript, 'v2.0.0', 'main', '--json-output', '../release-metadata.json'],
    { cwd: fixture, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } }
  );
  assert.notEqual(unsafeResult.status, 0);
  assert.match(unsafeResult.stderr, /safe|output|destination/i);
  assert.equal(existsSync(join(fixture, '..', 'release-metadata.json')), false);

  assert.throws(() => readReleaseMetadata({ cwd: fixture, tag: 'release-2.0.0', mainRef: 'main' }), /semantic version/);
  writeFileSync(join(fixture, 'package.json'), '{"name":"@toss-software/cli","version":"2.0.1"}\n');
  assert.throws(() => readReleaseMetadata({ cwd: fixture, tag: 'v2.0.0', mainRef: 'main' }), /does not match/);
  runGit('checkout', '-b', 'feature-release');
  runGit('add', 'package.json');
  runGit('commit', '-m', 'off-main release fixture');
  mkdirSync(join(fixture, 'docs', 'releases'), { recursive: true });
  writeFileSync(join(fixture, 'docs', 'releases', 'v2.0.1.md'), '# Off-main fixture release\n');
  runGit('add', 'docs/releases/v2.0.1.md');
  runGit('commit', '-m', 'off-main release notes fixture');
  const offMainCommit = runGit('rev-parse', 'HEAD').toString().trim();
  runGit('tag', '-a', 'v2.0.1', '-m', canonicalJson({
    ...tagEvidence,
    commit: offMainCommit
  }));
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
