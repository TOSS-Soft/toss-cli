#!/usr/bin/env node
import {runCoreCli} from "../src/core/cli.js";

process.exitCode=await runCoreCli(process.argv.slice(2),{
  cwd:process.cwd(),
  stdin:process.stdin,
  stdout:process.stdout,
  stderr:process.stderr,
});
