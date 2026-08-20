import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

import {canonicalJson} from "../../src/contracts/acp.js";
import {comparePerformanceBudget} from "./report.mjs";

export function parseBudgetOptions(argv) {
  if (!Array.isArray(argv)) throw new TypeError("budget arguments must be an array");
  const options={json:false};
  const seen=new Set();
  for (let index=0;index<argv.length;index+=1) {
    const option=argv[index];
    if (option==="--json") {
      if (seen.has(option)) throw new TypeError("duplicate option --json");
      seen.add(option);
      options.json=true;
      continue;
    }
    if (!["--baseline","--report","--lane"].includes(option)) {
      throw new TypeError(`unknown option ${String(option)}`);
    }
    if (seen.has(option)) throw new TypeError(`duplicate option ${option}`);
    const value=argv[index+1];
    if (typeof value!=="string" || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
    seen.add(option);
    index+=1;
    if (option==="--baseline") options.baseline=value;
    if (option==="--report") options.report=value;
    if (option==="--lane") {
      if (value!=="fast" && value!=="full") throw new TypeError("budget lane must be fast or full");
      options.lane=value;
    }
  }
  if (options.baseline===undefined || options.report===undefined) {
    throw new TypeError("budget requires --baseline and --report");
  }
  if (options.lane===undefined) throw new TypeError("budget requires --lane");
  return Object.freeze(options);
}

async function readJson(path) {
  let source;
  try {
    source=await readFile(path,"utf8");
  } catch (error) {
    if (error?.code==="ENOENT" || error?.code==="EACCES" || error?.code==="EISDIR") {
      throw new PerformanceEvidenceError("unable to read performance evidence");
    }
    throw error;
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new PerformanceEvidenceError("invalid performance evidence JSON");
  }
}

class PerformanceEvidenceError extends Error {}

function writeResult(result,json) {
  process.stdout.write(json ? canonicalJson(result) : `${result.message}\n`);
}

export async function runBudgetCheck(argv) {
  const options=parseBudgetOptions(argv);
  const [baseline,report]=await Promise.all([readJson(options.baseline),readJson(options.report)]);
  return {result:comparePerformanceBudget(baseline,report,options.lane),json:options.json};
}

async function main(argv) {
  let options;
  try {
    options=parseBudgetOptions(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode=2;
    return;
  }
  try {
    const [baseline,report]=await Promise.all([readJson(options.baseline),readJson(options.report)]);
    const result=comparePerformanceBudget(baseline,report,options.lane);
    const {json}=options;
    writeResult(result,json);
    process.exitCode=result.ok ? 0 : 5;
  } catch (error) {
    if (error instanceof PerformanceEvidenceError || error instanceof TypeError) {
      writeResult({
        ok:false,code:"INVALID_PERFORMANCE_EVIDENCE",message:error.message,
      },options.json);
      process.exitCode=5;
      return;
    }
    throw error;
  }
}

if (process.argv[1]===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode=70;
  });
}
