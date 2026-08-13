import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root=path.resolve(".");
const cli=path.join(root,"bin","toss.js");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-cli-"));
const brief=path.join(tmp,"project-brief.yaml");

let r=spawnSync(process.execPath,[cli,"init",brief],{encoding:"utf8"});
if (r.status!==0 || !fs.existsSync(brief)) {
  console.error(r.stdout,r.stderr); process.exit(1);
}

let text=fs.readFileSync(brief,"utf8")
  .replace('name: ""','name: "NPM Smoke Project"')
  .replace('description: ""','description: "NPM package smoke test"')
  .replace('problem: ""','problem: "Validate TOSS npm CLI"')
  .replace('primary_goal: ""','primary_goal: "Create a project from brief"');
fs.writeFileSync(brief,text);

r=spawnSync(process.execPath,[cli,"create",brief],{cwd:tmp,encoding:"utf8"});
if (r.status!==0) {
  console.error(r.stdout,r.stderr); process.exit(1);
}
const project=path.join(tmp,"npm-smoke-project");
for (const rel of [
  "CLAUDE.md",
  "project.json",
  "project-management/PM_AGENT.md",
  "project-management/bootstrap/PROJECT_BRIEF.json",
  "project-management/GLOBAL_AGENT_CATALOG.json",
]) {
  if (!fs.existsSync(path.join(project,rel))) {
    console.error("Missing",rel); process.exit(1);
  }
}
console.log("TOSS CLI smoke test: PASS");
