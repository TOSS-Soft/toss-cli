import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import YAML from "yaml";

const root=path.resolve(".");
const cli=path.join(root,"bin","toss.js");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-governance-contract-"));
after(() => fs.rmSync(tmp,{recursive:true,force:true}));

const brief=YAML.parse(
  fs.readFileSync(path.join(root,"templates","project-brief.yaml"),"utf8"),
);
brief.project.name="Governance Contract Project";
brief.project.slug="governance-contract-project";
brief.project.description="Generated governance semantic fixture";
brief.business.problem="Protect authority and assignment boundaries";
brief.business.primary_goal="Validate material governance invariants";
brief.governance.delivery=true;
const briefPath=path.join(tmp,"project-brief.yaml");
fs.writeFileSync(briefPath,YAML.stringify(brief),"utf8");
const generation=spawnSync(process.execPath,[cli,"create",briefPath],{
  cwd:tmp,
  encoding:"utf8",
});
assert.equal(
  generation.status,
  0,
  `governance fixture generation failed\nstdout:\n${generation.stdout}\nstderr:\n${generation.stderr}`,
);
const project=path.join(tmp,"governance-contract-project");

function read(relativePath) {
  return fs.readFileSync(path.join(project,...relativePath.split("/")),"utf8");
}

function prose(text) {
  return text.replace(/\s+/g," ");
}

test("verified CEO authority remains explicit and authority types cannot be inferred",() => {
  const governance=read("project-management/GOVERNANCE.md");
  const delivery=read("project-management/policies/DELIVERY.md");
  const operations=read("project-management/policies/OPERATIONS.md");
  const release=read("project-management/templates/RELEASE.md");
  const datafix=read("project-management/templates/DATAFIX.md");
  const governanceProse=prose(governance);
  const deliveryProse=prose(delivery);
  const operationsProse=prose(operations);

  assert.match(
    governanceProse,
    /Main-branch merge requires explicit, action-specific verified CEO merge authorization/i,
  );
  assert.match(
    governanceProse,
    /Recovery exceptions do not grant merge authority/i,
  );

  assert.match(
    deliveryProse,
    /main-branch merge requires explicit verified CEO merge authorization/i,
  );
  assert.match(
    deliveryProse,
    /generic code-review approval (?:is insufficient|does not grant merge authority)/i,
  );
  assert.match(
    deliveryProse,
    /production deployment requires explicit verified CEO deployment authorization/i,
  );
  assert.match(
    deliveryProse,
    /code review, merge authorization, release approval, production deployment authorization, and rollout authority are distinct/i,
  );
  assert.match(
    operationsProse,
    /production data mutation requires explicit verified CEO approval/i,
  );
  assert.match(
    operationsProse,
    /narrower pre-authorized recovery authority/i,
  );
  assert.match(
    operationsProse,
    /exact scope, trigger, executor, stop conditions, and recovery procedure/i,
  );
  assert.match(release,/## Code Review Evidence/);
  assert.match(release,/## Verified CEO Merge Authorization/);
  assert.match(release,/## Verified CEO Production Deployment Authorization/);
  assert.match(datafix,/## Verified CEO Mutation Approval/);
  assert.match(datafix,/## Pre-Authorized Recovery Authority/);
});

test("Core owns dependency safety and Delivery owns independent risk-based security review",() => {
  const quality=read("project-management/QUALITY.md");
  const delivery=read("project-management/policies/DELIVERY.md");
  const qualityProse=prose(quality);
  const deliveryProse=prose(delivery);

  assert.match(quality,/## Dependency and Supply-Chain Safety/);
  assert.match(qualityProse,/necessity, provenance, integrity, known vulnerabilities/i);
  assert.match(qualityProse,/install or build behavior, and lockfile consistency/i);
  assert.match(delivery,/## Risk-Based Delivery Security Review/);
  assert.match(
    deliveryProse,
    /HIGH and CRITICAL security-impact changes require independent security review/i,
  );
  assert.match(
    deliveryProse,
    /reviewer independent of the implementation under review/i,
  );
});

test("Task records can express every assignment boundary",() => {
  const task=read("project-management/templates/TASK.md");
  for (const field of [
    "Workspace",
    "Environment",
    "Allowed Actions",
    "Prohibited Actions",
    "Escalation Conditions",
  ]) {
    assert.match(task,new RegExp(`^${field}:`,"m"),`Task record omits ${field}`);
  }
});

test("Agent Registry rows use only declared status values",() => {
  const registry=read("project-management/AGENT_REGISTRY.md");
  const vocabularySection=registry.match(
    /## Status Vocabulary\n\n([\s\S]*?)(?=\n## )/,
  )?.[1] ?? "";
  const declared=new Set(vocabularySection.match(/\b[A-Z][A-Z_]+\b/g) ?? []);
  const tableSection=registry.match(
    /## Active Specialist\n\n([\s\S]*?)(?=\n## )/,
  )?.[1] ?? "";
  const rows=tableSection.split("\n")
    .filter(line => /^\|/.test(line))
    .slice(2);
  for (const row of rows) {
    const columns=row.split("|").slice(1,-1).map(value => value.trim());
    assert.ok(
      declared.has(columns[1]),
      `Agent Registry uses undeclared status ${columns[1]}`,
    );
  }
  assert.doesNotMatch(registry,/\| NONE \| NONE \|/);
});
