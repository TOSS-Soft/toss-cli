import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import {
  resolveGovernanceProfiles,
  resolveRequiredStatusChecks,
} from "../src/governance-config.js";

assert.deepEqual(resolveGovernanceProfiles({}), { core:true, delivery:false });
assert.deepEqual(
  resolveGovernanceProfiles({ governance:{ delivery:true } }),
  { core:true, delivery:true },
);
assert.throws(
  () => resolveGovernanceProfiles({ governance:{ delivery:"AUTO" } }),
  /governance\.delivery must be true or false/,
);
assert.throws(
  () => resolveGovernanceProfiles({ governance:{ assurance:true } }),
  /governance\.assurance is not supported/,
);
assert.throws(
  () => resolveGovernanceProfiles({ governance:{ unknown:true } }),
  /unknown governance key: unknown/,
);

assert.deepEqual(resolveRequiredStatusChecks({}),[]);
assert.deepEqual(
  resolveRequiredStatusChecks({delivery:{required_status_checks:["ci","security"]}}),
  ["ci","security"],
);
assert.throws(
  () => resolveRequiredStatusChecks({delivery:{required_status_checks:"ci"}}),
  /delivery\.required_status_checks must be an array/,
);
assert.throws(
  () => resolveRequiredStatusChecks({delivery:{required_status_checks:["ci",""]}}),
  /non-empty strings/,
);
assert.throws(
  () => resolveRequiredStatusChecks({delivery:{required_status_checks:["ci","ci"]}}),
  /must not contain duplicates/,
);

const root=path.resolve(".");
const cli=path.join(root,"bin","toss.js");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-governance-config-"));

function completeBrief(name,slug,governance) {
  return {
    project:{name,slug,description:"Governance validation test"},
    business:{problem:"Validate governance before project creation",primary_goal:"Reject invalid governance"},
    governance,
  };
}

function assertInvalidBrief({file,slug,governance,error}) {
  const brief=path.join(tmp,file);
  fs.writeFileSync(brief,YAML.stringify(completeBrief(file,slug,governance)),"utf8");
  const result=spawnSync(process.execPath,[cli,"create",brief],{
    cwd:tmp,
    encoding:"utf8",
  });

  assert.notEqual(result.status,0,`${file} was accepted`);
  assert.match(result.stderr,error);
  assert.equal(fs.existsSync(path.join(tmp,slug)),false);
}

assertInvalidBrief({
  file:"invalid-governance-project.yaml",
  slug:"invalid-governance-project",
  governance:{delivery:"AUTO"},
  error:/governance\.delivery must be true or false/,
});
assertInvalidBrief({
  file:"unsupported-assurance-project.yaml",
  slug:"unsupported-assurance-project",
  governance:{assurance:true},
  error:/governance\.assurance is not supported/,
});

for (const scenario of [
  {
    name:"project-without-repository",
    args:["--github-project"],
    error:/--github-project requires --github/,
  },
  {
    name:"ruleset-without-repository",
    args:["--ruleset"],
    error:/--ruleset requires --github/,
  },
]) {
  const destination=path.join(tmp,scenario.name);
  const result=spawnSync(
    process.execPath,
    [
      cli,
      scenario.name,
      "--slug",scenario.name,
      "--dir",destination,
      "--no-git",
      ...scenario.args,
    ],
    {cwd:tmp,encoding:"utf8"},
  );
  assert.notEqual(result.status,0,`${scenario.name} was accepted`);
  assert.match(result.stderr,scenario.error);
  assert.equal(
    fs.existsSync(destination),
    false,
    `${scenario.name} left a partial destination after precondition failure`,
  );
}

console.log("Governance configuration test: PASS");
