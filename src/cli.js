import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const TEMPLATE = path.join(ROOT, "templates");

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT,"package.json"),"utf8")).version;
const GOVERNANCE_VERSION = "1.6.0";

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

function copyTree(src,dst) {
  fs.cpSync(src,dst,{recursive:true});
}

function render(text, vals) {
  for (const [k,v] of Object.entries(vals)) {
    text = text.split(`{{${k}}}`).join(String(v));
  }
  return text;
}

function renderTree(root, vals) {
  const walk = dir => {
    for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const p=path.join(dir,entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        try {
          const t=fs.readFileSync(p,"utf8");
          if (Object.keys(vals).some(k => t.includes(`{{${k}}}`))) {
            fs.writeFileSync(p,render(t,vals),"utf8");
          }
        } catch {}
      }
    }
  };
  walk(root);
}

function readJson(p) { return JSON.parse(fs.readFileSync(p,"utf8")); }
function writeJson(p,obj) { fs.writeFileSync(p,JSON.stringify(obj,null,2)+"\n","utf8"); }

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

function writeRulesetPayload(projectDir) {
  const payload={
    name:"main-governance",
    target:"branch",
    enforcement:"active",
    conditions:{ref_name:{include:["~DEFAULT_BRANCH"],exclude:[]}},
    rules:[
      {type:"deletion"},
      {type:"non_fast_forward"},
      {type:"pull_request",parameters:{
        required_approving_review_count:1,
        dismiss_stale_reviews_on_push:true,
        require_code_owner_review:false,
        require_last_push_approval:false,
        required_review_thread_resolution:true
      }},
      {type:"required_status_checks",parameters:{
        strict_required_status_checks_policy:true,
        do_not_enforce_on_create:false,
        required_status_checks:[{context:"governance-certification"}]
      }}
    ],
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
  if (!exists("gh")) die("GitHub CLI 'gh' is required for GitHub creation.");
  run("gh",["auth","status"]);
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

function hydrateProjectState(dest,name,remote,projectUrl,langsmith) {
  const p=path.join(dest,"project-management","PROJECT_STATE.md");
  let t=fs.readFileSync(p,"utf8");
  t=t.replace("Name:\n",`Name: ${name}\n`);
  if (remote) t=t.replace("Repositories:\n",`Repositories: https://github.com/${remote}\n`);
  if (projectUrl) t=t.replace("GitHub Project:\n",`GitHub Project: ${projectUrl}\n`);
  if (langsmith) t=t.replace(/Project: .*/,`Project: ${langsmith}`);
  fs.writeFileSync(p,t,"utf8");
}

function writeBriefContext(dest,data) {
  const b=path.join(dest,"project-management","bootstrap");
  ensureDir(b);
  const context={
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
    langsmith:data.langsmith||{},
    constraints:data.constraints||[],
    initial_objective:data.initial_objective||{}
  };
  writeJson(path.join(b,"PROJECT_BRIEF.json"),context);
  fs.copyFileSync(path.join(TEMPLATE,"PROJECT_BRIEF_GUIDE.md"),path.join(b,"PROJECT_BRIEF_GUIDE.md"));
}

function applyBriefToState(dest,data) {
  const p=path.join(dest,"project-management","PROJECT_STATE.md");
  let t=fs.readFileSync(p,"utf8");
  if (!t.includes("## CEO Project Brief")) {
    t += `\n## CEO Project Brief\n\nDescription: ${nested(data,["project","description"],"")}\n\nProblem: ${nested(data,["business","problem"],"")}\n\nPrimary Goal: ${nested(data,["business","primary_goal"],"")}\n`;
  }
  fs.writeFileSync(p,t,"utf8");
}

function createFromConfig(a, briefData=null) {
  const slug=a.slug || slugify(a.name);
  const langsmith=a.langsmithProject || slug;
  const dest=path.resolve(a.directory || slug);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length && !a.force) die(`Destination is not empty: ${dest}`);
  ensureDir(dest);

  copyTree(path.join(TEMPLATE,"governance"),dest);

  const vals={
    PROJECT_NAME:a.name,
    PROJECT_SLUG:slug,
    DESCRIPTION:a.description || a.name,
    GITHUB_OWNER:a.owner,
    VISIBILITY:a.visibility,
    LANGSMITH_PROJECT:langsmith,
  };

  const files=[
    ["README.project.md","README.md"],
    ["project.json","project.json"],
    [".gitignore",".gitignore"],
    [".env.example",".env.example"],
    ["CLAUDE.md","CLAUDE.md"],
    ["AGENTS.md","AGENTS.md"],
    ["SUPERPOWERS.md","SUPERPOWERS.md"],
  ];
  for (const [src,dst] of files) {
    fs.writeFileSync(path.join(dest,dst),render(fs.readFileSync(path.join(TEMPLATE,src),"utf8"),vals),"utf8");
  }
  renderTree(dest,vals);

  const b=path.join(dest,"project-management","bootstrap");
  ensureDir(b);
  fs.copyFileSync(path.join(TEMPLATE,"PM_BOOTSTRAP_STATE.md"),path.join(b,"PM_BOOTSTRAP_STATE.md"));
  fs.copyFileSync(path.join(TEMPLATE,"GLOBAL_AGENT_CATALOG.json"),path.join(dest,"project-management","GLOBAL_AGENT_CATALOG.json"));
  fs.copyFileSync(path.join(TEMPLATE,"GLOBAL_AGENT_CATALOG.md"),path.join(dest,"project-management","GLOBAL_AGENT_CATALOG.md"));
  fs.copyFileSync(path.join(TEMPLATE,"AGENT_CAPABILITY_PLAN.md"),path.join(b,"AGENT_CAPABILITY_PLAN.md"));
  fs.copyFileSync(path.join(TEMPLATE,"AGENT_PROPOSAL.md"),path.join(dest,"project-management","templates","AGENT_PROPOSAL.md"));
  const designDir=path.join(dest,"project-management","design");
  ensureDir(designDir);
  fs.copyFileSync(path.join(TEMPLATE,"DESIGN_BRIEF.md"),path.join(designDir,"DESIGN_BRIEF.md"));
  fs.copyFileSync(path.join(TEMPLATE,"DESIGN_SYSTEM.md"),path.join(designDir,"DESIGN_SYSTEM.md"));

  const ruleset=writeRulesetPayload(dest);

  let committed=false;
  if (!a.noGit) {
    if (!exists("git")) die("git is required unless --no-git is used.");
    committed=initGit(dest);
  }

  let remote=null, gp=null;
  if (a.github) {
    remote=createGithubRepo(dest,a.owner,slug,a.visibility,a.description);
    updateProjectJson(dest,{github_repository:"CREATED"});
  }
  if (a.githubProject) {
    if (!a.github) die("--github-project requires GitHub repository creation.");
    gp=createGithubProject(a.owner,`${a.name} — Execution`);
    updateProjectJson(dest,{github_project:"CREATED"});
  }
  if (a.ruleset) {
    if (!remote) die("--ruleset requires GitHub repository creation.");
    applyRuleset(remote,ruleset);
    updateProjectJson(dest,{ruleset:"APPLIED"});
  }

  updateProjectJson(dest,{langsmith:"CONFIG_READY"});
  hydrateProjectState(dest,a.name,remote,gp?.url||null,langsmith);

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
  }

  if (!a.noGit) {
    const ok=commitIfPossible(dest,"chore: record bootstrap state");
    if (remote && ok) run("git",["push"],{cwd:dest});
  }

  console.log("\nPROJECT BOOTSTRAP COMPLETE");
  console.log(" Project:",a.name);
  console.log(" Directory:",dest);
  console.log(" Governance: v"+GOVERNANCE_VERSION);
  console.log(" LangSmith:",langsmith);
  console.log(" GitHub repo:",remote||"not created");
  console.log("\nNext:");
  console.log(`  cd ${slug}`);
  console.log("  start your supported agent host in the project root");
  console.log("TOSS bootstrap starts from AGENTS.md; Claude Code imports it through CLAUDE.md.");
}

function parseLegacy(args) {
  const a={
    name:args[0], owner:"toss-software", visibility:"private",
    description:"", directory:null, slug:null, langsmithProject:null,
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
    else if (x==="--langsmith-project") a.langsmithProject=value();
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
  npm install -g @toss/cli
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
    const briefPath=path.resolve(args[1]);
    const data=YAML.parse(fs.readFileSync(briefPath,"utf8")) || {};
    validateBrief(data);
    const name=String(nested(data,["project","name"]));
    const slugRaw=nested(data,["project","slug"],"AUTO");
    const lsRaw=nested(data,["langsmith","project"],"AUTO");
    const delivery=data.delivery||{};
    const a={
      name,
      slug:String(slugRaw).toUpperCase()==="AUTO"?null:String(slugRaw),
      description:String(nested(data,["project","description"],name)),
      owner:String(delivery.github_owner||"toss-software"),
      visibility:String(delivery.visibility||"private"),
      directory:null,
      langsmithProject:String(lsRaw).toUpperCase()==="AUTO"?null:String(lsRaw),
      github:Boolean(delivery.create_github_repository),
      githubProject:Boolean(delivery.create_github_project),
      ruleset:Boolean(delivery.apply_main_ruleset),
      noGit:false,
      force:false,
    };
    return createFromConfig(a,data);
  }

  return createFromConfig(parseLegacy(args),null);
}

main();
