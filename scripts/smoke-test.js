import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root=path.resolve(".");
const cli=path.join(root,"bin","toss.js");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-cli-"));
const releasePackageMetadata=JSON.parse(
  fs.readFileSync(path.join(root,"package.json"),"utf8"),
);
const lockMetadata=JSON.parse(
  fs.readFileSync(path.join(root,"package-lock.json"),"utf8"),
);
const packageVersion=releasePackageMetadata.version;

function runCli(args,options={}) {
  return spawnSync(process.execPath,[cli,...args],{
    cwd:options.cwd||root,
    encoding:"utf8",
  });
}

function assertSuccess(result,label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function completeBrief(data,{name,slug}={}) {
  data.project.name=name||"Design Smoke Project";
  data.project.slug=slug||"design-smoke-project";
  data.project.description="Design bootstrap smoke test";
  data.business.problem="Validate TOSS design bootstrap";
  data.business.primary_goal="Create governed design artifacts";
  return data;
}

function writeYaml(file,data) {
  fs.writeFileSync(file,YAML.stringify(data),"utf8");
}

assert.equal(releasePackageMetadata.name,"@toss-software/cli");
assert.equal(releasePackageMetadata.bin?.toss,"bin/toss.js");
assert.equal(lockMetadata.name,releasePackageMetadata.name);
assert.equal(lockMetadata.version,releasePackageMetadata.version);
assert.equal(lockMetadata.packages[""].name,releasePackageMetadata.name);
assert.equal(lockMetadata.packages[""].version,releasePackageMetadata.version);
assert.deepEqual(lockMetadata.packages[""].bin,releasePackageMetadata.bin);

let result=runCli(["--version"]);
assertSuccess(result,"toss --version");
assert.equal(result.stdout.trim(),packageVersion);

result=runCli(["--help"]);
assertSuccess(result,"toss --help");
assert.match(result.stdout,/npm install -g @toss-software\/cli/);
assert.doesNotMatch(result.stdout,/npm install -g @toss\/cli/);

const brief=path.join(tmp,"project-brief.yaml");
result=runCli(["init",brief]);
assertSuccess(result,"toss init");

const initialized=YAML.parse(fs.readFileSync(brief,"utf8"));
assert.ok(initialized.design,"toss init did not emit the design brief section");
assert.deepEqual(initialized.design.required,"AUTO");
assert.equal(initialized.design.production_tool,"AUTO");
assert.deepEqual(initialized.design.company_design_system.references,[]);

const explicit=completeBrief(initialized);
explicit.design.required=true;
explicit.design.source="company_system";
explicit.design.company_design_system.name="TOSS Brand System";
explicit.design.company_design_system.references=["docs/brand.md"];
explicit.design.production_tool="pencil";
writeYaml(brief,explicit);

result=runCli(["create",brief],{cwd:tmp});
assertSuccess(result,"toss create with design");

const project=path.join(tmp,"design-smoke-project");
const coreFiles=[
  "AGENTS.md",
  "CLAUDE.md",
  "SUPERPOWERS.md",
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
const deliveryFiles=[
  "project-management/policies/DELIVERY.md",
  "project-management/policies/OPERATIONS.md",
  "project-management/templates/RELEASE.md",
  "project-management/templates/INCIDENT.md",
  "project-management/templates/DATAFIX.md",
];
for (const rel of coreFiles) {
  assert.ok(fs.existsSync(path.join(project,rel)),`Missing ${rel}`);
}
for (const rel of deliveryFiles) {
  assert.ok(!fs.existsSync(path.join(project,rel)),`Unexpected Delivery asset ${rel}`);
}

for (const rel of [
  "project.json",
  "project-management/bootstrap/PROJECT_BRIEF.json",
  "project-management/bootstrap/PROJECT_BRIEF_GUIDE.md",
  "project-management/GLOBAL_AGENT_CATALOG.json",
  "project-management/GLOBAL_AGENT_CATALOG.md",
  "project-management/design/DESIGN_BRIEF.md",
  "project-management/design/DESIGN_SYSTEM.md",
]) {
  assert.ok(fs.existsSync(path.join(project,rel)),`Missing retained bootstrap asset ${rel}`);
}

for (const rel of [
  "project-management/PM_AGENT.md",
  "project-management/policies/LANGSMITH.md",
  "project-management/bootstrap/PM_BOOTSTRAP_STATE.md",
  ".github/workflows/pm-governance-certification.yml",
  ".env.example",
  "project-management/bootstrap/AGENT_CAPABILITY_PLAN.md",
  "project-management/templates/AGENT_PROPOSAL.md",
]) {
  assert.ok(!fs.existsSync(path.join(project,rel)),`Unexpected legacy asset ${rel}`);
}

const claudeBridge=fs.readFileSync(path.join(project,"CLAUDE.md"),"utf8");
assert.equal(claudeBridge,"@AGENTS.md\n");

const agentsBootstrap=fs.readFileSync(path.join(project,"AGENTS.md"),"utf8");
assert.match(agentsBootstrap,/SUPERPOWERS\.md/);
assert.match(agentsBootstrap,/project-management\/WORK\.md/);
assert.match(agentsBootstrap,/project-management\/QUALITY\.md/);
assert.match(agentsBootstrap,/BLOCKED_SUPERPOWERS_MISSING/);

const superpowersContract=fs.readFileSync(path.join(project,"SUPERPOWERS.md"),"utf8");
for (const capability of [
  "superpowers:brainstorming",
  "superpowers:using-superpowers",
  "superpowers:writing-plans",
  "superpowers:using-git-worktrees",
  "superpowers:test-driven-development",
  "superpowers:systematic-debugging",
  "superpowers:subagent-driven-development",
  "superpowers:executing-plans",
  "superpowers:verification-before-completion",
  "superpowers:requesting-code-review",
  "superpowers:receiving-code-review",
  "superpowers:finishing-a-development-branch",
  "superpowers:writing-skills",
]) {
  assert.match(superpowersContract,new RegExp(capability.replaceAll("-","\\-")));
}
assert.match(superpowersContract,/no TOSS execution fallback/i);
assert.doesNotMatch(superpowersContract,/\$superpowers|\/superpowers/);

const generatedReadme=fs.readFileSync(path.join(project,"README.md"),"utf8");
assert.match(generatedReadme,/Superpowers: REQUIRED/);
assert.match(generatedReadme,/AGENTS\.md/);
assert.doesNotMatch(generatedReadme,/Start Claude Code/);

const packageMetadata=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
assert.equal(packageMetadata.version,packageVersion);
assert.ok(packageMetadata.keywords.includes("superpowers"));
assert.ok(packageMetadata.keywords.includes("agent-governance"));

const projectState=JSON.parse(fs.readFileSync(path.join(project,"project.json"),"utf8"));
assert.equal(projectState.governance.version,"2.0.0");
assert.equal(projectState.governance.profiles.core,true);
assert.equal(projectState.governance.profiles.delivery,false);
assert.ok(!Object.hasOwn(projectState,"langsmith"));
assert.ok(!Object.hasOwn(projectState.bootstrap_state,"langsmith"));
assert.equal(projectState.bootstrap_state.design_system,"DISCOVERY_REQUIRED");
assert.deepEqual(projectState.superpowers,{
  requirement:"REQUIRED",
  provider:"UNKNOWN",
  availability:"PENDING_VERIFICATION",
  active_capability:"NONE",
  execution_state:"READY",
  evidence_references:{
    plan:[],
    tests:[],
    reviews:[],
    verification:[],
    branches:[],
    commits:[],
  },
});

const canonicalState=fs.readFileSync(
  path.join(project,"project-management/PROJECT_STATE.md"),
  "utf8",
);
assert.match(canonicalState,/## Superpowers State/);
assert.match(canonicalState,/## Superpowers State\n\nStatus: UNKNOWN/);

const context=JSON.parse(fs.readFileSync(
  path.join(project,"project-management/bootstrap/PROJECT_BRIEF.json"),
  "utf8",
));
assert.equal(context.design.required,true);
assert.equal(context.design.source,"company_system");
assert.equal(context.design.production_tool,"pencil");
assert.equal(context.design.company_design_system.name,"TOSS Brand System");
assert.deepEqual(context.design.company_design_system.references,["docs/brand.md"]);
assert.deepEqual(context.governance,{delivery:false});
assert.ok(!Object.hasOwn(context,"langsmith"));

const deliveryBrief=path.join(tmp,"delivery-project-brief.yaml");
const delivery=completeBrief(structuredClone(explicit),{
  name:"Delivery Smoke Project",
  slug:"delivery-smoke-project",
});
delivery.governance={delivery:true};
writeYaml(deliveryBrief,delivery);

result=runCli(["create",deliveryBrief],{cwd:tmp});
assertSuccess(result,"toss create with Delivery governance");
const deliveryProject=path.join(tmp,"delivery-smoke-project");
for (const rel of deliveryFiles) {
  assert.ok(fs.existsSync(path.join(deliveryProject,rel)),`Missing Delivery asset ${rel}`);
}
const deliveryState=JSON.parse(fs.readFileSync(
  path.join(deliveryProject,"project.json"),
  "utf8",
));
assert.equal(deliveryState.governance.profiles.delivery,true);

const invalidBrief=path.join(tmp,"invalid-design-brief.yaml");
const invalid=structuredClone(explicit);
invalid.project.name="Invalid Design Project";
invalid.project.slug="invalid-design-project";
invalid.design.production_tool="photoshop";
writeYaml(invalidBrief,invalid);

result=runCli(["create",invalidBrief],{cwd:tmp});
assert.notEqual(result.status,0,"unsupported design production tool was accepted");
assert.match(result.stderr,/design\.production_tool/);

const legacyBrief=path.join(tmp,"legacy-project-brief.yaml");
const legacy=completeBrief(structuredClone(explicit),{
  name:"Legacy Smoke Project",
  slug:"legacy-smoke-project",
});
delete legacy.design;
writeYaml(legacyBrief,legacy);

result=runCli(["create",legacyBrief],{cwd:tmp});
assertSuccess(result,"toss create with legacy brief");

const legacyContext=JSON.parse(fs.readFileSync(
  path.join(tmp,"legacy-smoke-project/project-management/bootstrap/PROJECT_BRIEF.json"),
  "utf8",
));
assert.deepEqual(legacyContext.design,{required:"AUTO"});
const legacyState=JSON.parse(fs.readFileSync(
  path.join(tmp,"legacy-smoke-project/project.json"),
  "utf8",
));
assert.equal(legacyState.bootstrap_state.design_system,"PENDING");

const noDesignBrief=path.join(tmp,"no-design-project-brief.yaml");
const noDesign=completeBrief(structuredClone(explicit),{
  name:"No Design Smoke Project",
  slug:"no-design-smoke-project",
});
noDesign.design.required=false;
writeYaml(noDesignBrief,noDesign);

result=runCli(["create",noDesignBrief],{cwd:tmp});
assertSuccess(result,"toss create without design requirement");
const noDesignProject=path.join(tmp,"no-design-smoke-project");
const noDesignState=JSON.parse(fs.readFileSync(
  path.join(noDesignProject,"project.json"),
  "utf8",
));
assert.equal(noDesignState.bootstrap_state.design_system,"NOT_APPLICABLE");
assert.ok(fs.existsSync(path.join(noDesignProject,"project-management/design/DESIGN_BRIEF.md")));
assert.ok(fs.existsSync(path.join(noDesignProject,"project-management/design/DESIGN_SYSTEM.md")));

console.log("TOSS CLI smoke test: PASS");
