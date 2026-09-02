import {types} from "node:util";

import {CoreConflictError,CoreValidationError} from "../errors.js";
import {parseReservedBranch,parseWorkItemId} from "./identity.js";

const REPOSITORY=/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const RELEASE_BRANCH=/^release\/v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const ITEM_KEYS=new Set([
  "acceptance_criteria","base_branch","branch","gate","id","issue_number","kind","milestone",
  "parent_id","repository","schema_version","status",
]);

function invalid(message) {
  throw new CoreValidationError(message);
}

function closeRecord(value,label,{allowed,required}) {
  if (value===null || typeof value!=="object" || Array.isArray(value) ||
      types.isProxy(value)) {
    invalid(`${label} must be a plain non-proxy record`);
  }
  const prototype=Object.getPrototypeOf(value);
  if (prototype!==Object.prototype && prototype!==null) {
    invalid(`${label} must be a plain non-proxy record`);
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const keys=Reflect.ownKeys(descriptors);
  for (const key of keys) {
    const descriptor=descriptors[key];
    if (typeof key!=="string" || !allowed.has(key) || !descriptor.enumerable ||
        !("value" in descriptor)) {
      invalid(`${label} must contain only known own enumerable data`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(descriptors,key)) invalid(`${label} is missing ${key}`);
  }
  return Object.freeze(Object.fromEntries(
    keys.map(key => [key,descriptors[key].value]),
  ));
}

function assertRepository(value,label) {
  if (typeof value!=="string" || !REPOSITORY.test(value)) {
    invalid(`${label} must be canonical OWNER/REPO ASCII`);
  }
  return value;
}

function assertWorkBranch(value,label,kind) {
  let parsed;
  try {
    parsed=parseReservedBranch(value);
  } catch {
    invalid(`${label} must be a canonical ${kind ?? "work"} branch`);
  }
  if (kind!==undefined && parsed.kind!==kind) {
    invalid(`${label} must be a canonical ${kind ?? "work"} branch`);
  }
  return parsed;
}

function assertReleaseBranch(value,label) {
  if (typeof value!=="string" || !RELEASE_BRANCH.test(value)) {
    invalid(`${label} must be a canonical release branch`);
  }
  return value;
}

function relation(value,label,kind) {
  const record=closeRecord(value,label,{
    allowed:new Set(["branch","id","repository"]),
    required:new Set(["branch","id","repository"]),
  });
  assertRepository(record.repository,`${label}.repository`);
  if (kind==="release") {
    assertReleaseBranch(record.branch,`${label}.branch`);
    if (record.id!==`${record.repository}@${record.branch}`) {
      invalid(`${label}.id must bind the exact repository release branch`);
    }
  } else {
    const branch=assertWorkBranch(record.branch,`${label}.branch`,kind);
    const identity=parseWorkItemId(record.id);
    if (identity.repository!==record.repository || identity.issueNumber!==branch.issueNumber) {
      invalid(`${label}.id must bind the exact repository and native issue branch`);
    }
  }
  return record;
}

function sameRepository(item,related,label) {
  if (item.repository!==related.repository) {
    invalid(`${label} must belong to the same repository`);
  }
}

export function requiredBaseBranch(itemValue,contextValue) {
  const item=closeRecord(itemValue,"Work item",{
    allowed:ITEM_KEYS,
    required:new Set(["id","kind","repository"]),
  });
  const context=closeRecord(contextValue,"Branch context",{
    allowed:new Set(["default_branch","parent","patch_release","release"]),
    required:new Set(),
  });
  assertRepository(item.repository,"Work item repository");
  if (["bug","epic","issue"].includes(item.kind)) {
    const identity=parseWorkItemId(item.id);
    if (identity.repository!==item.repository) invalid("Work item id must match its repository");
  } else if (item.kind==="release") {
    if (typeof item.id!=="string" || !item.id.startsWith(`${item.repository}@release/v`)) {
      invalid("Release item id must bind its repository and release identity");
    }
  }

  if (item.kind==="issue") {
    const parentIdentity=parseWorkItemId(item.parent_id);
    if (parentIdentity.repository!==item.repository) {
      invalid("Child issue must identify a same-repository parent");
    }
    if (context.parent===null || context.parent===undefined) return null;
    const parent=relation(context.parent,"Parent epic","epic");
    sameRepository(item,parent,"Parent epic");
    if (parent.id!==item.parent_id) {
      invalid("Parent epic identity does not match the child relation");
    }
    return parent.branch;
  }

  if (item.kind==="epic") {
    if (context.release===null || context.release===undefined) return null;
    const release=relation(context.release,"Active release","release");
    sameRepository(item,release,"Active release");
    return release.branch;
  }

  if (item.kind==="bug") {
    if (context.patch_release===null || context.patch_release===undefined) return null;
    const patch=relation(context.patch_release,"Patch release","release");
    sameRepository(item,patch,"Patch release");
    return patch.branch;
  }

  if (item.kind==="release") {
    if (context.default_branch!=="main") {
      invalid("Release pull requests must use the normalized main default branch");
    }
    return "main";
  }

  invalid("Unsupported work item kind for branch derivation");
}

export function assertValidPullRequestTarget(value) {
  const target=closeRecord(value,"Pull request target",{
    allowed:new Set(["base","baseRepository","expectedBase","head","headRepository"]),
    required:new Set(["base","baseRepository","expectedBase","head","headRepository"]),
  });
  assertRepository(target.headRepository,"Head repository");
  assertRepository(target.baseRepository,"Base repository");
  if (target.headRepository!==target.baseRepository) {
    invalid("Cross-repository pull request targets are not governed");
  }
  if (typeof target.base!=="string" || typeof target.expectedBase!=="string") {
    invalid("Pull request base branches must be strings");
  }
  if (target.base!==target.expectedBase) {
    throw new CoreConflictError("Existing pull request base conflicts with the required base");
  }

  let workHead;
  try {
    workHead=parseReservedBranch(target.head);
  } catch {
    workHead=null;
  }
  if (workHead) {
    if (target.base==="main") invalid("Work item pull requests may not target main");
    if (workHead.kind==="issue") assertWorkBranch(target.base,"Issue pull request base","epic");
    else assertReleaseBranch(target.base,"Epic or bug pull request base");
    return true;
  }

  if (typeof target.head==="string" && RELEASE_BRANCH.test(target.head)) {
    if (target.base!=="main") invalid("Release pull requests must target main");
    return true;
  }

  invalid("Pull request head must be a reserved work or release branch");
}
