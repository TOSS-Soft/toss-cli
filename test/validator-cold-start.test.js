import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {
  CONTRACT_SCHEMA_CATALOG,
  validateContractSchemaCatalog,
} from "../src/contracts/schema-catalog.js";

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
