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
]);
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

function commandsFromReadme(readme) {
  return [...readme.matchAll(/^toss ((?:project|feature|decisions|architecture|plan|audit|readiness|issues)\b.*)$/gmu)]
    .map(match => match[1].trim().split(/\s+/u));
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

test("README lifecycle workflows use recognized command paths and preserve safety boundaries",async () => {
  const readme=await readFile(resolve(root,"README.md"),"utf8");

  for (const section of requiredSections) {
    assert.match(readme,new RegExp(`## ${escape(section)}`));
  }
  for (const command of requiredCommands) assert.ok(readme.includes(command),command);

  const commands=commandsFromReadme(readme);
  assert.ok(commands.length>=requiredCommands.length,"README should show each lifecycle command as a copyable command");
  for (const command of commands) {
    assert.ok(lifecycleFamilies.has(command[0]));
    assertHelpRecognizes(command);
  }

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
});
