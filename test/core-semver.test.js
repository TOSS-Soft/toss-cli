import assert from "node:assert/strict";
import test from "node:test";

import {CoreValidationError} from "../src/core/errors.js";
import {
  classifyReleaseChange,
  nextVersion,
  parseSemVer,
  selectRepositoryVersion,
} from "../src/core/release/semver.js";

const CLI="TOSS-Soft/toss-cli";

function epic(number,changeClass="backward_compatible_feature") {
  return {id:`${CLI}#${number}`,change_class:changeClass};
}

function bug(number,{kind="bug",published=true}={}) {
  return {id:`${CLI}#${number}`,kind,affects_published_product:published};
}

function scopeEpic(number,changeClass="backward_compatible_feature") {
  return {
    id:`${CLI}#${number}`,
    kind:"epic",
    change_class:changeClass,
    affects_published_product:false,
  };
}

function scopeBug(number,{kind="bug",published=true}={}) {
  return {
    id:`${CLI}#${number}`,
    kind,
    change_class:null,
    affects_published_product:published,
  };
}

function deeplyFrozen(value,seen=new Set()) {
  if (value===null || typeof value!=="object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Reflect.ownKeys(value)
    .every(key => deeplyFrozen(value[key],seen));
}

test("parseSemVer accepts only canonical stable safe-integer components",() => {
  for (const [value,expected] of [
    ["0.0.0",{major:0,minor:0,patch:0}],
    ["2.1.2",{major:2,minor:1,patch:2}],
    [`${Number.MAX_SAFE_INTEGER}.${Number.MAX_SAFE_INTEGER}.${Number.MAX_SAFE_INTEGER}`,{
      major:Number.MAX_SAFE_INTEGER,
      minor:Number.MAX_SAFE_INTEGER,
      patch:Number.MAX_SAFE_INTEGER,
    }],
  ]) {
    const parsed=parseSemVer(value);
    assert.deepEqual(parsed,expected,value);
    assert.ok(Object.isFrozen(parsed),value);
  }

  for (const value of [
    "", "2", "2.1", "2.1.2.0", "v2.1.2", "+2.1.2", "-2.1.2",
    " 2.1.2", "2.1.2 ", "02.1.2", "2.01.2", "2.1.02",
    "2.1.2-beta.1", "2.1.2+build.1", "9007199254740992.0.0",
    null, undefined, 212, new String("2.1.2"),
  ]) {
    assert.throws(
      () => parseSemVer(value),
      error => error instanceof CoreValidationError && error.exitCode===5,
      String(value),
    );
  }
});

test("nextVersion increments exactly one selected component and resets lower components",() => {
  for (const [current,changeClass,expected] of [
    ["2.1.2","patch","2.1.3"],
    ["2.1.2","minor","2.2.0"],
    ["2.1.2","major","3.0.0"],
    ["0.0.0","patch","0.0.1"],
    ["0.0.0","minor","0.1.0"],
    ["0.0.0","major","1.0.0"],
  ]) {
    assert.equal(nextVersion(current,changeClass),expected,`${current} ${changeClass}`);
  }
});

test("nextVersion fails closed on unsafe increments and unknown change classes",() => {
  const maximum=String(Number.MAX_SAFE_INTEGER);
  for (const [current,changeClass] of [
    [`${maximum}.0.0`,"major"],
    [`0.${maximum}.0`,"minor"],
    [`0.0.${maximum}`,"patch"],
  ]) {
    assert.throws(
      () => nextVersion(current,changeClass),
      error => error instanceof CoreValidationError && error.exitCode===5,
      `${current} ${changeClass}`,
    );
  }
  assert.throws(
    () => nextVersion("2.1.2","feature"),
    error => error instanceof CoreValidationError &&
      error.code==="CORE_CHANGE_CLASS_INVALID" && error.exitCode===5,
  );
});

test("nextVersion rejects exotic change classes without primitive coercion",() => {
  let coercions=0;
  const hostile={
    toString() {
      coercions+=1;
      throw new Error("change class coercion trap");
    },
  };

  assert.throws(
    () => nextVersion("2.1.2",hostile),
    error => error instanceof CoreValidationError &&
      error.code==="CORE_CHANGE_CLASS_INVALID" && error.exitCode===5,
  );
  assert.equal(coercions,0);
});

test("classifyReleaseChange applies breaking then feature then published-fix precedence",() => {
  for (const [scope,expected] of [
    [[scopeBug(3)],"patch"],
    [[scopeBug(3,{kind:"fix"})],"patch"],
    [[scopeEpic(2)],"minor"],
    [[scopeEpic(1,"breaking")],"major"],
    [[scopeBug(3),scopeEpic(2)],"minor"],
    [[scopeBug(3),scopeEpic(2),scopeEpic(1,"breaking")],"major"],
  ]) {
    assert.equal(classifyReleaseChange(scope),expected);
  }
});

test("unreleased-only defects and empty release scope cannot select a release",() => {
  for (const scope of [[],[scopeBug(4,{published:false})]]) {
    assert.throws(
      () => classifyReleaseChange(scope),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }

  for (const input of [
    {latestPublishedVersion:"2.1.2",epics:[],bugs:[]},
    {latestPublishedVersion:"2.1.2",epics:[],bugs:[bug(4,{published:false})]},
  ]) {
    assert.throws(
      () => selectRepositoryVersion(input),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }
});

test("selectRepositoryVersion returns the independent version and canonical structured rationale",() => {
  const selected=selectRepositoryVersion({
    latestPublishedVersion:"2.1.2",
    epics:[epic(11),epic(3,"breaking")],
    bugs:[bug(20),bug(5,{kind:"fix"}),bug(9,{published:false})],
  });

  assert.deepEqual(selected,{
    version:"3.0.0",
    change_class:"major",
    rationale:[
      {rule:"breaking_public_boundary",scope_ids:[`${CLI}#3`]},
      {rule:"backward_compatible_feature",scope_ids:[`${CLI}#11`]},
      {rule:"published_product_fix",scope_ids:[`${CLI}#20`,`${CLI}#5`]},
      {rule:"unreleased_defect_excluded",scope_ids:[`${CLI}#9`]},
    ],
  });
  assert.ok(deeplyFrozen(selected));
});

test("version selection covers patch minor major and zero baselines",() => {
  for (const [input,expected] of [
    [
      {latestPublishedVersion:"2.1.2",epics:[],bugs:[bug(4)]},
      {version:"2.1.3",change_class:"patch",rationale:[
        {rule:"published_product_fix",scope_ids:[`${CLI}#4`]},
      ]},
    ],
    [
      {latestPublishedVersion:"2.1.2",epics:[epic(4)],bugs:[]},
      {version:"2.2.0",change_class:"minor",rationale:[
        {rule:"backward_compatible_feature",scope_ids:[`${CLI}#4`]},
      ]},
    ],
    [
      {latestPublishedVersion:"2.1.2",epics:[epic(4,"breaking")],bugs:[]},
      {version:"3.0.0",change_class:"major",rationale:[
        {rule:"breaking_public_boundary",scope_ids:[`${CLI}#4`]},
      ]},
    ],
    [
      {latestPublishedVersion:"0.0.0",epics:[],bugs:[bug(4)]},
      {version:"0.0.1",change_class:"patch",rationale:[
        {rule:"published_product_fix",scope_ids:[`${CLI}#4`]},
      ]},
    ],
  ]) {
    assert.deepEqual(selectRepositoryVersion(input),expected);
  }
});

test("equivalent shuffled scope produces canonically identical selection",() => {
  const left=selectRepositoryVersion({
    latestPublishedVersion:"2.1.2",
    epics:[epic(12),epic(3,"breaking"),epic(2)],
    bugs:[bug(20),bug(4,{published:false}),bug(10,{kind:"fix"})],
  });
  const right=selectRepositoryVersion({
    latestPublishedVersion:"2.1.2",
    epics:[epic(2),epic(12),epic(3,"breaking")],
    bugs:[bug(10,{kind:"fix"}),bug(20),bug(4,{published:false})],
  });

  assert.deepEqual(right,left);
  assert.equal(JSON.stringify(right),JSON.stringify(left));
});

test("scope inputs require exact semantic records one repository and unique logical IDs",() => {
  const invalidScopes=[
    [scopeEpic(1),scopeBug(1)],
    [scopeEpic(1),{...scopeEpic(2),id:"TOSS-Soft/toss-console#2"}],
    [{...scopeEpic(1),extra:true}],
    [{...scopeEpic(1),kind:"feature"}],
    [{...scopeEpic(1),affects_published_product:true}],
    [{...scopeEpic(1),change_class:"patch"}],
    [{...scopeBug(1),change_class:"breaking"}],
    [{...scopeBug(1),affects_published_product:"yes"}],
    [{...scopeBug(1),id:"toss-cli#1"}],
    [null],
  ];
  for (const scope of invalidScopes) {
    assert.throws(
      () => classifyReleaseChange(scope),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }

  const invalidSelections=[
    {latestPublishedVersion:"2.1.2",epics:[epic(1)],bugs:[bug(1)]},
    {latestPublishedVersion:"2.1.2",epics:[epic(1),{...epic(2),id:"TOSS-Soft/toss-console#2"}],bugs:[]},
    {latestPublishedVersion:"2.1.2",epics:[{...epic(1),extra:true}],bugs:[]},
    {latestPublishedVersion:"2.1.2",epics:[{...epic(1),change_class:"patch"}],bugs:[]},
    {latestPublishedVersion:"2.1.2",epics:[],bugs:[{...bug(1),kind:"defect"}]},
    {latestPublishedVersion:"2.1.2",epics:[],bugs:[{...bug(1),affects_published_product:null}]},
    {latestPublishedVersion:"2.1.2",epics:[],bugs:[{...bug(1),id:"TOSS-Soft/toss-cli#01"}]},
    {latestPublishedVersion:"2.1.2",epics:[],bugs:[],extra:true},
  ];
  for (const input of invalidSelections) {
    assert.throws(
      () => selectRepositoryVersion(input),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }
});

test("scope boundaries reject sparse hidden symbol accessor and proxy data without traps",() => {
  const sparse=new Array(1);
  const hidden=[scopeEpic(1)];
  Object.defineProperty(hidden,"hidden",{value:true});
  const symbol=[scopeEpic(1)];
  Object.defineProperty(symbol,Symbol("hidden"),{value:true,enumerable:true});
  let reads=0;
  const accessor={...scopeEpic(1)};
  Object.defineProperty(accessor,"kind",{enumerable:true,get() { reads+=1; return "epic"; }});
  const proxy=new Proxy(scopeEpic(1),{get() { reads+=1; throw new Error("trap"); }});

  for (const scope of [sparse,hidden,symbol,[accessor],[proxy]]) {
    assert.throws(() => classifyReleaseChange(scope),CoreValidationError);
  }
  assert.equal(reads,0);
});

test("selection normalization is detached from mutable caller input",() => {
  const input={
    latestPublishedVersion:"2.1.2",
    epics:[epic(2)],
    bugs:[bug(4,{published:false})],
  };
  const selected=selectRepositoryVersion(input);
  input.epics[0].id=`${CLI}#99`;
  input.bugs[0].affects_published_product=true;
  input.epics.push(epic(3,"breaking"));

  assert.deepEqual(selected,{
    version:"2.2.0",
    change_class:"minor",
    rationale:[
      {rule:"backward_compatible_feature",scope_ids:[`${CLI}#2`]},
      {rule:"unreleased_defect_excluded",scope_ids:[`${CLI}#4`]},
    ],
  });
  assert.ok(deeplyFrozen(selected));
});
