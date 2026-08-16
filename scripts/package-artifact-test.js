import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

const root=path.resolve(".");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-package-artifact-"));

function resolveNpmRoot() {
  const candidates=[
    process.env.npm_execpath
      ? path.resolve(path.dirname(process.env.npm_execpath),"..")
      : null,
    process.env.CODEX_PRIMARY_RUNTIME_ROOT
      ? path.join(
          process.env.CODEX_PRIMARY_RUNTIME_ROOT,
          "dependencies","node","lib","node_modules","npm",
        )
      : null,
    path.resolve(path.dirname(process.execPath),"..","lib","node_modules","npm"),
  ].filter(Boolean);
  const npmRoot=candidates.find(candidate =>
    fs.existsSync(path.join(candidate,"node_modules","libnpmpack","package.json")));
  assert.ok(npmRoot,"Unable to locate npm's packing implementation");
  return npmRoot;
}

function run(command,args,options={}) {
  return spawnSync(command,args,{
    cwd:options.cwd ?? root,
    encoding:"utf8",
    env:options.env ?? process.env,
  });
}

function assertSuccess(result,label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function installYaml(packageRoot) {
  const nodeModules=path.join(packageRoot,"node_modules");
  fs.mkdirSync(nodeModules,{recursive:true});
  fs.cpSync(path.join(root,"node_modules","yaml"),path.join(nodeModules,"yaml"),{
    recursive:true,
  });
}

function runPackedCli(packageRoot,args,cwd) {
  return run(process.execPath,[path.join(packageRoot,"bin","toss.js"),...args],{cwd});
}

try {
  const npmRequire=createRequire(path.join(resolveNpmRoot(),"package.json"));
  const npmPack=npmRequire("libnpmpack");
  const npmTar=npmRequire("tar");
  const tarball=await npmPack(root,{ignoreScripts:true});
  const artifact=path.join(tmp,"toss-cli-2.0.0.tgz");
  fs.writeFileSync(artifact,tarball);
  const packedFiles=[];
  await npmTar.t({
    file:artifact,
    onReadEntry:entry => packedFiles.push(entry.path),
  });

  const extractRoot=path.join(tmp,"extracted");
  fs.mkdirSync(extractRoot);
  await npmTar.x({file:artifact,cwd:extractRoot});
  const packedRoot=path.join(extractRoot,"package");
  installYaml(packedRoot);

  const brokenRoot=path.join(tmp,"broken-package");
  fs.cpSync(packedRoot,brokenRoot,{recursive:true});
  fs.rmSync(path.join(brokenRoot,"templates","gitignore.template"),{force:true});
  const brokenDestination=path.join(tmp,"broken-output");
  const brokenResult=runPackedCli(
    brokenRoot,
    ["Broken Packed Project","--slug","broken-packed-project","--dir",brokenDestination,"--no-git"],
    tmp,
  );
  assert.notEqual(brokenResult.status,0,"packed CLI accepted a missing runtime template");
  assert.equal(
    fs.existsSync(brokenDestination),
    false,
    "packed CLI partially created a destination before reporting a missing runtime template",
  );

  assert.ok(
    packedFiles.includes("package/templates/gitignore.template"),
    "packed artifact omits the generated-project gitignore template",
  );

  const createWorkspace=path.join(tmp,"create-workspace");
  fs.mkdirSync(createWorkspace);
  const brief=YAML.parse(
    fs.readFileSync(path.join(packedRoot,"templates","project-brief.yaml"),"utf8"),
  );
  brief.project.name="Packed Create Project";
  brief.project.slug="packed-create-project";
  brief.project.description="Execute toss create from the packed artifact";
  brief.business.problem="Validate the shipped CLI";
  brief.business.primary_goal="Generate a complete Delivery project";
  brief.governance.delivery=true;
  brief.delivery.create_github_repository=false;
  brief.delivery.create_github_project=false;
  brief.delivery.apply_main_ruleset=false;
  const briefPath=path.join(createWorkspace,"project-brief.yaml");
  fs.writeFileSync(briefPath,YAML.stringify(brief),"utf8");

  const createResult=runPackedCli(packedRoot,["create",briefPath],createWorkspace);
  assertSuccess(createResult,"packed toss create");
  const createProject=path.join(createWorkspace,"packed-create-project");

  const fastDestination=path.join(tmp,"packed-fast-project");
  const fastResult=runPackedCli(
    packedRoot,
    ["Packed Fast Project","--slug","packed-fast-project","--dir",fastDestination,"--no-git"],
    tmp,
  );
  assertSuccess(fastResult,"packed fast scaffold");

  for (const project of [createProject,fastDestination]) {
    assert.equal(
      fs.readFileSync(path.join(project,".gitignore"),"utf8"),
      fs.readFileSync(path.join(packedRoot,"templates","gitignore.template"),"utf8"),
      `${path.basename(project)} generated an unexpected .gitignore`,
    );
  }

  const integrityModule=await import(pathToFileURL(
    path.join(packedRoot,"src","reference-integrity.js"),
  ));
  integrityModule.validateGeneratedProject(createProject);
  integrityModule.validateGeneratedProject(fastDestination);

  console.log("Packed artifact execution test: PASS");
} finally {
  fs.rmSync(tmp,{recursive:true,force:true});
}
