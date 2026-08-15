import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { validateGeneratedProject } from "../src/reference-integrity.js";

const root=path.resolve(".");
const cli=path.join(root,"bin","toss.js");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-reference-integrity-"));

function writeCompleteBrief(name,slug,delivery) {
  const brief=YAML.parse(
    fs.readFileSync(path.join(root,"templates","project-brief.yaml"),"utf8"),
  );
  brief.project.name=name;
  brief.project.slug=slug;
  brief.project.description="Generated reference integrity fixture";
  brief.business.problem="Validate generated governance references";
  brief.business.primary_goal="Reject invalid generated references";
  brief.governance.delivery=delivery;

  const briefPath=path.join(tmp,`${slug}.yaml`);
  fs.writeFileSync(briefPath,YAML.stringify(brief),"utf8");
  return briefPath;
}

function generateProject(name,slug,delivery) {
  const result=spawnSync(
    process.execPath,
    [cli,"create",writeCompleteBrief(name,slug,delivery)],
    {cwd:tmp,encoding:"utf8"},
  );
  assert.equal(
    result.status,
    0,
    `${slug} generation failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return path.join(tmp,slug);
}

try {
  const coreProject=generateProject("Core Integrity Project","core-integrity-project",false);
  const deliveryProject=generateProject(
    "Delivery Integrity Project",
    "delivery-integrity-project",
    true,
  );

  validateGeneratedProject(coreProject);
  validateGeneratedProject(deliveryProject);

  const brokenDocument=path.join(coreProject,"BROKEN.md");
  fs.writeFileSync(brokenDocument,"See `scripts/missing.js`.\n","utf8");
  assert.throws(
    () => validateGeneratedProject(coreProject),
    error => {
      assert.match(error.message,/BROKEN\.md/);
      assert.match(error.message,/scripts\/missing\.js/);
      return true;
    },
  );
  fs.rmSync(brokenDocument);

  const workDocument=path.join(coreProject,"project-management","WORK.md");
  fs.appendFileSync(workDocument,"\n`superpowers:test-driven-development`\n","utf8");
  assert.throws(
    () => validateGeneratedProject(coreProject),
    error => {
      assert.match(error.message,/project-management\/WORK\.md/);
      assert.match(error.message,/superpowers:test-driven-development/);
      return true;
    },
  );

  console.log("Generated reference integrity test: PASS");
} finally {
  fs.rmSync(tmp,{recursive:true,force:true});
}
