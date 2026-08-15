import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import {
  resolveGovernanceProfiles,
  resolveRequiredStatusChecks,
} from "./governance-config.js";
import {
  loadProfileAssets,
  loadProfileManifest,
  validateContainedFileTargets,
  writeContainedFiles,
} from "./profile-assets.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const TEMPLATE = path.join(ROOT, "templates");
const NO_FOLLOW=fs.constants.O_NOFOLLOW ?? 0;

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT,"package.json"),"utf8")).version;
const GOVERNANCE_VERSION = "2.0.0";
const DELIVERY_PROFILE_FILES=[
  "project-management/policies/DELIVERY.md",
  "project-management/policies/OPERATIONS.md",
  "project-management/templates/RELEASE.md",
  "project-management/templates/INCIDENT.md",
  "project-management/templates/DATAFIX.md",
];
const LEGACY_GOVERNANCE_MARKERS=[
  "project-management/PM_AGENT.md",
  "project-management/policies/AUTHORITY.md",
  "project-management/policies/SECURITY.md",
  "project-management/policies/LANGSMITH.md",
  "project-management/LANGSMITH_INTEGRATION.md",
  ".github/workflows/pm-governance-certification.yml",
  ".github/workflows/request-trusted-governance-evaluation.yml",
];
const RUNTIME_TEMPLATE_ASSETS=[
  {source:"README.project.md",target:"README.md",render:true},
  {source:"project.json",target:"project.json",render:true},
  {source:"gitignore.template",target:".gitignore",render:true},
  {source:"CLAUDE.md",target:"CLAUDE.md",render:true},
  {source:"AGENTS.md",target:"AGENTS.md",render:true},
  {source:"SUPERPOWERS.md",target:"SUPERPOWERS.md",render:true},
  {
    source:"GLOBAL_AGENT_CATALOG.json",
    target:"project-management/GLOBAL_AGENT_CATALOG.json",
    render:false,
  },
  {
    source:"GLOBAL_AGENT_CATALOG.md",
    target:"project-management/GLOBAL_AGENT_CATALOG.md",
    render:false,
  },
  {
    source:"DESIGN_BRIEF.md",
    target:"project-management/design/DESIGN_BRIEF.md",
    render:false,
  },
  {
    source:"DESIGN_SYSTEM.md",
    target:"project-management/design/DESIGN_SYSTEM.md",
    render:false,
  },
  {
    source:"PROJECT_BRIEF_GUIDE.md",
    target:"project-management/bootstrap/PROJECT_BRIEF_GUIDE.md",
    render:false,
  },
];

function die(message, code=1) {
  console.error(message);
  process.exit(code);
}

function exists(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding:"utf8" });
  return r.status === 0;
}

function run(cmd, args=[], opts={}) {
  console.log("+", [cmd, ...args].join(" "));
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: opts.capture ? ["ignore","pipe","pipe"] : "inherit",
    env: process.env,
  });
  if (opts.check !== false && r.status !== 0) {
    if (opts.capture) {
      if (r.stdout) console.error(r.stdout);
      if (r.stderr) console.error(r.stderr);
    }
    die(`Command failed: ${cmd} ${args.join(" ")}`);
  }
  return r;
}

function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
}

function ensureDir(p) { fs.mkdirSync(p,{recursive:true}); }

function render(text, vals) {
  for (const [k,v] of Object.entries(vals)) {
    text = text.split(`{{${k}}}`).join(String(v));
  }
  return text;
}

function isWithin(root,target) {
  const relative=path.relative(root,target);
  return relative!==".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function loadRuntimeTemplateAssets() {
  let templateRootStat;
  try {
    templateRootStat=fs.lstatSync(TEMPLATE);
  } catch {
    throw new TypeError("Runtime template root is missing: templates");
  }
  if (templateRootStat.isSymbolicLink() || !templateRootStat.isDirectory()) {
    throw new TypeError("Runtime template root is not a regular directory: templates");
  }
  const canonicalTemplateRoot=fs.realpathSync(TEMPLATE);

  return RUNTIME_TEMPLATE_ASSETS.map(asset => {
    const source=path.join(TEMPLATE,asset.source);
    let stat;
    try {
      stat=fs.lstatSync(source);
    } catch {
      throw new TypeError(`Runtime template is missing: templates/${asset.source}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new TypeError(
        `Runtime template is not a regular file: templates/${asset.source}`,
      );
    }
    let descriptor;
    try {
      descriptor=fs.openSync(source,fs.constants.O_RDONLY|NO_FOLLOW);
    } catch (error) {
      if (error?.code==="ELOOP") {
        throw new TypeError(
          `Runtime template is not a regular file: templates/${asset.source}`,
        );
      }
      throw error;
    }
    try {
      const descriptorStat=fs.fstatSync(descriptor);
      const canonicalSource=fs.realpathSync(source);
      const pathStat=fs.statSync(canonicalSource);
      if (
        !descriptorStat.isFile()
        || !isWithin(canonicalTemplateRoot,canonicalSource)
        || descriptorStat.dev!==pathStat.dev
        || descriptorStat.ino!==pathStat.ino
      ) {
        throw new TypeError(
          `Runtime template changed or escaped its root: templates/${asset.source}`,
        );
      }
      return {...asset,contents:fs.readFileSync(descriptor,"utf8")};
    } finally {
      fs.closeSync(descriptor);
    }
  });
}

function writeRuntimeTemplateAssets(destination,assets,values) {
  writeContainedFiles(destination,assets.map(asset => ({
    relativePath:asset.target,
    contents:asset.render ? render(asset.contents,values) : asset.contents,
  })));
}

function readJson(p) { return JSON.parse(fs.readFileSync(p,"utf8")); }
function writeJson(p,obj) { fs.writeFileSync(p,JSON.stringify(obj,null,2)+"\n","utf8"); }

function pathEntryExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code==="ENOENT") return false;
    throw error;
  }
}

function profileLabel(profiles) {
  return profiles.delivery ? "Core+Delivery" : "Core";
}

function validateForceOverlay(destination,requestedProfiles,force) {
  if (!pathEntryExists(destination)) return;
  const destinationStat=fs.lstatSync(destination);
  if (destinationStat.isSymbolicLink()) {
    throw new TypeError(`Destination must not be a symbolic link: ${destination}`);
  }
  if (!destinationStat.isDirectory()) {
    throw new TypeError(`Destination must be a directory: ${destination}`);
  }
  if (fs.readdirSync(destination).length===0) return;
  if (!force) throw new TypeError(`Destination is not empty: ${destination}`);

  const statePath=path.join(destination,"project.json");
  if (!pathEntryExists(statePath)) {
    throw new TypeError(
      "Refusing --force over an unrecognized non-empty destination; use a deliberate manual migration.",
    );
  }
  const stateStat=fs.lstatSync(statePath);
  if (stateStat.isSymbolicLink() || !stateStat.isFile()) {
    throw new TypeError(
      "Refusing --force because project.json is not a regular project-state file.",
    );
  }

  let state;
  try {
    state=readJson(statePath);
  } catch {
    throw new TypeError(
      "Refusing --force because project.json is not valid JSON; use a deliberate manual migration.",
    );
  }
  const version=state?.governance?.version;
  const hasLegacyState=LEGACY_GOVERNANCE_MARKERS.some(relativePath =>
    pathEntryExists(path.join(destination,...relativePath.split("/"))))
    || Object.hasOwn(state,"langsmith")
    || Object.hasOwn(state?.bootstrap_state ?? {},"langsmith")
    || Object.hasOwn(state?.governance?.profiles ?? {},"assurance");
  if (version!==GOVERNANCE_VERSION || hasLegacyState) {
    throw new TypeError(
      "Refusing --force over governance v1 or legacy governance assets; follow the manual migration guide.",
    );
  }

  const installedProfiles=state.governance?.profiles;
  if (
    installedProfiles?.core!==true
    || typeof installedProfiles?.delivery!=="boolean"
  ) {
    throw new TypeError(
      "Refusing --force because the installed governance profile state is incomplete or ambiguous.",
    );
  }
  const deliveryPresence=DELIVERY_PROFILE_FILES.map(relativePath =>
    pathEntryExists(path.join(destination,...relativePath.split("/"))));
  if (
    (installedProfiles.delivery && deliveryPresence.some(present => !present))
    || (!installedProfiles.delivery && deliveryPresence.some(Boolean))
  ) {
    throw new TypeError(
      "Refusing --force because installed Delivery assets contradict project.json profile state.",
    );
  }
  if (installedProfiles.delivery!==requestedProfiles.delivery) {
    throw new TypeError(
      `Refusing --force profile overlay from ${profileLabel(installedProfiles)} to ${profileLabel(requestedProfiles)}; use a deliberate manual migration.`,
    );
  }
}

function nested(data, keys, fallback=null) {
  let cur=data;
  for (const k of keys) {
    if (!cur || typeof cur !== "object" || !(k in cur)) return fallback;
    cur=cur[k];
  }
  return cur;
}

const DESIGN_ENUMS = [
  [["design","required"],[true,false,"AUTO"]],
  [["design","source"],["company_system","new_system","AUTO"]],
  [["design","production_tool"],["figma","pencil","claude_design","code_native","AUTO"]],
  [["design","users_and_accessibility","responsive"],[true,false,"AUTO"]],
];

function validateEnum(data, keys, allowed) {
  let value=data;
  for (const key of keys) {
    if (!value || typeof value!=="object" || !(key in value)) return;
    value=value[key];
  }
  if (!allowed.includes(value)) {
    die(`Project Brief invalid value for ${keys.join(".")}: ${String(value)}. Allowed: ${allowed.join(", ")}`);
  }
}

function validateBrief(data) {
  const required=[
    ["project","name"],
    ["project","description"],
    ["business","problem"],
    ["business","primary_goal"],
  ];
  const missing=required.filter(keys => {
    const v=nested(data,keys,"");
    return String(v ?? "").trim()==="";
  }).map(x=>x.join("."));
  if (missing.length) die("Project Brief missing required fields: "+missing.join(", "));
  for (const [keys,allowed] of DESIGN_ENUMS) validateEnum(data,keys,allowed);
}

function initBrief(target="project-brief.yaml") {
  const out=path.resolve(target);
  if (fs.existsSync(out)) die(`Refusing to overwrite existing file: ${out}`);
  fs.copyFileSync(path.join(TEMPLATE,"project-brief.yaml"),out);
  console.log(`Created Project Brief: ${out}`);
  console.log("Fill it, then run:");
  console.log(`  toss create ${out}`);
}

function writeRulesetPayload(projectDir, requiredChecks=[]) {
  const rules=[
    {type:"deletion"},
    {type:"non_fast_forward"},
    {type:"pull_request",parameters:{
      required_approving_review_count:1,
      dismiss_stale_reviews_on_push:true,
      require_code_owner_review:false,
      require_last_push_approval:false,
      required_review_thread_resolution:true
    }},
  ];
  if (requiredChecks.length > 0) {
    rules.push({type:"required_status_checks",parameters:{
      strict_required_status_checks_policy:true,
      do_not_enforce_on_create:false,
      required_status_checks:requiredChecks.map(context => ({context})),
    }});
  }
  const payload={
    name:"main-governance",
    target:"branch",
    enforcement:"active",
    conditions:{ref_name:{include:["~DEFAULT_BRANCH"],exclude:[]}},
    rules,
    bypass_actors:[]
  };
  const p=path.join(projectDir,"project-management","bootstrap","main-ruleset.json");
  ensureDir(path.dirname(p)); writeJson(p,payload); return p;
}

function gitIdentityAvailable(cwd) {
  const n=run("git",["config","user.name"],{cwd,capture:true,check:false});
  const e=run("git",["config","user.email"],{cwd,capture:true,check:false});
  return n.status===0 && e.status===0 && n.stdout.trim() && e.stdout.trim();
}

function commitIfPossible(cwd,msg) {
  run("git",["add","."],{cwd});
  const st=run("git",["status","--porcelain"],{cwd,capture:true});
  if (!st.stdout.trim()) return true;
  if (!gitIdentityAvailable(cwd)) {
    console.log("! Git identity is not configured; commit skipped.");
    return false;
  }
  run("git",["commit","-m",msg],{cwd});
  return true;
}

function initGit(cwd) {
  if (!fs.existsSync(path.join(cwd,".git"))) run("git",["init","-b","main"],{cwd});
  return commitIfPossible(cwd,`chore: bootstrap PM Governance v${GOVERNANCE_VERSION}`);
}

function createGithubRepo(cwd,owner,slug,visibility,description) {
  const remote=`${owner}/${slug}`;
  const args=["repo","create",remote,`--${visibility}`,"--source=.","--remote=origin"];
  if (description) args.push("--description",description);
  const head=run("git",["rev-parse","--verify","HEAD"],{cwd,capture:true,check:false});
  if (head.status===0) args.push("--push");
  run("gh",args,{cwd});
  return remote;
}

function createGithubProject(owner,title) {
  const r=run("gh",["project","create","--owner",owner,"--title",title,"--format","json"],{capture:true});
  console.log(r.stdout.trim());
  return JSON.parse(r.stdout);
}

function applyRuleset(remote,payloadPath) {
  const [owner,repo]=remote.split("/");
  run("gh",["api","--method","POST",`repos/${owner}/${repo}/rulesets`,"--input",payloadPath]);
}

function updateProjectJson(dest, updates) {
  const p=path.join(dest,"project.json");
  const d=readJson(p);
  d.bootstrap_state={...(d.bootstrap_state||{}),...updates};
  writeJson(p,d);
}

function updateGovernanceProfiles(dest,profiles) {
  const p=path.join(dest,"project.json");
  const d=readJson(p);
  d.governance={...d.governance,profiles:{...profiles}};
  writeJson(p,d);
}

function hydrateProjectState(dest,name,remote,projectUrl,profiles=null) {
  const p=path.join(dest,"project-management","PROJECT_STATE.md");
  let t=fs.readFileSync(p,"utf8");
  t=t.replace(/^Name:.*$/m,`Name: ${name}`);
  if (profiles) {
    t=t.replace(
      "{{DELIVERY_PROFILE_STATE}}",
      profiles.delivery ? "INSTALLED" : "NOT_SELECTED",
    );
  }
  if (remote) t=t.replace(/^Repositor(?:y|ies):.*$/m,`Repository: https://github.com/${remote}`);
  if (projectUrl) t=t.replace(/^GitHub Project:.*$/m,`GitHub Project: ${projectUrl}`);
  fs.writeFileSync(p,t,"utf8");
}

function writeBriefContext(dest,data,inputMode="PROJECT_BRIEF_FILE") {
  const b=path.join(dest,"project-management","bootstrap");
  ensureDir(b);
  const context={
    input_mode:inputMode,
    project:data.project||{},
    business:data.business||{},
    scope:data.scope||{},
    platform:data.platform||{},
    technology:data.technology||{},
    architecture:data.architecture||{},
    environments:data.environments||[],
    security:data.security||{},
    design:data.design||{required:"AUTO"},
    delivery:data.delivery||{},
    governance:data.governance ?? {delivery:false},
    constraints:data.constraints||[],
    initial_objective:data.initial_objective||{}
  };
  writeJson(path.join(b,"PROJECT_BRIEF.json"),context);
}

function applyBriefToState(dest,data) {
  const p=path.join(dest,"project-management","PROJECT_STATE.md");
  let t=fs.readFileSync(p,"utf8");
  if (!t.includes("## CEO Project Brief")) {
    t += `\n## CEO Project Brief\n\nDescription: ${nested(data,["project","description"],"")}\n\nProblem: ${nested(data,["business","problem"],"")}\n\nPrimary Goal: ${nested(data,["business","primary_goal"],"")}\n`;
  }
  fs.writeFileSync(p,t,"utf8");
}

function preflightExecutionRequirements(a) {
  if (a.githubProject && !a.github) {
    die("--github-project requires --github.");
  }
  if (a.ruleset && !a.github) {
    die("--ruleset requires --github.");
  }
  if (a.github && a.noGit) {
    die("--github cannot be combined with --no-git.");
  }
  if (!a.noGit && !exists("git")) {
    die("git is required unless --no-git is used.");
  }
  if (a.github) {
    if (!exists("gh")) {
      die("GitHub CLI 'gh' is required for GitHub creation.");
    }
    run("gh",["auth","status"]);
  }
}

function createFromConfig(a, briefData=null) {
  preflightExecutionRequirements(a);
  const slug=a.slug || slugify(a.name);
  const runtimeAssets=loadRuntimeTemplateAssets();
  const coreRoot=path.join(TEMPLATE,"governance","core");
  const coreManifest=loadProfileManifest(coreRoot);
  const coreAssets=loadProfileAssets(coreRoot,coreManifest);
  let deliveryRoot=null;
  let deliveryManifest=null;
  let deliveryAssets=[];
  if (a.governanceProfiles.delivery) {
    deliveryRoot=path.join(TEMPLATE,"governance","profiles","delivery");
    deliveryManifest=loadProfileManifest(deliveryRoot);
    deliveryAssets=loadProfileAssets(deliveryRoot,deliveryManifest);
  }
  const dest=path.resolve(a.directory || slug);
  try {
    validateForceOverlay(dest,a.governanceProfiles,a.force);
  } catch (error) {
    die(error.message);
  }
  ensureDir(dest);
  try {
    validateContainedFileTargets(dest,[
      ...coreManifest.files,
      ...(deliveryManifest?.files ?? []),
      ...runtimeAssets.map(asset => asset.target),
      "project-management/bootstrap/main-ruleset.json",
      "project-management/bootstrap/PROJECT_BRIEF.json",
    ]);
  } catch (error) {
    die(`${a.force ? "Refusing --force because " : ""}${error.message}`);
  }

  writeContainedFiles(dest,[...coreAssets,...deliveryAssets]);

  const vals={
    PROJECT_NAME:a.name,
    PROJECT_SLUG:slug,
    DESCRIPTION:a.description || a.name,
    GITHUB_OWNER:a.owner,
    VISIBILITY:a.visibility,
    DELIVERY_PROFILE_STATUS:a.governanceProfiles.delivery ? "installed" : "not installed",
    DELIVERY_PROFILE_STATE:a.governanceProfiles.delivery ? "INSTALLED" : "NOT_SELECTED",
  };

  writeRuntimeTemplateAssets(dest,runtimeAssets,vals);
  updateGovernanceProfiles(dest,a.governanceProfiles);
  hydrateProjectState(dest,a.name,null,null,a.governanceProfiles);

  const ruleset=writeRulesetPayload(dest,a.requiredStatusChecks);

  let committed=false;
  if (!a.noGit) {
    committed=initGit(dest);
  }

  let remote=null, gp=null;
  if (a.github) {
    remote=createGithubRepo(dest,a.owner,slug,a.visibility,a.description);
    updateProjectJson(dest,{github_repository:"CREATED"});
  }
  if (a.githubProject) {
    gp=createGithubProject(a.owner,`${a.name} — Execution`);
    updateProjectJson(dest,{github_project:"CREATED"});
  }
  if (a.ruleset) {
    applyRuleset(remote,ruleset);
    updateProjectJson(dest,{ruleset:"APPLIED"});
  }

  hydrateProjectState(dest,a.name,remote,gp?.url||null,a.governanceProfiles);

  if (briefData) {
    writeBriefContext(dest,briefData);
    applyBriefToState(dest,briefData);
    const designRequired=nested(briefData,["design","required"],"AUTO");
    const designState=designRequired===false
      ? "NOT_APPLICABLE"
      : designRequired===true
        ? "DISCOVERY_REQUIRED"
        : "PENDING";
    updateProjectJson(dest,{project_brief:"LOADED",design_system:designState});
    const title=nested(briefData,["initial_objective","title"],"");
    const outcome=nested(briefData,["initial_objective","outcome"],"");
    if (String(title).trim() && String(outcome).trim()) {
      updateProjectJson(dest,{initial_objective:"CEO_AUTHORED_PENDING_PM_CAPTURE"});
    }
  } else {
    writeBriefContext(dest,{
      project:{
        name:a.name,
        slug,
        description:a.description || a.name,
      },
      governance:{delivery:false},
      design:{required:"AUTO"},
    },"FAST_SCAFFOLD_ARGUMENTS");
    updateProjectJson(dest,{project_brief:"FAST_SCAFFOLD_ARGUMENTS"});
  }

  if (!a.noGit) {
    const ok=commitIfPossible(dest,"chore: record bootstrap state");
    if (remote && ok) run("git",["push"],{cwd:dest});
  }

  console.log("\nPROJECT BOOTSTRAP COMPLETE");
  console.log(" Project:",a.name);
  console.log(" Directory:",dest);
  console.log(" Governance: v"+GOVERNANCE_VERSION);
  console.log(" GitHub repo:",remote||"not created");
  console.log("\nNext:");
  console.log(`  cd ${slug}`);
  console.log("  start your supported agent host in the project root");
  console.log("TOSS bootstrap starts from AGENTS.md; Claude Code imports it through CLAUDE.md.");
}

function parseLegacy(args) {
  const a={
    name:args[0], owner:"toss-software", visibility:"private",
    description:"", directory:null, slug:null,
    github:false, githubProject:false, ruleset:false, noGit:false, force:false
  };
  for (let i=1;i<args.length;i++) {
    const x=args[i];
    const value=()=>args[++i];
    if (x==="--description") a.description=value();
    else if (x==="--owner") a.owner=value();
    else if (x==="--visibility") a.visibility=value();
    else if (x==="--dir") a.directory=value();
    else if (x==="--slug") a.slug=value();
    else if (x==="--github") a.github=true;
    else if (x==="--github-project") a.githubProject=true;
    else if (x==="--ruleset") a.ruleset=true;
    else if (x==="--no-git") a.noGit=true;
    else if (x==="--force") a.force=true;
    else die(`Unknown option: ${x}`);
  }
  if (!a.name) die("Project name is required.");
  return a;
}

function help() {
  console.log(`TOSS CLI v${VERSION}

Usage:
  toss init [project-brief.yaml]
  toss create <project-brief.yaml>
  toss "Project Name" [options]

Recommended:
  toss init
  # fill project-brief.yaml
  toss create project-brief.yaml

Global package:
  npm install -g @toss-software/cli
`);
}

function main() {
  const args=process.argv.slice(2);
  if (!args.length || args[0]==="--help" || args[0]==="-h") return help();
  if (args[0]==="--version" || args[0]==="-v") return console.log(VERSION);

  if (args[0]==="init") {
    return initBrief(args[1]||"project-brief.yaml");
  }

  if (args[0]==="create") {
    if (!args[1]) die("Usage: toss create <project-brief.yaml>");
    let force=false;
    for (const option of args.slice(2)) {
      if (option==="--force" && !force) force=true;
      else die(`Unknown option: ${option}`);
    }
    const briefPath=path.resolve(args[1]);
    const data=YAML.parse(fs.readFileSync(briefPath,"utf8")) || {};
    validateBrief(data);
    let governanceProfiles, requiredStatusChecks;
    try {
      governanceProfiles=resolveGovernanceProfiles(data);
      requiredStatusChecks=resolveRequiredStatusChecks(data);
    } catch (error) {
      die(error.message);
    }
    const name=String(nested(data,["project","name"]));
    const slugRaw=nested(data,["project","slug"],"AUTO");
    const delivery=data.delivery||{};
    const a={
      name,
      slug:String(slugRaw).toUpperCase()==="AUTO"?null:String(slugRaw),
      description:String(nested(data,["project","description"],name)),
      owner:String(delivery.github_owner||"toss-software"),
      visibility:String(delivery.visibility||"private"),
      directory:null,
      github:Boolean(delivery.create_github_repository),
      githubProject:Boolean(delivery.create_github_project),
      ruleset:Boolean(delivery.apply_main_ruleset),
      noGit:false,
      force,
      governanceProfiles,
      requiredStatusChecks,
    };
    return createFromConfig(a,data);
  }

  return createFromConfig({
    ...parseLegacy(args),
    governanceProfiles:{core:true,delivery:false},
    requiredStatusChecks:[],
  },null);
}

main();
