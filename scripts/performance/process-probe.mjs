import {appendFileSync} from "node:fs";
import {performance} from "node:perf_hooks";

const logPath=process.env.TOSS_PERFORMANCE_PROCESS_LOG;
const runId=process.env.TOSS_PERFORMANCE_RUN_ID;

if (logPath && runId) {
  const at=() => performance.timeOrigin+performance.now();
  const recordBytes=event => Buffer.byteLength(`${JSON.stringify(event)}\n`,"utf8");
  const append=event => {
    const text=JSON.stringify(event);
    if (Buffer.byteLength(`${text}\n`,"utf8")>=4096) {
      throw new RangeError("performance process event exceeds 4095 bytes");
    }
    appendFileSync(logPath,`${text}\n`,{encoding:"utf8",flag:"a"});
  };
  const start={kind:"start",run_id:runId,pid:process.pid,at_ms:at(),argv:[...process.argv]};
  while (recordBytes(start)>=4096 && start.argv.length>1) {
    start.argv.pop();
  }
  while (recordBytes(start)>=4096 && start.argv[0].length>0) {
    start.argv[0]=start.argv[0].slice(0,Math.floor(start.argv[0].length/2));
  }
  append(start);
  process.once("exit",() => {
    const usage=process.resourceUsage();
    append({
      kind:"end",run_id:runId,pid:process.pid,at_ms:at(),
      user_cpu_us:usage.userCPUTime,system_cpu_us:usage.systemCPUTime,
    });
  });
}
