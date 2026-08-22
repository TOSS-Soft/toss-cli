import assert from "node:assert/strict";
import {execFile as execFileCallback} from "node:child_process";
import {mkdir,mkdtemp,readFile,rm,symlink,writeFile} from "node:fs/promises";
import {join} from "node:path";
import test from "node:test";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {
  discoverEligibleTestEntries,
  selectTestEntries,
  validateTestManifest,
} from "../scripts/test-manifest.mjs";

const root=fileURLToPath(new URL("..",import.meta.url));
const manifestUrl=new URL("../scripts/test-manifest.json",import.meta.url);
const manifestModuleUrl=new URL("../scripts/test-manifest.mjs",import.meta.url);
const execFile=promisify(execFileCallback);

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

function withNonEnumerableIndex(entries,index) {
  Object.defineProperty(entries,String(index),{
    value:entries[index],enumerable:false,writable:true,configurable:true,
  });
  return entries;
}

for (const example of [
  {
    name:"duplicate entries",
    entries:["scripts/a-test.js","test/a.test.js","test/a.test.js","test/b.test.js"],
    expected:/duplicate eligible entry.*test\/a\.test\.js/i,
  },
  {
    name:"unstable entries",
    entries:["test/a.test.js","scripts/a-test.js","test/b.test.js"],
    expected:/eligible entries.*stable ASCII order/i,
  },
  {
    name:"an unsafe entry",
    entries:[...eligible,"../test/escape.test.js"],
    expected:/unsafe test entry.*\.\.\/test\/escape\.test\.js/i,
  },
  {
    name:"a non-string entry",
    entries:[...eligible,7],
    expected:/eligible entries must be strings/i,
  },
  {
    name:"a sparse entry",
    entries:[...eligible,,],
    expected:/eligible entries must be a dense JSON array/i,
  },
  {
    name:"a non-enumerable numeric entry",
    entries:withNonEnumerableIndex([...eligible],1),
    expected:/eligible entries must be a dense JSON array/i,
  },
]) {
  test(`manifest rejects injected eligible entries with ${example.name}`,() => {
    assert.throws(
      () => validateTestManifest(valid,{eligibleEntries:example.entries}),
      example.expected,
    );
  });
}

test("manifest rejects a non-enumerable lane entry",() => {
  const entries=withNonEnumerableIndex(["test/a.test.js"],0);
  assert.throws(
    () => validateTestManifest({
      ...valid,lanes:{...valid.lanes,fast:entries},
    },{eligibleEntries:eligible}),
    /lane fast must be a dense JSON array/i,
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

for (const example of [
  {
    basename:"node_modules",
    nestedEntry:"scripts/nested/node_modules/example/ignored-test.js",
  },
  {
    basename:"worktrees",
    nestedEntry:"test/nested/worktrees/issue/ignored.test.js",
  },
  {
    basename:"evidence",
    nestedEntry:"scripts/nested/evidence/run/ignored-test.js",
  },
]) {
  test(`eligibility scan recursively prunes nested ${example.basename} trees`,async t => {
    const root=await createRepository(t);
    await Promise.all([
      write(root,"scripts/a-test.js"),
      write(root,"test/a.test.js"),
      write(root,example.nestedEntry),
    ]);
    assert.deepEqual(await discoverEligibleTestEntries(root),[
      "scripts/a-test.js",
      "test/a.test.js",
    ]);
  });
}

test("eligibility scan rejects a symlink named like an ignored tree",async t => {
  const root=await createRepository(t);
  const outside=join(root,"outside-node-modules");
  await mkdir(outside);
  await symlink(outside,join(root,"scripts","node_modules"),"dir");
  await assert.rejects(
    () => discoverEligibleTestEntries(root),
    /symbolic link.*scripts\/node_modules/i,
  );
});

test("eligibility scan rejects a file named like an ignored tree",async t => {
  const root=await createRepository(t);
  await write(root,"scripts/node_modules");
  await assert.rejects(
    () => discoverEligibleTestEntries(root),
    /ignored test tree must be a directory.*scripts\/node_modules/i,
  );
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

async function readCheckedInManifest() {
  return JSON.parse(await readFile(manifestUrl,"utf8"));
}

async function validateCheckedInManifest(manifest) {
  if (manifest===undefined) {
    manifest=await readCheckedInManifest();
  }
  return validateTestManifest(manifest,{
    eligibleEntries:await discoverEligibleTestEntries(root),
  });
}

test("the checked-in inventory owns every executable entry exactly once",async () => {
  const manifest=await readCheckedInManifest();
  const eligibleEntries=await discoverEligibleTestEntries(root);
  const normalized=validateTestManifest(manifest,{eligibleEntries});
  const selected=selectTestEntries(normalized,"full");
  assert.equal(selected.length,eligibleEntries.length);
  assert.equal(new Set(selected).size,eligibleEntries.length);
  assert.equal(selected.some(entry => entry.startsWith("test/support/") || entry.startsWith("test/fixtures/")),false);
});

test("the coverage audit contract remains release-owned",async () => {
  const manifest=JSON.parse(await readFile(manifestUrl,"utf8"));
  assert.deepEqual(manifest.lanes.release,[
    "scripts/release-workflow-test.js",
    "test/coverage-audit.test.js",
    "test/release-v2.1.0.test.js",
    "test/test-lanes.test.js",
  ]);
});

test("the checked-in inventory uses the measured stable concurrency",async () => {
  const manifest=await readCheckedInManifest();
  assert.equal(manifest.concurrency,4);
});

test("the checked-in inventory rejects a removed real entry",async () => {
  const manifest=await readCheckedInManifest();
  manifest.lanes.fast.shift();
  await assert.rejects(
    () => validateCheckedInManifest(manifest),
    /missing owner.*test\/acp-v1\.test\.js/i,
  );
});

test("the checked-in inventory rejects a real entry with a second owner",async () => {
  const manifest=await readCheckedInManifest();
  manifest.lanes.integration.push("test/acp-v1.test.js");
  manifest.lanes.integration.sort();
  await assert.rejects(
    () => validateCheckedInManifest(manifest),
    /multiple owners.*test\/acp-v1\.test\.js/i,
  );
});

test("the checked-in inventory rejects a support path",async () => {
  const manifest=await readCheckedInManifest();
  manifest.lanes.fast.push("test/support/helper.test.js");
  manifest.lanes.fast.sort();
  await assert.rejects(
    () => validateCheckedInManifest(manifest),
    /unsafe test entry.*test\/support\/helper\.test\.js/i,
  );
});

test("the checked-in inventory rejects a nonexistent top-level test",async () => {
  const manifest=await readCheckedInManifest();
  manifest.lanes.fast.push("test/not-in-repository.test.js");
  manifest.lanes.fast.sort();
  await assert.rejects(
    () => validateCheckedInManifest(manifest),
    /unknown entry.*test\/not-in-repository\.test\.js/i,
  );
});

test("the checked-in inventory rejects a reordered lane",async () => {
  const manifest=await readCheckedInManifest();
  manifest.lanes.fast.reverse();
  await assert.rejects(
    () => validateCheckedInManifest(manifest),
    /stable ASCII order/i,
  );
});

test("the checked-in inventory rejects non-explicit concurrency",async () => {
  for (const concurrency of [0,5,1.5,"ambient","automatic"]) {
    const manifest=await readCheckedInManifest();
    manifest.concurrency=concurrency;
    await assert.rejects(
      () => validateCheckedInManifest(manifest),
      /manifest concurrency must be an integer from 1 to 4/i,
    );
  }
});

test("the manifest integrity CLI reports a passing checked-in inventory",async () => {
  const result=await execFile(process.execPath,["./scripts/test-manifest.mjs"],{cwd:root});
  assert.equal(result.stdout,"Test manifest integrity: PASS\n");
  assert.equal(result.stderr,"");
});

test("the manifest integrity CLI returns the validation diagnostic from an isolated fixture",async t => {
  const isolatedRoot=await createRepository(t);
  const manifest=await readCheckedInManifest();
  manifest.concurrency=0;
  await write(
    isolatedRoot,
    "scripts/test-manifest.json",
    `${JSON.stringify(manifest,null,2)}\n`,
  );
  await write(
    isolatedRoot,
    "scripts/test-manifest.mjs",
    await readFile(manifestModuleUrl,"utf8"),
  );
  await assert.rejects(
    () => execFile(process.execPath,["./scripts/test-manifest.mjs"],{cwd:isolatedRoot}),
    error => {
      assert.equal(error.code,1);
      assert.equal(error.stdout,"");
      assert.equal(error.stderr,"manifest concurrency must be an integer from 1 to 4\n");
      return true;
    },
  );
});
