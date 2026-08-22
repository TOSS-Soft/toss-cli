import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync,readFileSync} from "node:fs";
import {dirname,join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {
  discoverEligibleTestEntries,
  selectTestEntries,
  validateTestManifest,
} from "../scripts/test-manifest.mjs";

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const releaseNotesPath=join(root,"docs","releases","v2.1.1.md");
const scopedIssues=[84,85,86,87,88];

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root,relativePath),"utf8"));
}

function readReleaseNotes() {
  assert.equal(
    existsSync(releaseNotesPath),
    true,
    "docs/releases/v2.1.1.md must exist for the release candidate",
  );
  return readFileSync(releaseNotesPath,"utf8");
}

test("release metadata targets v2.1.1 in the manifest and both lockfile roots",() => {
  const pkg=readJson("package.json");
  const lock=readJson("package-lock.json");

  assert.equal(pkg.version,"2.1.1");
  assert.equal(lock.version,"2.1.1");
  assert.equal(lock.packages[""].version,"2.1.1");
});

test("release inventory retains the independent e2e smoke contract once in full",async () => {
  const manifest=validateTestManifest(readJson("scripts/test-manifest.json"),{
    eligibleEntries:await discoverEligibleTestEntries(root),
  });
  assert.equal(manifest.lanes.e2e.includes("scripts/smoke-test.js"),true);
  assert.equal(
    selectTestEntries(manifest,"full")
      .filter(entry => entry==="scripts/smoke-test.js").length,
    1,
  );
});

test("release notes expose the v2.1.1 heading and required categories",() => {
  const notes=readReleaseNotes();
  assert.match(notes,/^# TOSS CLI v2\.1\.1$/m);
  for (const category of [
    "Test lanes",
    "Contributor workflow",
    "Internal cold start",
    "Durability and concurrency",
    "Compatibility",
    "Verification",
    "Closed issues",
  ]) {
    assert.match(notes,new RegExp(`^## ${category}$`,`m`),`missing ${category} category`);
  }
});

test("release notes defer numeric release-candidate benchmark claims until Task 6",() => {
  const notes=readReleaseNotes();
  assert.doesNotMatch(notes,/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|%)\b/i);
});

test("release notes avoid unsupported public-runtime claims",() => {
  const notes=readReleaseNotes();
  assert.doesNotMatch(notes,/CLI is \d+% faster/i);
});

test("release notes inventory every completed scoped issue exactly once",() => {
  const notes=readReleaseNotes();
  const inventoryHeading="## Closed issues\n";
  const inventoryStart=notes.indexOf(inventoryHeading);
  assert.notEqual(inventoryStart,-1,"release notes omit the closed issue inventory");
  const inventory=notes
    .slice(inventoryStart+inventoryHeading.length)
    .split(/^## /m,1)[0];
  const listed=[...inventory.matchAll(/^- #(\d+) — /gm)].map(match => Number(match[1]));

  assert.deepEqual(listed,scopedIssues);
  for (const issue of scopedIssues) {
    assert.equal(
      listed.filter(listedIssue => listedIssue===issue).length,
      1,
      `issue #${issue} must appear exactly once in the closed issue inventory`,
    );
  }
});

test("release notes and CLI help preserve all legacy entry points",() => {
  const notes=readReleaseNotes();
  for (const command of [
    "`toss init [project-brief.yaml]`",
    "`toss create <project-brief.yaml>`",
    "`toss \"Project Name\" [legacy scaffold options]`",
  ]) {
    assert.ok(notes.includes(command),`release notes omit ${command}`);
  }

  const help=spawnSync(process.execPath,[join(root,"bin","toss.js"),"--help"],{
    cwd:root,
    encoding:"utf8",
  });
  assert.equal(help.status,0,help.stderr);
  assert.match(help.stdout,/toss init \[project-brief\.yaml\]/);
  assert.match(help.stdout,/toss create <project-brief\.yaml>/);
  assert.match(help.stdout,/toss "Project Name" \[legacy scaffold options\]/);
});
