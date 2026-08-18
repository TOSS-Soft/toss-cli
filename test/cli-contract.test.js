import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";

import {validateDocument} from "../src/contracts/validator.js";
import {completeArtifacts} from "./support/trace-fixture.js";

const routerModule=await import("../src/commands/router.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const outputModule=await import("../src/output/command-result.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});

const unavailable=name => () => {
  throw new Error(`${name} is unavailable`);
};
const parseCommand=routerModule.parseCommand ?? unavailable("parseCommand");
const dispatchCommand=routerModule.dispatchCommand ?? unavailable("dispatchCommand");
const EXIT_CODES=routerModule.EXIT_CODES ?? Object.freeze({});
const SHELL_COMPLETION_WORDS=routerModule.SHELL_COMPLETION_WORDS ?? [];
const successResult=outputModule.successResult ?? unavailable("successResult");
const failureResult=outputModule.failureResult ?? unavailable("failureResult");

const root=path.resolve(new URL("..",import.meta.url).pathname);
const cli=path.join(root,"bin","toss.js");

function runCli(args,{cwd=root,imports=[]}={}) {
  return spawnSync(process.execPath,[
    ...imports.flatMap(file => ["--import",file]),
    cli,
    ...args,
  ],{cwd,encoding:"utf8"});
}

const commandMatrix=[
  {argv:["project","create"],name:"project.create",readOnly:false,interactive:true},
  {argv:["project","analyze"],name:"project.analyze",readOnly:false,interactive:true},
  {argv:["project","prepare"],name:"project.prepare",readOnly:false,interactive:true},
  {argv:["project","status"],name:"project.status",readOnly:true,interactive:false},
  {argv:["project","resume"],name:"project.resume",readOnly:false,interactive:true},
  {argv:["feature","add"],name:"feature.add",readOnly:false,interactive:true},
  {argv:["feature","analyze"],name:"feature.analyze",readOnly:false,interactive:true},
  {argv:["feature","prepare"],name:"feature.prepare",readOnly:false,interactive:true},
  {argv:["feature","status"],name:"feature.status",readOnly:true,interactive:false},
  {argv:["decisions","list"],name:"decisions.list",readOnly:true,interactive:false},
  {argv:["decisions","answer","Q-001"],name:"decisions.answer",readOnly:false,interactive:true},
  {argv:["architecture","review"],name:"architecture.review",readOnly:false,interactive:true},
  {argv:["architecture","approve","ADR-001"],name:"architecture.approve",readOnly:false,interactive:true},
  {argv:["plan","show"],name:"plan.show",readOnly:true,interactive:false},
  {argv:["audit","run"],name:"audit.run",readOnly:false,interactive:false},
  {argv:["readiness","check"],name:"readiness.check",readOnly:true,interactive:false},
  {argv:["issues","preview"],name:"issues.preview",readOnly:true,interactive:false},
  {argv:["issues","publish"],name:"issues.publish",readOnly:true,interactive:true},
  {argv:["issues","publish","--apply"],name:"issues.publish",readOnly:false,interactive:true},
  {argv:["trace","REQ-001"],name:"trace",readOnly:true,interactive:false},
  {argv:["artifacts","list"],name:"artifacts.list",readOnly:true,interactive:false},
  {argv:["artifacts","inspect","ISSUE-PLAN-001"],name:"artifacts.inspect",readOnly:true,interactive:false},
  {argv:["validate","project.json"],name:"validate",readOnly:true,interactive:false},
];

test("parseCommand exposes every issue #27 command with stable safety metadata",() => {
  for (const expected of commandMatrix) {
    const command=parseCommand(expected.argv);
    assert.equal(command.name,expected.name,expected.argv.join(" "));
    assert.equal(command.readOnly,expected.readOnly,expected.argv.join(" "));
    assert.equal(command.interactive,expected.interactive,expected.argv.join(" "));
    assert.equal(Object.isFrozen(command),true);
    assert.equal(Object.isFrozen(command.args),true);
    assert.equal(Object.isFrozen(command.options),true);
  }
});

test("every command accepts exactly its normative option vocabulary",() => {
  const allOptions=[
    "--from","--non-interactive","--json","--continue","--project","--apply",
  ];
  const allowed={
    "project.create":["--from","--non-interactive","--json","--project"],
    "project.analyze":["--from","--non-interactive","--json","--continue","--project"],
    "project.prepare":["--from","--non-interactive","--json","--continue","--project"],
    "project.status":["--json","--project"],
    "project.resume":["--non-interactive","--json","--continue","--project"],
    "feature.add":["--from","--non-interactive","--json","--project"],
    "feature.analyze":["--from","--non-interactive","--json","--continue","--project"],
    "feature.prepare":["--from","--non-interactive","--json","--continue","--project"],
    "feature.status":["--json","--project"],
    "decisions.list":["--json","--project"],
    "decisions.answer":["--from","--non-interactive","--json","--project"],
    "architecture.review":["--non-interactive","--json","--continue","--project"],
    "architecture.approve":["--from","--non-interactive","--json","--project"],
    "plan.show":["--json","--project"],
    "audit.run":["--json","--continue","--project"],
    "readiness.check":["--json","--project"],
    "issues.preview":["--json","--project"],
    "issues.publish":["--from","--non-interactive","--json","--project","--apply"],
    trace:["--json","--project"],
    "artifacts.list":["--json","--project"],
    "artifacts.inspect":["--json","--project"],
    validate:["--json","--project"],
  };
  const baseRows=commandMatrix.filter(row =>
    !(row.name==="issues.publish" && row.argv.includes("--apply")));

  for (const row of baseRows) {
    for (const option of allOptions) {
      const suffix=[option];
      if (option==="--from") suffix.push("input.yaml");
      if (option==="--project") suffix.push("./project");
      if (allowed[row.name].includes(option)) {
        assert.equal(parseCommand([...row.argv,...suffix]).name,row.name);
      } else {
        assert.throws(
          () => parseCommand([...row.argv,...suffix]),
          /invalid option/i,
          `${row.name} ${option}`,
        );
      }
    }
  }
});

test("parseCommand normalizes only the options declared for a command",() => {
  const prepare=parseCommand([
    "project","prepare",
    "--from","brief.yaml",
    "--non-interactive",
    "--json",
    "--project","./demo",
  ]);
  assert.deepEqual(prepare.options,{
    from:"brief.yaml",
    nonInteractive:true,
    json:true,
    continue:false,
    project:"./demo",
    apply:false,
  });
  assert.equal(prepare.interactive,false);

  const resume=parseCommand([
    "project","resume","--continue","--project","./demo",
  ]);
  assert.equal(resume.options.continue,true);
  assert.equal(resume.options.project,"./demo");
  assert.equal(resume.interactive,true);
});

test("parseCommand rejects unknown syntax and invalid option combinations",() => {
  const invalid=[
    ["unknown"],
    ["project","unknown"],
    ["project","prepare","--unknown"],
    ["project","prepare","--apply"],
    ["project","prepare","--continue","--from","brief.yaml"],
    ["project","status","--from","brief.yaml"],
    ["readiness","check","extra"],
    ["trace"],
    ["trace","REQ-001","extra"],
    ["validate"],
    ["validate","a.json","b.json"],
    ["project","prepare","--json","--json"],
    ["project","prepare","--project"],
  ];
  for (const argv of invalid) {
    assert.throws(
      () => parseCommand(argv),
      /unknown|invalid|usage|duplicate|requires|cannot/i,
      argv.join(" "),
    );
  }
});

test("parseCommand rejects non-canonical argv without reading accessors",() => {
  let getterReads=0;
  const accessor=[];
  Object.defineProperty(accessor,"0",{
    enumerable:true,
    get() {
      getterReads+=1;
      return "project";
    },
  });
  accessor.length=1;
  const sparse=[];
  sparse.length=1;
  const symbolic=["project","status"];
  symbolic[Symbol("invalid")]=true;

  for (const argv of [accessor,sparse,symbolic,new Date(),["project",1]]) {
    assert.throws(() => parseCommand(argv),/canonical|array|string|JSON/i);
  }
  assert.equal(getterReads,0);
});

test("parseCommand and command-result builders reject exotic arrays without invoking methods",() => {
  let methodCalls=0;
  const exotic=["project","status"];
  Object.setPrototypeOf(exotic,{
    map() {
      methodCalls+=1;
      return ["readiness","check"];
    },
  });
  const hidden=["project","status"];
  Object.defineProperty(hidden,"0",{value:"project",enumerable:false});

  assert.throws(() => parseCommand(exotic),/canonical|JSON/i);
  assert.throws(() => successResult(exotic),/canonical|JSON/i);
  assert.throws(() => failureResult(exotic),/error|canonical|JSON|plain/i);
  assert.throws(() => parseCommand(hidden),/canonical|JSON/i);
  assert.equal(methodCalls,0);
});

test("command-result builders emit closed canonical frozen envelopes",() => {
  const success=successResult({ready:true,evidence:["PDOR-001"]});
  assert.deepEqual(success,{
    schema_version:"command-result.v1",
    document_type:"command-result",
    ok:true,
    data:{ready:true,evidence:["PDOR-001"]},
    error:null,
  });
  assert.equal(Object.isFrozen(success),true);
  assert.equal(Object.isFrozen(success.data),true);
  assert.equal(Object.isFrozen(success.data.evidence),true);
  assert.deepEqual(validateDocument(success,"command-result.v1"),{
    valid:true,
    errors:[],
  });

  const failure=failureResult({code:"READINESS_BLOCKED",message:"Audit failed"});
  assert.deepEqual(failure,{
    schema_version:"command-result.v1",
    document_type:"command-result",
    ok:false,
    data:null,
    error:{code:"READINESS_BLOCKED",message:"Audit failed"},
  });
  assert.deepEqual(validateDocument(failure,"command-result.v1"),{
    valid:true,
    errors:[],
  });

  assert.equal(validateDocument({...success,extra:true},"command-result.v1").valid,false);
  assert.equal(validateDocument({
    ...failure,
    error:{...failure.error,extra:true},
  },"command-result.v1").valid,false);
});

test("command-result builders reject exotic, accessor, and open values",() => {
  let getterReads=0;
  const accessor={};
  Object.defineProperty(accessor,"value",{
    enumerable:true,
    get() {
      getterReads+=1;
      return "forged";
    },
  });
  const inherited=Object.create({code:"INHERITED",message:"forged"});
  const exotic=Object.assign(Object.create({forged:true}),{
    code:"EXOTIC",
    message:"forged",
  });
  const openError={code:"OPEN",message:"open",extra:true};

  for (const data of [undefined,new Date(),accessor,{value:Symbol("invalid")}]) {
    assert.throws(() => successResult(data),/canonical|JSON|unsupported|plain/i);
  }
  for (const error of [inherited,exotic,openError,accessor]) {
    assert.throws(() => failureResult(error),/error|canonical|property|plain/i);
  }
  assert.equal(getterReads,0);
});

test("failureResult trusts native Errors but rejects proxies without observable traps",() => {
  let getterReads=0;
  const native=new Error("native failure");
  native.code="NATIVE_FAILURE";
  native.exitCode=EXIT_CODES.BLOCKED;
  Object.defineProperty(native,"stack",{
    configurable:true,
    get() {
      getterReads+=1;
      return "forged stack";
    },
  });
  const accepted=failureResult(native);
  assert.deepEqual(accepted.error,{
    code:"NATIVE_FAILURE",
    message:"native failure",
  });

  const trapCounts={getPrototypeOf:0,ownKeys:0,getOwnPropertyDescriptor:0,get:0};
  const stackAccessor={code:"STACK_ACCESSOR",message:"forged"};
  Object.defineProperty(stackAccessor,"stack",{
    enumerable:true,
    get() {
      getterReads+=1;
      return "forged stack";
    },
  });
  const cooperative=new Proxy({
    name:"Error",
    code:"PROXY",
    message:"forged",
    stack:"forged stack",
    cause:null,
    exitCode:EXIT_CODES.BLOCKED,
  },{
    getPrototypeOf(target) {
      trapCounts.getPrototypeOf+=1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      trapCounts.ownKeys+=1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target,key) {
      trapCounts.getOwnPropertyDescriptor+=1;
      return Reflect.getOwnPropertyDescriptor(target,key);
    },
    get(target,key,receiver) {
      trapCounts.get+=1;
      return Reflect.get(target,key,receiver);
    },
  });
  const throwing=new Proxy({},{
    getPrototypeOf() {
      trapCounts.getPrototypeOf+=1;
      throw new Error("prototype trap");
    },
    ownKeys() {
      trapCounts.ownKeys+=1;
      throw new Error("keys trap");
    },
    getOwnPropertyDescriptor() {
      trapCounts.getOwnPropertyDescriptor+=1;
      throw new Error("descriptor trap");
    },
    get() {
      trapCounts.get+=1;
      throw new Error("get trap");
    },
  });

  assert.throws(() => failureResult(stackAccessor),/command error|canonical|accessor/i);
  assert.throws(() => failureResult(cooperative),/proxy|command error/i);
  assert.throws(() => failureResult(throwing),/proxy|command error/i);
  assert.throws(() => failureResult({
    code:cooperative,
    message:"nested proxy",
  }),/command error|canonical|string/i);
  const nativeWithProxyCode=new Error("native with invalid code");
  nativeWithProxyCode.code=cooperative;
  assert.throws(
    () => failureResult(nativeWithProxyCode),
    /command error|metadata|string/i,
  );
  assert.deepEqual(trapCounts,{
    getPrototypeOf:0,
    ownKeys:0,
    getOwnPropertyDescriptor:0,
    get:0,
  });
  assert.equal(getterReads,0);
});

test("dispatchCommand fails safely for declared commands without handlers",async () => {
  const command=parseCommand(["readiness","check","--json"]);
  const dispatched=await dispatchCommand(command,{});

  assert.equal(dispatched.exitCode,EXIT_CODES.NOT_IMPLEMENTED);
  assert.equal(dispatched.result.schema_version,"command-result.v1");
  assert.equal(dispatched.result.ok,false);
  assert.equal(dispatched.result.error.code,"COMMAND_NOT_IMPLEMENTED");
  assert.equal(Object.isFrozen(dispatched),true);
});

test("dispatchCommand invokes only an explicit own data-function handler",async () => {
  const command=parseCommand(["readiness","check"]);
  const handled=await dispatchCommand(command,{
    handlers:{
      "readiness.check":async received => ({
        command:received.name,
        ready:true,
      }),
    },
  });
  assert.equal(handled.exitCode,EXIT_CODES.SUCCESS);
  assert.deepEqual(handled.result.data,{command:"readiness.check",ready:true});

  let getterReads=0;
  const handlers={};
  Object.defineProperty(handlers,"readiness.check",{
    enumerable:true,
    get() {
      getterReads+=1;
      return async () => ({ready:true});
    },
  });
  await assert.rejects(
    dispatchCommand(command,{handlers}),
    /handler|accessor|data-function/i,
  );
  assert.equal(getterReads,0);
});

test("dispatchCommand ignores inherited context injection without invoking getters",async t => {
  const command=parseCommand(["readiness","check"]);
  const originalHandlers=Object.getOwnPropertyDescriptor(Object.prototype,"handlers");
  const originalServices=Object.getOwnPropertyDescriptor(Object.prototype,"services");
  t.after(() => {
    if (originalHandlers) Object.defineProperty(Object.prototype,"handlers",originalHandlers);
    else delete Object.prototype.handlers;
    if (originalServices) Object.defineProperty(Object.prototype,"services",originalServices);
    else delete Object.prototype.services;
  });

  let inheritedHandlerCalls=0;
  Object.defineProperty(Object.prototype,"handlers",{
    configurable:true,
    enumerable:false,
    value:{
      "readiness.check":async () => {
        inheritedHandlerCalls+=1;
        return {ready:true};
      },
    },
  });
  let dispatched=await dispatchCommand(command,{});
  assert.equal(dispatched.exitCode,EXIT_CODES.NOT_IMPLEMENTED);
  assert.equal(inheritedHandlerCalls,0);

  let inheritedHandlerReads=0;
  Object.defineProperty(Object.prototype,"handlers",{
    configurable:true,
    enumerable:false,
    get() {
      inheritedHandlerReads+=1;
      return {"readiness.check":async () => ({ready:true})};
    },
  });
  dispatched=await dispatchCommand(command,{});
  assert.equal(dispatched.exitCode,EXIT_CODES.NOT_IMPLEMENTED);
  assert.equal(inheritedHandlerReads,0);

  let inheritedServiceReads=0;
  Object.defineProperty(Object.prototype,"services",{
    configurable:true,
    enumerable:false,
    get() {
      inheritedServiceReads+=1;
      return {forged:true};
    },
  });
  dispatched=await dispatchCommand(command,{
    handlers:{
      "readiness.check":async (_command,services) => ({
        serviceWasAbsent:services===undefined,
      }),
    },
  });
  assert.equal(dispatched.exitCode,EXIT_CODES.SUCCESS);
  assert.deepEqual(dispatched.result.data,{serviceWasAbsent:true});
  assert.equal(inheritedServiceReads,0);
});

test("dispatchCommand rejects open or exotic own context maps without reading accessors",async () => {
  const command=parseCommand(["readiness","check"]);
  let getterReads=0;
  const accessorContext={};
  Object.defineProperty(accessorContext,"handlers",{
    enumerable:true,
    get() {
      getterReads+=1;
      return {};
    },
  });
  const nonEnumerableContext={};
  Object.defineProperty(nonEnumerableContext,"services",{
    enumerable:false,
    value:{},
  });
  const symbolicContext={[Symbol("handlers")]:{}};
  const extraContext={extra:true};
  const symbolicHandlers={};
  symbolicHandlers[Symbol("readiness.check")]=async () => ({ready:true});
  const hiddenHandlers={};
  Object.defineProperty(hiddenHandlers,"readiness.check",{
    enumerable:false,
    value:async () => ({ready:true}),
  });

  for (const context of [
    accessorContext,nonEnumerableContext,symbolicContext,extraContext,
    {handlers:symbolicHandlers},{handlers:hiddenHandlers},
    {handlers:{extra:async () => ({})}},
  ]) {
    await assert.rejects(
      dispatchCommand(command,context),
      /context|accessor|non-enumerable|symbol|unknown/i,
    );
  }
  assert.equal(getterReads,0);
});

test("dispatchCommand rejects accessor services and closes exotic handler failures",async () => {
  const command=parseCommand(["readiness","check"]);
  let getterReads=0;
  const services={};
  Object.defineProperty(services,"readiness",{
    enumerable:true,
    get() {
      getterReads+=1;
      return {};
    },
  });
  await assert.rejects(dispatchCommand(command,{services}),/service|accessor/i);

  const thrown={};
  Object.defineProperty(thrown,"message",{
    enumerable:true,
    get() {
      getterReads+=1;
      return "forged";
    },
  });
  const dispatched=await dispatchCommand(command,{
    handlers:{
      "readiness.check":async () => {
        throw thrown;
      },
    },
  });
  assert.equal(dispatched.exitCode,EXIT_CODES.INTERNAL);
  assert.equal(dispatched.result.ok,false);
  assert.deepEqual(dispatched.result.error,{
    code:"COMMAND_FAILED",
    message:"Command handler failed with an unsupported error",
  });
  assert.equal(getterReads,0);
});

test("dispatchCommand defaults every non-Error failure without inspecting proxy traps",async () => {
  const command=parseCommand(["readiness","check"]);
  let accessorReads=0;
  const stackAccessor={code:"FORGED",message:"forged"};
  Object.defineProperty(stackAccessor,"stack",{
    enumerable:true,
    get() {
      accessorReads+=1;
      return "forged stack";
    },
  });
  const exotic=Object.assign(Object.create({trusted:true}),{
    code:"TRACE_ENTITY_NOT_FOUND",
    message:"forged",
  });
  const trapCounts={getPrototypeOf:0,ownKeys:0,getOwnPropertyDescriptor:0,get:0};
  const cooperative=new Proxy({
    name:"Error",
    code:"TRACE_ENTITY_NOT_FOUND",
    message:"forged",
    stack:"forged stack",
    cause:null,
    exitCode:EXIT_CODES.INVALID_INPUT,
  },{
    getPrototypeOf(target) {
      trapCounts.getPrototypeOf+=1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      trapCounts.ownKeys+=1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target,key) {
      trapCounts.getOwnPropertyDescriptor+=1;
      return Reflect.getOwnPropertyDescriptor(target,key);
    },
    get(target,key,receiver) {
      trapCounts.get+=1;
      return Reflect.get(target,key,receiver);
    },
  });
  const throwing=new Proxy({},{
    getPrototypeOf() {
      trapCounts.getPrototypeOf+=1;
      throw new Error("prototype trap");
    },
    ownKeys() {
      trapCounts.ownKeys+=1;
      throw new Error("keys trap");
    },
    getOwnPropertyDescriptor() {
      trapCounts.getOwnPropertyDescriptor+=1;
      throw new Error("descriptor trap");
    },
    get() {
      trapCounts.get+=1;
      throw new Error("get trap");
    },
  });
  const failures=[
    {code:"TRACE_ENTITY_NOT_FOUND",message:"forged"},
    {code:"FORGED",message:"forged",exitCode:EXIT_CODES.BLOCKED},
    exotic,
    stackAccessor,
    cooperative,
    throwing,
  ];

  for (const failure of failures) {
    const dispatched=await dispatchCommand(command,{
      handlers:{"readiness.check":async () => { throw failure; }},
    });
    assert.equal(dispatched.exitCode,EXIT_CODES.INTERNAL);
    assert.deepEqual(dispatched.result.error,{
      code:"COMMAND_FAILED",
      message:"Command handler failed with an unsupported error",
    });
    assert.deepEqual(validateDocument(dispatched.result,"command-result.v1"),{
      valid:true,
      errors:[],
    });
  }
  assert.equal(accessorReads,0);
  assert.deepEqual(trapCounts,{
    getPrototypeOf:0,
    ownKeys:0,
    getOwnPropertyDescriptor:0,
    get:0,
  });
});

test("dispatchCommand retains safe native Error code and exit metadata",async () => {
  const command=parseCommand(["readiness","check"]);
  let stackReads=0;
  const failure=new Error("blocked by a trusted native error");
  failure.code="READINESS_BLOCKED";
  failure.exitCode=EXIT_CODES.BLOCKED;
  Object.defineProperty(failure,"stack",{
    configurable:true,
    get() {
      stackReads+=1;
      return "forged stack";
    },
  });

  const dispatched=await dispatchCommand(command,{
    handlers:{"readiness.check":async () => { throw failure; }},
  });
  assert.equal(dispatched.exitCode,EXIT_CODES.BLOCKED);
  assert.deepEqual(dispatched.result.error,{
    code:"READINESS_BLOCKED",
    message:"blocked by a trusted native error",
  });
  assert.equal(stackReads,0);
});

test("dispatchCommand wraps trace-result.v1 without changing its raw shape",async () => {
  const command=parseCommand(["trace","REQ-001","--json"]);
  const dispatched=await dispatchCommand(command,{artifacts:completeArtifacts()});

  assert.equal(dispatched.exitCode,EXIT_CODES.SUCCESS);
  assert.equal(dispatched.result.schema_version,"command-result.v1");
  assert.equal(dispatched.result.data.schema_version,"trace-result.v1");
  assert.equal(dispatched.result.data.document_type,"trace-result");
  assert.equal(Object.hasOwn(dispatched.result.data,"data"),false);
});

test("dispatchCommand closes ambiguous trace inputs before tracing",async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"toss-trace-ambiguous-"));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const missing=path.join(directory,"must-not-be-created");
  const command=parseCommand(["trace","REQ-001","--project",missing]);
  let storeReads=0;
  let artifactReads=0;
  const artifacts=new Proxy(completeArtifacts(),{
    getPrototypeOf(target) {
      artifactReads+=1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      artifactReads+=1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target,key) {
      artifactReads+=1;
      return Reflect.getOwnPropertyDescriptor(target,key);
    },
    get(target,key,receiver) {
      artifactReads+=1;
      return Reflect.get(target,key,receiver);
    },
  });
  const store={};
  Object.defineProperty(store,"list",{
    enumerable:true,
    get() {
      storeReads+=1;
      return async () => [];
    },
  });
  const dispatched=await dispatchCommand(command,{
    artifacts,
    artifactStore:store,
  });
  assert.equal(dispatched.exitCode,EXIT_CODES.INVALID_INPUT);
  assert.equal(dispatched.result.error.code,"TRACE_INPUT_AMBIGUOUS");
  assert.equal(Object.isFrozen(dispatched),true);
  assert.deepEqual(validateDocument(dispatched.result,"command-result.v1"),{
    valid:true,
    errors:[],
  });
  assert.equal(storeReads,0);
  assert.equal(artifactReads,0);
  assert.equal(fs.existsSync(missing),false);
});

test("trace dispatch requires one explicit source and never creates a fallback project",async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"toss-trace-source-"));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const missing=path.join(directory,"must-not-be-created");
  const command=parseCommand(["trace","REQ-001","--project",missing]);

  const dispatched=await dispatchCommand(command,{});
  assert.equal(dispatched.exitCode,EXIT_CODES.INVALID_INPUT);
  assert.equal(dispatched.result.ok,false);
  assert.equal(fs.existsSync(missing),false);
  assert.deepEqual(validateDocument(dispatched.result,"command-result.v1"),{
    valid:true,
    errors:[],
  });
});

test("trace dispatch maps stable input and store categories to documented exit codes",async () => {
  const missingEntity=await dispatchCommand(
    parseCommand(["trace","REQ-MISSING"]),
    {artifacts:completeArtifacts()},
  );
  assert.equal(missingEntity.exitCode,EXIT_CODES.INVALID_INPUT);
  assert.equal(missingEntity.result.error.code,"TRACE_ENTITY_NOT_FOUND");

  const missingInput=await dispatchCommand(
    parseCommand(["trace","REQ-001"]),
    {artifacts:[]},
  );
  assert.equal(missingInput.exitCode,EXIT_CODES.INVALID_INPUT);

  const invalidStore=await dispatchCommand(
    parseCommand(["trace","REQ-001"]),
    {artifactStore:{list:async () => ({})}},
  );
  assert.equal(invalidStore.exitCode,EXIT_CODES.VALIDATION_FAILED);
  assert.equal(invalidStore.result.error.code,"TRACE_STORE_INVALID");

  for (const dispatched of [missingEntity,missingInput,invalidStore]) {
    assert.deepEqual(validateDocument(dispatched.result,"command-result.v1"),{
      valid:true,
      errors:[],
    });
  }
});

test("every declared future command dispatches to the safe unavailable result",async () => {
  for (const row of commandMatrix) {
    if (row.name==="trace" || row.argv.includes("--apply")) continue;
    const dispatched=await dispatchCommand(parseCommand(row.argv),{});
    assert.equal(dispatched.exitCode,EXIT_CODES.NOT_IMPLEMENTED,row.name);
    assert.equal(dispatched.result.error.code,"COMMAND_NOT_IMPLEMENTED",row.name);
  }
});

test("CLI help exposes the lifecycle tree and shell-completion vocabulary",() => {
  const result=runCli(["--help"]);
  assert.equal(result.status,0,result.stderr);
  for (const line of [
    "project <create|analyze|prepare|status|resume>",
    "feature <add|analyze|prepare|status>",
    "decisions <list|answer>",
    "architecture <review|approve>",
    "plan show",
    "audit run",
    "readiness check",
    "issues <preview|publish>",
    "trace <ENTITY-ID>",
    "artifacts <list|inspect>",
    "validate <FILE>",
  ]) assert.match(result.stdout,new RegExp(line.replace(/[|<>]/g,"\\$&")),line);

  for (const word of [
    "project","feature","decisions","architecture","plan","audit",
    "readiness","issues","trace","artifacts","validate","--from",
    "--non-interactive","--json","--continue","--project","--apply",
  ]) assert.ok(SHELL_COMPLETION_WORDS.includes(word),word);
});

test("CLI usage failures are deterministic and JSON failures use stdout",() => {
  const unknown=runCli(["unknown"]);
  assert.equal(unknown.status,EXIT_CODES.USAGE);
  assert.match(unknown.stderr,/unknown command/i);
  assert.equal(unknown.stdout,"");

  const invalid=runCli(["project","prepare","--apply"]);
  assert.equal(invalid.status,EXIT_CODES.USAGE);
  assert.match(invalid.stderr,/invalid option/i);

  const unknownHelp=runCli(["project","unknown","--help"]);
  assert.equal(unknownHelp.status,EXIT_CODES.USAGE);
  assert.match(unknownHelp.stderr,/unknown command/i);

  const unavailable=runCli(["readiness","check","--json"]);
  assert.equal(unavailable.status,EXIT_CODES.NOT_IMPLEMENTED);
  assert.equal(unavailable.stderr,"");
  const result=JSON.parse(unavailable.stdout);
  assert.equal(result.schema_version,"command-result.v1");
  assert.equal(result.ok,false);
  assert.equal(result.error.code,"COMMAND_NOT_IMPLEMENTED");
});

test("CLI help and version accept only exact valid paths",() => {
  for (const args of [
    ["--help"],
    ["-h"],
    ["--version"],
    ["-v"],
    ["project","create","--help"],
    ["trace","--help"],
    ["validate","--help"],
  ]) {
    const result=runCli(args);
    assert.equal(result.status,EXIT_CODES.SUCCESS,`${args.join(" ")}: ${result.stderr}`);
  }
  for (const args of [
    ["unknown","--help"],
    ["project","--help"],
    ["--help","--unknown"],
    ["--version","--unknown"],
  ]) {
    const result=runCli(args);
    assert.equal(result.status,EXIT_CODES.USAGE,args.join(" "));
    assert.match(result.stderr,/unknown|usage|invalid/i,args.join(" "));
  }
});

test("unimplemented lifecycle routing does not eagerly load Ajv",t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"toss-cli-loader-"));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const loader=path.join(directory,"deny-ajv-loader.mjs");
  const register=path.join(directory,"register-loader.mjs");
  fs.writeFileSync(loader,`
export async function resolve(specifier,context,nextResolve) {
  if (specifier === "ajv" || specifier.startsWith("ajv/")) {
    throw new Error("Ajv was loaded eagerly");
  }
  return nextResolve(specifier,context);
}
`,"utf8");
  fs.writeFileSync(register,`
import {register} from "node:module";
register(${JSON.stringify(new URL(`file://${loader}`).href)});
`,"utf8");

  const result=runCli(["readiness","check","--json"],{imports:[register]});
  assert.equal(result.status,EXIT_CODES.NOT_IMPLEMENTED,result.stderr);
  assert.equal(JSON.parse(result.stdout).schema_version,"command-result.v1");
});

test("legacy init and explicit fast scaffold remain routed unchanged",t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"toss-cli-legacy-"));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));

  const brief=path.join(directory,"legacy-brief.yaml");
  const initialized=runCli(["init",brief],{cwd:directory});
  assert.equal(initialized.status,0,initialized.stderr);
  assert.equal(fs.existsSync(brief),true);

  const destination=path.join(directory,"legacy-contract-project");
  const scaffold=runCli([
    "Legacy Contract Project",
    "--slug","legacy-contract-project",
    "--dir",destination,
    "--no-git",
  ],{cwd:directory});
  assert.equal(scaffold.status,0,scaffold.stderr);
  assert.match(scaffold.stdout,/PROJECT BOOTSTRAP COMPLETE/);
  assert.equal(fs.existsSync(path.join(destination,"project.json")),true);
});

test("legacy fast scaffold keeps nonalphabetic names and explicit scaffold options",t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"toss-cli-fast-legacy-"));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));

  const hyphenated=runCli(["my-project"],{cwd:directory});
  assert.equal(hyphenated.status,EXIT_CODES.SUCCESS,hyphenated.stderr);
  assert.equal(fs.existsSync(path.join(directory,"my-project","project.json")),true);

  const destination=path.join(directory,"project-scaffold");
  const explicit=runCli([
    "project","--slug","project-scaffold","--dir",destination,"--no-git",
  ],{cwd:directory});
  assert.equal(explicit.status,EXIT_CODES.SUCCESS,explicit.stderr);
  assert.equal(fs.existsSync(path.join(destination,"project.json")),true);

  const lifecycle=runCli(["project","status"],{cwd:directory});
  assert.equal(lifecycle.status,EXIT_CODES.NOT_IMPLEMENTED,lifecycle.stderr);
  assert.equal(fs.existsSync(path.join(directory,"project","project.json")),false);
});
