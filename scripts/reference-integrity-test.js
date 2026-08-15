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

function copyProject(source,name) {
  const destination=path.join(tmp,name);
  fs.cpSync(source,destination,{recursive:true});
  return destination;
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

  const inRootProject=copyProject(coreProject,"in-root-reference-project");
  fs.mkdirSync(path.join(inRootProject,"scripts","generated"),{recursive:true});
  fs.writeFileSync(path.join(inRootProject,"scripts","existing.js"),"export {};\n","utf8");
  fs.writeFileSync(
    path.join(inRootProject,"REFERENCES.md"),
    "Use `scripts/existing.js` and `scripts/generated`.\n",
    "utf8",
  );
  validateGeneratedProject(inRootProject);

  const traversalProject=copyProject(coreProject,"traversal-reference-project");
  const outsideTraversalTarget=path.join(tmp,"outside-target");
  fs.writeFileSync(outsideTraversalTarget,"outside\n","utf8");
  const traversalDocument=path.join(traversalProject,"TRAVERSAL.md");
  const traversalToken="scripts/../../outside-target";
  fs.writeFileSync(traversalDocument,`See \`${traversalToken}\`.\n`,"utf8");
  assert.throws(
    () => validateGeneratedProject(traversalProject),
    error => {
      assert.match(error.message,/TRAVERSAL\.md/);
      assert.match(error.message,/scripts\/\.\.\/\.\.\/outside-target/);
      return true;
    },
  );

  const symlinkProject=copyProject(coreProject,"symlink-reference-project");
  const outsideSymlinkTarget=path.join(tmp,"outside-symlink-target.js");
  fs.writeFileSync(outsideSymlinkTarget,"export {};\n","utf8");
  fs.mkdirSync(path.join(symlinkProject,"scripts"),{recursive:true});
  fs.symlinkSync(outsideSymlinkTarget,path.join(symlinkProject,"scripts","outside.js"));
  const symlinkDocument=path.join(symlinkProject,"SYMLINK.md");
  fs.writeFileSync(symlinkDocument,"See `scripts/outside.js`.\n","utf8");
  assert.throws(
    () => validateGeneratedProject(symlinkProject),
    error => {
      assert.match(error.message,/SYMLINK\.md/);
      assert.match(error.message,/scripts\/outside\.js/);
      return true;
    },
  );

  const gitResidueProject=copyProject(coreProject,"git-residue-project");
  const gitResidueDocument=path.join(gitResidueProject,".git","generated-note");
  fs.writeFileSync(gitResidueDocument,"Trusted Evaluator\n","utf8");
  assert.throws(
    () => validateGeneratedProject(gitResidueProject),
    error => {
      assert.match(error.message,/\.git\/generated-note/);
      assert.match(error.message,/Trusted Evaluator/);
      return true;
    },
  );

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
