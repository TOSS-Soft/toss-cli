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
