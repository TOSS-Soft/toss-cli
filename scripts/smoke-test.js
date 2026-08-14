import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root=path.resolve(".");
const cli=path.join(root,"bin","toss.js");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-cli-"));

function runCli(args,options={}) {
  return spawnSync(process.execPath,[cli,...args],{
    cwd:options.cwd||root,
    encoding:"utf8",
  });
}

function assertSuccess(result,label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function completeBrief(data,{name,slug}={}) {
  data.project.name=name||"Design Smoke Project";
  data.project.slug=slug||"design-smoke-project";
  data.project.description="Design bootstrap smoke test";
  data.business.problem="Validate TOSS design bootstrap";
  data.business.primary_goal="Create governed design artifacts";
  return data;
}

function writeYaml(file,data) {
  fs.writeFileSync(file,YAML.stringify(data),"utf8");
}

const brief=path.join(tmp,"project-brief.yaml");
let result=runCli(["init",brief]);
assertSuccess(result,"toss init");

const initialized=YAML.parse(fs.readFileSync(brief,"utf8"));
assert.ok(initialized.design,"toss init did not emit the design brief section");
assert.deepEqual(initialized.design.required,"AUTO");
assert.equal(initialized.design.production_tool,"AUTO");
assert.deepEqual(initialized.design.company_design_system.references,[]);

const explicit=completeBrief(initialized);
explicit.design.required=true;
explicit.design.source="company_system";
explicit.design.company_design_system.name="TOSS Brand System";
explicit.design.company_design_system.references=["docs/brand.md"];
explicit.design.production_tool="pencil";
writeYaml(brief,explicit);

result=runCli(["create",brief],{cwd:tmp});
assertSuccess(result,"toss create with design");

const project=path.join(tmp,"design-smoke-project");
for (const rel of [
  "CLAUDE.md",
  "project.json",
  "project-management/PM_AGENT.md",
  "project-management/bootstrap/PROJECT_BRIEF.json",
  "project-management/GLOBAL_AGENT_CATALOG.json",
]) {
  assert.ok(fs.existsSync(path.join(project,rel)),`Missing ${rel}`);
}

const context=JSON.parse(fs.readFileSync(
  path.join(project,"project-management/bootstrap/PROJECT_BRIEF.json"),
  "utf8",
));
assert.equal(context.design.required,true);
assert.equal(context.design.source,"company_system");
assert.equal(context.design.production_tool,"pencil");
assert.equal(context.design.company_design_system.name,"TOSS Brand System");
assert.deepEqual(context.design.company_design_system.references,["docs/brand.md"]);

const invalidBrief=path.join(tmp,"invalid-design-brief.yaml");
const invalid=structuredClone(explicit);
invalid.project.name="Invalid Design Project";
invalid.project.slug="invalid-design-project";
invalid.design.production_tool="photoshop";
writeYaml(invalidBrief,invalid);

result=runCli(["create",invalidBrief],{cwd:tmp});
assert.notEqual(result.status,0,"unsupported design production tool was accepted");
assert.match(result.stderr,/design\.production_tool/);

const legacyBrief=path.join(tmp,"legacy-project-brief.yaml");
const legacy=completeBrief(structuredClone(explicit),{
  name:"Legacy Smoke Project",
  slug:"legacy-smoke-project",
});
delete legacy.design;
writeYaml(legacyBrief,legacy);

result=runCli(["create",legacyBrief],{cwd:tmp});
assertSuccess(result,"toss create with legacy brief");

const legacyContext=JSON.parse(fs.readFileSync(
  path.join(tmp,"legacy-smoke-project/project-management/bootstrap/PROJECT_BRIEF.json"),
  "utf8",
));
assert.deepEqual(legacyContext.design,{required:"AUTO"});

console.log("TOSS CLI smoke test: PASS");
