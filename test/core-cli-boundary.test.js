import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {runCoreCli} from "../src/core/cli.js";

const repositoryRoot=fileURLToPath(new URL("..",import.meta.url));
const coreCli=join(repositoryRoot,"bin","toss-core.js");
const legacyCli=join(repositoryRoot,"bin","toss.js");
const manifest=JSON.parse(await readFile(join(repositoryRoot,"package.json"),"utf8"));
const CORE_HELP=`Usage: toss-core <command> [options]

Commands:
  init
  repo add <OWNER/REPO> --from <FILE>
  repo list

Common options:
  --json
  --control <PATH>  Local control repository (default: .toss-core-control)
  --apply --non-interactive
  --dry-run
`;

function stream() {
  let value="";
  return Object.freeze({write(chunk) { value+=chunk; },read() { return value; }});
}

function invoke(args,{cwd=repositoryRoot}={}) {
  return spawnSync(process.execPath,[coreCli,...args],{
    cwd,
    encoding:"utf8",
    maxBuffer:10*1024*1024,
  });
}

function git(cwd,args) {
  const result=spawnSync("git",args,{cwd,encoding:"utf8"});
  assert.equal(result.status,0,result.stderr || result.stdout);
}

async function emptyControlRepository(t) {
  const root=await mkdtemp(join(tmpdir(),"toss-core-cli-boundary-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const control=join(root,"control");
  git(root,["init","--quiet",control]);
  await writeFile(join(control,"README.md"),"local control state\n","utf8");
  git(control,["add","README.md"]);
  git(control,["-c","user.name=TOSS Test","-c","user.email=toss-test@example.invalid","commit","--quiet","-m","initialize local control"]);
  return {root,control};
}

test("runCoreCli accepts an explicit fake runtime provider for init preview and apply",async () => {
  const events=[];
  const runtimeProvider=async ({command}) => ({
    handlers:{
      init:async received => {
        events.push({name:received.name,apply:received.options.apply,interactive:received.interactive});
        return {phase:received.options.apply ? "apply" : "preview"};
      },
    },
  });

  for (const [argv,expected] of [
    [["init","--json"],"preview"],
    [["init","--apply","--non-interactive","--json"],"apply"],
  ]) {
    const stdout=stream();
    const stderr=stream();
    assert.equal(await runCoreCli(argv,{cwd:"/workspace",stdin:Object.freeze({}),stdout,stderr,runtimeProvider}),0);
    assert.equal(stderr.read(),"");
    assert.deepEqual(JSON.parse(stdout.read()),{
      schema_version:"command-result.v1",
      document_type:"command-result",
      ok:true,
      data:{phase:expected},
      error:null,
    });
  }
  assert.deepEqual(events,[
    {name:"init",apply:false,interactive:true},
    {name:"init",apply:true,interactive:false},
  ]);
});

test("toss-core process owns top-level help, version, JSON purity, and empty local repo listing",async t => {
  const {root}=await emptyControlRepository(t);
  const help=invoke(["--help"]);
  assert.equal(help.status,0,help.stderr);
  assert.equal(help.stderr,"");
  assert.equal(help.stdout,CORE_HELP);
  const shortHelp=invoke(["-h"]);
  assert.equal(shortHelp.status,0,shortHelp.stderr);
  assert.equal(shortHelp.stdout,help.stdout);

  const version=invoke(["--version"]);
  assert.equal(version.status,0,version.stderr);
  assert.equal(version.stderr,"");
  assert.equal(version.stdout,manifest.version+"\n");
  const shortVersion=invoke(["-v"]);
  assert.equal(shortVersion.status,0,shortVersion.stderr);
  assert.equal(shortVersion.stdout,version.stdout);

  const listed=invoke(["repo","list","--control","control","--json"],{cwd:root});
  assert.equal(listed.status,0,listed.stderr || listed.stdout);
  assert.equal(listed.stderr,"");
  assert.equal(listed.stdout.trim().split("\n").filter(Boolean).length>0,true);
  const result=JSON.parse(listed.stdout);
  assert.equal(result.schema_version,"command-result.v1");
  assert.deepEqual(result.data.repositories,[]);
  assert.deepEqual(result.data.github_revisions,[]);

  const invalid=invoke(["--version","--json"]);
  assert.equal(invalid.status,2);
  assert.equal(invalid.stderr,"");
  assert.equal(JSON.parse(invalid.stdout).error.code,"COMMAND_USAGE");
  const invalidHelp=invoke(["--help","--json"]);
  assert.equal(invalidHelp.status,2);
  assert.equal(invalidHelp.stderr,"");
  assert.equal(JSON.parse(invalidHelp.stdout).error.code,"COMMAND_USAGE");
});

test("legacy toss feature status retains its established JSON failure contract",() => {
  const result=spawnSync(process.execPath,[legacyCli,"feature","status","--json"],{
    cwd:repositoryRoot,
    encoding:"utf8",
  });
  assert.equal(result.status,3,result.stderr || result.stdout);
  assert.equal(result.stderr,"");
  assert.deepEqual(JSON.parse(result.stdout),{
    schema_version:"command-result.v1",
    document_type:"command-result",
    ok:false,
    data:null,
    error:{
      code:"FEATURE_INPUT_REQUIRED",
      message:"No persisted feature input exists",
    },
  });
});
