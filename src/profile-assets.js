import fs from "node:fs";
import path from "node:path";

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

  const files=[];
  const paths=new Set();
  for (const relativePath of manifest.files) {
    assertSafeRelativePath(relativePath);
    const canonicalPath=canonicalizeRelativePath(relativePath);
    if (paths.has(canonicalPath)) {
      throw new TypeError(`Profile manifest contains duplicate file path: ${relativePath}`);
    }
    paths.add(canonicalPath);

    const source=path.join(profileRoot,canonicalPath);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new TypeError(`Profile asset is missing or not a regular file: ${relativePath}`);
    }
    files.push(canonicalPath);
  }

  return {profile:manifest.profile,version:manifest.version,files};
}

export function loadProfileManifest(profileRoot) {
  const manifestPath=path.join(profileRoot,"manifest.json");
  const manifest=JSON.parse(fs.readFileSync(manifestPath,"utf8"));
  return validateManifest(manifest,profileRoot);
}

export function copyProfileAssets(profileRoot,destination,manifest) {
  const validated=manifest
    ? validateManifest(manifest,profileRoot)
    : loadProfileManifest(profileRoot);

  for (const relativePath of validated.files) {
    const source=path.join(profileRoot,relativePath);
    const target=path.join(destination,relativePath);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.copyFileSync(source,target);
  }
}
