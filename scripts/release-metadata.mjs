import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync, existsSync, linkSync, lstatSync, readFileSync, realpathSync, rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/contracts/acp.js';

export const RELEASE_TAG_EVIDENCE_VERSION = 'toss-release-tag.v1';

const TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BENCHMARK_LIMITS = Object.freeze({ fast: 15000, full: 90103 });
const JSON_OUTPUT_PATH = '.superpowers/sdd/2026-08-22-v2.1.1-issue-88-release/release-metadata.json';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const gitRaw = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function validateTag(tag) {
  if (!TAG_PATTERN.test(tag)) {
    throw new Error(`Tag must be an exact semantic version: ${tag}`);
  }
}

function exactFields(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a JSON object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function validateBenchmark(value, lane) {
  exactFields(value, ['report_sha256', 'median_ms', 'limit_ms'], `${lane} benchmark`);
  if (typeof value.report_sha256 !== 'string' || !SHA256_PATTERN.test(value.report_sha256)) {
    throw new Error(`${lane} report_sha256 must be a lowercase SHA-256 hash`);
  }
  if (typeof value.median_ms !== 'number' || !Number.isFinite(value.median_ms) ||
      value.median_ms < 0) {
    throw new Error(`${lane} median_ms must be a finite nonnegative number`);
  }
  if (value.limit_ms !== BENCHMARK_LIMITS[lane]) {
    throw new Error(`${lane} limit_ms must equal ${BENCHMARK_LIMITS[lane]}`);
  }
  if (value.median_ms > value.limit_ms) {
    throw new Error(`${lane} benchmark exceeds its limit`);
  }
  return Object.freeze({
    report_sha256: value.report_sha256,
    median_ms: value.median_ms,
    limit_ms: value.limit_ms
  });
}

function tagMessage(cwd, tag) {
  const ref = `refs/tags/${tag}`;
  if (git(cwd, ['cat-file', '-t', ref]) !== 'tag') {
    throw new Error(`Release tag ${tag} must be an annotated tag`);
  }
  const tagObject = gitRaw(cwd, ['cat-file', 'tag', ref]);
  const separator = tagObject.indexOf('\n\n');
  if (separator === -1) throw new Error(`Release tag ${tag} has no annotation message`);
  const rawMessage = tagObject.slice(separator + 2);
  return rawMessage.endsWith('\n') ? rawMessage.slice(0, -1) : rawMessage;
}

export function readReleaseTagEvidence({ cwd = process.cwd(), tag }) {
  validateTag(tag);
  const message = tagMessage(cwd, tag);
  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch (error) {
    throw new Error('Release tag message must be one canonical JSON object', { cause: error });
  }
  let normalized;
  try {
    normalized = canonicalJson(parsed);
  } catch (error) {
    throw new Error(
      `Release tag message must be one canonical JSON object: ${error.message}`,
      { cause: error }
    );
  }
  if (message !== normalized) {
    throw new Error('Release tag message must be one canonical JSON object');
  }
  exactFields(parsed, ['schema_version', 'commit', 'fast', 'full'], 'Release tag evidence');
  if (parsed.schema_version !== RELEASE_TAG_EVIDENCE_VERSION) {
    throw new Error(`Release tag schema_version must equal ${RELEASE_TAG_EVIDENCE_VERSION}`);
  }
  if (typeof parsed.commit !== 'string' || !COMMIT_PATTERN.test(parsed.commit)) {
    throw new Error('Release tag commit must be a lowercase 40-character Git commit hash');
  }
  const tagCommit = git(cwd, ['rev-parse', `refs/tags/${tag}^{commit}`]);
  if (parsed.commit !== tagCommit) {
    throw new Error('Release tag evidence commit does not match the peeled tag commit');
  }
  return Object.freeze({
    commit: parsed.commit,
    benchmarks: Object.freeze({
      fast: validateBenchmark(parsed.fast, 'fast'),
      full: validateBenchmark(parsed.full, 'full')
    })
  });
}

export function readReleaseMetadata({ cwd = process.cwd(), tag, mainRef }) {
  validateTag(tag);
  const version = tag.slice(1);
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  if (pkg.version !== version) {
    throw new Error(`Tag ${tag} does not match package.json ${pkg.version}`);
  }
  const evidence = readReleaseTagEvidence({ cwd, tag });
  const checkedOutCommit = git(cwd, ['rev-parse', 'HEAD']);
  if (evidence.commit !== checkedOutCommit) {
    throw new Error('Tag does not resolve to the checked-out commit');
  }
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', checkedOutCommit, mainRef], { cwd });
  if (ancestry.status !== 0) throw new Error('Release commit is not contained in main');
  const notesPath = `docs/releases/v${version}.md`;
  const absoluteNotesPath = join(cwd, notesPath);
  if (!existsSync(absoluteNotesPath) || !lstatSync(absoluteNotesPath).isFile()) {
    throw new Error(`Versioned release notes do not exist: ${notesPath}`);
  }
  return Object.freeze({
    version,
    artifactName: `npm-package-${version}`,
    notesPath,
    commit: evidence.commit,
    benchmarks: evidence.benchmarks
  });
}

function safeJsonOutputDestination(cwd, outputPath) {
  if (outputPath !== JSON_OUTPUT_PATH) {
    throw new Error(`JSON output destination must be exactly ${JSON_OUTPUT_PATH}`);
  }
  const root = realpathSync(cwd);
  const destination = resolve(root, outputPath);
  let current = root;
  for (const part of outputPath.split('/')) {
    current = join(current, part);
    try {
      const status = lstatSync(current);
      if (status.isSymbolicLink()) {
        throw new Error('JSON output destination must not use symbolic links');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  const parent = dirname(destination);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) {
    throw new Error('JSON output parent must be an existing safe directory');
  }
  if (existsSync(destination)) throw new Error('JSON output destination already exists');
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', outputPath], {
    cwd: root,
    stdio: 'ignore'
  });
  if (tracked.status === 0) throw new Error('JSON output destination must be untracked');
  const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', outputPath], {
    cwd: root,
    stdio: 'ignore'
  });
  if (ignored.status !== 0) throw new Error('JSON output destination must be ignored');
  return { destination, parent };
}

export function writeReleaseMetadataJson(cwd, outputPath, metadata, {
  writeTemporary = writeFileSync,
  publishTemporary = linkSync,
  removeTemporary = rmSync
} = {}) {
  const { destination, parent } = safeJsonOutputDestination(cwd, outputPath);
  const temporary = join(
    parent,
    `.release-metadata.json.${process.pid}.${randomBytes(16).toString('hex')}.tmp`
  );
  let primaryFailure;
  let failed = false;
  try {
    writeTemporary(temporary, canonicalJson(metadata), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    publishTemporary(temporary, destination);
  } catch (error) {
    failed = true;
    primaryFailure = error;
    throw error;
  } finally {
    try {
      removeTemporary(temporary, { force: true });
    } catch (cleanupError) {
      if (!failed) throw cleanupError;
      try {
        if (((typeof primaryFailure === 'object' && primaryFailure !== null) ||
            typeof primaryFailure === 'function') && Object.isExtensible(primaryFailure) &&
            !Object.prototype.hasOwnProperty.call(primaryFailure, 'cleanupError')) {
          Object.defineProperty(primaryFailure, 'cleanupError', {
            value: cleanupError,
            enumerable: false,
            configurable: true
          });
        }
      } catch {
        // Cleanup diagnostics must never replace the primary output failure.
      }
    }
  }
}

function parseCli(argv) {
  if (argv.length === 2) return { tag: argv[0], mainRef: argv[1] };
  if (argv.length === 4 && argv[2] === '--json-output') {
    return { tag: argv[0], mainRef: argv[1], jsonOutput: argv[3] };
  }
  throw new Error(`Usage: release-metadata.mjs <tag> <main-ref> [--json-output ${JSON_OUTPUT_PATH}]`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseCli(process.argv.slice(2));
  const metadata = readReleaseMetadata(options);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `version=${metadata.version}`,
      `artifact_name=${metadata.artifactName}`,
      `notes_path=${metadata.notesPath}`,
      `release_commit=${metadata.commit}`,
      `fast_report_sha256=${metadata.benchmarks.fast.report_sha256}`,
      `full_report_sha256=${metadata.benchmarks.full.report_sha256}`,
      ''
    ].join('\n'));
  }
  if (options.jsonOutput) writeReleaseMetadataJson(process.cwd(), options.jsonOutput, metadata);
  if (!process.env.GITHUB_OUTPUT && !options.jsonOutput) {
    throw new Error('GITHUB_OUTPUT or --json-output is required');
  }
}
