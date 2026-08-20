import assert from "node:assert/strict";
import {mkdir,mkdtemp,rm,symlink,writeFile} from "node:fs/promises";
import {join} from "node:path";
import test from "node:test";
import {tmpdir} from "node:os";

import {
  discoverEligibleTestEntries,
  selectTestEntries,
  validateTestManifest,
} from "../scripts/test-manifest.mjs";

const eligible=["scripts/a-test.js","test/a.test.js","test/b.test.js"];
const valid={
  schema_version:"toss-test-manifest.v1",
  concurrency:1,
  lanes:{
    fast:["test/a.test.js"],
    integration:["test/b.test.js"],
    e2e:["scripts/a-test.js"],
    package:[],
    release:[],
  },
};

test("a closed manifest owns each eligible entry exactly once",() => {
  const manifest=validateTestManifest(valid,{eligibleEntries:eligible});
  assert.deepEqual(selectTestEntries(manifest,"fast"),["test/a.test.js"]);
  assert.deepEqual(selectTestEntries(manifest,"full"),[
    "test/a.test.js","test/b.test.js","scripts/a-test.js",
  ]);
  assert.equal(Object.isFrozen(manifest),true);
  assert.equal(Object.isFrozen(manifest.lanes),true);
});

test("manifest validation rejects open, missing, duplicate, and unstable ownership",() => {
  assert.throws(
    () => validateTestManifest({...valid,extra:true},{eligibleEntries:eligible}),
    /unknown manifest field.*extra/i,
  );
  assert.throws(
    () => validateTestManifest({...valid,lanes:{...valid.lanes,fast:[]}},{eligibleEntries:eligible}),
    /missing owner.*test\/a\.test\.js/i,
  );
  assert.throws(
    () => validateTestManifest({
      ...valid,lanes:{...valid.lanes,integration:["test/a.test.js","test/b.test.js"]},
    },{eligibleEntries:eligible}),
    /multiple owners.*test\/a\.test\.js/i,
  );
  assert.throws(
    () => validateTestManifest({
      ...valid,lanes:{...valid.lanes,fast:["test/b.test.js","test/a.test.js"]},
    },{eligibleEntries:eligible}),
    /stable ascii order/i,
  );
});

for (const unsafe of [
  "",
  "../test/a.test.js",
  "/test/a.test.js",
  "C:/test/a.test.js",
  "//server/share/test/a.test.js",
  "\\\\server\\share\\test\\a.test.js",
  "test\\a.test.js",
  "test/./a.test.js",
  "test/../a.test.js",
  "test//a.test.js",
  "test/\0a.test.js",
  "test/support/helper.js",
  "test/fixtures/case.js",
  "test/a.test.mjs",
]) {
  test(`manifest rejects unsafe entry ${JSON.stringify(unsafe)}`,() => {
    const manifest={...valid,lanes:{...valid.lanes,fast:[unsafe]}};
    assert.throws(
      () => validateTestManifest(manifest,{eligibleEntries:eligible}),
      /unsafe|support|fixture/i,
    );
  });
}

test("manifest rejects an existing-looking but unknown entry",() => {
  const manifest={...valid,lanes:{...valid.lanes,fast:["test/ghost.test.js"]}};
  assert.throws(
    () => validateTestManifest(manifest,{eligibleEntries:eligible}),
    /unknown entry.*test\/ghost\.test\.js/i,
  );
});

test("manifest rejects an accessor without invoking it",() => {
  const manifest={...valid};
  Object.defineProperty(manifest,"lanes",{
    enumerable:true,
    get() {
      throw new Error("accessor was invoked");
    },
  });
  assert.throws(
    () => validateTestManifest(manifest,{eligibleEntries:eligible}),
    /own enumerable data properties/i,
  );
});

test("manifest rejects exotic records and sparse arrays",() => {
  const exotic=Object.assign(Object.create(null),valid);
  assert.throws(
    () => validateTestManifest(exotic,{eligibleEntries:eligible}),
    /plain JSON record/i,
  );
  assert.throws(
    () => validateTestManifest({
      ...valid,lanes:{...valid.lanes,fast:new Array(1)},
    },{eligibleEntries:eligible}),
    /dense JSON array/i,
  );
});

test("manifest rejects unsupported lanes, invalid concurrency, and unknown selection",() => {
  assert.throws(
    () => validateTestManifest({
      ...valid,lanes:{...valid.lanes,preview:[]},
    },{eligibleEntries:eligible}),
    /unknown lanes field.*preview/i,
  );
  assert.throws(
    () => validateTestManifest({...valid,concurrency:0},{eligibleEntries:eligible}),
    /integer from 1 to 4/i,
  );
  const manifest=validateTestManifest(valid,{eligibleEntries:eligible});
  assert.throws(() => selectTestEntries(manifest,"preview"),/unknown test lane.*preview/i);
});

async function createRepository(t) {
  const root=await mkdtemp(join(tmpdir(),"toss-test-manifest-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  await Promise.all([
    mkdir(join(root,"scripts"),{recursive:true}),
    mkdir(join(root,"test"),{recursive:true}),
  ]);
  return root;
}

async function write(root,relative,contents="export {};\n") {
  const target=join(root,...relative.split("/"));
  await mkdir(join(target,".."),{recursive:true});
  await writeFile(target,contents,"utf8");
}

test("eligibility scan includes only direct regular test entries in ASCII order",async t => {
  const root=await createRepository(t);
  await Promise.all([
    write(root,"scripts/z-test.js"),
    write(root,"scripts/a-test.js"),
    write(root,"scripts/prepare.mjs"),
    write(root,"scripts/metadata.json","{}\n"),
    write(root,"test/z.test.js"),
    write(root,"test/a.test.js"),
    write(root,"test/support/imported.test.js"),
    write(root,"test/fixtures/imported.cjs"),
    write(root,"node_modules/example/test/ignored.test.js"),
  ]);
  assert.deepEqual(await discoverEligibleTestEntries(root),[
    "scripts/a-test.js",
    "scripts/z-test.js",
    "test/a.test.js",
    "test/z.test.js",
  ]);
});

test("eligibility scan does not traverse ignored generated or dependency trees",async t => {
  const root=await createRepository(t);
  await Promise.all([
    write(root,"scripts/a-test.js"),
    write(root,"test/a.test.js"),
    write(root,"scripts/node_modules/example/ignored-test.js"),
    write(root,"scripts/worktrees/issue/ignored.test.js"),
    write(root,"test/evidence/run/ignored.test.js"),
  ]);
  assert.deepEqual(await discoverEligibleTestEntries(root),[
    "scripts/a-test.js",
    "test/a.test.js",
  ]);
});

for (const extension of ["js","mjs","cjs"]) {
  test(`eligibility scan rejects nested test ${extension} files outside declared test imports`,async t => {
    const root=await createRepository(t);
    const entry=`test/nested/candidate.${extension}`;
    await write(root,entry);
    await assert.rejects(
      () => discoverEligibleTestEntries(root),
      new RegExp(`unexpected nested test candidate.*${entry.replace(".","\\.")}`,"i"),
    );
  });
}

for (const entry of ["scripts/nested/candidate-test.js","scripts/nested/candidate.test.js"]) {
  test(`eligibility scan rejects nested script candidate ${entry}`,async t => {
    const root=await createRepository(t);
    await write(root,entry);
    await assert.rejects(
      () => discoverEligibleTestEntries(root),
      /unexpected nested script test candidate/i,
    );
  });
}

test("eligibility scan rejects a symlinked direct test entry",async t => {
  const root=await createRepository(t);
  const outside=join(root,"outside.test.js");
  await writeFile(outside,"export {};\n","utf8");
  await symlink(outside,join(root,"test","linked.test.js"));
  await assert.rejects(
    () => discoverEligibleTestEntries(root),
    /symbolic link.*test\/linked\.test\.js/i,
  );
});

test("eligibility scan rejects a symlinked declared-root ancestor",async t => {
  const root=await createRepository(t);
  const outside=join(root,"outside-test-root");
  await mkdir(outside);
  await rm(join(root,"test"),{recursive:true});
  await symlink(outside,join(root,"test"),"dir");
  await assert.rejects(
    () => discoverEligibleTestEntries(root),
    /symbolic link.*test/i,
  );
});

test("eligibility scan rejects a direct test path that is a directory",async t => {
  const root=await createRepository(t);
  await mkdir(join(root,"test","directory.test.js"));
  await assert.rejects(
    () => discoverEligibleTestEntries(root),
    /regular file.*test\/directory\.test\.js/i,
  );
});

test("manifest rejects a missing regular test file",() => {
  const manifest={...valid,lanes:{...valid.lanes,fast:["test/missing.test.js"]}};
  assert.throws(
    () => validateTestManifest(manifest,{eligibleEntries:eligible}),
    /unknown entry.*test\/missing\.test\.js/i,
  );
});
