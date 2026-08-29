import {spawn} from "node:child_process";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {performance} from "node:perf_hooks";
import {fileURLToPath,pathToFileURL} from "node:url";

import {
  PERFORMANCE_CODES,PerformanceToolError,parseNamedDurations,summarizeProcessEvents,
} from "./report.mjs";

const probe=fileURLToPath(new URL("./process-probe.mjs",import.meta.url));

function preloadOptions(existing="") {
  const own=`--import=${pathToFileURL(probe).href}`;
  return existing.trim()==="" ? own : `${existing} ${own}`;
}

function nonemptyString(value,label) {
  if (typeof value!=="string" || value.length===0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
  return value;
}

function commandArguments(args) {
  if (!Array.isArray(args) || args.some(value => typeof value!=="string")) {
    throw new TypeError("performance arguments must be a string array");
  }
  return [...args];
}

export function performanceInvocationForPlatform(command,args,{
  platform=process.platform,
  comSpec=process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
}={}) {
  nonemptyString(command,"performance command");
  const normalizedArgs=commandArguments(args);
  nonemptyString(platform,"performance platform");
  if (platform!=="win32" || command!=="npm.cmd") {
    return {command,args:normalizedArgs};
  }
  const interpreter=nonemptyString(comSpec,"performance command interpreter");
  return {command:interpreter,args:["/d","/c",command,...normalizedArgs]};
}

function execute(command,args,{cwd,env}) {
  return new Promise((resolveExecution,rejectExecution) => {
    const invocation=performanceInvocationForPlatform(command,args);
    const child=spawn(invocation.command,invocation.args,{cwd,env,stdio:["ignore","pipe","pipe"],shell:false});
    let stdout="";
    let stderr="";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data",chunk => { stdout+=chunk; });
    child.stderr.on("data",chunk => { stderr+=chunk; });
    child.once("error",rejectExecution);
    child.once("close",status => resolveExecution({status:status ?? 70,stdout,stderr}));
  });
}

export function parseProcessLog(text,root,runId) {
  let events;
  try {
    events=text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  } catch {
    throw new PerformanceToolError(PERFORMANCE_CODES.INVALID_PROCESS_LOG,
      "invalid process log JSONL");
  }
  try {
    return summarizeProcessEvents(events,root,runId);
  } catch (error) {
    if (error instanceof PerformanceToolError) throw error;
    throw new PerformanceToolError(PERFORMANCE_CODES.INVALID_PROCESS_LOG,
      "invalid process log event");
  }
}

export async function runSuiteOnce({command,args,cwd,runId,env={}}) {
  const scratch=await mkdtemp(join(tmpdir(),"toss-test-performance-"));
  const log=join(scratch,"processes.jsonl");
  const inheritedEnvironment={...process.env};
  delete inheritedEnvironment.NODE_TEST_CONTEXT;
  await writeFile(log,"","utf8");
  const started=performance.now();
  try {
    const result=await execute(command,args,{
      cwd,
      env:{
        ...inheritedEnvironment,...env,
        NODE_OPTIONS:preloadOptions(env.NODE_OPTIONS ?? inheritedEnvironment.NODE_OPTIONS ?? ""),
        TOSS_PERFORMANCE_PROCESS_LOG:log,
        TOSS_PERFORMANCE_RUN_ID:runId,
      },
    });
    const processes=parseProcessLog(await readFile(log,"utf8"),cwd,runId);
    return {
      wall_ms:performance.now()-started,
      user_cpu_ms:processes.user_cpu_ms,
      system_cpu_ms:processes.system_cpu_ms,
      exit_status:result.status,
      fresh_process_count:processes.fresh_process_count,
      peak_process_count:processes.peak_process_count,
      duplicates:processes.duplicates,
      slowest_files:processes.entries.slice(0,10),
      slowest_tests:parseNamedDurations(result.stdout)
        .sort((left,right) => right.duration_ms-left.duration_ms).slice(0,10),
      stdout:result.stdout,stderr:result.stderr,
    };
  } finally {
    await rm(scratch,{recursive:true,force:true});
  }
}
