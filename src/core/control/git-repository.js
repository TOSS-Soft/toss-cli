import {types} from "node:util";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import {dirname,join,relative,resolve} from "node:path";

import YAML from "yaml";

import {canonicalJson} from "../../contracts/acp.js";

const SHA=/^[a-f0-9]{40}$/u;
const ZERO_SHA="0".repeat(40);
const EMPTY_TREE_SHA="4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const SEGMENT=/^[A-Za-z0-9._-]+$/u;
const REPOSITORY_FILENAME=/^[a-z0-9._-]+%2F[a-z0-9._-]+\.yaml$/u;

function ownData(options,key) {
  if (options===null || typeof options!=="object" || types.isProxy(options)) {
    throw new TypeError("control repository options must be a non-proxy object");
  }
  const descriptor=Object.getOwnPropertyDescriptor(options,key);
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`${key} must be an own data property`);
  }
  return descriptor.value;
}

function ownDataFunction(options,key) {
  const value=ownData(options,key);
  if (typeof value!=="function" || types.isProxy(value)) {
    throw new TypeError(`${key} must be an own-data non-proxy function`);
  }
  return value;
}

function assertExpectedHead(expectedHead) {
  if (expectedHead!==null && (typeof expectedHead!=="string" || !SHA.test(expectedHead))) {
    throw new TypeError("expectedHead must be null or an exact 40-character commit SHA");
  }
}

function assertMessage(message) {
  if (typeof message!=="string" || !message.trim() || message.includes("\0")) {
    throw new TypeError("commit message must be a non-empty string without NUL bytes");
  }
}

function assertSafeRelativePath(value) {
  if (typeof value!=="string" || !value || value.includes("\\") || value.startsWith("/") ||
      value.includes("\0") || /^[A-Za-z]:/u.test(value)) {
    throw new TypeError(`unsafe relative path: ${String(value)}`);
  }
  const segments=value.split("/");
  // Ledger ruling: generated repository filenames retain their canonical %2F.
  const generatedRepositoryPath=segments.length===3 && segments[0]==="config" &&
    segments[1]==="repositories" && REPOSITORY_FILENAME.test(segments[2]) &&
    encodeURIComponent(decodeURIComponent(segments[2].slice(0,-5)))===segments[2].slice(0,-5);
  if (segments.some(segment => !segment || segment==="." || segment===".." || !SEGMENT.test(segment)) &&
      !generatedRepositoryPath) {
    throw new TypeError(`unsafe relative path: ${value}`);
  }
  const extension=value.endsWith(".yaml") ? ".yaml" : value.endsWith(".json") ? ".json" : null;
  if (!extension) throw new TypeError(`unsupported control document extension: ${value}`);
  return {segments,extension};
}

function assertSafeRelativePrefix(value) {
  if (typeof value!=="string" || !value || value.includes("\\") || value.startsWith("/") ||
      value.includes("\0") || /^[A-Za-z]:/u.test(value)) {
    throw new TypeError(`unsafe relative prefix: ${String(value)}`);
  }
  const segments=value.split("/");
  if (segments.some(segment => !segment || segment==="." || segment===".." || !SEGMENT.test(segment))) {
    throw new TypeError(`unsafe relative prefix: ${value}`);
  }
  return segments;
}

function assertPlainData(value,label,seen=new Set()) {
  if (value===null || typeof value!=="object") return;
  if (types.isProxy(value)) throw new TypeError(`${label} must not contain Proxy values`);
  if (seen.has(value)) throw new TypeError(`${label} must not contain cyclic values`);
  seen.add(value);
  try {
    const prototype=Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype!==Array.prototype) throw new TypeError(`${label} arrays must be plain arrays`);
    } else if (prototype!==Object.prototype && prototype!==null) {
      throw new TypeError(`${label} objects must be plain objects`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key==="length") continue;
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if (typeof key!=="string" || !descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`${label} must contain only own enumerable data properties`);
      }
      assertPlainData(descriptor.value,label,seen);
    }
  } finally {
    seen.delete(value);
  }
}

function canonicalBytes(document,extension) {
  assertPlainData(document,"control document");
  canonicalJson(document);
  if (extension===".json") return Buffer.from(canonicalJson(document),"utf8");
  return Buffer.from(YAML.stringify(document,{sortMapEntries:true}),"utf8");
}

function normalizeFiles(files) {
  if (files===null || typeof files!=="object" || Array.isArray(files) || types.isProxy(files)) {
    throw new TypeError("files must be a non-proxy object map");
  }
  const entries=[];
  for (const path of Object.keys(files)) {
    const descriptor=Object.getOwnPropertyDescriptor(files,path);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("files must contain only own enumerable data properties");
    }
    const checked=assertSafeRelativePath(path);
    entries.push({path,document:descriptor.value,...checked});
  }
  if (entries.length===0) throw new TypeError("files must contain at least one control document");
  entries.sort((left,right) => left.path.localeCompare(right.path,"en",{sensitivity:"variant"}));
  return entries;
}

function isMissing(error) {
  return error?.code==="ENOENT";
}

function isAbsentGitPath(error) {
  const stderr=String(error?.stderr ?? "");
  return /does not exist in|exists on disk, but not in|ambiguous argument 'HEAD'/iu.test(stderr);
}

export function createGitControlRepository(options) {
  const root=ownData(options,"root");
  const execFile=ownDataFunction(options,"execFile");
  const clock=Object.hasOwn(options,"clock") ? ownDataFunction(options,"clock") : Date.now;
  const writeTempFile=Object.hasOwn(options,"writeTempFile")
    ? ownDataFunction(options,"writeTempFile")
    : async (handle,bytes) => handle.writeFile(bytes);
  const removeLock=Object.hasOwn(options,"removeLock")
    ? ownDataFunction(options,"removeLock")
    : path => unlink(path);
  if (typeof root!=="string" || !root) throw new TypeError("root must be a non-empty path string");
  const absoluteRoot=resolve(root);
  let temporarySequence=0;

  async function runGit(args) {
    return execFile("git",args,{cwd:absoluteRoot});
  }

  const stageFinalIndex=Object.hasOwn(options,"stageFinalIndex")
    ? ownDataFunction(options,"stageFinalIndex")
    : stageProposedIndex;

  async function secureRoot() {
    const stat=await lstat(absoluteRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TypeError("control repository root must be a non-symlink directory");
    }
  }

  async function secureTarget(relativePath,{createParents=false}={}) {
    const {segments}=assertSafeRelativePath(relativePath);
    await secureRoot();
    let current=absoluteRoot;
    const created=[];
    for (const segment of segments.slice(0,-1)) {
      current=join(current,segment);
      try {
        const stat=await lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new TypeError(`symbolic link or non-directory path component is not allowed: ${relativePath}`);
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        if (!createParents) {
          const target=join(absoluteRoot,...segments);
          return {target,created};
        }
        await mkdir(current,{recursive:false});
        created.push(current);
        const stat=await lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new TypeError(`symbolic link or non-directory path component is not allowed: ${relativePath}`);
        }
      }
    }
    const target=join(absoluteRoot,...segments);
    if (!relative(absoluteRoot,target) || relative(absoluteRoot,target).startsWith("..")) {
      throw new TypeError(`unsafe relative path: ${relativePath}`);
    }
    try {
      const stat=await lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new TypeError(`symbolic link or non-file target is not allowed: ${relativePath}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return {target,created};
  }

  async function securePrefix(prefix) {
    const segments=assertSafeRelativePrefix(prefix);
    await secureRoot();
    let current=absoluteRoot;
    for (const segment of segments) {
      current=join(current,segment);
      try {
        const stat=await lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new TypeError(`symbolic link or non-directory path component is not allowed: ${prefix}`);
        }
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
    }
  }

  async function head() {
    await secureRoot();
    try {
      const result=await runGit(["rev-parse","--verify","--quiet","HEAD"]);
      const sha=String(result?.stdout ?? "").trim();
      if (!SHA.test(sha)) throw new Error("Git returned an invalid HEAD commit SHA");
      return sha;
    } catch (error) {
      if (error?.code===1) return null;
      throw error;
    }
  }

  async function headRef() {
    const result=await runGit(["symbolic-ref","-q","HEAD"]);
    const ref=String(result?.stdout ?? "").trim();
    if (!/^refs\/[A-Za-z0-9._/-]+$/u.test(ref) || ref.includes("//") || ref.endsWith("/")) {
      throw new Error("control repository HEAD must resolve to a safe symbolic ref");
    }
    return ref;
  }

  async function runHook(name,args=[],{nonVeto=false}={}) {
    try {
      await runGit(["hook","run","--ignore-missing",name,"--",...args]);
    } catch (error) {
      if (nonVeto) return false;
      throw error;
    }
    return true;
  }

  async function createMessageFile(message,temporary) {
    await secureRoot();
    const path=join(absoluteRoot,`.toss-core-message-${process.pid}-${temporarySequence++}.tmp`);
    const handle=await open(path,"wx",0o600);
    temporary.push(path);
    try {
      await handle.writeFile(message,"utf8");
    } finally {
      await handle.close();
    }
    return path;
  }

  async function requestedIndexIsCanonical(entries,actualHead) {
    const result=await runGit([
      "diff-index","--cached","--name-only","-z",actualHead ?? EMPTY_TREE_SHA,
    ]);
    const output=String(result?.stdout ?? "");
    if (output && !output.endsWith("\0")) throw new Error("Git returned malformed staged path output");
    const requested=new Set(entries.map(entry => entry.path));
    const changed=output ? output.slice(0,-1).split("\0") : [];
    for (const path of changed) {
      assertSafeRelativePath(path);
      if (!requested.has(path)) throw new Error(`hook staged an unexpected path: ${path}`);
    }
    for (const entry of entries) {
      const result=await runGit(["show",`:${entry.path}`]);
      if (String(result?.stdout ?? "")!==entry.bytes.toString("utf8")) {
        throw new Error(`hook changed canonical control document bytes: ${entry.path}`);
      }
    }
  }

  async function stageProposedIndex(entries,commitSha) {
    const result=await runGit(["ls-tree","-r","-z",commitSha,"--",...entries.map(entry => entry.path)]);
    const output=String(result?.stdout ?? "");
    if (output && !output.endsWith("\0")) throw new Error("Git returned malformed proposed tree output");
    const expected=new Set(entries.map(entry => entry.path));
    const objects=new Map();
    for (const record of output ? output.slice(0,-1).split("\0") : []) {
      const match=/^100644 blob ([a-f0-9]{40})\t(.+)$/u.exec(record);
      if (!match) throw new Error("Git returned an unexpected proposed control tree entry");
      const [,blob,path]=match;
      assertSafeRelativePath(path);
      if (!expected.delete(path) || objects.has(path)) {
        throw new Error(`Git returned an unexpected proposed control tree path: ${path}`);
      }
      objects.set(path,blob);
    }
    if (expected.size!==0) throw new Error("Git omitted a requested control document from the proposed tree");
    for (const entry of entries) {
      await runGit(["update-index","--add","--cacheinfo",`100644,${objects.get(entry.path)},${entry.path}`]);
    }
  }

  async function readDocument(relativePath,{at="HEAD"}={}) {
    const {extension}=assertSafeRelativePath(relativePath);
    if (at!=="HEAD" && (typeof at!=="string" || !SHA.test(at))) {
      throw new TypeError("document revision must be HEAD or an exact 40-character commit SHA");
    }
    await secureTarget(relativePath);
    const revision=at==="HEAD" ? await head() : at;
    if (revision===null) return null;
    let result;
    try {
      result=await runGit(["show",`${revision}:${relativePath}`]);
    } catch (error) {
      if (isAbsentGitPath(error)) return null;
      throw error;
    }
    const text=String(result?.stdout ?? "");
    const document=extension===".json"
      ? JSON.parse(text)
      : YAML.parse(text,{merge:false,prettyErrors:false,uniqueKeys:true});
    if (document===null || typeof document!=="object" || Array.isArray(document)) {
      throw new TypeError(`control document must be an object: ${relativePath}`);
    }
    assertPlainData(document,"control document");
    canonicalJson(document);
    return document;
  }

  async function listDocuments(prefix,{at="HEAD"}={}) {
    assertSafeRelativePrefix(prefix);
    if (at!=="HEAD" && (typeof at!=="string" || !SHA.test(at))) {
      throw new TypeError("document revision must be HEAD or an exact 40-character commit SHA");
    }
    await securePrefix(prefix);
    const revision=at==="HEAD" ? await head() : at;
    if (revision===null) return Object.freeze([]);
    const result=await runGit(["ls-tree","-r","-z","--name-only",revision,"--",prefix]);
    const output=String(result?.stdout ?? "");
    if (output && !output.endsWith("\0")) throw new Error("Git returned malformed NUL-delimited document paths");
    const documents=output ? output.slice(0,-1).split("\0") : [];
    const unique=new Set();
    for (const path of documents) {
      assertSafeRelativePath(path);
      if (!path.startsWith(`${prefix}/`) || unique.has(path)) {
        throw new Error(`Git returned an unexpected control document path: ${path}`);
      }
      unique.add(path);
    }
    documents.sort((left,right) => left<right ? -1 : left>right ? 1 : 0);
    return Object.freeze(documents);
  }

  async function rootSnapshotAt({at}={}) {
    if (typeof at!=="string" || !SHA.test(at)) throw new TypeError("root snapshot revision must be an exact 40-character commit SHA");
    await secureRoot();
    const roots=String((await runGit(["rev-list","--max-parents=0",at]))?.stdout ?? "").trim().split("\n").filter(Boolean);
    if (roots.length!==1 || !SHA.test(roots[0])) throw new Error("control repository history must have exactly one reachable root commit");
    const revision=roots[0];
    const output=String((await runGit(["ls-tree","-r","-z",revision]))?.stdout ?? "");
    if (output && !output.endsWith("\0")) throw new Error("Git returned malformed root tree output");
    const paths=[];
    for (const record of output ? output.slice(0,-1).split("\0") : []) {
      const match=/^(100644) blob [a-f0-9]{40}\t(.+)$/u.exec(record);
      if (!match) throw new Error("root control tree must contain only regular document blobs");
      assertSafeRelativePath(match[2]);
      paths.push(match[2]);
    }
    paths.sort();
    if (new Set(paths).size!==paths.length) throw new Error("root control tree contains duplicate paths");
    return Object.freeze({revision,paths:Object.freeze(paths)});
  }

  async function indexSnapshot() {
    const result=await runGit(["rev-parse","--git-path","index"]);
    const indexPath=resolve(absoluteRoot,String(result?.stdout ?? "").trim());
    try {
      return {indexPath,bytes:await readFile(indexPath)};
    } catch (error) {
      if (isMissing(error)) return {indexPath,bytes:null};
      throw error;
    }
  }

  async function restoreIndex(snapshot) {
    if (snapshot.bytes===null) {
      await rm(snapshot.indexPath,{force:true});
    } else {
      await writeFile(snapshot.indexPath,snapshot.bytes,{mode:0o600});
    }
  }

  async function acquireLock() {
    await secureRoot();
    const path=join(absoluteRoot,".toss-core.lock");
    try {
      const stat=await lstat(path);
      if (stat.isSymbolicLink()) throw new TypeError("control repository lock may not be a symbolic link");
      throw new Error("control repository is locked");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const handle=await open(path,"wx",0o600);
    await handle.close();
    return path;
  }

  async function commitFiles({expectedHead,message,files}) {
    assertExpectedHead(expectedHead);
    assertMessage(message);
    const entries=normalizeFiles(files);
    const lock=await acquireLock();
    const temporary=[];
    const createdDirectories=[];
    let index;
    let states=[];
    let succeeded=false;
    try {
      const actualHead=await head();
      if (actualHead!==expectedHead) {
        const error=new Error(`control repository expected head conflict: expected ${String(expectedHead)}, found ${String(actualHead)}`);
        error.code="CORE_CONTROL_CONFLICT";
        throw error;
      }
      index=await indexSnapshot();
      for (const entry of entries) {
        const secured=await secureTarget(entry.path,{createParents:true});
        createdDirectories.push(...secured.created);
        let bytes=null;
        try {
          bytes=await readFile(secured.target);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        states.push({entry,target:secured.target,bytes});
      }
      for (const state of states) {
        const bytes=canonicalBytes(state.entry.document,state.entry.extension);
        state.entry.bytes=bytes;
        const timestamp=clock();
        const milliseconds=timestamp instanceof Date ? timestamp.getTime() : timestamp;
        if (!Number.isSafeInteger(milliseconds) || milliseconds<0) {
          throw new TypeError("clock must return a non-negative integer timestamp or Date");
        }
        const temp=`${state.target}.toss-core-${process.pid}-${milliseconds}-${temporary.length}.tmp`;
        await secureTarget(state.entry.path);
        const handle=await open(temp,"wx",0o600);
        temporary.push(temp);
        try {
          await writeTempFile(handle,bytes,temp);
        } finally {
          await handle.close();
        }
        await secureTarget(state.entry.path);
        await rename(temp,state.target);
        temporary.pop();
      }
      await runGit(actualHead===null ? ["read-tree","--empty"] : ["read-tree",actualHead]);
      await runGit(["add","--",...entries.map(entry => entry.path)]);
      await runHook("pre-commit");
      const messagePath=await createMessageFile(message,temporary);
      await runHook("prepare-commit-msg",[messagePath,"message"]);
      await runHook("commit-msg",[messagePath]);
      const messageText=await readFile(messagePath,"utf8");
      assertMessage(messageText);
      await requestedIndexIsCanonical(entries,actualHead);
      const treeResult=await runGit(["write-tree"]);
      const tree=String(treeResult?.stdout ?? "").trim();
      if (!SHA.test(tree)) throw new Error("Git did not create an exact 40-character tree SHA");
      const commitResult=await runGit([
        "commit-tree",tree,...(actualHead===null ? [] : ["-p",actualHead]),"-F",messagePath,
      ]);
      await rm(messagePath,{force:true});
      temporary.splice(temporary.indexOf(messagePath),1);
      const commitSha=String(commitResult?.stdout ?? "").trim();
      if (!SHA.test(commitSha)) throw new Error("Git did not create an exact 40-character commit SHA");
      await restoreIndex(index);
      await stageFinalIndex(entries,commitSha);
      try {
        await runGit(["update-ref",await headRef(),commitSha,actualHead ?? ZERO_SHA]);
      } catch (error) {
        const conflict=new Error(`control repository expected head conflict: expected ${String(expectedHead)}`);
        conflict.code="CORE_CONTROL_CONFLICT";
        conflict.cause=error;
        throw conflict;
      }
      succeeded=true;
      await runHook("post-commit",[],{nonVeto:true});
      return Object.freeze({commit_sha:commitSha});
    } finally {
      try {
        if (!succeeded) {
        for (const temp of temporary) await rm(temp,{force:true});
        for (const state of states.reverse()) {
          try {
            await secureTarget(state.entry.path);
            if (state.bytes===null) await rm(state.target,{force:true});
            else await writeFile(state.target,state.bytes,{mode:0o600});
          } catch {
            // A hostile replacement must not be followed during rollback.
          }
        }
        if (index) await restoreIndex(index);
        for (const directory of [...createdDirectories].reverse()) {
          try { await rmdir(directory); } catch { /* directory is no longer empty */ }
        }
        }
      } finally {
        await removeLock(lock).catch(error => {
          if (!isMissing(error) && !succeeded) throw error;
        });
      }
    }
  }

  return Object.freeze({head,readDocument,listDocuments,rootSnapshotAt,commitFiles});
}
