import fs from "node:fs";
import { spawnSync } from "node:child_process";

const kind = process.argv[2];
if (!["patch","minor","major"].includes(kind)) {
  console.error("Usage: npm run release:version -- patch|minor|major");
  process.exit(1);
}

const run = (cmd,args) => {
  const r=spawnSync(cmd,args,{stdio:"inherit",encoding:"utf8"});
  if (r.status!==0) process.exit(r.status||1);
};

run("npm",["version",kind]);
console.log("");
console.log("Version/tag created locally.");
console.log("Review it, then push:");
console.log("  git push origin main --follow-tags");
