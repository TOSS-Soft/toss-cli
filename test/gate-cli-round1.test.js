import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { createArtifactStore } from "../src/artifacts/store.js";
import { runProjectCommand } from "../src/commands/project.js";
import { dispatchCommand, parseCommand } from "../src/commands/router.js";
import { canonicalJson } from "../src/contracts/acp.js";
import { validateDocument } from "../src/contracts/validator.js";
import {
  commandServices,
  memoryCommandStore,
  parsedCommand,
  projectCommandInput
} from "./support/command-fixture.js";

const execFileAsync = promisify(execFile);
const CLI = new URL("../src/cli.js", import.meta.url);
const NETWORK_GUARD = new URL("./fixtures/gate-cli/network-guard.mjs", import.meta.url);
const gateCliMatrix = JSON.parse(await readFile(
  new URL("./fixtures/commands/gate-cli-matrix.json", import.meta.url),
  "utf8"
));
let productionCliStarts = 0;
const PLATFORM_LAUNCH_KEYS = [
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
];

function servicesFor(profile, store, input) {
  if (profile === "read-only") return Object.freeze({ artifactStore: store });
  if (profile === "input") return Object.freeze({
    artifactStore: store,
    readInput: async () => canonicalJson(input),
  });
  if (profile === "issues") return Object.freeze({ artifactStore: store });
  throw new TypeError(`unknown gate CLI service profile: ${String(profile)}`);
}

function launchEnvironment() {
  const env = { NO_COLOR: "1" };
  for (const key of PLATFORM_LAUNCH_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function cliFilesystemPath(url) {
  return fileURLToPath(url);
}

async function runProductionCli({ cwd, root, argv, cliUrl = CLI }) {
  productionCliStarts += 1;
  let invoked;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--import",
      NETWORK_GUARD.href,
      cliFilesystemPath(cliUrl),
      ...argv,
      "--project",
      root,
    ], {
      cwd,
      encoding: "utf8",
      env: launchEnvironment(),
      shell: false,
    });
    invoked = { exitCode: 0, stdout, stderr };
  } catch (error) {
    invoked = {
      exitCode: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
  assert.doesNotMatch(invoked.stderr, /FORBIDDEN_NETWORK_ACCESS/);
  return invoked;
}

test("the network guard denies an actual fetch in a fresh process", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      "--import",
      NETWORK_GUARD.href,
      "--eval",
      "fetch('https://example.invalid')",
    ], { encoding: "utf8" }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /FORBIDDEN_NETWORK_ACCESS/);
      return true;
    }
  );
});

test("the parser and dispatcher preserve every issue 28 command result envelope", async (t) => {
  assert.equal(gateCliMatrix.length, 10);
  for (const row of gateCliMatrix) {
    await t.test(row.name, async () => {
      const store = memoryCommandStore();
      const input = projectCommandInput();
      await runProjectCommand(
        parsedCommand("project.prepare", { from: "project.json" }),
        commandServices(store, input)
      );
      const command = parseCommand(row.argv);
      const services = servicesFor(row.service_profile, store, input);
      const dispatched = await dispatchCommand(command, { services });

      assert.equal(dispatched.exitCode, row.exit_code, canonicalJson(dispatched));
      assert.equal(validateDocument(dispatched.result, "command-result.v1").valid, true);
      assert.notEqual(dispatched.result.error?.code, "COMMAND_CONTEXT_INVALID");
    });
  }
});

test("two production CLI sentinels preserve the executable boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "toss-gate-cli-round1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outsideRoot = await mkdtemp(join(tmpdir(), "toss-gate-cli-outside-"));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  assert.notEqual(outsideRoot, root);
  const store = createArtifactStore({ root });
  const input = projectCommandInput();
  await runProjectCommand(
    parsedCommand("project.prepare", { from: "project.json" }),
    commandServices(store, input)
  );

  const escapedCliUrl = new URL(CLI.href.replace(/cli\.js$/u, "%63li.js"));
  assert.match(escapedCliUrl.href, /%63/u);
  const jsonSuccess = await runProductionCli({
    cwd: outsideRoot,
    root,
    argv: ["architecture", "review", "--json"],
    cliUrl: escapedCliUrl,
  });
  assert.equal(jsonSuccess.exitCode, 0);
  assert.equal(jsonSuccess.stderr, "");
  assert.equal(JSON.parse(jsonSuccess.stdout).ok, true);

  const nativeSpacedCliPath = join(tmpdir(), "toss cli", "src", "cli.js");
  const escapedSpaceCliUrl = pathToFileURL(nativeSpacedCliPath);
  assert.match(escapedSpaceCliUrl.href, /%20/u);
  assert.equal(cliFilesystemPath(escapedSpaceCliUrl), nativeSpacedCliPath);

  const humanBlocked = await runProductionCli({
    cwd: outsideRoot,
    root,
    argv: ["decisions", "list"],
  });
  assert.equal(humanBlocked.exitCode, 4);
  assert.equal(humanBlocked.stdout, "");
  assert.match(humanBlocked.stderr, /blocked|decision/i);
  assert.doesNotMatch(humanBlocked.stderr, /FORBIDDEN_NETWORK_ACCESS/);
  assert.equal(productionCliStarts, 2);
});
