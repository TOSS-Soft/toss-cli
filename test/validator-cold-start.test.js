import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {
  VALIDATOR_PHASES,
  VALIDATOR_REPORT_VERSION,
  VALIDATOR_STRATEGIES,
  canonicalValidatorColdStartJson,
  createValidatorColdStartReport,
  selectValidatorStrategy,
  validateValidatorColdStartReport,
} from "../scripts/performance/validator-report.mjs";
import {
  CONTRACT_SCHEMA_CATALOG,
  validateContractSchemaCatalog,
} from "../src/contracts/schema-catalog.js";
import {createValidatorRuntime} from "../src/contracts/validator-runtime.js";

const validatorModuleUrl=new URL("../src/contracts/validator.js",import.meta.url).href;

function runFreshValidatorProbe(body) {
  return spawnSync(process.execPath,[
    "--input-type=module",
    "--eval",
    `
      import {createRequire} from "node:module";
      const require=createRequire(import.meta.url);
      const ajvIsCached=() => Object.keys(require.cache).some(cachedPath =>
        cachedPath.replaceAll("\\\\","/").includes("/node_modules/ajv/"));
      const validator=await import(${JSON.stringify(validatorModuleUrl)});
      const publicExports=Object.keys(validator).sort();
      if (JSON.stringify(publicExports)!==JSON.stringify([
        "createContractValidator","validateDocument",
      ])) throw new Error("Unexpected validator exports: "+publicExports.join(", "));
      ${body}
    `,
  ],{encoding:"utf8"});
}

test("public validator import and factory construction leave Ajv cold until validation",() => {
  const cold=runFreshValidatorProbe(`
    if (ajvIsCached()) throw new Error("Ajv loaded during validator import");
    validator.createContractValidator();
    if (ajvIsCached()) throw new Error("Ajv loaded during validator factory construction");
  `);
  assert.equal(cold.status,0,cold.stderr || cold.stdout);

  const firstValidation=runFreshValidatorProbe(`
    if (ajvIsCached()) throw new Error("Ajv loaded before validation");
    validator.validateDocument({},"command-result.v1");
    if (!ajvIsCached()) throw new Error("Ajv did not load during validation");
  `);
  assert.equal(firstValidation.status,0,firstValidation.stderr || firstValidation.stdout);
});

const BASE_CATALOG=[
  {
    schemaId:"alpha.v1",
    uri:"https://toss.software/schemas/common/alpha.v1.schema.json",
    relativePath:"../../contracts/common/alpha.schema.json",
  },
  {
    schemaId:"beta.v1",
    uri:"https://toss.software/schemas/design/beta.v1.schema.json",
    relativePath:"../../contracts/design/beta.schema.json",
  },
];

function validCatalog() {
  return BASE_CATALOG.map(row => ({...row}));
}

test("the contract catalog is closed, complete, sorted, unique, and immutable",async () => {
  assert.equal(CONTRACT_SCHEMA_CATALOG.length,37);
  assert.deepEqual(
    CONTRACT_SCHEMA_CATALOG.map(row => row.schemaId),
    [...CONTRACT_SCHEMA_CATALOG.map(row => row.schemaId)].sort(),
  );
  assert.equal(new Set(CONTRACT_SCHEMA_CATALOG.map(row => row.schemaId)).size,37);
  assert.equal(new Set(CONTRACT_SCHEMA_CATALOG.map(row => row.uri)).size,37);
  assert.equal(new Set(CONTRACT_SCHEMA_CATALOG.map(row => row.relativePath)).size,37);
  assert.equal(Object.isFrozen(CONTRACT_SCHEMA_CATALOG),true);
  assert.ok(CONTRACT_SCHEMA_CATALOG.every(Object.isFrozen));
  for (const row of CONTRACT_SCHEMA_CATALOG) {
    assert.deepEqual(Object.keys(row),["schemaId","uri","relativePath"]);
    const validatorUrl=new URL("../src/contracts/validator.js",import.meta.url);
    const schema=JSON.parse(await readFile(
      new URL(row.relativePath,validatorUrl),"utf8",
    ));
    assert.equal(schema.$id,row.uri,row.schemaId);
  }
});

test("the validator cold-start owner appears exactly once in fast",async () => {
  const manifest=JSON.parse(await readFile(
    new URL("../scripts/test-manifest.json",import.meta.url),"utf8",
  ));
  const owners=Object.entries(manifest.lanes)
    .filter(([,entries]) => entries.includes("test/validator-cold-start.test.js"))
    .map(([lane]) => lane);
  assert.deepEqual(owners,["fast"]);
  assert.equal(manifest.concurrency,1);
});

const rejectionCases=[
  {
    name:"an extra field",
    catalog:() => {
      const catalog=validCatalog();
      catalog[0].extra=true;
      return catalog;
    },
    expected:/contract schema catalog.*row.*exactly.*schemaId.*uri.*relativePath/i,
  },
  {
    name:"a missing field",
    catalog:() => {
      const catalog=validCatalog();
      delete catalog[0].uri;
      return catalog;
    },
    expected:/contract schema catalog.*row.*exactly.*schemaId.*uri.*relativePath/i,
  },
  {
    name:"a duplicate ID",
    catalog:() => {
      const catalog=validCatalog();
      catalog[1].schemaId=catalog[0].schemaId;
      return catalog;
    },
    expected:/contract schema catalog.*duplicate schemaId/i,
  },
  {
    name:"a duplicate URI",
    catalog:() => {
      const catalog=validCatalog();
      catalog[1].uri=catalog[0].uri;
      return catalog;
    },
    expected:/contract schema catalog.*duplicate uri/i,
  },
  {
    name:"a duplicate path",
    catalog:() => {
      const catalog=validCatalog();
      catalog[1].relativePath=catalog[0].relativePath;
      return catalog;
    },
    expected:/contract schema catalog.*duplicate relativePath/i,
  },
  {
    name:"unsorted rows",
    catalog:() => validCatalog().reverse(),
    expected:/contract schema catalog.*stable ASCII order/i,
  },
  {
    name:"a symbol field",
    catalog:() => {
      const catalog=validCatalog();
      catalog[0][Symbol("extra")]=true;
      return catalog;
    },
    expected:/contract schema catalog.*row.*exactly.*schemaId.*uri.*relativePath/i,
  },
  {
    name:"an accessor field",
    catalog:() => {
      const catalog=validCatalog();
      Object.defineProperty(catalog[0],"uri",{
        enumerable:true,
        get() {
          throw new Error("accessor was invoked");
        },
      });
      return catalog;
    },
    expected:/contract schema catalog.*row.*own enumerable data properties/i,
  },
  {
    name:"a non-enumerable field",
    catalog:() => {
      const catalog=validCatalog();
      Object.defineProperty(catalog[0],"uri",{
        value:catalog[0].uri,
        enumerable:false,
        writable:true,
        configurable:true,
      });
      return catalog;
    },
    expected:/contract schema catalog.*row.*own enumerable data properties/i,
  },
  {
    name:"an exotic prototype",
    catalog:() => {
      const catalog=validCatalog();
      catalog[0]=Object.assign(Object.create(null),catalog[0]);
      return catalog;
    },
    expected:/contract schema catalog.*row.*plain JSON record/i,
  },
  {
    name:"a non-string field",
    catalog:() => {
      const catalog=validCatalog();
      catalog[0].schemaId=1;
      return catalog;
    },
    expected:/contract schema catalog.*schemaId.*string/i,
  },
  {
    name:"an http URI",
    catalog:() => {
      const catalog=validCatalog();
      catalog[0].uri="http://toss.software/schemas/common/alpha.v1.schema.json";
      return catalog;
    },
    expected:/contract schema catalog.*canonical HTTPS toss\.software URI/i,
  },
  {
    name:"a URI with another host",
    catalog:() => {
      const catalog=validCatalog();
      catalog[0].uri="https://example.com/schemas/common/alpha.v1.schema.json";
      return catalog;
    },
    expected:/contract schema catalog.*canonical HTTPS toss\.software URI/i,
  },
  {
    name:"a URI fragment",
    catalog:() => {
      const catalog=validCatalog();
      catalog[0].uri+="#fragment";
      return catalog;
    },
    expected:/contract schema catalog.*canonical HTTPS toss\.software URI/i,
  },
  {
    name:"a URI query",
    catalog:() => {
      const catalog=validCatalog();
      catalog[0].uri+="?query=value";
      return catalog;
    },
    expected:/contract schema catalog.*canonical HTTPS toss\.software URI/i,
  },
  {
    name:"a backslash path",
    catalog:() => {
      const catalog=validCatalog();
      catalog[0].relativePath="..\\..\\contracts\\common\\alpha.schema.json";
      return catalog;
    },
    expected:/contract schema catalog.*safe repository-relative path/i,
  },
  {
    name:"a NUL path",
    catalog:() => {
      const catalog=validCatalog();
      catalog[0].relativePath="../../contracts/common/alpha\0.schema.json";
      return catalog;
    },
    expected:/contract schema catalog.*safe repository-relative path/i,
  },
  {
    name:"a path outside a contract family",
    catalog:() => {
      const catalog=validCatalog();
      catalog[0].relativePath="../../contracts/private/alpha.schema.json";
      return catalog;
    },
    expected:/contract schema catalog.*safe repository-relative path/i,
  },
];

for (const {name,catalog,expected} of rejectionCases) {
  test(`contract catalog rejects ${name}`,() => {
    assert.throws(() => validateContractSchemaCatalog(catalog()),expected);
  });
}

test("contract catalog normalizes to a detached frozen copy",() => {
  const source=validCatalog();
  const normalized=validateContractSchemaCatalog(source);
  source[0].schemaId="changed.v1";
  assert.deepEqual(normalized,BASE_CATALOG);
  assert.equal(Object.isFrozen(normalized),true);
  assert.ok(normalized.every(Object.isFrozen));
});

test("contract catalog rejects a sparse array directly",() => {
  const catalog=validCatalog();
  delete catalog[0];
  assert.throws(
    () => validateContractSchemaCatalog(catalog),
    /contract schema catalog.*dense plain array/i,
  );
});

const pipelineUri=schemaId =>
  `https://toss.software/schemas/pipeline/${schemaId}.schema.json`;

function pipelineRow(schemaId) {
  return {
    schemaId,
    uri:pipelineUri(schemaId),
    relativePath:`../../contracts/pipeline/${schemaId}.schema.json`,
  };
}

function countedDependencies(calls,options={}) {
  const catalog=["b.v1","c.v1","d.v1","root.v1"].map(pipelineRow);
  const schemas={
    "b.v1":{$id:pipelineUri("b.v1"),$ref:`${pipelineUri("d.v1")}#/$defs/item`},
    "c.v1":{
      $id:pipelineUri("c.v1"),
      allOf:[{$ref:pipelineUri("d.v1")},{$ref:pipelineUri("d.v1")}],
    },
    "d.v1":{$id:pipelineUri("d.v1"),$ref:`${pipelineUri("root.v1")}#/$defs/local`},
    "root.v1":{
      $id:pipelineUri("root.v1"),
      allOf:[
        {$ref:`${pipelineUri("b.v1")}#/$defs/item`},
        {$ref:pipelineUri("c.v1")},
        {$ref:"#/$defs/local"},
      ],
      $defs:{local:{type:"object"}},
    },
    ...options.schemas,
  };
  const schemaIdsByUri=new Map(catalog.map(row => [row.uri,row.schemaId]));
  const sharedErrors=options.errors ?? [{
    instancePath:"/kind",
    schemaPath:"#/properties/kind/const",
    keyword:"const",
    params:{allowedValue:"ok",nested:{values:["ok"]}},
    message:"must be equal to constant",
  }];

  return {
    catalog,
    readSchema:row => {
      calls.read.push(row.schemaId);
      if (options.readSchema) return options.readSchema(row,schemas);
      return structuredClone(schemas[row.schemaId]);
    },
    createAjv:() => {
      calls.createAjv+=1;
      if (options.createAjv) return options.createAjv({schemaIdsByUri,sharedErrors});
      return {
        addSchema(schema) {
          calls.add.push(schemaIdsByUri.get(schema.$id));
          options.addSchema?.(schema);
        },
        getSchema(uri) {
          calls.compile.push(uri);
          if (options.getSchema) return options.getSchema(uri,sharedErrors);
          const validate=value => {
            options.onValidate?.(value);
            const valid=value.kind==="ok";
            validate.errors=valid ? null : sharedErrors;
            return valid;
          };
          return validate;
        },
      };
    },
    ...(options.observe ? {observe:options.observe} : {}),
  };
}

function emptyCalls() {
  return {read:[],createAjv:0,add:[],compile:[]};
}

test("the runtime is cold until a known schema is requested",() => {
  const calls=emptyCalls();
  const runtime=createValidatorRuntime(countedDependencies(calls));
  assert.equal(Object.isFrozen(runtime),true);
  assert.deepEqual(Object.keys(runtime),["validateDocument"]);
  assert.deepEqual(calls,emptyCalls());
  assert.throws(
    () => runtime.validateDocument({},"unknown.v1"),
    /Unknown contract schema: unknown\.v1/,
  );
  assert.deepEqual(calls,emptyCalls());
});

test("runtime construction validates its closed dependencies without doing work",() => {
  const calls=emptyCalls();
  const base=countedDependencies(calls);
  for (const key of ["readSchema","createAjv"]) {
    assert.throws(
      () => createValidatorRuntime({...base,[key]:null}),
      /validator runtime dependencies must be functions/,
    );
  }
  assert.throws(
    () => createValidatorRuntime({...base,observe:null}),
    /validator runtime dependencies must be functions/,
  );
  assert.deepEqual(calls,emptyCalls());
});

test("a four-file closure is loaded once, registered dependency-first, and cached",() => {
  const calls=emptyCalls();
  const runtime=createValidatorRuntime(countedDependencies(calls));
  assert.equal(runtime.validateDocument({kind:"ok"},"root.v1").valid,true);
  assert.deepEqual(calls.read,["root.v1","b.v1","d.v1","c.v1"]);
  assert.deepEqual(calls.add,["d.v1","b.v1","c.v1","root.v1"]);
  assert.deepEqual(calls.compile,[pipelineUri("root.v1")]);
  const after=structuredClone(calls);
  runtime.validateDocument({kind:"ok"},"root.v1");
  assert.deepEqual(calls,after);
});

test("an independent schema reads and registers only itself",() => {
  const calls=emptyCalls();
  const row=pipelineRow("command-result.v1");
  const runtime=createValidatorRuntime({
    catalog:[row],
    readSchema:readRow => {
      calls.read.push(readRow.schemaId);
      return {$id:readRow.uri,type:"object"};
    },
    createAjv:() => {
      calls.createAjv+=1;
      return {
        addSchema(schema) {
          calls.add.push(schema.$id);
        },
        getSchema(uri) {
          calls.compile.push(uri);
          return () => true;
        },
      };
    },
  });
  assert.deepEqual(runtime.validateDocument({},row.schemaId),{valid:true,errors:[]});
  assert.deepEqual(calls.read,[row.schemaId]);
  assert.deepEqual(calls.add,[row.uri]);
  assert.deepEqual(calls.compile,[row.uri]);
});

test("a second requested root reuses its loaded and registered dependency",() => {
  const calls=emptyCalls();
  const runtime=createValidatorRuntime(countedDependencies(calls));
  runtime.validateDocument({kind:"ok"},"root.v1");
  calls.read.length=0;
  calls.add.length=0;
  calls.compile.length=0;
  runtime.validateDocument({kind:"ok"},"c.v1");
  assert.deepEqual(calls.read,[]);
  assert.deepEqual(calls.add,[]);
  assert.deepEqual(calls.compile,[pipelineUri("c.v1")]);
});

test("external fragments are stripped only for lookup and local refs stay local",() => {
  const calls=emptyCalls();
  const runtime=createValidatorRuntime(countedDependencies(calls));
  runtime.validateDocument({kind:"ok"},"root.v1");
  assert.deepEqual(calls.read,["root.v1","b.v1","d.v1","c.v1"]);
  assert.ok(calls.compile.every(uri => !uri.includes("#")));
  assert.equal(calls.read.includes(undefined),false);
});

test("validation canonicalizes input and returns fresh deeply copied errors",() => {
  const calls=emptyCalls();
  const values=[];
  const runtime=createValidatorRuntime(countedDependencies(calls,{onValidate:value => values.push(value)}));
  const input={z:2,kind:"bad",a:{b:1}};
  const first=runtime.validateDocument(input,"root.v1");
  input.a.b=9;
  assert.deepEqual(values[0],{a:{b:1},kind:"bad",z:2});
  assert.notEqual(values[0],input);
  assert.equal(first.valid,false);
  first.errors[0].params.nested.values[0]="mutated";
  first.errors.push({message:"caller-added"});
  const second=runtime.validateDocument({kind:"bad"},"root.v1");
  assert.deepEqual(second.errors,[{
    instancePath:"/kind",
    schemaPath:"#/properties/kind/const",
    keyword:"const",
    params:{allowedValue:"ok",nested:{values:["ok"]}},
    message:"must be equal to constant",
  }]);
  assert.notEqual(first.errors,second.errors);
  assert.notEqual(first.errors[0].params,second.errors[0].params);
});

test("canonical JSON rejection retains the public validation shape",() => {
  const calls=emptyCalls();
  const runtime=createValidatorRuntime(countedDependencies(calls));
  assert.deepEqual(runtime.validateDocument({missing:undefined},"root.v1"),{
    valid:false,
    errors:[{
      instancePath:"",
      schemaPath:"#",
      keyword:"canonical-json",
      params:{},
      message:"Non-JSON value at $.missing: unsupported undefined",
    }],
  });
});

test("observer events are frozen closed pairs and first validation is observed once",() => {
  const calls=emptyCalls();
  const events=[];
  const runtime=createValidatorRuntime(countedDependencies(calls,{
    observe:event => events.push(event),
  }));
  runtime.validateDocument({kind:"ok"},"root.v1");
  runtime.validateDocument({kind:"ok"},"root.v1");
  assert.ok(events.every(Object.isFrozen));
  assert.ok(events.every(event => Object.keys(event).every(key =>
    ["phase","state","schema_id","schema_uri"].includes(key))));
  assert.ok(events.every(event => ["start","end"].includes(event.state)));
  for (const phase of [
    "schema_io","dependency_discovery","ajv_creation","schema_registration",
    "compilation","first_validation",
  ]) {
    assert.equal(events.filter(event => event.phase===phase && event.state==="start").length,
      events.filter(event => event.phase===phase && event.state==="end").length);
  }
  assert.equal(events.filter(event => event.phase==="first_validation").length,2);
  const ajvEvents=events.filter(event => event.phase==="ajv_creation");
  assert.deepEqual(ajvEvents,[
    {phase:"ajv_creation",state:"start"},
    {phase:"ajv_creation",state:"end"},
  ]);
  for (const event of events.filter(event => event.schema_id!==undefined)) {
    assert.equal(event.schema_uri,pipelineUri(event.schema_id));
  }
});

test("a throwing end observer cannot replace the wrapped operation failure",() => {
  const calls=emptyCalls();
  const operationError=new Error("schema read failed");
  const observerError=new Error("observer end failed");
  let readAttempts=0;
  let endAttempts=0;
  const runtime=createValidatorRuntime(countedDependencies(calls,{
    readSchema:() => {
      readAttempts+=1;
      throw operationError;
    },
    observe:event => {
      if (event.phase==="schema_io" && event.state==="end") {
        endAttempts+=1;
        throw observerError;
      }
    },
  }));
  assert.throws(
    () => runtime.validateDocument({},"root.v1"),
    error => error===operationError,
  );
  assert.equal(readAttempts,1);
  assert.equal(endAttempts,1);
});

test("a throwing start observer still attempts end without running the operation",() => {
  const calls=emptyCalls();
  const startError=new Error("observer start failed");
  const endError=new Error("observer end failed");
  let readAttempts=0;
  let endAttempts=0;
  const runtime=createValidatorRuntime(countedDependencies(calls,{
    readSchema:() => {
      readAttempts+=1;
      return {$id:pipelineUri("root.v1")};
    },
    observe:event => {
      if (event.phase!=="schema_io") return;
      if (event.state==="start") throw startError;
      endAttempts+=1;
      throw endError;
    },
  }));
  assert.throws(
    () => runtime.validateDocument({},"root.v1"),
    error => error===startError,
  );
  assert.equal(readAttempts,0);
  assert.equal(endAttempts,1);
});

test("a throwing end observer fails closed after a successful operation",() => {
  const calls=emptyCalls();
  const observerError=new Error("observer end failed");
  let readAttempts=0;
  const runtime=createValidatorRuntime(countedDependencies(calls,{
    readSchema:(row,schemas) => {
      readAttempts+=1;
      return structuredClone(schemas[row.schemaId]);
    },
    observe:event => {
      if (event.phase==="schema_io" && event.state==="end") throw observerError;
    },
  }));
  assert.throws(
    () => runtime.validateDocument({},"root.v1"),
    error => error===observerError,
  );
  assert.equal(readAttempts,1);
});

test("schema reads and dependency discovery fail closed",() => {
  const cases=[
    {
      name:"malformed JSON",
      configure:{readSchema:() => { throw new SyntaxError("Unexpected token }"); }},
      expected:/Unexpected token }/,
    },
    {
      name:"non-record root",
      configure:{readSchema:() => []},
      expected:/schema root.*plain JSON record/i,
    },
    {
      name:"missing id",
      configure:{readSchema:() => ({type:"object"})},
      expected:/schema.*\$id.*missing/i,
    },
    {
      name:"id drift",
      configure:{readSchema:() => ({$id:pipelineUri("b.v1")})},
      expected:/schema.*\$id.*root\.v1/i,
    },
    {
      name:"unresolved external URI",
      configure:{schemas:{"root.v1":{
        $id:pipelineUri("root.v1"),
        $ref:"https://toss.software/schemas/pipeline/missing.v1.schema.json",
      }}},
      expected:/unresolved.*schema reference/i,
    },
    {
      name:"invalid ref value",
      configure:{schemas:{"root.v1":{$id:pipelineUri("root.v1"),$ref:7}}},
      expected:/\$ref.*string/i,
    },
    {
      name:"ref query",
      configure:{schemas:{"root.v1":{
        $id:pipelineUri("root.v1"),$ref:`${pipelineUri("b.v1")}?x=1`,
      }}},
      expected:/schema reference.*query/i,
    },
    {
      name:"unsupported ref scheme",
      configure:{schemas:{"root.v1":{
        $id:pipelineUri("root.v1"),$ref:"file:///tmp/schema.json",
      }}},
      expected:/schema reference.*scheme/i,
    },
  ];
  for (const {name,configure,expected} of cases) {
    const calls=emptyCalls();
    const runtime=createValidatorRuntime(countedDependencies(calls,configure));
    assert.throws(() => runtime.validateDocument({},"root.v1"),expected,name);
    assert.equal(calls.createAjv,0,name);
  }
});

test("unsafe schema JSON is rejected without invoking properties",() => {
  let accessorInvoked=false;
  const unsafeSchemas=[
    new Date(),
    {$id:pipelineUri("root.v1"),items:[,{}]},
    Object.assign({$id:pipelineUri("root.v1")},{nested:new Map()}),
    (() => {
      const schema={$id:pipelineUri("root.v1")};
      schema[Symbol("unsafe")]=true;
      return schema;
    })(),
    (() => {
      const schema={$id:pipelineUri("root.v1")};
      Object.defineProperty(schema,"hidden",{value:true,enumerable:false});
      return schema;
    })(),
    (() => {
      const schema={$id:pipelineUri("root.v1")};
      Object.defineProperty(schema,"unsafe",{
        enumerable:true,
        get() {
          accessorInvoked=true;
          return true;
        },
      });
      return schema;
    })(),
  ];
  for (const schema of unsafeSchemas) {
    const calls=emptyCalls();
    const runtime=createValidatorRuntime(countedDependencies(calls,{
      readSchema:row => row.schemaId==="root.v1" ? schema : null,
    }));
    assert.throws(
      () => runtime.validateDocument({},"root.v1"),
      /contract schema.*(?:plain JSON record|unsafe JSON)/i,
    );
  }
  assert.equal(accessorInvoked,false);
});

test("Ajv creation, registration, compilation, and validation failures propagate",() => {
  const cases=[
    {
      name:"creation",
      configure:{createAjv:() => { throw new Error("create failed"); }},
      expected:/create failed/,
    },
    {
      name:"registration",
      configure:{addSchema:() => { throw new Error("add failed"); }},
      expected:/add failed/,
    },
    {
      name:"missing compiled function",
      configure:{getSchema:() => undefined},
      expected:/Contract schema failed to compile: root\.v1/,
    },
    {
      name:"compile throw",
      configure:{getSchema:() => { throw new Error("compile failed"); }},
      expected:/compile failed/,
    },
    {
      name:"validation throw",
      configure:{getSchema:() => () => { throw new Error("validation failed"); }},
      expected:/validation failed/,
    },
  ];
  for (const {name,configure,expected} of cases) {
    const calls=emptyCalls();
    const runtime=createValidatorRuntime(countedDependencies(calls,configure));
    assert.throws(() => runtime.validateDocument({},"root.v1"),expected,name);
  }
});

test("failed registration and compilation are retried without false cache success",() => {
  const registrationCalls=emptyCalls();
  let addAttempts=0;
  const registrationRuntime=createValidatorRuntime(countedDependencies(registrationCalls,{
    addSchema:() => {
      addAttempts+=1;
      if (addAttempts===1) throw new Error("first add failed");
    },
  }));
  assert.throws(
    () => registrationRuntime.validateDocument({kind:"ok"},"root.v1"),
    /first add failed/,
  );
  assert.equal(registrationRuntime.validateDocument({kind:"ok"},"root.v1").valid,true);
  assert.equal(addAttempts,5);

  const compileCalls=emptyCalls();
  let compileAttempts=0;
  const compileRuntime=createValidatorRuntime(countedDependencies(compileCalls,{
    getSchema:() => {
      compileAttempts+=1;
      if (compileAttempts===1) return undefined;
      return () => true;
    },
  }));
  assert.throws(
    () => compileRuntime.validateDocument({},"root.v1"),
    /Contract schema failed to compile: root\.v1/,
  );
  assert.deepEqual(compileRuntime.validateDocument({},"root.v1"),{valid:true,errors:[]});
  assert.equal(compileAttempts,2);
  assert.deepEqual(compileCalls.compile,[pipelineUri("root.v1"),pipelineUri("root.v1")]);
});

const VALIDATOR_REPORT_IDENTITY={
  commit:"0123456789abcdef0123456789abcdef01234567",
  node_version:"v26.6.0",
  platform:"darwin",
  arch:"arm64",
  lock_sha256:"a".repeat(64),
  runner_id:"fixture",
};

function validatorSample(offset=0) {
  return {
    exit_status:0,
    process_ms:1+offset,
    module_ms:2+offset,
    schema_io_ms:3+offset,
    dependency_discovery_ms:4+offset,
    ajv_creation_ms:5+offset,
    schema_registration_ms:6+offset,
    compilation_ms:7+offset,
    first_validation_ms:8+offset,
    command_ms:9+offset,
    total_ms:20+offset,
  };
}

function validatorSamples() {
  return [validatorSample(20),validatorSample(0),validatorSample(10)];
}

const VALIDATOR_PHASE_MEDIANS={
  process_ms:11,
  module_ms:12,
  schema_io_ms:13,
  dependency_discovery_ms:14,
  ajv_creation_ms:15,
  schema_registration_ms:16,
  compilation_ms:17,
  first_validation_ms:18,
  command_ms:19,
  total_ms:30,
};

function validatorReportInput() {
  return {
    identity:{...VALIDATOR_REPORT_IDENTITY},
    probes:{
      empty_process:{
        samples:validatorSamples(),
        medians:{...VALIDATOR_PHASE_MEDIANS,total_ms:999},
      },
      cli_module:{samples:validatorSamples()},
      representative_command:{samples:validatorSamples()},
    },
    strategies:VALIDATOR_STRATEGIES.map(name => ({name,samples:validatorSamples()})),
    focused_gate_cli:{
      base_commit:"2caf811f521ee1c1664104a68ea35512fc87fdc8",
      before_samples_ms:[32581.98975,32685.560625,32656.405041],
      before_median_ms:1,
      after_samples_ms:[8100,8000,8200],
      after_median_ms:2,
      improvement_percent:3,
    },
    evidence:{
      standalone_deterministic:true,
      standalone_drift_verified:false,
      standalone_equivalent:true,
      standalone_focused_samples_ms:null,
    },
  };
}

test("validator report constants close the phases and strategy ordering",() => {
  assert.equal(VALIDATOR_REPORT_VERSION,"toss-validator-cold-start-report.v1");
  assert.deepEqual(VALIDATOR_STRATEGIES,[
    "demand-driven","eager-reference","standalone-experiment",
  ]);
  assert.deepEqual(VALIDATOR_PHASES,[
    "process_ms","module_ms","schema_io_ms","dependency_discovery_ms",
    "ajv_creation_ms","schema_registration_ms","compilation_ms",
    "first_validation_ms","command_ms","total_ms",
  ]);
  assert.equal(Object.isFrozen(VALIDATOR_STRATEGIES),true);
  assert.equal(Object.isFrozen(VALIDATOR_PHASES),true);
});

test("validator report derives exact medians, focused arithmetic, and the conservative decision",() => {
  const report=createValidatorColdStartReport(validatorReportInput());
  assert.equal(report.schema_version,VALIDATOR_REPORT_VERSION);
  assert.deepEqual(Object.keys(report.identity),[
    "commit","node_version","platform","arch","lock_sha256","runner_id",
  ]);
  assert.deepEqual(Object.keys(report.probes),[
    "empty_process","cli_module","representative_command",
  ]);
  assert.deepEqual(report.probes.empty_process.medians,VALIDATOR_PHASE_MEDIANS);
  assert.ok(Object.values(report.probes).every(row =>
    JSON.stringify(row.medians)===JSON.stringify(VALIDATOR_PHASE_MEDIANS)));
  assert.deepEqual(report.strategies.map(row => row.name),VALIDATOR_STRATEGIES);
  assert.ok(report.strategies.every(row =>
    JSON.stringify(row.medians)===JSON.stringify(VALIDATOR_PHASE_MEDIANS)));
  assert.deepEqual(report.focused_gate_cli,{
    base_commit:"2caf811f521ee1c1664104a68ea35512fc87fdc8",
    before_samples_ms:[32581.98975,32685.560625,32656.405041],
    before_median_ms:32656.405041,
    after_samples_ms:[8100,8000,8200],
    after_median_ms:8100,
    improvement_percent:75.196,
  });
  assert.deepEqual(report.decision,{
    selected:"demand-driven",
    rejected:["eager-reference","standalone-experiment"],
    standalone_deterministic:true,
    standalone_drift_verified:false,
    standalone_equivalent:true,
    standalone_focused_median_ms:null,
    reason_code:"STANDALONE_FOCUSED_GAIN_UNPROVEN",
  });
  assert.deepEqual(validateValidatorColdStartReport(report),report);
});

test("validator report requires exact successful samples and truthful total time",() => {
  const cases=[
    {
      name:"nonzero exit",
      mutate:input => { input.probes.empty_process.samples[0].exit_status=1; },
      expected:/successful exit_status/i,
    },
    {
      name:"nonfinite phase",
      mutate:input => { input.strategies[0].samples[0].schema_io_ms=Number.NaN; },
      expected:/finite nonnegative/i,
    },
    {
      name:"total below a component",
      mutate:input => { input.probes.cli_module.samples[0].total_ms=1; },
      expected:/total_ms.*at least/i,
    },
    {
      name:"wrong sample count",
      mutate:input => { input.strategies[1].samples.pop(); },
      expected:/exactly three samples/i,
    },
    {
      name:"focused base drift",
      mutate:input => { input.focused_gate_cli.base_commit="f".repeat(40); },
      expected:/locked base commit/i,
    },
    {
      name:"focused before-sample drift",
      mutate:input => { input.focused_gate_cli.before_samples_ms[0]=1; },
      expected:/locked before samples/i,
    },
  ];
  for (const {name,mutate,expected} of cases) {
    const input=validatorReportInput();
    mutate(input);
    assert.throws(() => createValidatorColdStartReport(input),expected,name);
  }
});

test("validator report rejects unknown, hidden, symbol, sparse, and exotic input data",() => {
  const cases=[
    {
      name:"unknown property",
      mutate:input => { input.extra=true; },
      expected:/unknown property extra/i,
    },
    {
      name:"hidden property",
      mutate:input => Object.defineProperty(input.identity,"hidden",{value:true}),
      expected:/unknown property hidden/i,
    },
    {
      name:"symbol property",
      mutate:input => { input.evidence[Symbol("hidden")]=true; },
      expected:/symbol property/i,
    },
    {
      name:"sparse samples",
      mutate:input => { delete input.probes.representative_command.samples[1]; },
      expected:/dense/i,
    },
    {
      name:"exotic record",
      mutate:input => Object.setPrototypeOf(input.probes.empty_process,{custom:true}),
      expected:/plain object/i,
    },
  ];
  for (const {name,mutate,expected} of cases) {
    const input=validatorReportInput();
    mutate(input);
    assert.throws(() => createValidatorColdStartReport(input),expected,name);
  }
});

test("validator report rejects accessors without invoking them",() => {
  const input=validatorReportInput();
  let invoked=false;
  Object.defineProperty(input.strategies[0].samples[0],"process_ms",{
    enumerable:true,
    get() {
      invoked=true;
      return 1;
    },
  });
  assert.throws(
    () => createValidatorColdStartReport(input),
    /property process_ms must be enumerable data/i,
  );
  assert.equal(invoked,false);
});

test("validator report validation rejects untrusted derived fields and ordering",() => {
  const cases=[
    {
      name:"phase median",
      mutate:report => { report.probes.empty_process.medians.total_ms=31; },
      expected:/medians do not match samples/i,
    },
    {
      name:"focused median",
      mutate:report => { report.focused_gate_cli.after_median_ms=8000; },
      expected:/focused gate.*derived values/i,
    },
    {
      name:"decision",
      mutate:report => { report.decision.selected="standalone-experiment"; },
      expected:/decision does not match evidence/i,
    },
    {
      name:"strategy order",
      mutate:report => { report.strategies.reverse(); },
      expected:/strategy.*order/i,
    },
    {
      name:"probe key",
      mutate:report => { report.probes.other=report.probes.empty_process; },
      expected:/unknown property other/i,
    },
  ];
  for (const {name,mutate,expected} of cases) {
    const report=createValidatorColdStartReport(validatorReportInput());
    mutate(report);
    assert.throws(() => validateValidatorColdStartReport(report),expected,name);
  }
});

test("validator report creation rejects a supplied decision that is not derived",() => {
  const input=validatorReportInput();
  const report=createValidatorColdStartReport(input);
  input.decision={...report.decision,reason_code:"STANDALONE_DRIFT_UNVERIFIED"};
  assert.throws(
    () => createValidatorColdStartReport(input),
    /decision does not match evidence/i,
  );
});

test("validator report validation rejects a coherent standalone decision without retained proof",() => {
  const report=createValidatorColdStartReport(validatorReportInput());
  report.decision={
    selected:"standalone-experiment",
    rejected:["demand-driven","eager-reference"],
    standalone_deterministic:true,
    standalone_drift_verified:true,
    standalone_equivalent:true,
    standalone_focused_median_ms:7000,
    reason_code:null,
  };
  assert.throws(
    () => validateValidatorColdStartReport(report),
    /cannot retain standalone eligibility evidence/i,
  );
});

test("validator report construction rejects standalone evidence its schema cannot retain",() => {
  const cases=[
    {
      name:"focused samples",
      mutate:evidence => { evidence.standalone_focused_samples_ms=[6900,7000,7100]; },
    },
    {
      name:"all-schema drift claim",
      mutate:evidence => { evidence.standalone_drift_verified=true; },
    },
    {
      name:"coherent standalone eligibility",
      mutate:evidence => {
        evidence.standalone_focused_samples_ms=[6900,7000,7100];
        evidence.standalone_drift_verified=true;
      },
    },
  ];
  for (const {name,mutate} of cases) {
    const input=validatorReportInput();
    mutate(input.evidence);
    assert.throws(
      () => createValidatorColdStartReport(input),
      /cannot retain standalone eligibility evidence/i,
      name,
    );
  }
});

test("validator strategy selection is fail-closed with stable single-condition reasons",() => {
  const qualifying={
    demand_focused_median_ms:100,
    standalone_focused_samples_ms:[91,89,90],
    standalone_deterministic:true,
    standalone_drift_verified:true,
    standalone_equivalent:true,
  };
  assert.deepEqual(selectValidatorStrategy(qualifying),{
    selected:"standalone-experiment",
    rejected:["demand-driven","eager-reference"],
    standalone_deterministic:true,
    standalone_drift_verified:true,
    standalone_equivalent:true,
    standalone_focused_median_ms:90,
    reason_code:null,
  });
  const cases=[
    ["missing focused evidence",{standalone_focused_samples_ms:null},
      "STANDALONE_FOCUSED_GAIN_UNPROVEN"],
    ["gain below ten percent",{standalone_focused_samples_ms:[90.002,90.001,90.003]},
      "STANDALONE_FOCUSED_GAIN_BELOW_TEN_PERCENT"],
    ["nondeterministic output",{standalone_deterministic:false},
      "STANDALONE_NONDETERMINISTIC"],
    ["unverified all-schema drift",{standalone_drift_verified:false},
      "STANDALONE_DRIFT_UNVERIFIED"],
    ["result mismatch",{standalone_equivalent:false},
      "STANDALONE_RESULT_MISMATCH"],
  ];
  for (const [name,mutation,reasonCode] of cases) {
    const evidence={...qualifying,...mutation};
    assert.deepEqual(selectValidatorStrategy(evidence),{
      selected:"demand-driven",
      rejected:["eager-reference","standalone-experiment"],
      standalone_deterministic:evidence.standalone_deterministic,
      standalone_drift_verified:evidence.standalone_drift_verified,
      standalone_equivalent:evidence.standalone_equivalent,
      standalone_focused_median_ms:evidence.standalone_focused_samples_ms===null ? null :
        [...evidence.standalone_focused_samples_ms].sort((left,right) => left-right)[1],
      reason_code:reasonCode,
    },name);
  }
});

test("validator strategy selection requires three real standalone focused samples",() => {
  const evidence={
    demand_focused_median_ms:100,
    standalone_focused_samples_ms:[80,81],
    standalone_deterministic:true,
    standalone_drift_verified:true,
    standalone_equivalent:true,
  };
  assert.throws(() => selectValidatorStrategy(evidence),/exactly three samples/i);
  assert.throws(() => selectValidatorStrategy({
    ...evidence,
    standalone_focused_samples_ms:[80,81,82],
    standalone_focused_median_ms:81,
  }),/unknown property standalone_focused_median_ms/i);
});

test("validator report canonical JSON is deterministic",() => {
  const report=createValidatorColdStartReport(validatorReportInput());
  const reordered={
    decision:report.decision,
    focused_gate_cli:report.focused_gate_cli,
    strategies:report.strategies,
    probes:report.probes,
    identity:report.identity,
    schema_version:report.schema_version,
  };
  assert.equal(
    canonicalValidatorColdStartJson(reordered),
    canonicalValidatorColdStartJson(report),
  );
  assert.deepEqual(JSON.parse(canonicalValidatorColdStartJson(report)),report);
});
