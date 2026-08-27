import assert from "node:assert/strict";
import {execFileSync,spawnSync} from "node:child_process";
import {
  linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,
  unlinkSync,writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,isAbsolute,join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {
  RELEASE_EVIDENCE_VERSION,
  createReleaseEvidence,
  validateReleaseEvidence,
  writeReleaseEvidenceJson,
} from "../scripts/release-evidence.mjs";

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const evidenceScript=join(root,"scripts","release-evidence.mjs");
const TARBALL_NAME="toss-software-cli-2.1.1.tgz";
const TARBALL_BYTES="canonical tarball bytes\n";
const TARBALL_SHA256="eafbb09892baacc635e3d4d68461c6ff0c33037f8ed9b78d4da4feb73065f9c6";
const FAST_LIMIT_MS=15000;
const FULL_LIMIT_MS=90103;

function canonicalJson(value) {
  if (value===null || typeof value!=="object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

function evidenceFixture() {
  return {
    schema_version:"toss-release-evidence.v1",
    tag:"v2.1.1",
    version:"2.1.1",
    commit:"a".repeat(40),
    benchmarks:{
      fast:{report_sha256:"b".repeat(64),median_ms:5762.305292,limit_ms:FAST_LIMIT_MS},
      full:{report_sha256:"c".repeat(64),median_ms:16566.500291,limit_ms:FULL_LIMIT_MS},
    },
    tarball:{name:TARBALL_NAME,sha256:"d".repeat(64)},
    workflow:{
      repository:"TOSS-Soft/toss-cli",
      run_id:"123",
      run_url:"https://github.com/TOSS-Soft/toss-cli/actions/runs/123",
    },
    packages:{npm:"@toss-software/cli@2.1.1",github:"@toss-soft/cli@2.1.1"},
    release:{
      tag:"v2.1.1",
      url:"https://github.com/TOSS-Soft/toss-cli/releases/tag/v2.1.1",
      draft:false,
      prerelease:false,
      assets:[TARBALL_NAME],
    },
  };
}

function metadataFixture() {
  return {
    version:"2.1.1",
    artifactName:"npm-package-2.1.1",
    notesPath:"docs/releases/v2.1.1.md",
    commit:"a".repeat(40),
    benchmarks:{
      fast:{report_sha256:"b".repeat(64),median_ms:5762.305292,limit_ms:FAST_LIMIT_MS},
      full:{report_sha256:"c".repeat(64),median_ms:16566.500291,limit_ms:FULL_LIMIT_MS},
    },
  };
}

function releaseFixture({digest=TARBALL_SHA256,draft=false,prerelease=false,assets}={}) {
  return {
    tagName:"v2.1.1",
    url:"https://github.com/TOSS-Soft/toss-cli/releases/tag/v2.1.1",
    isDraft:draft,
    isPrerelease:prerelease,
    assets:assets ?? [{name:TARBALL_NAME,digest:`sha256:${digest}`}],
  };
}

function createRepository(t) {
  const cwd=mkdtempSync(join(tmpdir(),"toss-release-evidence-"));
  t.after(() => rmSync(cwd,{recursive:true,force:true}));
  execFileSync("git",["init","-b","main"],{cwd,stdio:"pipe"});
  execFileSync("git",["config","user.name","Release Evidence Test"],{cwd,stdio:"pipe"});
  execFileSync("git",["config","user.email","release-evidence@example.invalid"],{
    cwd,stdio:"pipe",
  });
  writeFileSync(join(cwd,TARBALL_NAME),TARBALL_BYTES);
  return cwd;
}

function createInput(cwd,overrides={}) {
  return {
    tag:"v2.1.1",
    metadata:metadataFixture(),
    tarballPath:join(cwd,TARBALL_NAME),
    workflow:{
      repository:"TOSS-Soft/toss-cli",
      run_id:"123",
      run_url:"https://github.com/TOSS-Soft/toss-cli/actions/runs/123",
    },
    packages:{npm:"@toss-software/cli@2.1.1",github:"@toss-soft/cli@2.1.1"},
    release:releaseFixture(),
    ...overrides,
  };
}

function atPath(value,path) {
  return path.reduce((current,key) => current[key],value);
}

test("release evidence exposes the exact closed v1 shape as a deeply frozen copy",() => {
  const value=evidenceFixture();
  const normalized=validateReleaseEvidence(value);

  assert.equal(RELEASE_EVIDENCE_VERSION,"toss-release-evidence.v1");
  assert.deepEqual(normalized,value);
  assert.notEqual(normalized,value);
  for (const nested of [
    normalized,normalized.benchmarks,normalized.benchmarks.fast,normalized.benchmarks.full,
    normalized.tarball,normalized.workflow,normalized.packages,normalized.release,
    normalized.release.assets,
  ]) {
    assert.equal(Object.isFrozen(nested),true);
  }
  value.release.assets[0]="changed.tgz";
  assert.deepEqual(normalized.release.assets,[TARBALL_NAME]);
});

const closedRecords=[
  {label:"evidence",path:[],fields:[
    "schema_version","tag","version","commit","benchmarks","tarball","workflow","packages","release",
  ]},
  {label:"benchmarks",path:["benchmarks"],fields:["fast","full"]},
  {label:"fast benchmark",path:["benchmarks","fast"],fields:["report_sha256","median_ms","limit_ms"]},
  {label:"full benchmark",path:["benchmarks","full"],fields:["report_sha256","median_ms","limit_ms"]},
  {label:"tarball",path:["tarball"],fields:["name","sha256"]},
  {label:"workflow",path:["workflow"],fields:["repository","run_id","run_url"]},
  {label:"packages",path:["packages"],fields:["npm","github"]},
  {label:"release",path:["release"],fields:["tag","url","draft","prerelease","assets"]},
];

for (const {label,path,fields} of closedRecords) {
  test(`release evidence rejects an unknown ${label} field`,() => {
    const value=evidenceFixture();
    atPath(value,path).unexpected=true;
    assert.throws(() => validateReleaseEvidence(value),/unknown|fields/i);
  });
  for (const field of fields) {
    test(`release evidence rejects missing ${label}.${field}`,() => {
      const value=evidenceFixture();
      delete atPath(value,path)[field];
      assert.throws(() => validateReleaseEvidence(value),/missing|fields/i);
    });
  }
}

for (const example of [
  {
    name:"an accessor field",
    mutate:value => Object.defineProperty(value,"release",{
      enumerable:true,get() { throw new Error("accessor invoked"); },
    }),
  },
  {name:"a hidden field",mutate:value => Object.defineProperty(value,"hidden",{value:true})},
  {name:"a symbol field",mutate:value => { value[Symbol("hidden")]=true; }},
  {name:"an exotic record",mutate:value => Object.setPrototypeOf(value.workflow,null)},
]) {
  test(`release evidence rejects ${example.name}`,() => {
    const value=evidenceFixture();
    example.mutate(value);
    assert.throws(
      () => validateReleaseEvidence(value),
      error => /own enumerable data properties|plain JSON object/i.test(error.message) &&
        !/accessor invoked/i.test(error.message),
    );
  });
}

for (const example of [
  ["an unsupported schema version",value => { value.schema_version="toss-release-evidence.v0"; },/schema.version/i],
  ["a noncanonical tag",value => { value.tag="v02.1.1"; },/semantic version|tag/i],
  ["a mismatched version",value => { value.version="2.1.2"; },/version|tag/i],
  ["a malformed commit",value => { value.commit="A".repeat(40); },/commit/i],
  ["a malformed report hash",value => { value.benchmarks.fast.report_sha256="B".repeat(64); },/hash|sha/i],
  ["a negative median",value => { value.benchmarks.fast.median_ms=-1; },/median|nonnegative/i],
  ["a non-finite median",value => { value.benchmarks.full.median_ms=Infinity; },/median|finite/i],
  ["the wrong fast limit",value => { value.benchmarks.fast.limit_ms=14999; },/limit/i],
  ["the wrong full limit",value => { value.benchmarks.full.limit_ms=90102; },/limit/i],
  ["a fast budget miss",value => { value.benchmarks.fast.median_ms=15000.1; },/budget|limit/i],
  ["a malformed tarball hash",value => { value.tarball.sha256="D".repeat(64); },/hash|sha/i],
  ["a mismatched tarball name",value => { value.tarball.name="other.tgz"; },/tarball|name/i],
  ["a mismatched npm identity",value => { value.packages.npm="@other/cli@2.1.1"; },/npm|package/i],
  ["a mismatched GitHub identity",value => { value.packages.github="@toss-soft/cli@2.1.2"; },/github|package/i],
  ["a mismatched repository",value => { value.workflow.repository="fork/toss-cli"; },/repository/i],
  ["a noncanonical run ID",value => { value.workflow.run_id="0123"; },/run.id/i],
  ["a noncanonical run URL",value => { value.workflow.run_url="https://example.invalid/run/123"; },/run.url/i],
  ["a mismatched release tag",value => { value.release.tag="v2.1.2"; },/release tag|tag/i],
  ["a noncanonical release URL",value => { value.release.url+="/"; },/release url|url/i],
  ["a draft release",value => { value.release.draft=true; },/draft/i],
  ["a prerelease release",value => { value.release.prerelease=true; },/prerelease/i],
]) {
  test(`release evidence rejects ${example[0]}`,() => {
    const value=evidenceFixture();
    example[1](value);
    assert.throws(() => validateReleaseEvidence(value),example[2]);
  });
}

for (const unsafeName of ["",".","..","../escape.tgz","folder/asset.tgz","folder\\asset.tgz","bad\0asset.tgz"] ) {
  test(`release evidence rejects unsafe asset name ${JSON.stringify(unsafeName)}`,() => {
    const value=evidenceFixture();
    value.release.assets.push(unsafeName);
    assert.throws(() => validateReleaseEvidence(value),/asset.*safe|safe.*asset/i);
  });
}

test("release evidence rejects duplicate and missing canonical release assets",() => {
  const duplicate=evidenceFixture();
  duplicate.release.assets.push(TARBALL_NAME);
  assert.throws(() => validateReleaseEvidence(duplicate),/duplicate.*asset/i);
  const missing=evidenceFixture();
  missing.release.assets=["release-evidence.json"];
  assert.throws(() => validateReleaseEvidence(missing),/tarball.*asset|asset.*tarball/i);
});

test("release evidence requires one dense ordinary asset array",() => {
  const sparse=evidenceFixture();
  sparse.release.assets=new Array(1);
  assert.throws(() => validateReleaseEvidence(sparse),/dense.*array/i);
  const hidden=evidenceFixture();
  Object.defineProperty(hidden.release.assets,"0",{
    value:TARBALL_NAME,enumerable:false,writable:true,configurable:true,
  });
  assert.throws(() => validateReleaseEvidence(hidden),/dense.*array/i);
  const extra=evidenceFixture();
  extra.release.assets.extra=true;
  assert.throws(() => validateReleaseEvidence(extra),/dense.*array/i);
});

test("createReleaseEvidence derives the tarball hash and normalizes verified release JSON",t => {
  const cwd=createRepository(t);
  const evidence=createReleaseEvidence(createInput(cwd));

  assert.deepEqual(evidence,{
    ...evidenceFixture(),
    tarball:{name:TARBALL_NAME,sha256:TARBALL_SHA256},
  });
  assert.equal(Object.isFrozen(evidence),true);
  assert.equal(Object.isFrozen(evidence.release.assets),true);
});

test("createReleaseEvidence rejects caller-supplied digests and closed-input drift",t => {
  const cwd=createRepository(t);
  const injected=createInput(cwd);
  injected.tarballSha256="d".repeat(64);
  assert.throws(() => createReleaseEvidence(injected),/unknown|fields/i);
  const openMetadata=createInput(cwd);
  openMetadata.metadata.extra=true;
  assert.throws(() => createReleaseEvidence(openMetadata),/unknown|fields/i);
  const missingReleaseField=createInput(cwd);
  delete missingReleaseField.release.isDraft;
  assert.throws(() => createReleaseEvidence(missingReleaseField),/missing|fields/i);
  const openAsset=createInput(cwd);
  openAsset.release.assets[0].extra=true;
  assert.throws(() => createReleaseEvidence(openAsset),/unknown|fields/i);
  const missingAssetDigest=createInput(cwd);
  delete missingAssetDigest.release.assets[0].digest;
  assert.throws(() => createReleaseEvidence(missingAssetDigest),/missing|fields/i);
});

test("createReleaseEvidence rejects a remote tarball digest mismatch",t => {
  const cwd=createRepository(t);
  assert.throws(
    () => createReleaseEvidence(createInput(cwd,{release:releaseFixture({digest:"d".repeat(64)})})),
    /digest.*match|match.*digest/i,
  );
});

test("createReleaseEvidence rejects draft and prerelease release JSON",t => {
  const cwd=createRepository(t);
  assert.throws(
    () => createReleaseEvidence(createInput(cwd,{release:releaseFixture({draft:true})})),
    /draft/i,
  );
  assert.throws(
    () => createReleaseEvidence(createInput(cwd,{release:releaseFixture({prerelease:true})})),
    /prerelease/i,
  );
});

test("createReleaseEvidence opens only a no-follow regular tarball",t => {
  const cwd=createRepository(t);
  const realTarball=join(cwd,TARBALL_NAME);
  const symlinkDirectory=join(cwd,"symlink-fixture");
  mkdirSync(symlinkDirectory);
  const linkedTarball=join(symlinkDirectory,TARBALL_NAME);
  symlinkSync(realTarball,linkedTarball);
  assert.throws(
    () => createReleaseEvidence(createInput(cwd,{tarballPath:linkedTarball})),
    /symbolic link|too many levels|no-follow|regular file/i,
  );
  const directoryRoot=join(cwd,"directory-fixture");
  mkdirSync(directoryRoot);
  const directoryTarball=join(directoryRoot,TARBALL_NAME);
  mkdirSync(directoryTarball);
  assert.throws(
    () => createReleaseEvidence(createInput(cwd,{tarballPath:directoryTarball})),
    /regular file/i,
  );
});

test("atomic evidence output is exclusive, canonical, and residue-free",t => {
  const cwd=createRepository(t);
  const value=evidenceFixture();
  let observedTemporary;
  let observedOptions;
  writeReleaseEvidenceJson(cwd,"release-evidence.json",value,{
    writeTemporary:(temporary,contents,options) => {
      observedTemporary=temporary;
      observedOptions=options;
      writeFileSync(temporary,contents,options);
    },
  });
  assert.equal(dirname(observedTemporary),realpathSync(cwd));
  assert.equal(observedOptions.flag,"wx");
  assert.equal(observedOptions.mode,0o600);
  assert.equal(readFileSync(join(cwd,"release-evidence.json"),"utf8"),canonicalJson(value));
  assert.deepEqual(readdirSync(cwd).filter(name => name.includes(".tmp")),[]);
});

test("evidence output rejects unsafe, existing, symlinked, and tracked destinations",t => {
  const cwd=createRepository(t);
  const value=evidenceFixture();
  for (const output of [
    "../release-evidence.json",
    "/tmp/release-evidence.json",
    "./release-evidence.json",
    "nested/../release-evidence.json",
    "release.json",
    "release-evidence.json\0suffix",
    "nested\\release-evidence.json",
  ]) {
    assert.throws(
      () => writeReleaseEvidenceJson(cwd,output,value),
      /safe|destination|output/i,
      output,
    );
  }
  writeFileSync(join(cwd,"release-evidence.json"),"existing\n");
  assert.throws(
    () => writeReleaseEvidenceJson(cwd,"release-evidence.json",value),
    /already exists/i,
  );
  unlinkSync(join(cwd,"release-evidence.json"));
  const outside=join(cwd,"outside.json");
  writeFileSync(outside,"outside\n");
  symlinkSync(outside,join(cwd,"release-evidence.json"));
  assert.throws(
    () => writeReleaseEvidenceJson(cwd,"release-evidence.json",value),
    /symbolic link|symlink/i,
  );
  assert.equal(readFileSync(outside,"utf8"),"outside\n");
  unlinkSync(join(cwd,"release-evidence.json"));
  writeFileSync(join(cwd,"release-evidence.json"),canonicalJson(value));
  execFileSync("git",["add","-f","release-evidence.json"],{cwd,stdio:"pipe"});
  unlinkSync(join(cwd,"release-evidence.json"));
  assert.throws(
    () => writeReleaseEvidenceJson(cwd,"release-evidence.json",value),
    /tracked/i,
  );
  assert.equal(isAbsolute("release-evidence.json"),false);
});

test("evidence output tracking treats pathspec magic as a literal repository-relative path",t => {
  const cwd=createRepository(t);
  mkdirSync(join(cwd,"magic?"));
  mkdirSync(join(cwd,"magica"));
  writeFileSync(join(cwd,"magica","release-evidence.json"),"tracked sibling\n");
  execFileSync("git",["add","magica/release-evidence.json"],{cwd,stdio:"pipe"});

  writeReleaseEvidenceJson(cwd,"magic?/release-evidence.json",evidenceFixture());

  assert.equal(
    readFileSync(join(cwd,"magic?","release-evidence.json"),"utf8"),
    canonicalJson(evidenceFixture()),
  );
  assert.equal(readFileSync(join(cwd,"magica","release-evidence.json"),"utf8"),"tracked sibling\n");
});

test("evidence output rejects the exact tracked destination from a repository subdirectory",t => {
  const cwd=createRepository(t);
  const nested=join(cwd,"nested");
  const destination=join(nested,"release-evidence.json");
  mkdirSync(nested);
  writeFileSync(destination,"tracked evidence\n");
  execFileSync("git",["add","nested/release-evidence.json"],{cwd,stdio:"pipe"});
  unlinkSync(destination);

  assert.throws(
    () => writeReleaseEvidenceJson(nested,"release-evidence.json",evidenceFixture()),
    /tracked/i,
  );
  assert.equal(readdirSync(nested).includes("release-evidence.json"),false);
  assert.deepEqual(readdirSync(nested).filter(entry => entry.includes(".tmp")),[]);
});

test("evidence output permits a safe untracked destination from a repository subdirectory",t => {
  const cwd=createRepository(t);
  const nested=join(cwd,"untracked");
  mkdirSync(nested);

  writeReleaseEvidenceJson(nested,"release-evidence.json",evidenceFixture());

  assert.equal(
    readFileSync(join(nested,"release-evidence.json"),"utf8"),
    canonicalJson(evidenceFixture()),
  );
  assert.deepEqual(readdirSync(nested).filter(entry => entry.includes(".tmp")),[]);
});

test("evidence output fails closed on Git tracking errors without writer residue",t => {
  const failures=[
    {name:"spawn",result:{status:null,signal:null,error:new Error("injected Git spawn failure")}},
    {name:"fatal",result:{status:128,signal:null}},
    {name:"signal",result:{status:null,signal:"SIGTERM"}},
  ];
  for (const {name,result} of failures) {
    const cwd=createRepository(t);
    const parent=join(cwd,`git-${name}`);
    mkdirSync(parent);

    assert.throws(
      () => writeReleaseEvidenceJson(cwd,`git-${name}/release-evidence.json`,evidenceFixture(),{
        runGit:(_command,arguments_) => arguments_[0]==="rev-parse"
          ? {status:0,signal:null,stdout:`${cwd}\n`}
          : result,
      }),
      /Git.*track|track.*Git|determine.*tracked/i,
    );
    assert.equal(readdirSync(parent).includes("release-evidence.json"),false);
    assert.deepEqual(readdirSync(parent).filter(entry => entry.includes(".tmp")),[]);
  }
});

test("evidence output fails closed on invalid Git top-level discovery without residue",t => {
  const failures=[
    {
      name:"fatal",
      topLevel:{status:128,signal:null,stdout:""},
    },
    {
      name:"outside",
      topLevel:{
        status:0,
        signal:null,
        stdout:`${mkdtempSync(join(tmpdir(),"toss-git-root-outside-"))}\n`,
      },
    },
  ];
  t.after(() => {
    for (const {topLevel} of failures) {
      if (topLevel.stdout) rmSync(topLevel.stdout.trim(),{recursive:true,force:true});
    }
  });
  for (const {name,topLevel} of failures) {
    const cwd=createRepository(t);
    const parent=join(cwd,`top-${name}`);
    mkdirSync(parent);

    assert.throws(
      () => writeReleaseEvidenceJson(cwd,`top-${name}/release-evidence.json`,evidenceFixture(),{
        runGit:(_command,arguments_) => arguments_[0]==="rev-parse"
          ? topLevel
          : {status:1,signal:null},
      }),
      /Git.*top|repository.*root|outside/i,
    );
    assert.equal(readdirSync(parent).includes("release-evidence.json"),false);
    assert.deepEqual(readdirSync(parent).filter(entry => entry.includes(".tmp")),[]);
  }
});

test("publication races never clobber the winner and remove the temporary",t => {
  const cwd=createRepository(t);
  const destination=join(cwd,"release-evidence.json");
  assert.throws(
    () => writeReleaseEvidenceJson(cwd,"release-evidence.json",evidenceFixture(),{
      publishTemporary:(temporary,target) => {
        writeFileSync(target,"winner\n");
        linkSync(temporary,target);
      },
    }),
    /EEXIST|exist/i,
  );
  assert.equal(readFileSync(destination,"utf8"),"winner\n");
  assert.deepEqual(readdirSync(cwd).filter(name => name.includes(".tmp")),[]);
});

test("temporary cleanup preserves the primary writer failure and records cleanup evidence",t => {
  const cwd=createRepository(t);
  const partial=new Error("partial evidence write failure");
  assert.throws(
    () => writeReleaseEvidenceJson(cwd,"release-evidence.json",evidenceFixture(),{
      writeTemporary:temporary => {
        writeFileSync(temporary,"partial");
        throw partial;
      },
    }),
    error => error===partial,
  );
  assert.deepEqual(readdirSync(cwd).filter(name => name.includes(".tmp")),[]);

  const primary=new Error("primary evidence write failure");
  const cleanup=new Error("evidence cleanup failure");
  let observed;
  try {
    writeReleaseEvidenceJson(cwd,"release-evidence.json",evidenceFixture(),{
      writeTemporary:() => { throw primary; },
      removeTemporary:() => { throw cleanup; },
    });
  } catch (error) {
    observed=error;
  }
  assert.equal(observed,primary);
  assert.equal(observed.message,"primary evidence write failure");
  assert.equal(observed.cleanupError,cleanup);

  const cleanupOnly=new Error("standalone evidence cleanup failure");
  assert.throws(
    () => writeReleaseEvidenceJson(cwd,"release-evidence.json",evidenceFixture(),{
      writeTemporary:() => {},
      publishTemporary:() => {},
      removeTemporary:() => { throw cleanupOnly; },
    }),
    error => error===cleanupOnly,
  );
});

test("the CLI derives, writes, and independently validates release-evidence.json",t => {
  const cwd=createRepository(t);
  writeFileSync(join(cwd,"metadata.json"),JSON.stringify(metadataFixture()));
  writeFileSync(join(cwd,"release.json"),JSON.stringify(releaseFixture()));
  const args=[
    evidenceScript,"create","metadata.json",TARBALL_NAME,
    "@toss-software/cli@2.1.1","@toss-soft/cli@2.1.1",
    "release.json","release-evidence.json",
  ];
  const env={
    ...process.env,
    GITHUB_REF_NAME:"v2.1.1",
    GITHUB_REPOSITORY:"TOSS-Soft/toss-cli",
    GITHUB_RUN_ID:"123",
  };
  const create=spawnSync(process.execPath,args,{cwd,env,encoding:"utf8"});
  assert.equal(create.status,0,create.stderr);
  assert.equal(create.stdout,"");
  assert.equal(create.stderr,"");
  const expected={
    ...evidenceFixture(),
    tarball:{name:TARBALL_NAME,sha256:TARBALL_SHA256},
  };
  assert.equal(readFileSync(join(cwd,"release-evidence.json"),"utf8"),canonicalJson(expected));
  const validate=spawnSync(
    process.execPath,[evidenceScript,"validate","release-evidence.json"],
    {cwd,env,encoding:"utf8"},
  );
  assert.equal(validate.status,0,validate.stderr);
  assert.equal(validate.stdout,"");
  assert.equal(validate.stderr,"");
  assert.deepEqual(readdirSync(cwd).filter(name => name.includes(".tmp")),[]);
});

test("the CLI rejects digest mismatch and unsafe output without residue",t => {
  const cwd=createRepository(t);
  writeFileSync(join(cwd,"metadata.json"),JSON.stringify(metadataFixture()));
  writeFileSync(join(cwd,"release.json"),JSON.stringify(releaseFixture({digest:"d".repeat(64)})));
  const common=[
    evidenceScript,"create","metadata.json",TARBALL_NAME,
    "@toss-software/cli@2.1.1","@toss-soft/cli@2.1.1","release.json",
  ];
  const env={
    ...process.env,
    GITHUB_REF_NAME:"v2.1.1",
    GITHUB_REPOSITORY:"TOSS-Soft/toss-cli",
    GITHUB_RUN_ID:"123",
  };
  const mismatch=spawnSync(process.execPath,[...common,"release-evidence.json"],{
    cwd,env,encoding:"utf8",
  });
  assert.notEqual(mismatch.status,0);
  assert.match(mismatch.stderr,/digest.*match|match.*digest/i);
  assert.equal(readdirSync(cwd).some(name => name.startsWith(".release-evidence.json.")),false);
  writeFileSync(join(cwd,"release.json"),JSON.stringify(releaseFixture()));
  const unsafe=spawnSync(process.execPath,[...common,"../release-evidence.json"],{
    cwd,env,encoding:"utf8",
  });
  assert.notEqual(unsafe.status,0);
  assert.match(unsafe.stderr,/safe|destination|output/i);
  assert.equal(readdirSync(cwd).some(name => name.startsWith(".release-evidence.json.")),false);
});
