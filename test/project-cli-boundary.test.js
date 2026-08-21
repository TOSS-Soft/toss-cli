import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {projectCommandInput as projectInput} from "./support/command-fixture.js";

const repositoryRoot=fileURLToPath(new URL("..",import.meta.url));
const cli=join(repositoryRoot,"bin","toss.js");

test("CLI project prepare and status use only the local persisted artifact boundary",async t => {
  const directory=await mkdtemp(join(tmpdir(),"toss-project-cli-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const projectRoot=join(directory,"project");
  const inputPath=join(directory,"project.json");
  await writeFile(inputPath,JSON.stringify(projectInput()),"utf8");

  const prepared=spawnSync(process.execPath,[
    cli,"project","prepare","--from",inputPath,"--project",projectRoot,"--json",
  ],{cwd:repositoryRoot,encoding:"utf8",maxBuffer:10*1024*1024});
  assert.equal(prepared.status,0,prepared.stderr || prepared.stdout);
  const preparedResult=JSON.parse(prepared.stdout);
  assert.equal(preparedResult.schema_version,"command-result.v1");
  assert.equal(preparedResult.data.state,"READY_FOR_ISSUES");

  const status=spawnSync(process.execPath,[
    cli,"project","status","--project",projectRoot,"--json",
  ],{cwd:repositoryRoot,encoding:"utf8",maxBuffer:10*1024*1024});
  assert.equal(status.status,0,status.stderr || status.stdout);
  const statusResult=JSON.parse(status.stdout);
  assert.equal(statusResult.data.state,"READY_FOR_ISSUES");
  assert.equal(statusResult.data.next_command,"issues preview");
});
