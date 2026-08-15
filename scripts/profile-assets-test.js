import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  copyProfileAssets,
  loadProfileManifest,
  validateContainedFileTargets,
} from "../src/profile-assets.js";

const EXPECTED_CORE_FILES=[
  "project-management/GOVERNANCE.md",
  "project-management/WORK.md",
  "project-management/QUALITY.md",
  "project-management/PROJECT_STATE.md",
  "project-management/AGENT_REGISTRY.md",
  "project-management/templates/OBJECTIVE.md",
  "project-management/templates/TASK.md",
  "project-management/templates/DECISION.md",
  "project-management/templates/RISK.md",
  "project-management/templates/WAIVER.md",
];

const EXPECTED_DELIVERY_FILES=[
  "project-management/policies/DELIVERY.md",
  "project-management/policies/OPERATIONS.md",
  "project-management/templates/RELEASE.md",
  "project-management/templates/INCIDENT.md",
  "project-management/templates/DATAFIX.md",
];

const root=path.resolve(".");
const coreProfile=path.join(root,"templates","governance","core");
const deliveryProfile=path.join(root,"templates","governance","profiles","delivery");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-profile-assets-"));

function writeManifest(profileRoot,manifest) {
  fs.mkdirSync(profileRoot,{recursive:true});
  fs.writeFileSync(
    path.join(profileRoot,"manifest.json"),
    JSON.stringify(manifest,null,2),
    "utf8",
  );
}

function writeAsset(profileRoot,relativePath,content="asset") {
  const file=path.join(profileRoot,...relativePath.split("/"));
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,content,"utf8");
}

function fixture(name,manifest,assets=[]) {
  const profileRoot=path.join(tmp,name);
  writeManifest(profileRoot,manifest);
  for (const asset of assets) writeAsset(profileRoot,asset);
  return profileRoot;
}

try {
  const coreManifest=loadProfileManifest(coreProfile);
  assert.equal(coreManifest.profile,"core");
  assert.equal(coreManifest.version,"2.0.0");
  assert.deepEqual(coreManifest.files,EXPECTED_CORE_FILES);
  for (const relativePath of coreManifest.files) {
    assert.equal(
      fs.statSync(path.join(coreProfile,...relativePath.split("/"))).isFile(),
      true,
      `${relativePath} is not a regular file`,
    );
  }

  const deliveryManifest=loadProfileManifest(deliveryProfile);
  assert.equal(deliveryManifest.profile,"delivery");
  assert.equal(deliveryManifest.version,"2.0.0");
  assert.deepEqual(deliveryManifest.files,EXPECTED_DELIVERY_FILES);
  for (const relativePath of deliveryManifest.files) {
    assert.equal(
      fs.statSync(path.join(deliveryProfile,...relativePath.split("/"))).isFile(),
      true,
      `${relativePath} is not a regular file`,
    );
  }

  assert.throws(
    () => loadProfileManifest(fixture("empty-profile",{
      profile:"",
      version:"2.0.0",
      files:[],
    })),
    /profile.*non-empty string/i,
  );
  assert.throws(
    () => loadProfileManifest(fixture("non-string-profile",{
      profile:42,
      version:"2.0.0",
      files:[],
    })),
    /profile.*non-empty string/i,
  );
  assert.throws(
    () => loadProfileManifest(fixture("wrong-version",{
      profile:"fixture",
      version:"1.0.0",
      files:[],
    })),
    /version must be 2\.0\.0/i,
  );
  assert.throws(
    () => loadProfileManifest(fixture("duplicate",{
      profile:"fixture",
      version:"2.0.0",
      files:["project-management/WORK.md","project-management/WORK.md"],
    },["project-management/WORK.md"])),
    /duplicate/i,
  );
  assert.throws(
    () => loadProfileManifest(fixture("dot-alias",{
      profile:"fixture",
      version:"2.0.0",
      files:["dir/asset.md","dir/./asset.md"],
    },["dir/asset.md"])),
    /duplicate/i,
  );
  assert.throws(
    () => loadProfileManifest(fixture("separator-alias",{
      profile:"fixture",
      version:"2.0.0",
      files:["dir/asset.md","dir\\asset.md"],
    },["dir/asset.md","dir\\asset.md"])),
    /duplicate/i,
  );
  for (const relativePath of [
    path.resolve(tmp,"outside.md"),
    "C:\\outside.md",
    "\\\\server\\share\\outside.md",
    "\\rooted.md",
  ]) {
    assert.throws(
      () => loadProfileManifest(fixture(`absolute-${relativePath.length}`,{
        profile:"fixture",
        version:"2.0.0",
        files:[relativePath],
      })),
      /Unsafe profile asset path/,
    );
  }
  assert.throws(
    () => loadProfileManifest(fixture("traversal",{
      profile:"fixture",
      version:"2.0.0",
      files:["project-management/../outside.md"],
    })),
    /Unsafe profile asset path/,
  );
  assert.throws(
    () => loadProfileManifest(fixture("missing",{
      profile:"fixture",
      version:"2.0.0",
      files:["project-management/MISSING.md"],
    })),
    /missing|regular file/i,
  );
  assert.throws(
    () => loadProfileManifest(fixture("non-array",{
      profile:"fixture",
      version:"2.0.0",
      files:"project-management/WORK.md",
    })),
    /files.*array/i,
  );

  const outsideSourceFile=path.join(tmp,"outside-source-file.md");
  fs.writeFileSync(outsideSourceFile,"outside source\n","utf8");
  const sourceSymlinkProfile=fixture("source-symlink",{
    profile:"fixture",
    version:"2.0.0",
    files:["project-management/WORK.md"],
  });
  fs.mkdirSync(path.join(sourceSymlinkProfile,"project-management"),{recursive:true});
  fs.symlinkSync(
    outsideSourceFile,
    path.join(sourceSymlinkProfile,"project-management","WORK.md"),
  );
  assert.throws(
    () => loadProfileManifest(sourceSymlinkProfile),
    /symbolic link|symlink/i,
    "manifest loading followed a source-file symlink",
  );

  const outsideSourceDirectory=path.join(tmp,"outside-source-directory");
  fs.mkdirSync(outsideSourceDirectory);
  fs.writeFileSync(path.join(outsideSourceDirectory,"WORK.md"),"outside ancestor\n","utf8");
  const sourceAncestorProfile=fixture("source-ancestor-symlink",{
    profile:"fixture",
    version:"2.0.0",
    files:["project-management/WORK.md"],
  });
  fs.symlinkSync(
    outsideSourceDirectory,
    path.join(sourceAncestorProfile,"project-management"),
    "dir",
  );
  assert.throws(
    () => loadProfileManifest(sourceAncestorProfile),
    /symbolic link|symlink/i,
    "manifest loading followed a source-ancestor symlink",
  );

  const validProfile=fixture("valid",{
    profile:"fixture",
    version:"2.0.0",
    files:["project-management/WORK.md","project-management/templates/TASK.md"],
  },["project-management/WORK.md","project-management/templates/TASK.md"]);
  const destination=path.join(tmp,"destination");
  const validatedManifest=loadProfileManifest(validProfile);

  const outsideDestinationDirectory=path.join(tmp,"outside-destination-directory");
  const ancestorSymlinkDestination=path.join(tmp,"ancestor-symlink-destination");
  fs.mkdirSync(outsideDestinationDirectory);
  fs.mkdirSync(ancestorSymlinkDestination);
  fs.symlinkSync(
    outsideDestinationDirectory,
    path.join(ancestorSymlinkDestination,"project-management"),
    "dir",
  );
  assert.throws(
    () => copyProfileAssets(validProfile,ancestorSymlinkDestination,validatedManifest),
    /destination.*symbolic link|symlink.*destination/i,
    "profile copying followed a destination-ancestor symlink",
  );
  assert.equal(
    fs.existsSync(path.join(outsideDestinationDirectory,"WORK.md")),
    false,
    "profile copying wrote through a destination-ancestor symlink",
  );

  const outsideDestinationFile=path.join(tmp,"outside-destination-file.md");
  const fileSymlinkDestination=path.join(tmp,"file-symlink-destination");
  fs.writeFileSync(outsideDestinationFile,"outside destination\n","utf8");
  fs.mkdirSync(path.join(fileSymlinkDestination,"project-management"),{recursive:true});
  fs.symlinkSync(
    outsideDestinationFile,
    path.join(fileSymlinkDestination,"project-management","WORK.md"),
  );
  assert.throws(
    () => copyProfileAssets(validProfile,fileSymlinkDestination,validatedManifest),
    /destination.*symbolic link|symlink.*destination/i,
    "profile copying followed a destination-file symlink",
  );
  assert.equal(
    fs.readFileSync(outsideDestinationFile,"utf8"),
    "outside destination\n",
    "profile copying mutated a destination-file symlink target",
  );

  const outsideDestinationRoot=path.join(tmp,"outside-destination-root");
  const symlinkDestinationRoot=path.join(tmp,"symlink-destination-root");
  fs.mkdirSync(outsideDestinationRoot);
  fs.symlinkSync(outsideDestinationRoot,symlinkDestinationRoot,"dir");
  assert.throws(
    () => copyProfileAssets(validProfile,symlinkDestinationRoot,validatedManifest),
    /destination root.*symbolic link|symbolic link.*destination root/i,
    "profile copying accepted a symlink destination root",
  );
  assert.equal(
    fs.existsSync(path.join(outsideDestinationRoot,"project-management","WORK.md")),
    false,
    "profile copying wrote through a symlink destination root",
  );

  const lateOutsideDirectory=path.join(tmp,"late-outside-destination");
  const lateSymlinkDestination=path.join(tmp,"late-symlink-destination");
  fs.mkdirSync(lateOutsideDirectory);
  fs.mkdirSync(path.join(lateSymlinkDestination,"project-management"),{
    recursive:true,
  });
  fs.writeFileSync(
    path.join(lateSymlinkDestination,"project-management","WORK.md"),
    "original destination\n",
    "utf8",
  );
  fs.symlinkSync(
    lateOutsideDirectory,
    path.join(lateSymlinkDestination,"project-management","templates"),
    "dir",
  );
  assert.throws(
    () => copyProfileAssets(validProfile,lateSymlinkDestination,validatedManifest),
    /destination.*symbolic link|symlink.*destination/i,
    "profile copying accepted a later destination-ancestor symlink",
  );
  assert.equal(
    fs.readFileSync(
      path.join(lateSymlinkDestination,"project-management","WORK.md"),
      "utf8",
    ),
    "original destination\n",
    "profile copying mutated earlier assets before rejecting a later symlink",
  );
  assert.equal(
    fs.existsSync(path.join(lateOutsideDirectory,"TASK.md")),
    false,
    "profile copying wrote a later asset outside the destination root",
  );

  const readOnlyPreflightDestination=path.join(tmp,"read-only-preflight");
  const readOnlyPreflightOutside=path.join(tmp,"read-only-preflight-outside");
  fs.mkdirSync(
    path.join(readOnlyPreflightDestination,"project-management"),
    {recursive:true},
  );
  fs.mkdirSync(readOnlyPreflightOutside);
  fs.symlinkSync(
    readOnlyPreflightOutside,
    path.join(readOnlyPreflightDestination,"project-management","bootstrap"),
    "dir",
  );
  assert.throws(
    () => validateContainedFileTargets(readOnlyPreflightDestination,[
      "project-management/design/DESIGN_BRIEF.md",
      "project-management/bootstrap/PROJECT_BRIEF.json",
    ]),
    /destination.*symbolic link|symlink.*destination/i,
    "target preflight accepted a later destination-ancestor symlink",
  );
  assert.equal(
    fs.existsSync(
      path.join(readOnlyPreflightDestination,"project-management","design"),
    ),
    false,
    "target preflight created an earlier missing directory before refusal",
  );

  fs.rmSync(path.join(validProfile,"manifest.json"));
  copyProfileAssets(validProfile,destination,validatedManifest);
  for (const relativePath of ["project-management/WORK.md","project-management/templates/TASK.md"]) {
    assert.equal(
      fs.readFileSync(path.join(destination,...relativePath.split("/")),"utf8"),
      "asset",
      `${relativePath} was not copied to its relative destination`,
    );
  }

  console.log("Profile assets test: PASS");
} finally {
  fs.rmSync(tmp,{recursive:true,force:true});
}
