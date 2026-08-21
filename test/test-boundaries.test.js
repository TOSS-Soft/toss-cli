import assert from "node:assert/strict";
import {execFile as execFileCallback} from "node:child_process";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {
  BOUNDARY_CLASSIFICATIONS,
  TEST_BOUNDARY_VERSION,
  validateTestBoundaries,
} from "../scripts/test-boundaries.mjs";

const root=fileURLToPath(new URL("..",import.meta.url));
const inventoryUrl=new URL("../scripts/test-boundaries.json",import.meta.url);
const boundariesModuleUrl=new URL("../scripts/test-boundaries.mjs",import.meta.url);
const execFile=promisify(execFileCallback);

function manifestFixture() {
  return Object.freeze({
    schema_version:"toss-test-manifest.v1",
    concurrency:1,
    lanes:Object.freeze({
      fast:Object.freeze(["test/b.test.js"]),
      integration:Object.freeze(["test/a.test.js"]),
      e2e:Object.freeze(["test/c.test.js"]),
      package:Object.freeze(["scripts/package-artifact-test.js"]),
      release:Object.freeze(["scripts/release-workflow-test.js"]),
    }),
  });
}

function fixture() {
  return {
    schema_version:"toss-test-boundaries.v1",
    guarantees:[
      {id:"artifact.atomic-append",classification:"durability-atomicity",owner:"test/a.test.js"},
      {id:"artifact.immutable-revision",classification:"durability-atomicity",owner:"test/a.test.js"},
    ],
    semantic_delegations:[{
      entry:"test/b.test.js",
      guarantees:["artifact.atomic-append","artifact.immutable-revision"],
    }],
  };
}

function clone(value) {
  return structuredClone(value);
}

test("one owner may own distinct guarantees but every guarantee ID is unique",() => {
  const value=fixture();
  const normalized=validateTestBoundaries(value,{manifest:manifestFixture()});
  assert.equal(normalized.guarantees.length,2);
  assert.equal(Object.isFrozen(normalized),true);
  assert.equal(Object.isFrozen(normalized.guarantees),true);
  assert.equal(Object.isFrozen(normalized.guarantees[0]),true);
  assert.equal(Object.isFrozen(normalized.semantic_delegations),true);
  assert.equal(Object.isFrozen(normalized.semantic_delegations[0].guarantees),true);
  value.guarantees[0].id="artifact.changed";
  assert.equal(normalized.guarantees[0].id,"artifact.atomic-append");
});

test("boundary constants expose the closed v1 vocabulary",() => {
  assert.equal(TEST_BOUNDARY_VERSION,"toss-test-boundaries.v1");
  assert.deepEqual(BOUNDARY_CLASSIFICATIONS,[
    "semantic","store-integration","durability-atomicity","real-cli","package","release",
  ]);
  assert.equal(Object.isFrozen(BOUNDARY_CLASSIFICATIONS),true);
});

for (const example of [
  {
    name:"an unknown root field",
    mutate:value => { value.extra=true; },
    expected:/unknown boundary inventory field.*extra/i,
  },
  {
    name:"a missing root field",
    mutate:value => { delete value.guarantees; },
    expected:/missing boundary inventory field.*guarantees/i,
  },
  {
    name:"an unsupported version",
    mutate:value => { value.schema_version="toss-test-boundaries.v0"; },
    expected:/unsupported test boundary version/i,
  },
  {
    name:"an exotic root record",
    mutate:() => Object.assign(Object.create(null),fixture()),
    expected:/plain JSON record/i,
  },
  {
    name:"an exotic guarantees array",
    mutate:value => { Object.setPrototypeOf(value.guarantees,null); },
    expected:/dense JSON array/i,
  },
  {
    name:"a sparse guarantee array",
    mutate:value => { value.guarantees=new Array(1); },
    expected:/dense JSON array/i,
  },
  {
    name:"an accessor",
    mutate:value => {
      Object.defineProperty(value,"guarantees",{
        enumerable:true,
        get() { throw new Error("accessor was invoked"); },
      });
    },
    expected:/own enumerable data properties/i,
  },
  {
    name:"a symbol field",
    mutate:value => { value[Symbol("hidden")]=true; },
    expected:/own enumerable data properties/i,
  },
  {
    name:"a hidden field",
    mutate:value => { Object.defineProperty(value,"hidden",{value:true}); },
    expected:/own enumerable data properties/i,
  },
  {
    name:"an unsafe guarantee owner",
    mutate:value => { value.guarantees[0].owner="test/support/helper.test.js"; },
    expected:/unsafe boundary entry/i,
  },
  {
    name:"an unsafe delegation entry",
    mutate:value => { value.semantic_delegations[0].entry="../test/b.test.js"; },
    expected:/unsafe boundary entry/i,
  },
  {
    name:"a duplicate guarantee ID",
    mutate:value => { value.guarantees[1].id="artifact.atomic-append"; },
    expected:/duplicate guarantee ID/i,
  },
  {
    name:"unsorted guarantee IDs",
    mutate:value => { value.guarantees.reverse(); },
    expected:/stable ASCII order/i,
  },
  {
    name:"duplicate semantic entries",
    mutate:value => { value.semantic_delegations.push(clone(value.semantic_delegations[0])); },
    expected:/duplicate semantic delegation entry/i,
  },
  {
    name:"unsorted semantic entries",
    mutate:value => {
      value.semantic_delegations=[
        {entry:"test/c.test.js",guarantees:["artifact.atomic-append"]},
        value.semantic_delegations[0],
      ];
    },
    expected:/semantic delegations must use stable ASCII order/i,
  },
  {
    name:"duplicate delegated IDs",
    mutate:value => { value.semantic_delegations[0].guarantees.push("artifact.immutable-revision"); },
    expected:/duplicate delegated guarantee/i,
  },
  {
    name:"unsorted delegated IDs",
    mutate:value => { value.semantic_delegations[0].guarantees.reverse(); },
    expected:/delegated guarantees must use stable ASCII order/i,
  },
  {
    name:"a missing real guarantee",
    mutate:value => { value.semantic_delegations[0].guarantees[1]="artifact.missing"; },
    expected:/unknown delegated guarantee/i,
  },
  {
    name:"a delegation to a semantic guarantee",
    mutate:value => { value.guarantees[0].classification="semantic"; },
    expected:/must not delegate semantic guarantee/i,
  },
  {
    name:"an owner absent from the manifest",
    mutate:value => { value.guarantees[0].owner="test/missing.test.js"; },
    expected:/unknown manifest owner/i,
  },
  {
    name:"a support owner",
    mutate:value => { value.guarantees[0].owner="test/fixtures/helper.test.js"; },
    expected:/unsafe boundary entry/i,
  },
  {
    name:"a lane and classification mismatch",
    mutate:value => { value.guarantees[0].classification="package"; },
    expected:/incompatible with lane integration/i,
  },
]) {
  test(`boundary validation rejects ${example.name}`,() => {
    let value=fixture();
    const replacement=example.mutate(value);
    if (replacement!==undefined) value=replacement;
    assert.throws(
      () => validateTestBoundaries(value,{manifest:manifestFixture()}),
      example.expected,
    );
  });
}

test("boundary validation rejects malformed guarantee and delegation records",() => {
  const guarantee=fixture();
  guarantee.guarantees[0].extra=true;
  assert.throws(
    () => validateTestBoundaries(guarantee,{manifest:manifestFixture()}),
    /unknown guarantee field.*extra/i,
  );
  const delegation=fixture();
  delete delegation.semantic_delegations[0].guarantees;
  assert.throws(
    () => validateTestBoundaries(delegation,{manifest:manifestFixture()}),
    /missing semantic delegation field.*guarantees/i,
  );
});

test("checked-in boundary inventory binds the exact current memory-backed entries",async () => {
  const inventory=JSON.parse(await readFile(inventoryUrl,"utf8"));
  assert.deepEqual(inventory.semantic_delegations.map(row => row.entry),[
    "test/design-commands.test.js",
    "test/feature-commands.test.js",
    "test/gate-authority-provenance-round2.test.js",
    "test/gate-cli-round1.test.js",
    "test/gate-commands-round1.test.js",
    "test/gate-commands.test.js",
    "test/project-commands.test.js",
  ]);
  assert.equal(inventory.guarantees.length,20);
});

test("boundary CLI validates the checked-in manifest and inventory",async () => {
  const {stdout,stderr}=await execFile(process.execPath,[boundariesModuleUrl.pathname],{cwd:root});
  assert.equal(stdout,"Test boundary integrity: PASS\n");
  assert.equal(stderr,"");
});
