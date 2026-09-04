import assert from "node:assert/strict";
import {existsSync,readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import test from "node:test";

const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url)));
const dependencyFields=["dependencies","devDependencies","optionalDependencies","peerDependencies",
  "peerDependenciesMeta","bundledDependencies","bundleDependencies","overrides","resolutions"];
const corePackageNames=new Set(["@toss-soft/core","@toss-software/core"]);

function containsCoreDependency(value) {
  if (typeof value === "string") {
    return corePackageNames.has(value) || /^npm:(?:@toss-soft\/core|@toss-software\/core)(?:@|$)/u.test(value);
  }
  if (Array.isArray(value)) return value.some(containsCoreDependency);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([name,child]) => corePackageNames.has(name) || containsCoreDependency(child));
  }
  return false;
}

test("the product package does not own Core",() => {
  assert.deepEqual(pkg.bin,{toss:"bin/toss.js"});
  for (const field of dependencyFields) {
    assert.equal(containsCoreDependency(pkg[field]),false,field);
  }
  for (const path of ["bin/toss-core.js","src/core","contracts/core","test/fixtures/core"])
    assert.equal(existsSync(new URL(`../${path}`,import.meta.url)),false,path);
  const tracked=execFileSync("git",["ls-files"],{encoding:"utf8"}).split("\n");
  assert.equal(tracked.some(path => /^test\/core-.*\.test\.js$/u.test(path) &&
    path!=="test/core-removal-boundary.test.js"),false);
  assert.equal(tracked.includes("test/support/core-github-fixture.js"),false);
  assert.equal(tracked.some(path => /^docs\/superpowers\/(?:plans|specs)\/.*(?:toss-core|toss-cli-core)/u.test(path)),false);
  assert.equal(tracked.includes("docs/contracts/authority-severity-mapping.md"),false);
});
