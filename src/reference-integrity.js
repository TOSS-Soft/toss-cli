import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REFERENCE_EXTENSIONS=new Set([".md",".json",".yml"]);
const LOCAL_REFERENCE_PREFIXES=[
  "/project-management/",
  "project-management/",
  ".github/",
  "scripts/",
  "evaluators/",
  "trusted-evaluator-repo/",
];
const CANONICAL_CAPABILITIES=[
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
];
const FORBIDDEN_RESIDUE=[
  /LangSmith/i,
  /Klinik360/i,
  /o3-mini/i,
  /Claude Code Trajectory/i,
  /Trusted Evaluator/i,
  /governance-certification/i,
];

function listFiles(root) {
  const files=[];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b) =>
      a.name.localeCompare(b.name))) {
      if (entry.name===".git") continue;
      const absolutePath=path.join(directory,entry.name);
      if (entry.isDirectory()) walk(absolutePath);
      else if (entry.isFile()) files.push(absolutePath);
    }
  }
  walk(root);
  return files;
}

function relativeFile(projectRoot,file) {
  return path.relative(projectRoot,file).split(path.sep).join("/");
}

function localReferenceTokens(text) {
  const tokens=[];
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const token=match[1];
    if (/\s/.test(token)) continue;
    if (!LOCAL_REFERENCE_PREFIXES.some(prefix => token.startsWith(prefix))) continue;
    if (/[*?\[\]{}]/.test(token) || /[<>]/.test(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

function validateLocalReferences(projectRoot,files) {
  for (const file of files) {
    if (!REFERENCE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const text=fs.readFileSync(file,"utf8");
    for (const token of localReferenceTokens(text)) {
      const reference=token.replace(/^\//,"").split("#",1)[0];
      assert.ok(
        fs.existsSync(path.resolve(projectRoot,reference)),
        `${relativeFile(projectRoot,file)}: invalid local reference ${token}`,
      );
    }
  }
}

function validateOwnership(projectRoot,files) {
  const governanceRoot=path.join(projectRoot,"project-management");
  const governanceDocuments=files.filter(file =>
    file.startsWith(`${governanceRoot}${path.sep}`) &&
    path.extname(file).toLowerCase()===".md");
  const governanceText=governanceDocuments
    .map(file => fs.readFileSync(file,"utf8"))
    .join("\n");
  const ownershipPattern=/superpowers:[a-z0-9-]+/i;
  const match=governanceText.match(ownershipPattern);
  const source=match
    ? governanceDocuments.find(file => fs.readFileSync(file,"utf8").includes(match[0]))
    : null;
  assert.doesNotMatch(
    governanceText,
    ownershipPattern,
    source
      ? `${relativeFile(projectRoot,source)}: invalid ownership token ${match[0]}`
      : "project-management/**/*.md: invalid Superpowers ownership token",
  );
}

function validateAssuranceResidue(projectRoot,files) {
  for (const file of files) {
    const text=fs.readFileSync(file,"utf8");
    for (const pattern of FORBIDDEN_RESIDUE) {
      const match=text.match(pattern);
      assert.equal(
        match,
        null,
        `${relativeFile(projectRoot,file)}: forbidden Assurance residue ${match?.[0] ?? pattern}`,
      );
    }
  }
}

function validateRootContracts(projectRoot) {
  const superpowersFile=path.join(projectRoot,"SUPERPOWERS.md");
  const superpowersText=fs.readFileSync(superpowersFile,"utf8");
  for (const capability of CANONICAL_CAPABILITIES) {
    assert.ok(
      superpowersText.includes(capability),
      `SUPERPOWERS.md: missing canonical capability ${capability}`,
    );
  }

  const claudeText=fs.readFileSync(path.join(projectRoot,"CLAUDE.md"),"utf8");
  assert.equal(
    claudeText,
    "@AGENTS.md\n",
    "CLAUDE.md: invalid bridge token; expected @AGENTS.md",
  );
}

export function validateGeneratedProject(projectRoot) {
  const root=path.resolve(projectRoot);
  const files=listFiles(root);
  validateLocalReferences(root,files);
  validateOwnership(root,files);
  validateAssuranceResidue(root,files);
  validateRootContracts(root);
}
