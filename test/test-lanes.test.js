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
  const compatibility=ci.jobs.compatibility;
  assert.ok(compatibility,"CI must run the compatibility matrix");
  assert.equal(
    compatibility["timeout-minutes"],30,
    "PR CI must leave room for npm test plus the prepack full gate",
  );
  assert.deepEqual(compatibility.strategy.matrix.node,[20,24]);
  assert.equal(compatibility.strategy["fail-fast"],false);
  const ciCheckout=compatibility.steps.find(step => step.uses === "actions/checkout@v7");
  assert.ok(ciCheckout,"CI must check out the source and locked legacy tag");
  assert.equal(ciCheckout.with?.["fetch-depth"],0);
  const setupNode=compatibility.steps.find(step => step.uses === "actions/setup-node@v7");
  assert.ok(setupNode,"CI must configure Node with setup-node");
  assert.equal(setupNode.with["node-version"],"${{ matrix.node }}");
  assert.equal(stepRun(ci,"compatibility","Run smoke tests"),"npm test");
  assert.equal(stepRun(ci,"compatibility","Validate npm package"),"npm pack --dry-run");
  assert.equal(ci.jobs.test.name,"test");
  assert.equal(ci.jobs.test.needs,"compatibility");
  assert.equal(ci.jobs.test.if,"${{ always() }}");
  const requiredGate=ci.jobs.test.steps.find(step => step.name==="Require compatibility matrix");
  assert.ok(requiredGate,"CI must expose the required aggregate test status");
  assert.equal(requiredGate.env.COMPATIBILITY_RESULT,"${{ needs.compatibility.result }}");
  assert.equal(requiredGate.run,'test "$COMPATIBILITY_RESULT" = "success"');
  assert.equal(stepRun(publish,"validate","Test"),"npm test");
  assert.equal(publish.jobs.publish_npm.permissions["id-token"],"write");
  assert.equal(publish.jobs.publish_github_packages.permissions.packages,"write");
  assert.equal(publish.jobs.release.permissions.contents,"write");
  assert.equal(publish.jobs.release.permissions.packages,"read");
  const releaseCheckout=publish.jobs.release.steps.find(step => step.uses==="actions/checkout@v7");
  assert.ok(releaseCheckout,"release job must check out the tagged source");
  assert.equal(releaseCheckout.with.ref,"${{ github.ref }}");
  assert.equal(releaseCheckout.with["fetch-depth"],0);
  const upload=publish.jobs.validate.steps.find(step => step.uses==="actions/upload-artifact@v7");
  assert.match(upload.with.path,/release-metadata\.json/u);
  const releaseRun=stepRun(publish,"release","Create and verify GitHub Release evidence");
  assert.match(releaseRun,/--notes-file "\$NOTES_PATH"/u);
  assert.match(releaseRun,/release-evidence\.mjs/u);
  assert.match(releaseRun,/release-evidence\.json/u);
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
