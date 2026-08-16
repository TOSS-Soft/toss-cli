import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root=path.resolve(".");
const cli=path.join(root,"bin","toss.js");

function runCli(args,{cwd,env=process.env,imports=[]}) {
  return spawnSync(
    process.execPath,
    [...imports.flatMap(file => ["--import",file]),cli,...args],
    {cwd,env,encoding:"utf8"},
  );
}

function writeRecursiveBrief(file,{name,slug,requiredCheck="recursive-check"}) {
  fs.writeFileSync(file,`project:
  name: ${name}
  slug: ${slug}
  description: Reject cyclic Project Brief values atomically
business:
  problem: A recursive YAML alias is not JSON serializable
  primary_goal: Preserve the destination before reporting validation errors
governance:
  delivery: false
delivery:
  create_github_repository: false
  create_github_project: false
  apply_main_ruleset: false
  required_status_checks:
    - ${requiredCheck}
constraints: &loop
  - *loop
`,"utf8");
}

test("a post-preflight project.json symlink swap cannot escape the destination",t => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-create-symlink-swap-"));
  t.after(() => fs.rmSync(tmp,{recursive:true,force:true}));

  const destination=path.join(tmp,"swap-project");
  const projectJson=path.join(destination,"project.json");
  const outside=path.join(tmp,"outside.json");
  const outsideBefore='{"sentinel":"outside"}\n';
  fs.writeFileSync(outside,outsideBefore,"utf8");

  const hook=path.join(tmp,"swap-after-contained-write.mjs");
  fs.writeFileSync(hook,`
import fs from "node:fs";
import path from "node:path";

const target=path.resolve(process.env.TOSS_SWAP_TARGET);
const outside=path.resolve(process.env.TOSS_SWAP_OUTSIDE);
const trackedDescriptors=new Set();
let targetWritten=false;
let swapped=false;
const originalOpenSync=fs.openSync.bind(fs);
const originalWriteFileSync=fs.writeFileSync.bind(fs);
const originalCloseSync=fs.closeSync.bind(fs);

fs.openSync=(file,flags,...args) => {
  if (
    !swapped
    && targetWritten
    && typeof file === "string"
    && path.resolve(file) !== target
  ) {
    fs.rmSync(target);
    fs.symlinkSync(outside,target);
    swapped=true;
  }
  const descriptor=originalOpenSync(file,flags,...args);
  if (typeof file === "string" && path.resolve(file) === target) {
    trackedDescriptors.add(descriptor);
  }
  return descriptor;
};
fs.writeFileSync=(file,...args) => {
  const result=originalWriteFileSync(file,...args);
  if (typeof file === "number" && trackedDescriptors.has(file)) {
    targetWritten=true;
  }
  return result;
};
fs.closeSync=descriptor => {
  trackedDescriptors.delete(descriptor);
  return originalCloseSync(descriptor);
};
`,"utf8");

  const result=runCli([
    "Symlink Swap Project",
    "--slug","swap-project",
    "--dir",destination,
    "--no-git",
  ],{
    cwd:tmp,
    imports:[hook],
    env:{
      ...process.env,
      TOSS_SWAP_TARGET:projectJson,
      TOSS_SWAP_OUTSIDE:outside,
    },
  });

  assert.equal(
    fs.lstatSync(projectJson).isSymbolicLink(),
    true,
    "the adversarial hook did not perform the requested post-write swap",
  );
  assert.equal(
    fs.readFileSync(outside,"utf8"),
    outsideBefore,
    `the CLI wrote through a swapped project.json symlink\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.notEqual(result.status,0,"the CLI reported success after a destination swap");
  assert.doesNotMatch(result.stdout,/PROJECT BOOTSTRAP COMPLETE/);
});

test("recursive Project Brief YAML is rejected before creating its destination",t => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-recursive-brief-create-"));
  t.after(() => fs.rmSync(tmp,{recursive:true,force:true}));

  const slug="recursive-brief-project";
  const brief=path.join(tmp,"recursive.yaml");
  writeRecursiveBrief(brief,{name:"Recursive Brief Project",slug});

  const result=runCli(["create",brief],{cwd:tmp});

  assert.equal(
    fs.existsSync(path.join(tmp,slug)),
    false,
    `recursive YAML created a partial destination\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.notEqual(result.status,0,"recursive YAML unexpectedly succeeded");
  assert.match(result.stderr,/Project Brief.*not JSON.serializable/i);
});

test("recursive Project Brief YAML preserves same-profile force targets",t => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-recursive-brief-force-"));
  t.after(() => fs.rmSync(tmp,{recursive:true,force:true}));

  const slug="recursive-force-project";
  const destination=path.join(tmp,slug);
  const initial=runCli([
    "Original Atomic Project",
    "--slug",slug,
    "--dir",destination,
    "--no-git",
  ],{cwd:tmp});
  assert.equal(
    initial.status,
    0,
    `initial same-profile fixture failed\nstdout:\n${initial.stdout}\nstderr:\n${initial.stderr}`,
  );

  const affectedTargets=[
    "project.json",
    "project-management/PROJECT_STATE.md",
    "project-management/bootstrap/main-ruleset.json",
    "project-management/bootstrap/PROJECT_BRIEF.json",
  ];
  const before=new Map(affectedTargets.map(relativePath => [
    relativePath,
    fs.readFileSync(path.join(destination,...relativePath.split("/"))),
  ]));
  const brief=path.join(tmp,"recursive-force.yaml");
  writeRecursiveBrief(brief,{
    name:"Replacement Must Not Land",
    slug,
    requiredCheck:"replacement-check",
  });

  const result=runCli(["create",brief,"--force"],{cwd:tmp});

  for (const relativePath of affectedTargets) {
    assert.deepEqual(
      fs.readFileSync(path.join(destination,...relativePath.split("/"))),
      before.get(relativePath),
      `recursive --force mutated ${relativePath}`,
    );
  }
  assert.notEqual(result.status,0,"recursive --force unexpectedly succeeded");
  assert.match(result.stderr,/Project Brief.*not JSON.serializable/i);
});

test("fast scaffold preserves JSON-significant metadata as literal values",t => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-json-metadata-"));
  t.after(() => fs.rmSync(tmp,{recursive:true,force:true}));

  const slug="json-metadata-project";
  const destination=path.join(tmp,slug);
  const name='Acme "{{DESCRIPTION}}" \\ Platform\nNext';
  const description='Literal "quoted" \\ description\nSecond';
  const owner='owner-"quoted"-{{PROJECT_SLUG}}';
  const result=runCli([
    name,
    "--slug",slug,
    "--description",description,
    "--owner",owner,
    "--dir",destination,
    "--no-git",
  ],{cwd:tmp});

  assert.equal(
    result.status,
    0,
    `valid JSON-significant metadata failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  const state=JSON.parse(fs.readFileSync(path.join(destination,"project.json"),"utf8"));
  assert.equal(state.project.name,name);
  assert.equal(state.project.slug,slug);
  assert.equal(state.project.description,description);
  assert.equal(state.project.owner,owner);
  assert.equal(state.project.visibility,"private");
});
