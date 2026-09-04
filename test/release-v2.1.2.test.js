import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {canonicalJson} from "../src/contracts/acp.js";
import {readReleaseMetadata} from "../scripts/release-metadata.mjs";

const root=dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root,relativePath),"utf8"));
}

test("v2.1.2 release metadata is consistent across package roots and test ownership",() => {
  const pkg=readJson("package.json");
  const lock=readJson("package-lock.json");
  const manifest=readJson("scripts/test-manifest.json");

  assert.equal(pkg.version,"2.1.2");
  assert.equal(lock.version,"2.1.2");
  assert.equal(lock.packages[""].version,"2.1.2");
  assert.equal(manifest.lanes.release.includes("test/release-v2.1.2.test.js"),true);
  assert.equal(manifest.lanes.release.includes("test/release-v2.1.1.test.js"),false);
});

test("v2.1.2 has bounded release notes for the organizational lifecycle",() => {
  const notes=readFileSync(join(root,"docs","releases","v2.1.2.md"),"utf8");
  assert.match(notes,/^# TOSS CLI v2\.1\.2$/m);
  for (const heading of [
    "Organizational control",
    "Work lifecycle",
    "Release programs",
    "Safety and compatibility",
    "Verification",
    "Included pull requests",
  ]) {
    assert.match(notes,new RegExp(`^## ${heading}$`,`m`));
  }
  assert.match(notes,/^- #105 — /m);
  assert.doesNotMatch(notes,/CLI is \d+% faster/i);
});

test("annotated v2.1.2 tags resolve to the exact release package and notes",t => {
  const cwd=mkdtempSync(join(tmpdir(),"toss-v2.1.2-release-"));
  t.after(() => rmSync(cwd,{recursive:true,force:true}));
  const git=(...args) => execFileSync("git",args,{cwd,encoding:"utf8"}).trim();

  git("init","-b","main");
  git("config","user.name","Release Test");
  git("config","user.email","release-test@example.invalid");
  writeFileSync(join(cwd,"package.json"),'{"name":"@toss-software/cli","version":"2.1.2"}\n');
  mkdirSync(join(cwd,"docs","releases"),{recursive:true});
  writeFileSync(join(cwd,"docs","releases","v2.1.2.md"),"# TOSS CLI v2.1.2\n");
  git("add",".");
  git("commit","-m","release fixture");
  const commit=git("rev-parse","HEAD");
  git("tag","-a","v2.1.2","-m",canonicalJson({
    schema_version:"toss-release-tag.v1",
    commit,
    fast:{report_sha256:"b".repeat(64),median_ms:1,limit_ms:15000},
    full:{report_sha256:"c".repeat(64),median_ms:1,limit_ms:90103},
  }));

  assert.deepEqual(readReleaseMetadata({cwd,tag:"v2.1.2",mainRef:"main"}),{
    version:"2.1.2",
    artifactName:"npm-package-2.1.2",
    notesPath:"docs/releases/v2.1.2.md",
    commit,
    benchmarks:{
      fast:{report_sha256:"b".repeat(64),median_ms:1,limit_ms:15000},
      full:{report_sha256:"c".repeat(64),median_ms:1,limit_ms:90103},
    },
  });
});
