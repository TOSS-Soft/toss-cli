import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {resolve} from "node:path";
import process from "node:process";
import test from "node:test";

import {parseCommand} from "../src/commands/router.js";
import {renderHelp} from "../src/commands/options.js";

const root=resolve(new URL("..",import.meta.url).pathname);
const cli=resolve(root,"bin","toss.js");
const lifecycleFamilies=new Set([
  "project","feature","decisions","architecture","plan","audit","readiness","issues",
  "trace","artifacts","validate",
]);
const shellLanguages=new Set(["bash","console","sh","shell"]);
const requiredSections=[
  "Quick Start",
  "Project Lifecycle",
  "Feature Lifecycle",
  "Decisions and ADRs",
  "Audit and Readiness",
  "Publishing",
  "Automation and JSON",
  "Resume and Recovery",
  "Command Reference",
  "Safety Gates",
  "Legacy Compatibility",
];
const requiredCommands=[
  "toss project prepare",
  "toss project resume",
  "toss project status",
  "toss feature add",
  "toss feature analyze",
  "toss feature prepare",
  "toss feature status",
  "toss decisions list",
  "toss decisions answer",
  "toss architecture review",
  "toss architecture approve",
  "toss plan show",
  "toss audit run",
  "toss readiness check",
  "toss issues preview",
  "toss issues publish",
];

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&");
}

function tokenizeShellCommand(command) {
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
    } else if (character==="\"" || character==="'") {
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

function shellFenceCommands(lines) {
  const commands=[];
  let continuation=null;
  for (const line of lines) {
    const trimmed=line.trim();
    const candidate=trimmed.startsWith("$ ") ? trimmed.slice(2).trimStart() : trimmed;
    if (continuation!==null) {
      if (candidate.length===0) throw new TypeError(`Malformed shell command: ${continuation}`);
      const nextContinues=/\\\s*$/u.test(candidate);
      continuation+=` ${candidate.replace(/\\\s*$/u,"")}`;
      if (nextContinues) continue;
      commands.push(tokenizeShellCommand(continuation));
      continuation=null;
      continue;
    }
    if (!/^toss(?:\s|$)/u.test(candidate)) continue;
    if (/\\\s*$/u.test(candidate)) {
      continuation=candidate.replace(/\\\s*$/u,"");
      continue;
    }
    commands.push(tokenizeShellCommand(candidate));
  }
  if (continuation!==null) throw new TypeError(`Malformed shell command: ${continuation}`);
  return commands.map(command => command.slice(1));
}

function commandsFromReadme(readme) {
  const commands=[];
  let fence=null;
  for (const line of readme.split(/\r?\n/u)) {
    if (fence===null) {
      const opening=line.match(/^\s*(`{3,}|~{3,})\s*([^\s]*)[^`~]*$/u);
      if (!opening || !shellLanguages.has(opening[2].toLowerCase())) continue;
      fence={marker:opening[1][0],length:opening[1].length,lines:[]};
      continue;
    }
    const closing=new RegExp(`^\\s*${fence.marker}{${fence.length},}\\s*$`,`u`);
    if (closing.test(line)) {
      commands.push(...shellFenceCommands(fence.lines));
      fence=null;
    } else {
      fence.lines.push(line);
    }
  }
  if (fence!==null) throw new TypeError("Unclosed shell fence in README");
  return commands;
}

function assertHelpRecognizes(argv) {
  assert.doesNotThrow(() => parseCommand(argv),`README command is not parseable: toss ${argv.join(" ")}`);
  const result=spawnSync(process.execPath,[cli,...argv,"--help"],{
    cwd:root,
    encoding:"utf8",
    env:{...process.env,NO_COLOR:"1"},
  });
  assert.equal(result.status,0,`README command has no help path: toss ${argv.join(" ")}`);
}

function assertLegacyCommandRecognized(argv) {
  const help=renderHelp("2.0.0");
  if (argv.length===1 && argv[0]==="init") {
    assert.ok(help.includes("toss init [project-brief.yaml]"));
    return;
  }
  if (argv[0]==="create" && argv.length===2 && !argv[1].startsWith("-")) {
    assert.ok(help.includes("toss create <project-brief.yaml>"));
    return;
  }
  if (argv.length===1 && /\s|[A-Z]|[^a-z]/u.test(argv[0])) {
    assert.ok(help.includes("toss \"Project Name\" [legacy scaffold options]"));
    return;
  }
  assert.fail(`README command is not a recognized compatibility path: toss ${argv.join(" ")}`);
}

function assertReadmeCommandsRecognized(commands) {
  for (const command of commands) {
    if (lifecycleFamilies.has(command[0])) assertHelpRecognizes(command);
    else assertLegacyCommandRecognized(command);
  }
}

test("README shell extraction ignores prose and recognizes indented prompts, continuations, and legacy forms",() => {
  const fixture=`
toss project prepare --from prose-only.yaml

  \`\`\`console
  $ toss project prepare \\
    --from project-input.yaml --non-interactive
  $ toss project status
  \`\`\`

\`\`\`shell
toss init
toss create project-brief.yaml
toss "Project Name"
\`\`\`
`;

  assert.deepEqual(commandsFromReadme(fixture),[
    ["project","prepare","--from","project-input.yaml","--non-interactive"],
    ["project","status"],
    ["init"],
    ["create","project-brief.yaml"],
    ["Project Name"],
  ]);
});

test("README shell command validation rejects malformed lifecycle and unknown legacy paths",() => {
  assert.throws(() => assertReadmeCommandsRecognized(commandsFromReadme(`
\`\`\`bash
toss project status --from input.yaml
\`\`\`
`)),/project status --from/i);
  assert.throws(() => assertReadmeCommandsRecognized(commandsFromReadme(`
\`\`\`sh
$ toss unknown command
\`\`\`
`)),/unknown command/i);
});

test("README lifecycle workflows use recognized command paths and preserve safety boundaries",async () => {
  const readme=await readFile(resolve(root,"README.md"),"utf8");

  for (const section of requiredSections) {
    assert.match(readme,new RegExp(`## ${escape(section)}`));
  }
  for (const command of requiredCommands) assert.ok(readme.includes(command),command);

  const commands=commandsFromReadme(readme);
  assert.ok(commands.length>=requiredCommands.length,"README should show each lifecycle command as a copyable command");
  assertReadmeCommandsRecognized(commands);

  const help=renderHelp("2.0.0");
  for (const {readmePath,helpPath} of [
    {readmePath:"toss init",helpPath:"toss init [project-brief.yaml]"},
    {readmePath:"toss create project-brief.yaml",helpPath:"toss create <project-brief.yaml>"},
    {readmePath:"toss \"Project Name\"",helpPath:"toss \"Project Name\" [legacy scaffold options]"},
  ]) {
    assert.ok(readme.includes(readmePath));
    assert.ok(help.includes(helpPath));
  }

  assert.match(readme,/prepare.*does not write.*GitHub/is);
  assert.match(readme,/publish.*dry-run.*--apply/is);
  assert.ok(readme.includes("prepare does not write GitHub; publish is dry-run unless --apply"));
  assert.match(readme,/embedding host.*injects? a prompt service/i);
  assert.match(readme,/standalone CLI requires `--from`/i);
  assert.doesNotMatch(readme,/Without `--from`, prompt-capable commands run interactively/i);
});
