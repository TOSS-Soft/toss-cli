import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,readdir,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import process from "node:process";
import test from "node:test";

import {parseCommand} from "../src/commands/router.js";

const root=resolve(new URL("..",import.meta.url).pathname);
const cli=resolve(root,"bin","toss.js");
const shellLanguages=new Set(["bash","console","sh","shell"]);
const designFamilies=new Set(["design","feature","readiness","issues"]);
const requiredSections=[
  "When Design Is Required",
  "Lite, Standard and Critical Design Levels",
  "Existing Company Design System vs New System",
  "UI/UX Design Lifecycle",
  "Design Quick Commands",
  "Figma, Pencil and Code-Native Assets",
  "Design Review and Approval",
  "UI Design Definition of Ready",
  "Adding a UI Feature",
  "Resume and Recovery",
  "Frontend Issue Traceability",
];
const requiredCommands=[
  ["design","init"],
  ["design","prepare","--from","design-brief.yaml"],
  ["design","status"],
  ["design","flows"],
  ["design","wireframes"],
  ["design","direction"],
  ["design","system"],
  ["design","screens"],
  ["design","prototype"],
  ["design","audit"],
  ["design","review"],
  ["design","approve"],
  ["feature","prepare","--from","feature.yaml"],
  ["readiness","check"],
  ["issues","preview"],
];

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&");
}

function tokenize(command) {
  const words=[];
  let escaped=false;
  let quote=null;
  let word="";
  for (const character of command) {
    if (escaped) {
      word+=character;
      escaped=false;
    } else if (character==="\\") {
      escaped=true;
    } else if (quote!==null) {
      if (character===quote) quote=null;
      else word+=character;
    } else if (character==='"' || character==="'") {
      quote=character;
    } else if (/\s/u.test(character)) {
      if (word.length>0) words.push(word);
      word="";
    } else {
      word+=character;
    }
  }
  if (escaped || quote!==null) throw new TypeError(`Malformed shell command: ${command}`);
  if (word.length>0) words.push(word);
  return words;
}

function commandsFromShellFence(lines) {
  const commands=[];
  let pending=null;
  for (const line of lines) {
    const candidate=(line.trim().startsWith("$ ") ? line.trim().slice(2) : line.trim());
    if (pending!==null) {
      pending+=` ${candidate.replace(/\\\s*$/u,"")}`;
      if (/\\\s*$/u.test(candidate)) continue;
      commands.push(tokenize(pending));
      pending=null;
      continue;
    }
    if (!/^toss(?:\s|$)/u.test(candidate)) continue;
    if (/\\\s*$/u.test(candidate)) {
      pending=candidate.replace(/\\\s*$/u,"");
      continue;
    }
    commands.push(tokenize(candidate));
  }
  if (pending!==null) throw new TypeError(`Malformed shell command: ${pending}`);
  return commands.map(words => words.slice(1));
}

function commandsFromMarkdown(markdown) {
  const commands=[];
  let fence=null;
  for (const line of markdown.split(/\r?\n/u)) {
    if (fence===null) {
      const opening=line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/u);
      if (!opening || !shellLanguages.has(opening[2].toLowerCase())) continue;
      fence={marker:opening[1][0],length:opening[1].length,lines:[]};
      continue;
    }
    const closing=new RegExp(`^\\s*${fence.marker}{${fence.length},}\\s*$`,`u`);
    if (closing.test(line)) {
      commands.push(...commandsFromShellFence(fence.lines));
      fence=null;
    } else {
      fence.lines.push(line);
    }
  }
  if (fence!==null) throw new TypeError("Unclosed shell fence in README");
  return commands;
}

function assertLifecycleCommands(commands) {
  for (const argv of commands.filter(command => designFamilies.has(command[0]))) {
    assert.doesNotThrow(
      () => parseCommand(argv),
      `README command is not parser-supported: toss ${argv.join(" ")}`,
    );
  }
}

test("design README command extraction is Markdown-aware and rejects fictional CLI grammar",() => {
  const prose="toss design export --format figma";
  const markdown=`${prose}\n\n\`\`\`bash\n$ toss design status\n\`\`\``;
  assert.deepEqual(commandsFromMarkdown(markdown),[["design","status"]]);
  assert.doesNotThrow(() => assertLifecycleCommands(commandsFromMarkdown(markdown)));

  for (const invalid of [
    "```bash\ntoss design export\n```",
    "```console\n$ toss design status --from input.yaml\n```",
  ]) {
    assert.throws(() => assertLifecycleCommands(commandsFromMarkdown(invalid)));
  }
});

test("README documents the complete risk-based design and UI readiness contract",async () => {
  const readme=await readFile(resolve(root,"README.md"),"utf8");
  for (const section of requiredSections) {
    assert.match(readme,new RegExp(`^## ${escape(section)}$`,`mu`));
  }

  assert.match(readme,/UI project example[\s\S]*UI feature example[\s\S]*Backend-only N\/A example/i);
  assert.match(readme,/LITE[\s\S]*STANDARD[\s\S]*CRITICAL/);
  assert.match(readme,/Critical downgrade[\s\S]*toss design approve/i);
  assert.match(readme,/verified company design system[\s\S]*binding[\s\S]*project extensions/i);
  assert.match(readme,/repository artifacts[\s\S]*canonical[\s\S]*production assets/i);
  assert.match(readme,/Visual direction approval[\s\S]*Design System approval[\s\S]*final design approval/i);
  assert.match(readme,/failed UI Design DoR example[\s\S]*ready_for_ui_issue_generation[^\n]*false/i);
  assert.match(readme,/design prepare[\s\S]*feature prepare[\s\S]*do not write GitHub/i);
  assert.match(readme,/stale[\s\S]*toss design status[\s\S]*--from/i);
  assert.match(readme,/standalone executable[\s\S]*trusted authority[\s\S]*fail closed/i);
  for (const field of [
    "design_system_ref","flow_refs","screen_refs","component_refs","state_refs",
    "responsive_refs","accessibility_refs",
  ]) assert.ok(readme.includes(field),`README is missing exact UI trace field ${field}`);
});

test("every documented design lifecycle command parses and has a write-free help path",async t => {
  const readme=await readFile(resolve(root,"README.md"),"utf8");
  const commands=commandsFromMarkdown(readme);
  assertLifecycleCommands(commands);
  const keys=new Set(commands.map(command => JSON.stringify(command)));
  for (const command of requiredCommands) {
    assert.ok(keys.has(JSON.stringify(command)),`README is missing: toss ${command.join(" ")}`);
  }

  const sandbox=await mkdtemp(resolve(tmpdir(),"toss-readme-design-"));
  t.after(async () => rm(sandbox,{recursive:true,force:true}));
  for (const argv of commands.filter(command => designFamilies.has(command[0]))) {
    const result=spawnSync(process.execPath,[cli,...argv,"--help"],{
      cwd:sandbox,
      encoding:"utf8",
      env:{...process.env,NO_COLOR:"1"},
    });
    assert.equal(result.status,0,`README command has no help path: toss ${argv.join(" ")}`);
    assert.deepEqual(await readdir(sandbox),[],`help path wrote files: toss ${argv.join(" ")}`);
  }
});
