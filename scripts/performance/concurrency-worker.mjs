import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {executeTestEntry,runTestLane} from "../test-runner.mjs";
import {
  discoverEligibleTestEntries,
  validateTestManifest,
} from "../test-manifest.mjs";

export function parseConcurrencyWorkerOptions(argv) {
  if (!Array.isArray(argv) || argv.length!==2 || argv[0]!=="--concurrency" ||
      !/^[1-4]$/u.test(argv[1])) {
    throw new TypeError("usage: concurrency-worker.mjs --concurrency <1|2|3|4>");
  }
  return Object.freeze({concurrency:Number(argv[1])});
}

export async function runConcurrencyCandidate({
  concurrency,cwd,manifest,eligibleEntries,executeEntry,stdout,stderr,
}) {
  if (!Number.isInteger(concurrency) || concurrency<1 || concurrency>4) {
    throw new TypeError("concurrency candidate must be an integer from 1 to 4");
  }
  const candidate={
    schema_version:manifest?.schema_version,
    concurrency,
    lanes:Object.fromEntries(Object.entries(manifest?.lanes ?? {}).map(
      ([lane,entries]) => [lane,[...entries]],
    )),
  };
  return runTestLane({
    lane:"full",cwd,manifest:candidate,eligibleEntries,executeEntry,stdout,stderr,
  });
}

async function main(argv) {
  let options;
  try {
    options=parseConcurrencyWorkerOptions(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode=2;
    return;
  }
  const root=fileURLToPath(new URL("../..",import.meta.url));
  const manifest=JSON.parse(await readFile(
    new URL("../test-manifest.json",import.meta.url),"utf8",
  ));
  const eligibleEntries=await discoverEligibleTestEntries(root);
  validateTestManifest(manifest,{eligibleEntries});
  const result=await runConcurrencyCandidate({
    concurrency:options.concurrency,cwd:root,manifest,eligibleEntries,
    executeEntry:entry => executeTestEntry(entry,{cwd:root,env:process.env}),
    stdout:process.stdout,stderr:process.stderr,
  });
  process.exitCode=result.exit_status;
}

if (
  process.argv[1] &&
  resolve(process.argv[1])===fileURLToPath(import.meta.url) &&
  process.env.NODE_TEST_CONTEXT===undefined
) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode=70;
  });
}
