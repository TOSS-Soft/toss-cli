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
