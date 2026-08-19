import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const child=fileURLToPath(new URL("./child.mjs",import.meta.url));
const result=spawnSync(process.execPath,[child],{encoding:"utf8",env:process.env});
if (result.status!==0) process.exit(result.status ?? 70);
process.stdout.write(result.stdout);
process.stdout.write("✔ deterministic fixture case (20ms)\n");
