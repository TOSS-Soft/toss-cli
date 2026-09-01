import assert from "node:assert/strict";
import test from "node:test";

const routerModule=await import("../src/core/commands/router.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const cliModule=await import("../src/core/cli.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});

const unavailable=name => () => {
  throw new Error(`${name} is unavailable`);
};
const parseCoreCommand=routerModule.parseCoreCommand ?? unavailable("parseCoreCommand");
const dispatchCoreCommand=routerModule.dispatchCoreCommand ?? unavailable("dispatchCoreCommand");
const runCoreCli=cliModule.runCoreCli ?? unavailable("runCoreCli");

function outputStream() {
  let contents="";
  return Object.freeze({
    write(value) {
      contents+=value;
    },
    read() {
      return contents;
    },
  });
}

const commandMatrix=Object.freeze([
  {argv:["init"],name:"init",args:[0,0],readOnly:true,interactive:true},
  {argv:["repo","add","TOSS-Soft/toss-console"],name:"repo.add",args:[1,1],readOnly:true,interactive:true},
  {argv:["repo","list"],name:"repo.list",args:[0,0],readOnly:true,interactive:false},
  {argv:["feature","add","Core lifecycle"],name:"feature.add",args:[1,1],readOnly:true,interactive:true},
  {argv:["feature","status","FEATURE-001"],name:"feature.status",args:[1,1],readOnly:true,interactive:false},
  {argv:["epic","prepare","EPIC-001"],name:"epic.prepare",args:[1,1],readOnly:true,interactive:true},
  {argv:["epic","status","EPIC-001"],name:"epic.status",args:[1,1],readOnly:true,interactive:false},
  {argv:["epic","approve","EPIC-001"],name:"epic.approve",args:[1,1],readOnly:true,interactive:true},
  {argv:["epic","submit","EPIC-001"],name:"epic.submit",args:[1,1],readOnly:true,interactive:true},
  {argv:["epic","accept","EPIC-001"],name:"epic.accept",args:[1,1],readOnly:true,interactive:true},
  {argv:["issue","add","Bug report"],name:"issue.add",args:[1,1],readOnly:true,interactive:true},
  {argv:["issue","start","ISSUE-001"],name:"issue.start",args:[1,1],readOnly:true,interactive:true},
  {argv:["issue","submit","ISSUE-001"],name:"issue.submit",args:[1,1],readOnly:true,interactive:true},
  {argv:["issue","status","ISSUE-001"],name:"issue.status",args:[1,1],readOnly:true,interactive:false},
  {argv:["dependency","add","ISSUE-001","ISSUE-002"],name:"dependency.add",args:[2,2],readOnly:true,interactive:true},
  {argv:["dependency","remove","ISSUE-001","ISSUE-002"],name:"dependency.remove",args:[2,2],readOnly:true,interactive:true},
  {argv:["dependency","graph"],name:"dependency.graph",args:[0,1],readOnly:true,interactive:false},
  {argv:["dependency","check"],name:"dependency.check",args:[0,1],readOnly:true,interactive:false},
  {argv:["review","record","PR-001"],name:"review.record",args:[1,1],readOnly:true,interactive:true},
  {argv:["review","status","PR-001"],name:"review.status",args:[1,1],readOnly:true,interactive:false},
  {argv:["release","plan"],name:"release.plan",args:[0,0],readOnly:true,interactive:true},
  {argv:["release","activate","v2.2.0"],name:"release.activate",args:[1,2],readOnly:true,interactive:true},
  {argv:["release","status","v2.2.0"],name:"release.status",args:[1,1],readOnly:true,interactive:false},
  {argv:["release","approve","v2.2.0"],name:"release.approve",args:[1,1],readOnly:true,interactive:true},
  {argv:["program","status"],name:"program.status",args:[0,1],readOnly:true,interactive:false},
  {argv:["sync"],name:"sync",args:[0,1],readOnly:true,interactive:true},
  {argv:["audit"],name:"audit",args:[0,1],readOnly:true,interactive:false},
  {argv:["doctor"],name:"doctor",args:[0,0],readOnly:true,interactive:false},
  {argv:["migrate","rebaseline"],name:"migrate.rebaseline",args:[0,0],readOnly:true,interactive:true},
]);

test("core parser recognizes the approved command vocabulary and argument bounds",() => {
  for (const expected of commandMatrix) {
    const command=parseCoreCommand(expected.argv);
    assert.equal(command.name,expected.name,expected.argv.join(" "));
    assert.equal(command.args.length>=expected.args[0],true,expected.name);
    assert.equal(command.args.length<=expected.args[1],true,expected.name);
    assert.equal(command.readOnly,expected.readOnly,expected.name);
    assert.equal(command.interactive,expected.interactive,expected.name);
    assert.equal(Object.isFrozen(command),true,expected.name);
    assert.equal(Object.isFrozen(command.args),true,expected.name);
    assert.equal(Object.isFrozen(command.options),true,expected.name);
  }

  for (const expected of commandMatrix.filter(row => row.args[0]===row.args[1])) {
    assert.throws(
      () => parseCoreCommand([...expected.argv,"unexpected"]),
      /usage|argument/i,
      `${expected.name} rejects an extra argument`,
    );
  }
});

test("core parser normalizes the closed common option shape and applies safety metadata",() => {
  const command=parseCoreCommand([
    "repo","add","TOSS-Soft/toss-console",
    "--from","repository.yaml",
    "--control","./control",
    "--authority","authority.json",
    "--json","--apply","--non-interactive",
  ]);
  assert.deepEqual(command.options,{
    apply:true,
    authority:"authority.json",
    control:"./control",
    cutover:null,
    dryRun:false,
    from:"repository.yaml",
    json:true,
    nonInteractive:true,
  });
  assert.equal(command.readOnly,false);
  assert.equal(command.interactive,false);

  const migration=parseCoreCommand([
    "migrate","rebaseline","--cutover","v2.1.2","--dry-run",
  ]);
  assert.equal(migration.options.cutover,"v2.1.2");
  assert.equal(migration.options.dryRun,true);
  assert.equal(migration.readOnly,true);

  for (const argv of [
    ["repo","add","TOSS-Soft/toss-console","--apply","--dry-run"],
    ["repo","list","--apply"],
    ["repo","list","--cutover","v2.1.2"],
    ["feature","add","Core lifecycle","--cutover","v2.1.2"],
    ["migrate","rebaseline","--cutover"],
    ["migrate","rebaseline","--cutover","v2.1.2","--cutover","v2.1.2"],
  ]) {
    assert.throws(() => parseCoreCommand(argv),/apply|dry-run|option|requires|duplicate/i,argv.join(" "));
  }
});

test("declared later commands stay inside the core boundary and report not implemented",async () => {
  const command=parseCoreCommand(["feature","add","Core lifecycle"]);
  const dispatched=await dispatchCoreCommand(command,{});
  assert.equal(dispatched.exitCode,69);
  assert.deepEqual(dispatched.result,{
    schema_version:"command-result.v1",
    document_type:"command-result",
    ok:false,
    data:null,
    error:{
      code:"COMMAND_NOT_IMPLEMENTED",
      message:"Command is declared but not implemented: feature.add",
    },
  });
});

test("core CLI requires an injected prompt capability for interactive apply",async () => {
  const withoutPrompt=outputStream();
  const rejected=await runCoreCli(
    ["feature","add","Core lifecycle","--apply","--json"],
    {cwd:"/workspace",stdin:Object.freeze({}),stdout:withoutPrompt,stderr:outputStream()},
  );
  assert.equal(rejected,4);
  assert.equal(JSON.parse(withoutPrompt.read()).error.code,"CONFIRMATION_REQUIRED");

  let promptCalls=0;
  const withPrompt=outputStream();
  const confirmed=await runCoreCli(
    ["feature","add","Core lifecycle","--apply","--json"],
    {
      cwd:"/workspace",
      stdin:Object.freeze({}),
      stdout:withPrompt,
      stderr:outputStream(),
      runtimeProvider:async ({command}) => ({
        prompt:async request => {
          promptCalls+=1;
          assert.equal(request.kind,"confirm-apply");
          assert.equal(request.command,command);
          return true;
        },
      }),
    },
  );
  assert.equal(promptCalls,1);
  assert.equal(confirmed,69);
  assert.equal(JSON.parse(withPrompt.read()).error.code,"COMMAND_NOT_IMPLEMENTED");
});
