import assert from "node:assert/strict";
import {execFileSync,spawnSync} from "node:child_process";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import * as releaseMetadata from "../scripts/release-metadata.mjs";
import {
  discoverEligibleTestEntries,
  selectTestEntries,
  validateTestManifest,
} from "../scripts/test-manifest.mjs";

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const releaseNotesPath=join(root,"docs","releases","v2.1.1.md");
const scopedIssues=[84,85,86,87,88];
const FAST_LIMIT_MS=15000;
const FULL_LIMIT_MS=90103;

function canonicalJson(value) {
  if (value===null || typeof value!=="object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

function createTagFixture(t,{lightweight=false,notes=true,mutate,message}={}) {
  const cwd=mkdtempSync(join(tmpdir(),"toss-release-tag-"));
  t.after(() => rmSync(cwd,{recursive:true,force:true}));
  const git=(...args) => execFileSync("git",args,{cwd,encoding:"utf8"}).trim();
  git("init","-b","main");
  git("config","user.name","Release Test");
  git("config","user.email","release-test@example.invalid");
  writeFileSync(join(cwd,"package.json"),'{"name":"@toss-software/cli","version":"2.1.1"}\n');
  if (notes) {
    mkdirSync(join(cwd,"docs","releases"),{recursive:true});
    writeFileSync(join(cwd,"docs","releases","v2.1.1.md"),"# TOSS CLI v2.1.1\n");
  }
  git("add",".");
  git("commit","-m","release fixture");
  const commit=git("rev-parse","HEAD");
  const annotation={
    schema_version:"toss-release-tag.v1",
    commit,
    fast:{report_sha256:"b".repeat(64),median_ms:5762.305292,limit_ms:FAST_LIMIT_MS},
    full:{report_sha256:"c".repeat(64),median_ms:16566.500291,limit_ms:FULL_LIMIT_MS},
  };
  mutate?.(annotation);
  if (lightweight) git("tag","v2.1.1");
  else git("tag","-a","v2.1.1","-m",message ?? canonicalJson(annotation));
  return {cwd,commit,annotation};
}

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
  assert.equal(pkg.engines.node,">=20");
  assert.equal(lock.version,"2.1.1");
  assert.equal(lock.packages[""].version,"2.1.1");
});

test("release metadata binds a canonical annotated tag to deeply frozen benchmark evidence",t => {
  assert.equal(releaseMetadata.RELEASE_TAG_EVIDENCE_VERSION,"toss-release-tag.v1");
  assert.equal(typeof releaseMetadata.readReleaseTagEvidence,"function");
  const {cwd,commit,annotation}=createTagFixture(t);

  assert.deepEqual(releaseMetadata.readReleaseTagEvidence({cwd,tag:"v2.1.1"}),{
    commit,
    benchmarks:{fast:annotation.fast,full:annotation.full},
  });
  const metadata=releaseMetadata.readReleaseMetadata({cwd,tag:"v2.1.1",mainRef:"main"});
  assert.deepEqual(metadata,{
    version:"2.1.1",
    artifactName:"npm-package-2.1.1",
    notesPath:"docs/releases/v2.1.1.md",
    commit,
    benchmarks:{fast:annotation.fast,full:annotation.full},
  });
  assert.deepEqual(Object.keys(metadata),[
    "version","artifactName","notesPath","commit","benchmarks",
  ]);
  assert.equal(Object.isFrozen(metadata),true);
  assert.equal(Object.isFrozen(metadata.benchmarks),true);
  assert.equal(Object.isFrozen(metadata.benchmarks.fast),true);
  assert.equal(Object.isFrozen(metadata.benchmarks.full),true);
});

test("release tag evidence rejects lightweight tags",t => {
  const {cwd}=createTagFixture(t,{lightweight:true});
  assert.throws(
    () => releaseMetadata.readReleaseTagEvidence({cwd,tag:"v2.1.1"}),
    /annotated tag/i,
  );
});

for (const [name,options,pattern] of [
  ["unknown fields",{mutate:value => { value.extra=true; }},/unknown|fields/i],
  ["missing fields",{mutate:value => { delete value.full; }},/missing|fields/i],
  ["noncanonical JSON",{message:'{ "schema_version": "toss-release-tag.v1" }'},/canonical JSON/i],
  ["a mismatched commit",{mutate:value => { value.commit="a".repeat(40); }},/commit/i],
  ["non-string commits",{mutate:value => { value.commit=[value.commit]; }},/commit/i],
  ["malformed report hashes",{mutate:value => { value.fast.report_sha256="B".repeat(64); }},/sha256|hash/i],
  ["non-string report hashes",{
    mutate:value => { value.full.report_sha256=[value.full.report_sha256]; },
  },/sha256|hash/i],
  ["non-finite medians",{
    message:({commit}) => canonicalJson({
      commit,
      fast:{limit_ms:FAST_LIMIT_MS,median_ms:null,report_sha256:"b".repeat(64)},
      full:{limit_ms:FULL_LIMIT_MS,median_ms:16566.500291,report_sha256:"c".repeat(64)},
      schema_version:"toss-release-tag.v1",
    }).replace('"median_ms":null','"median_ms":1e999'),
  },/finite|median/i],
  ["negative medians",{mutate:value => { value.fast.median_ms=-1; }},/nonnegative|median/i],
  ["wrong fast limits",{mutate:value => { value.fast.limit_ms=14999; }},/limit/i],
  ["wrong full limits",{mutate:value => { value.full.limit_ms=90102; }},/limit/i],
  ["fast budget misses",{mutate:value => { value.fast.median_ms=15000.000001; }},/budget|limit/i],
  ["full budget misses",{mutate:value => { value.full.median_ms=90103.000001; }},/budget|limit/i],
]) {
  test(`release tag evidence rejects ${name}`,t => {
    const initial=createTagFixture(t,typeof options.message==="function" ? {} : options);
    if (typeof options.message==="function") {
      execFileSync("git",["tag","-d","v2.1.1"],{cwd:initial.cwd,stdio:"pipe"});
      execFileSync("git",[
        "tag","-a","v2.1.1","-m",options.message(initial),
      ],{cwd:initial.cwd,stdio:"pipe"});
    }
    assert.throws(
      () => releaseMetadata.readReleaseTagEvidence({cwd:initial.cwd,tag:"v2.1.1"}),
      pattern,
    );
  });
}

test("release metadata requires versioned release notes",t => {
  const {cwd}=createTagFixture(t,{notes:false});
  assert.throws(
    () => releaseMetadata.readReleaseMetadata({cwd,tag:"v2.1.1",mainRef:"main"}),
    /release notes/i,
  );
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
