import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {parse as parseYaml} from "yaml";

import {
  OWNERSHIP_LANES,
  discoverEligibleTestEntries,
  selectTestEntries,
  validateTestManifest,
} from "../scripts/test-manifest.mjs";

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const laneScripts=Object.freeze({
  fast:"node ./scripts/test-runner.mjs fast",
  integration:"node ./scripts/test-runner.mjs integration",
  e2e:"node ./scripts/test-runner.mjs e2e",
  package:"node ./scripts/test-runner.mjs package",
  release:"node ./scripts/test-runner.mjs release",
  full:"node ./scripts/test-runner.mjs full",
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(root,relativePath),"utf8"));
}

async function readYaml(relativePath) {
  return parseYaml(await readFile(join(root,relativePath),"utf8"));
}

async function normalizedManifest() {
  const manifest=await readJson("scripts/test-manifest.json");
  return validateTestManifest(manifest,{
    eligibleEntries:await discoverEligibleTestEntries(root),
  });
}

function stepRun(workflow,jobName,stepName) {
  const step=workflow.jobs[jobName].steps.find(item => item.name===stepName);
  assert.ok(step,`workflow ${jobName} job must define the ${stepName} step`);
  return step.run;
}

test("package scripts expose explicit lanes and keep every external gate full",async () => {
  const pkg=await readJson("package.json");
  assert.equal(pkg.scripts.test,"npm run test:full");
  for (const [lane,command] of Object.entries(laneScripts)) {
    assert.equal(pkg.scripts[`test:${lane}`],command);
  }
  assert.equal(pkg.scripts.prepack,"npm test");
  assert.equal(/(?:^|\s)node --test(?:\s|$)/u.test(pkg.scripts.test),false);
});

test("PR and publish workflows preserve the canonical full and package gates",async () => {
  const [ci,publish]=await Promise.all([
    readYaml(".github/workflows/ci.yml"),
    readYaml(".github/workflows/publish.yml"),
  ]);
  assert.ok(ci.on.pull_request,"CI must run for pull requests");
  assert.equal(
    ci.jobs.test["timeout-minutes"],30,
    "PR CI must leave room for npm test plus the prepack full gate",
  );
  assert.deepEqual(ci.jobs.test.strategy.matrix.node,[20,24]);
  assert.equal(ci.jobs.test.strategy["fail-fast"],false);
  const setupNode=ci.jobs.test.steps.find(step => step.uses === "actions/setup-node@v7");
  assert.ok(setupNode,"CI must configure Node with setup-node");
  assert.equal(setupNode.with["node-version"],"${{ matrix.node }}");
  assert.ok(ci.jobs.test.steps.some(step => step.run === "npm test"));
  assert.ok(ci.jobs.test.steps.some(step => step.run === "npm pack --dry-run"));
  assert.equal(stepRun(ci,"test","Run smoke tests"),"npm test");
  assert.equal(stepRun(ci,"test","Validate npm package"),"npm pack --dry-run");
  assert.equal(stepRun(publish,"validate","Test"),"npm test");
});

test("each focused package lane resolves to its only owner list",async () => {
  const [pkg,manifest]=await Promise.all([readJson("package.json"),normalizedManifest()]);
  for (const lane of OWNERSHIP_LANES) {
    assert.equal(pkg.scripts[`test:${lane}`],laneScripts[lane]);
    assert.deepEqual(selectTestEntries(manifest,lane),manifest.lanes[lane]);
  }
});

test("full is the complete unique ownership union without support entries",async () => {
  const [manifest,eligibleEntries]=await Promise.all([
    normalizedManifest(),discoverEligibleTestEntries(root),
  ]);
  const full=selectTestEntries(manifest,"full");
  assert.equal(Number.isInteger(manifest.concurrency),true);
  assert.ok(manifest.concurrency>=1 && manifest.concurrency<=4);
  assert.equal(manifest.concurrency,4);
  assert.deepEqual(full,OWNERSHIP_LANES.flatMap(lane => manifest.lanes[lane]));
  assert.equal(full.length,eligibleEntries.length);
  assert.equal(new Set(full).size,eligibleEntries.length);
  assert.equal(full.some(entry => entry.startsWith("test/support/") || entry.startsWith("test/fixtures/")),false);
});
