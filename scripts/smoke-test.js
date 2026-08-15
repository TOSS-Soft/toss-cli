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
for (const rel of [
  "CLAUDE.md",
  "AGENTS.md",
  "SUPERPOWERS.md",
  "project.json",
  "project-management/PM_AGENT.md",
  "project-management/bootstrap/PROJECT_BRIEF.json",
  "project-management/GLOBAL_AGENT_CATALOG.json",
  "project-management/design/DESIGN_BRIEF.md",
  "project-management/design/DESIGN_SYSTEM.md",
]) {
  assert.ok(fs.existsSync(path.join(project,rel)),`Missing ${rel}`);
}

const claudeBridge=fs.readFileSync(path.join(project,"CLAUDE.md"),"utf8");
assert.equal(claudeBridge,"@AGENTS.md\n");

const agentsBootstrap=fs.readFileSync(path.join(project,"AGENTS.md"),"utf8");
assert.match(agentsBootstrap,/SUPERPOWERS\.md/);
assert.match(agentsBootstrap,/project-management\/PM_AGENT\.md/);
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
assert.match(canonicalState,/Availability: PENDING_VERIFICATION/);
assert.match(canonicalState,/Execution State: READY/);

const pmConstitution=fs.readFileSync(
  path.join(project,"project-management/PM_AGENT.md"),
  "utf8",
);
for (const phrase of [
  "Superpowers Execution Boundary",
  "ROUTE SUPERPOWERS",
  "verification-before-completion",
  "BLOCKED_SUPERPOWERS_MISSING",
]) {
  assert.match(pmConstitution,new RegExp(phrase));
}

const agentPolicy=fs.readFileSync(
  path.join(project,"project-management/policies/AGENTS.md"),
  "utf8",
);
assert.match(agentPolicy,/AGENT-018 — Superpowers Contract/);
assert.match(agentPolicy,/AGENT-019 — Missing Superpowers Capability/);
assert.match(agentPolicy,/AGENT-020 — Evidence Handoff/);

const taskPolicy=fs.readFileSync(
  path.join(project,"project-management/policies/TASKS.md"),"utf8",
);
assert.match(taskPolicy,/TASK-021 — Superpowers Execution/);
assert.match(taskPolicy,/TASK-022 — Missing Superpowers Block/);

const qualityPolicy=fs.readFileSync(
  path.join(project,"project-management/policies/QUALITY.md"),"utf8",
);
assert.match(qualityPolicy,/QUAL-021 — Test-Driven Implementation/);
assert.match(qualityPolicy,/QUAL-022 — Systematic Debugging/);
assert.match(qualityPolicy,/QUAL-023 — Completion Verification/);
assert.match(qualityPolicy,/QUAL-024 — Code Review Workflow/);

const releasePolicy=fs.readFileSync(
  path.join(project,"project-management/policies/RELEASES.md"),"utf8",
);
assert.match(releasePolicy,/REL-051 — Development Branch Completion/);
assert.match(releasePolicy,/finishing-a-development-branch/);
assert.match(releasePolicy,/MUST NOT grant merge, release, deployment, rollout, or production authority/);

const assignmentTemplate=fs.readFileSync(
  path.join(project,"project-management/templates/ASSIGNMENT.md"),
  "utf8",
);
assert.match(assignmentTemplate,/Canonical Superpowers Capability:/);

const context=JSON.parse(fs.readFileSync(
  path.join(project,"project-management/bootstrap/PROJECT_BRIEF.json"),
  "utf8",
));
assert.equal(context.design.required,true);
assert.equal(context.design.source,"company_system");
assert.equal(context.design.production_tool,"pencil");
assert.equal(context.design.company_design_system.name,"TOSS Brand System");
assert.deepEqual(context.design.company_design_system.references,["docs/brand.md"]);

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
