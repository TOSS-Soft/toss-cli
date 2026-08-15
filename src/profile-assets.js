import fs from "node:fs";
import path from "node:path";

const NO_FOLLOW=fs.constants.O_NOFOLLOW ?? 0;

function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new TypeError("Profile manifest file paths must be non-empty strings.");
  }
  if (
    path.posix.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new TypeError(`Unsafe profile asset path: ${relativePath}`);
  }
}

function canonicalizeRelativePath(relativePath) {
  return path.posix.normalize(relativePath.replaceAll("\\","/"));
}

function isWithin(root,target) {
  const relative=path.relative(root,target);
  return relative!==".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function lstatOrThrow(file,label) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code==="ENOENT") {
      throw new TypeError(`${label} is missing: ${file}`);
    }
    throw error;
  }
}

function lstatIfExists(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code==="ENOENT") return null;
    throw error;
  }
}

function validateDirectoryRoot(directory,label,{create=false}={}) {
  const absolute=path.resolve(directory);
  let stat=lstatIfExists(absolute);
  if (create && !stat) {
    fs.mkdirSync(absolute,{recursive:true});
    stat=lstatOrThrow(absolute,label);
  }
  if (!stat) throw new TypeError(`${label} is missing: ${absolute}`);
  if (stat.isSymbolicLink()) {
    throw new TypeError(`${label} must not be a symbolic link: ${absolute}`);
  }
  if (!stat.isDirectory()) {
    throw new TypeError(`${label} must be a directory: ${absolute}`);
  }
  return {absolute,canonical:fs.realpathSync(absolute)};
}

function assertSourcePath(profileRoot,canonicalRoot,relativePath) {
  let current=profileRoot;
  const segments=relativePath.split("/");
  for (let index=0;index<segments.length;index+=1) {
    current=path.join(current,segments[index]);
    const stat=lstatOrThrow(current,`Profile asset ${relativePath}`);
    if (stat.isSymbolicLink()) {
      throw new TypeError(
        `Profile asset path contains a symbolic link: ${relativePath}`,
      );
    }
    if (index<segments.length-1 && !stat.isDirectory()) {
      throw new TypeError(`Profile asset parent is not a directory: ${relativePath}`);
    }
    if (index===segments.length-1 && !stat.isFile()) {
      throw new TypeError(
        `Profile asset is missing or not a regular file: ${relativePath}`,
      );
    }
  }
  const canonicalSource=fs.realpathSync(current);
  if (!isWithin(canonicalRoot,canonicalSource)) {
    throw new TypeError(`Profile asset escapes its profile root: ${relativePath}`);
  }
  return current;
}

function readSourceAsset(profileRoot,canonicalRoot,relativePath) {
  const source=assertSourcePath(profileRoot,canonicalRoot,relativePath);
  let descriptor;
  try {
    descriptor=fs.openSync(source,fs.constants.O_RDONLY|NO_FOLLOW);
  } catch (error) {
    if (error?.code==="ELOOP") {
      throw new TypeError(
        `Profile asset path contains a symbolic link: ${relativePath}`,
      );
    }
    throw error;
  }
  try {
    const descriptorStat=fs.fstatSync(descriptor);
    if (!descriptorStat.isFile()) {
      throw new TypeError(
        `Profile asset is missing or not a regular file: ${relativePath}`,
      );
    }
    const canonicalSource=fs.realpathSync(source);
    if (!isWithin(canonicalRoot,canonicalSource)) {
      throw new TypeError(`Profile asset escapes its profile root: ${relativePath}`);
    }
    const pathStat=fs.statSync(canonicalSource);
    if (descriptorStat.dev!==pathStat.dev || descriptorStat.ino!==pathStat.ino) {
      throw new TypeError(`Profile asset changed during validation: ${relativePath}`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateManifest(manifest,profileRoot) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("Profile manifest must be an object.");
  }
  if (typeof manifest.profile !== "string" || !manifest.profile.trim()) {
    throw new TypeError("Profile manifest profile must be a non-empty string.");
  }
  if (manifest.version !== "2.0.0") {
    throw new TypeError("Profile manifest version must be 2.0.0.");
  }
  if (!Array.isArray(manifest.files)) {
    throw new TypeError("Profile manifest files must be an array.");
  }

  const root=validateDirectoryRoot(profileRoot,"Profile root");
  const files=[];
  const paths=new Set();
  for (const relativePath of manifest.files) {
    assertSafeRelativePath(relativePath);
    const canonicalPath=canonicalizeRelativePath(relativePath);
    if (paths.has(canonicalPath)) {
      throw new TypeError(`Profile manifest contains duplicate file path: ${relativePath}`);
    }
    paths.add(canonicalPath);
    assertSourcePath(root.absolute,root.canonical,canonicalPath);
    files.push(canonicalPath);
  }

  return {profile:manifest.profile,version:manifest.version,files};
}

function readManifest(profileRoot) {
  const root=validateDirectoryRoot(profileRoot,"Profile root");
  const manifestPath=path.join(root.absolute,"manifest.json");
  const stat=lstatOrThrow(manifestPath,"Profile manifest");
  if (stat.isSymbolicLink()) {
    throw new TypeError(`Profile manifest must not be a symbolic link: ${manifestPath}`);
  }
  if (!stat.isFile()) {
    throw new TypeError(`Profile manifest is not a regular file: ${manifestPath}`);
  }
  const descriptor=fs.openSync(manifestPath,fs.constants.O_RDONLY|NO_FOLLOW);
  try {
    return JSON.parse(fs.readFileSync(descriptor,"utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensureDestinationParent(root,relativePath) {
  let current=root.absolute;
  for (const segment of relativePath.split("/").slice(0,-1)) {
    current=path.join(current,segment);
    let stat=lstatIfExists(current);
    if (!stat) {
      fs.mkdirSync(current);
      stat=lstatOrThrow(current,`Profile destination ${relativePath}`);
    }
    if (stat.isSymbolicLink()) {
      throw new TypeError(
        `Profile destination path contains a symbolic link: ${relativePath}`,
      );
    }
    if (!stat.isDirectory()) {
      throw new TypeError(
        `Profile destination parent is not a directory: ${relativePath}`,
      );
    }
    const canonicalDirectory=fs.realpathSync(current);
    if (!isWithin(root.canonical,canonicalDirectory)) {
      throw new TypeError(`Profile destination escapes its root: ${relativePath}`);
    }
  }
}

function inspectDestinationParent(root,relativePath) {
  let current=root.absolute;
  for (const segment of relativePath.split("/").slice(0,-1)) {
    current=path.join(current,segment);
    const stat=lstatIfExists(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new TypeError(
        `Profile destination path contains a symbolic link: ${relativePath}`,
      );
    }
    if (!stat.isDirectory()) {
      throw new TypeError(
        `Profile destination parent is not a directory: ${relativePath}`,
      );
    }
    const canonicalDirectory=fs.realpathSync(current);
    if (!isWithin(root.canonical,canonicalDirectory)) {
      throw new TypeError(`Profile destination escapes its root: ${relativePath}`);
    }
  }
}

function assertDestinationTarget(root,relativePath) {
  const target=path.join(root.absolute,...relativePath.split("/"));
  if (!isWithin(root.absolute,target)) {
    throw new TypeError(`Profile destination escapes its root: ${relativePath}`);
  }
  const stat=lstatIfExists(target);
  if (stat) {
    if (stat.isSymbolicLink()) {
      throw new TypeError(
        `Profile destination path contains a symbolic link: ${relativePath}`,
      );
    }
    if (!stat.isFile()) {
      throw new TypeError(
        `Profile destination is not a regular file: ${relativePath}`,
      );
    }
  }
  return {target,exists:Boolean(stat)};
}

function writeDestinationAsset(root,relativePath,contents) {
  ensureDestinationParent(root,relativePath);
  const targetState=assertDestinationTarget(root,relativePath);
  const {target}=targetState;
  let descriptor;
  try {
    const creationFlags=targetState.exists
      ? 0
      : fs.constants.O_CREAT|fs.constants.O_EXCL;
    descriptor=fs.openSync(
      target,
      fs.constants.O_WRONLY|creationFlags|NO_FOLLOW,
      0o666,
    );
  } catch (error) {
    if (error?.code==="ELOOP" || error?.code==="EEXIST") {
      throw new TypeError(
        `Profile destination changed or contains a symbolic link: ${relativePath}`,
      );
    }
    throw error;
  }
  try {
    const stat=fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new TypeError(
        `Profile destination is not a regular file: ${relativePath}`,
      );
    }
    const canonicalTarget=fs.realpathSync(target);
    if (!isWithin(root.canonical,canonicalTarget)) {
      throw new TypeError(`Profile destination escapes its root: ${relativePath}`);
    }
    const pathStat=fs.statSync(canonicalTarget);
    if (stat.dev!==pathStat.dev || stat.ino!==pathStat.ino) {
      throw new TypeError(`Profile destination changed during copy: ${relativePath}`);
    }
    fs.ftruncateSync(descriptor,0);
    fs.writeFileSync(descriptor,contents);
  } finally {
    fs.closeSync(descriptor);
  }
}

function normalizeDestinationPaths(relativePaths) {
  if (!Array.isArray(relativePaths)) {
    throw new TypeError("Contained destination paths must be an array.");
  }
  const normalizedPaths=[];
  const seen=new Set();
  for (const relativePath of relativePaths) {
    assertSafeRelativePath(relativePath);
    const canonicalPath=canonicalizeRelativePath(relativePath);
    if (seen.has(canonicalPath)) {
      throw new TypeError(`Contained destination contains duplicate path: ${relativePath}`);
    }
    seen.add(canonicalPath);
    normalizedPaths.push(canonicalPath);
  }
  return normalizedPaths;
}

function inspectDestinationTargets(destinationRoot,normalizedPaths) {
  for (const relativePath of normalizedPaths) {
    inspectDestinationParent(destinationRoot,relativePath);
    assertDestinationTarget(destinationRoot,relativePath);
  }
}

function prepareDestination(destination,relativePaths) {
  const normalizedPaths=normalizeDestinationPaths(relativePaths);
  const destinationRoot=validateDirectoryRoot(
    destination,
    "Profile destination root",
    {create:true},
  );

  inspectDestinationTargets(destinationRoot,normalizedPaths);
  for (const relativePath of normalizedPaths) {
    ensureDestinationParent(destinationRoot,relativePath);
  }
  inspectDestinationTargets(destinationRoot,normalizedPaths);
  return {destinationRoot,normalizedPaths};
}

export function validateContainedFileTargets(destination,relativePaths) {
  const normalizedPaths=normalizeDestinationPaths(relativePaths);
  const absolute=path.resolve(destination);
  if (!lstatIfExists(absolute)) return;
  const destinationRoot=validateDirectoryRoot(
    absolute,
    "Profile destination root",
  );
  inspectDestinationTargets(destinationRoot,normalizedPaths);
}

export function writeContainedFiles(destination,assets) {
  if (!Array.isArray(assets)) {
    throw new TypeError("Contained destination assets must be an array.");
  }
  const prepared=prepareDestination(
    destination,
    assets.map(asset => asset?.relativePath),
  );
  for (let index=0;index<assets.length;index+=1) {
    writeDestinationAsset(
      prepared.destinationRoot,
      prepared.normalizedPaths[index],
      assets[index].contents,
    );
  }
  inspectDestinationTargets(
    prepared.destinationRoot,
    prepared.normalizedPaths,
  );
}

export function loadProfileManifest(profileRoot) {
  return validateManifest(readManifest(profileRoot),profileRoot);
}

export function loadProfileAssets(profileRoot,manifest) {
  const validated=manifest
    ? validateManifest(manifest,profileRoot)
    : loadProfileManifest(profileRoot);
  const sourceRoot=validateDirectoryRoot(profileRoot,"Profile root");

  return validated.files.map(relativePath => ({
    relativePath,
    contents:readSourceAsset(
      sourceRoot.absolute,
      sourceRoot.canonical,
      relativePath,
    ),
  }));
}

export function copyProfileAssets(profileRoot,destination,manifest) {
  writeContainedFiles(destination,loadProfileAssets(profileRoot,manifest));
}
