import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchCoreCommand,
  parseCoreCommand,
} from "../src/core/commands/router.js";
import {runCoreCli} from "../src/core/cli.js";

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

function cliOptions(runtimeProvider) {
  const stdout=outputStream();
  const stderr=outputStream();
  return {
    options:{
      cwd:"/workspace",
      stdin:Object.freeze({}),
      stdout,
      stderr,
      ...(runtimeProvider===undefined ? {} : {runtimeProvider}),
    },
    stdout,
    stderr,
  };
}

const commandMatrix=Object.freeze([
  {tokens:["init"],name:"init",arity:[0,0],mutation:true},
  {tokens:["repo","add"],name:"repo.add",arity:[1,1],mutation:true,values:["TOSS-Soft/toss-console"]},
  {tokens:["repo","list"],name:"repo.list",arity:[0,0],mutation:false},
  {tokens:["feature","add"],name:"feature.add",arity:[1,1],mutation:true,values:["Core lifecycle"]},
  {tokens:["feature","status"],name:"feature.status",arity:[1,1],mutation:false,values:["FEATURE-001"]},
  {tokens:["epic","prepare"],name:"epic.prepare",arity:[1,1],mutation:true,values:["EPIC-001"]},
  {tokens:["epic","status"],name:"epic.status",arity:[1,1],mutation:false,values:["EPIC-001"]},
  {tokens:["epic","approve"],name:"epic.approve",arity:[1,1],mutation:true,values:["EPIC-001"]},
  {tokens:["epic","submit"],name:"epic.submit",arity:[1,1],mutation:true,values:["EPIC-001"]},
  {tokens:["epic","accept"],name:"epic.accept",arity:[1,1],mutation:true,values:["EPIC-001"]},
  {tokens:["issue","add"],name:"issue.add",arity:[1,1],mutation:true,values:["Bug report"]},
  {tokens:["issue","start"],name:"issue.start",arity:[1,1],mutation:true,values:["ISSUE-001"]},
  {tokens:["issue","submit"],name:"issue.submit",arity:[1,1],mutation:true,values:["ISSUE-001"]},
  {tokens:["issue","status"],name:"issue.status",arity:[1,1],mutation:false,values:["ISSUE-001"]},
  {tokens:["dependency","add"],name:"dependency.add",arity:[2,2],mutation:true,values:["ISSUE-001","ISSUE-002"]},
  {tokens:["dependency","remove"],name:"dependency.remove",arity:[2,2],mutation:true,values:["ISSUE-001","ISSUE-002"]},
  {tokens:["dependency","graph"],name:"dependency.graph",arity:[0,1],mutation:false,values:["ISSUE-001"]},
  {tokens:["dependency","check"],name:"dependency.check",arity:[0,1],mutation:false,values:["ISSUE-001"]},
  {tokens:["review","record"],name:"review.record",arity:[1,1],mutation:true,values:["PR-001"]},
  {tokens:["review","status"],name:"review.status",arity:[1,1],mutation:false,values:["PR-001"]},
  {tokens:["release","plan"],name:"release.plan",arity:[0,0],mutation:true},
  {tokens:["release","activate"],name:"release.activate",arity:[1,2],mutation:true,values:["v2.2.0","TOSS-OS-R0001"]},
  {tokens:["release","status"],name:"release.status",arity:[1,1],mutation:false,values:["v2.2.0"]},
  {tokens:["release","approve"],name:"release.approve",arity:[1,1],mutation:true,values:["v2.2.0"]},
  {tokens:["program","status"],name:"program.status",arity:[0,1],mutation:false,values:["TOSS-OS-R0001"]},
  {tokens:["sync"],name:"sync",arity:[0,1],mutation:true,values:["TOSS-OS-R0001"]},
  {tokens:["audit"],name:"audit",arity:[0,1],mutation:false,values:["TOSS-OS-R0001"]},
  {tokens:["doctor"],name:"doctor",arity:[0,0],mutation:false},
  {
    tokens:["migrate","rebaseline"],
    name:"migrate.rebaseline",
    arity:[0,0],
    mutation:true,
    requiredOptions:["--cutover","v2.1.2"],
  },
]);

function argvFor(row,count=row.arity[0],extra=[]) {
  return [
    ...row.tokens,
    ...(row.values ?? []).slice(0,count),
    ...(row.requiredOptions ?? []),
    ...extra,
  ];
}

test("core parser closes every declared command at its minimum, maximum, and overflow arity",() => {
  for (const row of commandMatrix) {
    const minimum=parseCoreCommand(argvFor(row,row.arity[0]));
    assert.equal(minimum.name,row.name,row.name+" minimum");
    assert.equal(minimum.args.length,row.arity[0],row.name+" minimum arity");

    const maximum=parseCoreCommand(argvFor(row,row.arity[1]));
    assert.equal(maximum.name,row.name,row.name+" maximum");
    assert.equal(maximum.args.length,row.arity[1],row.name+" maximum arity");

    if (row.arity[0]>0) {
      assert.throws(
        () => parseCoreCommand(argvFor(row,row.arity[0]-1)),
        /argument/i,
        row.name+" rejects missing required arguments",
      );
    }
    assert.throws(
      () => parseCoreCommand(argvFor(row,row.arity[1],["overflow"])),
      /argument/i,
      row.name+" rejects overflowing arguments",
    );
  }
});

test("migration rebaseline requires a nonblank cutover option while retaining zero positional arguments",() => {
  assert.throws(
    () => parseCoreCommand(["migrate","rebaseline"]),
    /cutover/i,
  );
  assert.throws(
    () => parseCoreCommand(["migrate","rebaseline","--cutover",""]),
    /cutover|requires/i,
  );
  const migration=parseCoreCommand([
    "migrate","rebaseline","--cutover","v2.1.2","--dry-run",
  ]);
  assert.deepEqual(migration.args,[]);
  assert.equal(migration.options.cutover,"v2.1.2");
  assert.equal(migration.options.dryRun,true);
});

const optionCases=Object.freeze([
  {
    flag:"--apply",property:"apply",value:true,
    allowed:["repo","add","TOSS-Soft/toss-console"],
    rejected:["repo","list"],
  },
  {
    flag:"--authority",property:"authority",value:"authority.json",
    allowed:["repo","add","TOSS-Soft/toss-console"],
    rejected:["repo","list"],
  },
  {
    flag:"--control",property:"control",value:"./control",
    allowed:["repo","list"],
  },
  {
    flag:"--cutover",property:"cutover",value:"v2.1.2",
    allowed:["migrate","rebaseline"],
    rejected:["repo","add","TOSS-Soft/toss-console"],
  },
  {
    flag:"--dry-run",property:"dryRun",value:true,
    allowed:["repo","add","TOSS-Soft/toss-console"],
    rejected:["repo","list"],
  },
  {
    flag:"--from",property:"from",value:"input.yaml",
    allowed:["repo","add","TOSS-Soft/toss-console"],
    rejected:["repo","list"],
  },
  {
    flag:"--json",property:"json",value:true,
    allowed:["repo","list"],
  },
  {
    flag:"--non-interactive",property:"nonInteractive",value:true,
    allowed:["repo","add","TOSS-Soft/toss-console"],
    rejected:["repo","list"],
  },
]);

test("core parser normalizes every common option and rejects unsafe option contexts",() => {
  for (const row of optionCases) {
    const suffix=row.value===true ? [row.flag] : [row.flag,row.value];
    const command=parseCoreCommand([...row.allowed,...suffix]);
    assert.equal(command.options[row.property],row.value,row.flag+" normalized");

    if (row.value!==true) {
      assert.throws(
        () => parseCoreCommand([...row.allowed,row.flag]),
        /requires/i,
        row.flag+" requires a value",
      );
    }
    const duplicate=row.value===true ?
      [...row.allowed,row.flag,row.flag] :
      [...row.allowed,row.flag,row.value,row.flag,row.value];
    assert.throws(
      () => parseCoreCommand(duplicate),
      /duplicate/i,
      row.flag+" rejects duplicates",
    );
    if (row.rejected) {
      assert.throws(
        () => parseCoreCommand([...row.rejected,...suffix]),
        /invalid option/i,
        row.flag+" rejects its disallowed command context",
      );
    }
  }

  assert.throws(
    () => parseCoreCommand(["repo","add","TOSS-Soft/toss-console","--unknown"]),
    /invalid option/i,
  );
  assert.throws(
    () => parseCoreCommand([
      "repo","add","TOSS-Soft/toss-console","--apply","--dry-run",
    ]),
    /apply.*dry-run/i,
  );
});

test("core parser derives preview, apply, and interactivity safety for mutations and reads",() => {
  for (const row of commandMatrix) {
    const preview=parseCoreCommand(argvFor(row));
    if (!row.mutation) {
      assert.equal(preview.readOnly,true,row.name+" is read-only");
      assert.equal(preview.interactive,false,row.name+" is never interactive");
      continue;
    }
    assert.equal(preview.readOnly,true,row.name+" previews by default");
    assert.equal(preview.interactive,true,row.name+" default is interactive");

    const applied=parseCoreCommand(argvFor(row,row.arity[0],["--apply"]));
    assert.equal(applied.readOnly,false,row.name+" apply can mutate");
    assert.equal(applied.interactive,true,row.name+" interactive apply remains interactive");

    const automated=parseCoreCommand(
      argvFor(row,row.arity[0],["--apply","--non-interactive"]),
    );
    assert.equal(automated.readOnly,false,row.name+" automation can mutate");
    assert.equal(automated.interactive,false,row.name+" automation is not interactive");
  }
});

test("every declared later command returns the stable not-implemented result",async () => {
  const laterCommands=commandMatrix.filter(row =>
    !["init","repo.add","repo.list"].includes(row.name));
  for (const row of laterCommands) {
    const dispatched=await dispatchCoreCommand(parseCoreCommand(argvFor(row)),{});
    assert.equal(dispatched.exitCode,69,row.name);
    assert.equal(dispatched.result.schema_version,"command-result.v1",row.name);
    assert.equal(dispatched.result.ok,false,row.name);
    assert.equal(dispatched.result.error.code,"COMMAND_NOT_IMPLEMENTED",row.name);
  }
});

test("core CLI renders usage and internal failures to the correct stream for human and JSON callers",async () => {
  for (const example of [
    {argv:["unknown"],exitCode:2,code:"COMMAND_USAGE",json:false},
    {argv:["unknown","--json"],exitCode:2,code:"COMMAND_USAGE",json:true},
    {
      argv:["feature","add","Core lifecycle"],
      exitCode:70,
      code:"COMMAND_FAILED",
      json:false,
      runtimeProvider:async () => null,
    },
    {
      argv:["feature","add","Core lifecycle","--json"],
      exitCode:70,
      code:"COMMAND_FAILED",
      json:true,
      runtimeProvider:async () => null,
    },
  ]) {
    const {options,stdout,stderr}=cliOptions(example.runtimeProvider);
    const exitCode=await runCoreCli(example.argv,options);
    assert.equal(exitCode,example.exitCode,example.argv.join(" "));
    const selected=example.json ? stdout.read() : stderr.read();
    const unselected=example.json ? stderr.read() : stdout.read();
    assert.notEqual(selected,"",example.argv.join(" "));
    assert.equal(unselected,"",example.argv.join(" "));
    const result=example.json ? JSON.parse(selected) : null;
    if (result) assert.equal(result.error.code,example.code,example.argv.join(" "));
    else assert.match(selected,/unknown|runtime provider/i,example.argv.join(" "));
  }
});

test("core CLI reserves exact confirmation for implemented interactive applies",async () => {
  const missing=cliOptions();
  assert.equal(await runCoreCli(["feature","add","Core lifecycle","--apply","--json"],missing.options),69);
  assert.equal(JSON.parse(missing.stdout.read()).error.code,"COMMAND_NOT_IMPLEMENTED");

  const rejected=cliOptions(async () => ({prompt:async () => false}));
  assert.equal(
    await runCoreCli(["feature","add","Core lifecycle","--apply","--json"],rejected.options),
    69,
  );
  assert.equal(JSON.parse(rejected.stdout.read()).error.code,"COMMAND_NOT_IMPLEMENTED");

  let confirmations=0;
  const accepted=cliOptions(async ({command}) => ({
    prompt:async request => {
      confirmations+=1;
      assert.equal(request.kind,"confirm-apply");
      assert.equal(request.command,command);
      return true;
    },
  }));
  assert.equal(
    await runCoreCli(["feature","add","Core lifecycle","--apply","--json"],accepted.options),
    69,
  );
  assert.equal(confirmations,0);
  assert.equal(JSON.parse(accepted.stdout.read()).error.code,"COMMAND_NOT_IMPLEMENTED");

  const automated=cliOptions();
  assert.equal(
    await runCoreCli([
      "feature","add","Core lifecycle","--apply","--non-interactive","--json",
    ],automated.options),
    69,
  );
  assert.equal(JSON.parse(automated.stdout.read()).error.code,"COMMAND_NOT_IMPLEMENTED");
});
