import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createArtifactStore } from "../src/artifacts/store.js";
import { runProjectCommand } from "../src/commands/project.js";
import {
  commandServices,
  parsedCommand,
  projectCommandInput
} from "./support/command-fixture.js";

const execFileAsync = promisify(execFile);
const CLI = new URL("../src/cli.js", import.meta.url);

async function runCli(root, argv) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI.pathname, ...argv, "--project", root, "--json"], {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" }
    });
    return { exitCode: 0, stdout, stderr, result: JSON.parse(stdout) };
  } catch (error) {
    return {
      exitCode: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
      result: JSON.parse(error.stdout)
    };
  }
}

test("the executable composes a local gate context for every issue 28 command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "toss-gate-cli-round1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createArtifactStore({ root });
  const input = projectCommandInput();
  await runProjectCommand(
    parsedCommand("project.prepare", { from: "project.json" }),
    commandServices(store, input)
  );

  const cases = [
    { name: "decisions list", argv: ["decisions", "list"], exitCode: 4 },
    {
      name: "decisions answer",
      argv: ["decisions", "answer", "Q-001", "--from", "answer.json", "--non-interactive"],
      exitCode: 4
    },
    { name: "architecture review", argv: ["architecture", "review"], exitCode: 0 },
    {
      name: "architecture approve",
      argv: ["architecture", "approve", "ADR-001", "--from", "approval.json", "--non-interactive"],
      exitCode: 4
    },
    { name: "plan show", argv: ["plan", "show"], exitCode: 0 },
    { name: "audit run", argv: ["audit", "run"], exitCode: 0 },
    { name: "readiness check", argv: ["readiness", "check"], exitCode: 4 },
    { name: "issues preview", argv: ["issues", "preview"], exitCode: 4 },
    { name: "issues publish dry-run", argv: ["issues", "publish"], exitCode: 4 },
    {
      name: "issues publish apply",
      argv: ["issues", "publish", "--apply", "--from", "publication.json", "--non-interactive"],
      exitCode: 4
    }
  ];

  for (const row of cases) {
    await t.test(row.name, async () => {
      const invoked = await runCli(root, row.argv);
      assert.equal(invoked.exitCode, row.exitCode, JSON.stringify(invoked.result));
      assert.notEqual(invoked.result.error?.code, "COMMAND_CONTEXT_INVALID");
      assert.doesNotMatch(invoked.stderr, /github\.com|api\.github|\bgh\b/iu);
    });
  }
});
