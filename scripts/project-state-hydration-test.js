import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root=path.resolve(".");
const cli=path.join(root,"bin","toss.js");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-project-state-hydration-"));

try {
  const fakeBin=path.join(tmp,"bin");
  const fakeGh=path.join(fakeBin,process.platform==="win32" ? "gh.cmd" : "gh");
  fs.mkdirSync(fakeBin);
  const fakeGhSource=`#!/usr/bin/env node
const {spawnSync}=require("node:child_process");
const args=process.argv.slice(2);
if (args[0]==="auth" && args[1]==="status") process.exit(0);
if (args[0]==="repo" && args[1]==="create") {
  let result=spawnSync("git",["init","--bare",process.env.TOSS_FAKE_GH_REMOTE],{stdio:"inherit"});
  if (result.status!==0) process.exit(result.status ?? 1);
  result=spawnSync("git",["remote","add","origin",process.env.TOSS_FAKE_GH_REMOTE],{cwd:process.cwd(),stdio:"inherit"});
  if (result.status!==0) process.exit(result.status ?? 1);
  result=spawnSync("git",["push","-u","origin","main"],{cwd:process.cwd(),stdio:"inherit"});
  process.exit(result.status ?? 1);
}
if (args[0]==="project" && args[1]==="create") {
  process.stdout.write(JSON.stringify({url:"https://github.com/orgs/example-owner/projects/42"})+"\\n");
  process.exit(0);
}
process.stderr.write("Unexpected fake gh arguments: "+args.join(" ")+"\\n");
process.exit(2);
`;
  fs.writeFileSync(fakeGh,fakeGhSource,"utf8");
  fs.chmodSync(fakeGh,0o755);

  const gitConfig=path.join(tmp,"gitconfig");
  fs.writeFileSync(
    gitConfig,
    "[user]\n\tname = TOSS Fixture\n\temail = toss-fixture@example.test\n",
    "utf8",
  );
  const emptySystemConfig=path.join(tmp,"empty-system-gitconfig");
  fs.writeFileSync(emptySystemConfig,"","utf8");

  const brief=YAML.parse(
    fs.readFileSync(path.join(root,"templates","project-brief.yaml"),"utf8"),
  );
  brief.project.name="Remote State Project";
  brief.project.slug="remote-state-project";
  brief.project.description="Persist remote recovery state";
  brief.business.problem="Remote URLs must survive bootstrap";
  brief.business.primary_goal="Hydrate canonical repository and Project URLs";
  brief.delivery.github_owner="example-owner";
  brief.delivery.create_github_repository=true;
  brief.delivery.create_github_project=true;
  brief.delivery.apply_main_ruleset=false;
  const briefPath=path.join(tmp,"remote-project.yaml");
  fs.writeFileSync(briefPath,YAML.stringify(brief),"utf8");

  const result=spawnSync(process.execPath,[cli,"create",briefPath],{
    cwd:tmp,
    encoding:"utf8",
    env:{
      ...process.env,
      PATH:`${fakeBin}${path.delimiter}${process.env.PATH}`,
      GIT_CONFIG_GLOBAL:gitConfig,
      GIT_CONFIG_SYSTEM:emptySystemConfig,
      TOSS_FAKE_GH_REMOTE:path.join(tmp,"remote.git"),
    },
  });
  assert.equal(
    result.status,
    0,
    `remote bootstrap failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const project=path.join(tmp,"remote-state-project");
  const state=fs.readFileSync(
    path.join(project,"project-management","PROJECT_STATE.md"),
    "utf8",
  );
  assert.match(
    state,
    /Repository: https:\/\/github\.com\/example-owner\/remote-state-project/,
  );
  assert.match(
    state,
    /GitHub Project: https:\/\/github\.com\/orgs\/example-owner\/projects\/42/,
  );
  const projectJson=JSON.parse(fs.readFileSync(path.join(project,"project.json"),"utf8"));
  assert.equal(projectJson.bootstrap_state.github_repository,"CREATED");
  assert.equal(projectJson.bootstrap_state.github_project,"CREATED");

  console.log("Project state hydration test: PASS");
} finally {
  fs.rmSync(tmp,{recursive:true,force:true});
}
