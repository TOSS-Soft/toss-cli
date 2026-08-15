import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root=path.resolve(".");
const cli=path.join(root,"bin","toss.js");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-overlay-safety-"));

function runCli(args) {
  return spawnSync(process.execPath,[cli,...args],{
    cwd:tmp,
    encoding:"utf8",
  });
}

function writeBrief(file,{name,slug,delivery}) {
  const brief=YAML.parse(
    fs.readFileSync(path.join(root,"templates","project-brief.yaml"),"utf8"),
  );
  brief.project.name=name;
  brief.project.slug=slug;
  brief.project.description="Force-overlay safety fixture";
  brief.business.problem="Prevent hybrid governance output";
  brief.business.primary_goal="Reject ambiguous profile overlays";
  brief.governance.delivery=delivery;
  brief.delivery.create_github_repository=false;
  brief.delivery.create_github_project=false;
  brief.delivery.apply_main_ruleset=false;
  const briefPath=path.join(tmp,file);
  fs.writeFileSync(briefPath,YAML.stringify(brief),"utf8");
  return briefPath;
}

function assertSuccess(result,label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function assertRejected(result,pattern,label) {
  assert.notEqual(result.status,0,`${label} unexpectedly succeeded`);
  assert.match(
    result.stderr,
    pattern,
    `${label} reported the wrong refusal\nstderr:\n${result.stderr}`,
  );
}

try {
  const coreSlug="core-to-delivery-overlay";
  const coreBrief=writeBrief("core.yaml",{
    name:"Core Overlay Project",
    slug:coreSlug,
    delivery:false,
  });
  assertSuccess(runCli(["create",coreBrief]),"initial Core generation");
  const coreProject=path.join(tmp,coreSlug);
  const coreStateBefore=fs.readFileSync(path.join(coreProject,"project.json"),"utf8");
  const deliveryBrief=writeBrief("core-to-delivery.yaml",{
    name:"Core Overlay Project",
    slug:coreSlug,
    delivery:true,
  });
  const coreToDelivery=runCli(["create",deliveryBrief,"--force"]);
  assertRejected(
    coreToDelivery,
    /Refusing --force profile overlay from Core to Core\+Delivery/i,
    "Core-to-Delivery force overlay",
  );
  assert.equal(
    fs.readFileSync(path.join(coreProject,"project.json"),"utf8"),
    coreStateBefore,
    "Core-to-Delivery refusal mutated project state",
  );
  assert.equal(
    fs.existsSync(path.join(coreProject,"project-management","policies","DELIVERY.md")),
    false,
    "Core-to-Delivery refusal installed Delivery assets",
  );

  const deliverySlug="delivery-to-core-overlay";
  const initialDeliveryBrief=writeBrief("delivery.yaml",{
    name:"Delivery Overlay Project",
    slug:deliverySlug,
    delivery:true,
  });
  assertSuccess(runCli(["create",initialDeliveryBrief]),"initial Delivery generation");
  const deliveryProject=path.join(tmp,deliverySlug);
  const deliveryStateBefore=fs.readFileSync(path.join(deliveryProject,"project.json"),"utf8");
  const deliveryPolicy=path.join(
    deliveryProject,
    "project-management","policies","DELIVERY.md",
  );
  const deliveryPolicyBefore=fs.readFileSync(deliveryPolicy,"utf8");
  const deliveryToCore=runCli([
    "Delivery Overlay Replacement",
    "--slug",deliverySlug,
    "--dir",deliveryProject,
    "--no-git",
    "--force",
  ]);
  assertRejected(
    deliveryToCore,
    /Refusing --force profile overlay from Core\+Delivery to Core/i,
    "Delivery-to-Core force overlay",
  );
  assert.equal(
    fs.readFileSync(path.join(deliveryProject,"project.json"),"utf8"),
    deliveryStateBefore,
    "Delivery-to-Core refusal rewrote project state",
  );
  assert.equal(
    fs.readFileSync(deliveryPolicy,"utf8"),
    deliveryPolicyBefore,
    "Delivery-to-Core refusal rewrote Delivery governance",
  );

  const legacyProject=path.join(tmp,"legacy-v1-project");
  const legacyPolicy=path.join(
    legacyProject,
    "project-management","policies","SECURITY.md",
  );
  fs.mkdirSync(path.dirname(legacyPolicy),{recursive:true});
  fs.writeFileSync(legacyPolicy,"# Project-specific v1 security policy\n","utf8");
  const legacyState={
    governance:{version:"1.6.0",root:"project-management"},
    bootstrap_state:{project_brief:"LOADED"},
  };
  fs.writeFileSync(
    path.join(legacyProject,"project.json"),
    JSON.stringify(legacyState,null,2)+"\n",
    "utf8",
  );
  const legacyStateBefore=fs.readFileSync(path.join(legacyProject,"project.json"),"utf8");
  const legacyToV2=runCli([
    "Legacy v1 Project",
    "--slug","legacy-v1-project",
    "--dir",legacyProject,
    "--no-git",
    "--force",
  ]);
  assertRejected(
    legacyToV2,
    /Refusing --force.*governance v1.*manual migration/i,
    "v1-to-v2 force overlay",
  );
  assert.equal(
    fs.readFileSync(path.join(legacyProject,"project.json"),"utf8"),
    legacyStateBefore,
    "v1-to-v2 refusal rewrote legacy project state",
  );
  assert.equal(
    fs.readFileSync(legacyPolicy,"utf8"),
    "# Project-specific v1 security policy\n",
    "v1-to-v2 refusal rewrote a populated legacy policy",
  );

  const sameProfile=runCli([
    "Core Overlay Project",
    "--slug",coreSlug,
    "--dir",coreProject,
    "--no-git",
    "--force",
  ]);
  assertSuccess(sameProfile,"same-profile Core force refresh");
  const refreshedState=JSON.parse(
    fs.readFileSync(path.join(coreProject,"project.json"),"utf8"),
  );
  assert.deepEqual(refreshedState.governance.profiles,{core:true,delivery:false});

  const outsideRuntimeTarget=path.join(tmp,"outside-runtime-target.md");
  fs.writeFileSync(outsideRuntimeTarget,"outside sentinel\n","utf8");
  const generatedReadme=path.join(coreProject,"README.md");
  fs.rmSync(generatedReadme);
  fs.symlinkSync(outsideRuntimeTarget,generatedReadme);
  const runtimeSymlinkOverlay=runCli([
    "Core Overlay Project",
    "--slug",coreSlug,
    "--dir",coreProject,
    "--no-git",
    "--force",
  ]);
  assertRejected(
    runtimeSymlinkOverlay,
    /Refusing --force.*symbolic link.*README\.md/i,
    "same-profile runtime-template symlink overlay",
  );
  assert.equal(
    fs.readFileSync(outsideRuntimeTarget,"utf8"),
    "outside sentinel\n",
    "same-profile force overlay wrote through a runtime-template symlink",
  );

  console.log("Force overlay safety test: PASS");
} finally {
  fs.rmSync(tmp,{recursive:true,force:true});
}
