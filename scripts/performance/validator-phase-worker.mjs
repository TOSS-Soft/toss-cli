import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {performance} from "node:perf_hooks";

const MODE=process.argv[2];
const MODES=new Set([
  "empty-process","cli-module","representative-command",
  "eager-reference","demand-driven","standalone-experiment",
]);
const PHASES=[
  "process_ms","module_ms","schema_io_ms","dependency_discovery_ms",
  "ajv_creation_ms","schema_registration_ms","compilation_ms",
  "first_validation_ms","command_ms","total_ms",
];
const started=performance.now();
const durations=Object.fromEntries(PHASES.map(phase => [phase,0]));
const active=new Map();
const seen=new Set();
const SUCCESS={
  schema_version:"command-result.v1",
  document_type:"command-result",
  ok:true,
  data:{ready:true},
  error:null,
};
const INVALID={...SUCCESS,extra:true};

function canonical(value) {
  if (value===null || typeof value!=="object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function timed(phase,operation) {
  const phaseStart=performance.now();
  const result=operation();
  const elapsed=performance.now()-phaseStart;
  if (!Number.isFinite(elapsed) || elapsed<0) throw new Error(`Invalid ${phase} timing`);
  durations[phase]+=elapsed;
  return result;
}

async function timedAsync(phase,operation) {
  const phaseStart=performance.now();
  const result=await operation();
  const elapsed=performance.now()-phaseStart;
  if (!Number.isFinite(elapsed) || elapsed<0) throw new Error(`Invalid ${phase} timing`);
  durations[phase]+=elapsed;
  return result;
}

function observe(event) {
  if (!event || typeof event!=="object" ||
      !["start","end"].includes(event.state) || !PHASES.includes(`${event.phase}_ms`)) {
    throw new Error("Malformed validator phase event");
  }
  const phase=`${event.phase}_ms`;
  if (event.state==="start") {
    if (active.has(phase)) throw new Error(`Duplicate validator phase start: ${phase}`);
    active.set(phase,{
      started:performance.now(),
      schema_id:event.schema_id,
      schema_uri:event.schema_uri,
    });
    seen.add(phase);
    return;
  }
  const phaseStart=active.get(phase);
  if (phaseStart===undefined) throw new Error(`Unpaired validator phase end: ${phase}`);
  if (phaseStart.schema_id!==event.schema_id || phaseStart.schema_uri!==event.schema_uri) {
    throw new Error(`Inverted validator phase evidence: ${phase}`);
  }
  const elapsed=performance.now()-phaseStart.started;
  if (!Number.isFinite(elapsed) || elapsed<0) throw new Error(`Invalid ${phase} evidence`);
  durations[phase]+=elapsed;
  active.delete(phase);
}

function ensureObserverClosed(required=[]) {
  if (active.size!==0) {
    throw new Error(`Missing validator phase end: ${[...active.keys()].join(",")}`);
  }
  const missing=required.filter(phase => !seen.has(`${phase}_ms`));
  if (missing.length>0) {
    throw new Error(`Missing validator phase evidence: ${missing.join(",")}`);
  }
}

function isLeapYear(year) {
  return year%4===0 && (year%100!==0 || year%400===0);
}

function daysInMonth(year,month) {
  if (month===2) return isLeapYear(year) ? 29 : 28;
  return [4,6,9,11].includes(month) ? 30 : 31;
}

const RFC3339_DATE_TIME=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isRfc3339DateTime(value) {
  if (typeof value!=="string") return false;
  const match=RFC3339_DATE_TIME.exec(value);
  if (!match) return false;
  const [,yearText,monthText,dayText,hourText,minuteText,secondText,
    offsetHourText,offsetMinuteText]=match;
  const year=Number(yearText);
  const month=Number(monthText);
  const day=Number(dayText);
  const hour=Number(hourText);
  const minute=Number(minuteText);
  const second=Number(secondText);
  if (month<1 || month>12 || day<1 || day>daysInMonth(year,month) ||
      hour>23 || minute>59 || second>59) return false;
  return offsetHourText===undefined ||
    (Number(offsetHourText)<=23 && Number(offsetMinuteText)<=59);
}

function addDateFormat(ajv) {
  ajv.addFormat("rfc3339-date-time",{type:"string",validate:isRfc3339DateTime});
  return ajv;
}

function normalizedStandalone(validate,value) {
  const document=JSON.parse(canonical(value));
  const valid=Boolean(validate(document));
  return {
    valid,
    errors:valid ? [] : JSON.parse(canonical(validate.errors ?? [])),
  };
}

function resultHash(validateDocument) {
  return digest(canonical([
    validateDocument(SUCCESS),
    validateDocument(INVALID),
  ]));
}

async function moduleImports(imports) {
  return timedAsync("module_ms",() => Promise.all(imports.map(url => import(url))));
}

async function run() {
  const diagnostics={};
  if (MODE==="empty-process") return diagnostics;

  if (MODE==="cli-module") {
    await timedAsync("module_ms",() => import("../../src/commands/router.js"));
    return diagnostics;
  }

  if (MODE==="representative-command") {
    const [router,fixture,validator]=await moduleImports([
      new URL("../../src/commands/router.js",import.meta.url),
      new URL("../../test/support/gate-command-round1-fixture.js",import.meta.url),
      new URL("../../src/contracts/validator.js",import.meta.url),
    ]);
    await timedAsync("command_ms",async () => {
      const {store}=await fixture.prepareStore(fixture.projectCommandInput());
      const command=router.parseCommand(["architecture","review","--json"]);
      const dispatched=await router.dispatchCommand(command,{
        services:{artifactStore:store},
      });
      if (dispatched.exitCode!==0) throw new Error("Representative command failed");
      const checked=validator.validateDocument(dispatched.result,"command-result.v1");
      if (!checked.valid) throw new Error("Representative command returned an invalid envelope");
    });
    return diagnostics;
  }

  if (MODE==="eager-reference") {
    const [{createEagerContractValidator}]=await moduleImports([
      new URL("../../test/support/eager-contract-validator.mjs",import.meta.url),
    ]);
    const validator=createEagerContractValidator({observe});
    diagnostics.result_sha256=resultHash(value =>
      validator.validateDocument(value,"command-result.v1"));
    ensureObserverClosed([
      "ajv_creation","schema_io","schema_registration","compilation","first_validation",
    ]);
    return diagnostics;
  }

  if (MODE==="demand-driven") {
    const [runtimeModule,catalogModule,ajvModule]=await moduleImports([
      new URL("../../src/contracts/validator-runtime.js",import.meta.url),
      new URL("../../src/contracts/schema-catalog.js",import.meta.url),
      "ajv/dist/2020.js",
    ]);
    const Ajv2020=ajvModule.default;
    const validatorUrl=new URL("../../src/contracts/validator.js",import.meta.url);
    const validator=runtimeModule.createValidatorRuntime({
      catalog:catalogModule.CONTRACT_SCHEMA_CATALOG,
      readSchema:row => JSON.parse(readFileSync(
        new URL(row.relativePath,validatorUrl),"utf8",
      )),
      createAjv:() => addDateFormat(new Ajv2020({
        allErrors:true,strict:true,validateFormats:true,
      })),
      observe,
    });
    diagnostics.result_sha256=resultHash(value =>
      validator.validateDocument(value,"command-result.v1"));
    ensureObserverClosed([
      "schema_io","dependency_discovery","ajv_creation","schema_registration",
      "compilation","first_validation",
    ]);
    return diagnostics;
  }

  const [catalogModule,ajvModule,standaloneModule]=await moduleImports([
    new URL("../../src/contracts/schema-catalog.js",import.meta.url),
    "ajv/dist/2020.js",
    "ajv/dist/standalone/index.js",
  ]);
  const row=catalogModule.CONTRACT_SCHEMA_CATALOG.find(
    candidate => candidate.schemaId==="command-result.v1",
  );
  if (!row) throw new Error("command-result.v1 is absent from the catalog");
  const validatorUrl=new URL("../../src/contracts/validator.js",import.meta.url);
  const schemaSource=timed("schema_io_ms",() =>
    readFileSync(new URL(row.relativePath,validatorUrl),"utf8"));
  const schema=JSON.parse(schemaSource);
  const Ajv2020=ajvModule.default;
  const ajv=timed("ajv_creation_ms",() => addDateFormat(new Ajv2020({
    allErrors:true,
    strict:true,
    validateFormats:true,
    code:{source:true},
  })));
  const validate=timed("compilation_ms",() => ajv.compile(schema));
  const source=timed("compilation_ms",() => standaloneModule.default(ajv,validate));
  const commonjs={exports:{}};
  const require=createRequire(import.meta.url);
  timed("compilation_ms",() => {
    Function("module","exports","require",source)(commonjs,commonjs.exports,require);
  });
  const standaloneValidate=commonjs.exports;
  if (typeof standaloneValidate!=="function") {
    throw new Error("Standalone source did not evaluate to a validator");
  }
  let hash;
  timed("first_validation_ms",() => {
    hash=resultHash(value => normalizedStandalone(standaloneValidate,value));
  });
  diagnostics.result_sha256=hash;
  diagnostics.standalone_source_sha256=digest(source);
  diagnostics.standalone_source_bytes=Buffer.byteLength(source);
  diagnostics.input_schema_sha256=digest(schemaSource);
  return diagnostics;
}

if (process.argv.length!==3 || !MODES.has(MODE)) {
  process.stderr.write("validator phase worker requires exactly one supported mode\n");
  process.exitCode=2;
} else {
  run().then(diagnostics => {
    ensureObserverClosed();
    durations.total_ms=performance.now()-started;
    const record={mode:MODE,exit_status:0,...durations,...diagnostics};
    process.stdout.write(canonical(record));
  }).catch(error => {
    let usage;
    try {
      usage=process.resourceUsage();
    } catch {
      usage={unavailable:true};
    }
    process.stderr.write(`${error.message}\n${canonical({resource_usage:usage})}\n`);
    process.exitCode=5;
  });
}
