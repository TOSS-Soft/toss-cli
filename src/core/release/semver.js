import {types} from "node:util";

import {compareCanonicalText} from "../canonical-order.js";
import {closedData,exact} from "../commands/common.js";
import {parseWorkItemId} from "../domain/identity.js";
import {CoreValidationError} from "../errors.js";

const SEMVER=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SCOPE_KEYS=Object.freeze([
  "id","kind","change_class","affects_published_product",
]);
const EPIC_KEYS=Object.freeze(["id","change_class"]);
const BUG_KEYS=Object.freeze(["id","kind","affects_published_product"]);
const SELECTION_KEYS=Object.freeze([
  "latestPublishedVersion","epics","bugs",
]);
const FEATURE_CHANGE_CLASSES=Object.freeze([
  "breaking","backward_compatible_feature",
]);
const DEFECT_KINDS=Object.freeze(["bug","fix"]);

function invalid(message,options={}) {
  throw new CoreValidationError(message,options);
}

function checkedAdd(value) {
  if (value===Number.MAX_SAFE_INTEGER) {
    invalid("Semantic version component cannot be incremented safely");
  }
  return value+1;
}

function shallowExactRecord(value,keys,label) {
  if (value===null || typeof value!=="object" || Array.isArray(value) ||
      types.isProxy(value)) {
    invalid(`${label} must be a plain non-proxy record`);
  }
  const prototype=Object.getPrototypeOf(value);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const ownKeys=Reflect.ownKeys(descriptors);
  if (![Object.prototype,null].includes(prototype) || ownKeys.length!==keys.length ||
      ownKeys.some(key => typeof key!=="string") ||
      keys.some(key => !Object.hasOwn(descriptors,key))) {
    invalid(`${label} must use an exact closed shape`);
  }
  const captured=Object.create(null);
  for (const key of keys) {
    const descriptor=descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor)) {
      invalid(`${label}.${key} must be an own enumerable data property`);
    }
    captured[key]=descriptor.value;
  }
  return captured;
}

function shallowDenseArray(value,label) {
  if (value===null || typeof value!=="object" || types.isProxy(value) ||
      !Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype) {
    invalid(`${label} must be a dense plain array`);
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const ownKeys=Reflect.ownKeys(descriptors);
  const lengthDescriptor=Object.getOwnPropertyDescriptor(descriptors,"length")?.value;
  const length=lengthDescriptor?.value;
  if (!lengthDescriptor || !("value" in lengthDescriptor) ||
      lengthDescriptor.enumerable!==false || lengthDescriptor.configurable!==false ||
      typeof lengthDescriptor.writable!=="boolean" || !Number.isSafeInteger(length) ||
      length<0 || length>0xffffffff || ownKeys.length!==length+1 ||
      (lengthDescriptor.writable===false && Object.isExtensible(value))) {
    invalid(`${label} must be a dense plain array`);
  }
  const captured=[];
  for (let index=0;index<length;index+=1) {
    const descriptor=descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) ||
        (lengthDescriptor.writable===false &&
         (descriptor.writable!==false || descriptor.configurable!==false))) {
      invalid(`${label} must contain dense own data`);
    }
    captured.push(descriptor.value);
  }
  return captured;
}

function scalar(value,typesAllowed,label,{nullable=false}={}) {
  if ((nullable && value===null) || typesAllowed.includes(typeof value)) return;
  invalid(`${label} must be a bounded scalar`);
}

function preflightScope(scopeInput) {
  const scope=shallowDenseArray(scopeInput,"Release scope");
  for (let index=0;index<scope.length;index+=1) {
    const item=shallowExactRecord(scope[index],SCOPE_KEYS,`Release scope[${index}]`);
    scalar(item.id,["string"],`Release scope[${index}].id`);
    scalar(item.kind,["string"],`Release scope[${index}].kind`);
    scalar(item.change_class,["string"],`Release scope[${index}].change_class`,{
      nullable:true,
    });
    scalar(item.affects_published_product,["boolean"],
      `Release scope[${index}].affects_published_product`);
  }
}

function preflightSelection(input) {
  const value=shallowExactRecord(input,SELECTION_KEYS,"Repository version selection");
  scalar(value.latestPublishedVersion,["string"],
    "Repository version selection.latestPublishedVersion");
  const epics=shallowDenseArray(value.epics,"Repository version selection epics");
  const bugs=shallowDenseArray(value.bugs,"Repository version selection bugs");
  for (let index=0;index<epics.length;index+=1) {
    const epic=shallowExactRecord(epics[index],EPIC_KEYS,
      `Repository version selection epic[${index}]`);
    scalar(epic.id,["string"],`Repository version selection epic[${index}].id`);
    scalar(epic.change_class,["string"],
      `Repository version selection epic[${index}].change_class`);
  }
  for (let index=0;index<bugs.length;index+=1) {
    const bug=shallowExactRecord(bugs[index],BUG_KEYS,
      `Repository version selection bug[${index}]`);
    scalar(bug.id,["string"],`Repository version selection bug[${index}].id`);
    scalar(bug.kind,["string"],`Repository version selection bug[${index}].kind`);
    scalar(bug.affects_published_product,["boolean"],
      `Repository version selection bug[${index}].affects_published_product`);
  }
}

export function parseSemVer(value) {
  const match=typeof value==="string" ? SEMVER.exec(value) : null;
  if (!match) invalid("Version must be canonical stable SemVer");
  const components=match.slice(1).map(component => Number(component));
  if (components.some(component => !Number.isSafeInteger(component))) {
    invalid("Semantic version components must be safe integers");
  }
  const [major,minor,patch]=components;
  return Object.freeze({major,minor,patch});
}

export function compareSemVer(left,right) {
  const leftValue=parseSemVer(left);
  const rightValue=parseSemVer(right);
  for (const key of ["major","minor","patch"]) {
    if (leftValue[key]!==rightValue[key]) return leftValue[key]<rightValue[key] ? -1 : 1;
  }
  return 0;
}

function normalizeScope(scopeInput) {
  preflightScope(scopeInput);
  const scope=closedData(scopeInput,"Release scope");
  if (!Array.isArray(scope) || scope.length===0) {
    invalid("Release scope must be a nonempty dense array");
  }
  const identities=new Set();
  let repository;
  for (let index=0;index<scope.length;index+=1) {
    const item=scope[index];
    exact(item,SCOPE_KEYS,`Release scope[${index}]`);
    const identity=parseWorkItemId(item.id);
    if (identities.has(item.id)) invalid(`Release scope contains duplicate id: ${item.id}`);
    identities.add(item.id);
    if (repository===undefined) repository=identity.repository;
    else if (repository!==identity.repository) {
      invalid("Release scope must belong to exactly one repository");
    }

    if (item.kind==="epic") {
      if (!FEATURE_CHANGE_CLASSES.includes(item.change_class) ||
          item.affects_published_product!==false) {
        invalid(`Release scope epic ${item.id} is invalid`);
      }
      continue;
    }
    if (!DEFECT_KINDS.includes(item.kind) || item.change_class!==null ||
        typeof item.affects_published_product!=="boolean") {
      invalid(`Release scope defect ${item.id} is invalid`);
    }
  }
  return scope;
}

function categorizedRationale(scope) {
  const categories=[
    ["breaking_public_boundary",item => item.kind==="epic" && item.change_class==="breaking"],
    ["backward_compatible_feature",item => item.kind==="epic" && item.change_class==="backward_compatible_feature"],
    ["published_product_fix",item => item.kind!=="epic" && item.affects_published_product],
    ["unreleased_defect_excluded",item => item.kind!=="epic" && !item.affects_published_product],
  ];
  return Object.freeze(categories.flatMap(([rule,matches]) => {
    const scopeIds=scope.filter(matches).map(item => item.id).sort(compareCanonicalText);
    return scopeIds.length===0 ? [] : [Object.freeze({
      rule,
      scope_ids:Object.freeze(scopeIds),
    })];
  }));
}

function selectedChangeClass(rationale) {
  const rules=new Set(rationale.map(reason => reason.rule));
  if (rules.has("breaking_public_boundary")) return "major";
  if (rules.has("backward_compatible_feature")) return "minor";
  if (rules.has("published_product_fix")) return "patch";
  invalid("Release scope must contain a selectable change");
}

export function classifyReleaseChange(scopeInput) {
  return selectedChangeClass(categorizedRationale(normalizeScope(scopeInput)));
}

export function nextVersion(currentVersion,changeClass) {
  const current=parseSemVer(currentVersion);
  if (changeClass==="major") return `${checkedAdd(current.major)}.0.0`;
  if (changeClass==="minor") return `${current.major}.${checkedAdd(current.minor)}.0`;
  if (changeClass==="patch") return `${current.major}.${current.minor}.${checkedAdd(current.patch)}`;
  const detail=typeof changeClass==="string" ? `: ${changeClass}` : "";
  invalid(`Unknown change class${detail}`,{
    code:"CORE_CHANGE_CLASS_INVALID",
  });
}

export function selectRepositoryVersion(input) {
  preflightSelection(input);
  const value=closedData(input,"Repository version selection");
  exact(value,SELECTION_KEYS,"Repository version selection");
  parseSemVer(value.latestPublishedVersion);
  if (!Array.isArray(value.epics) || !Array.isArray(value.bugs)) {
    invalid("Repository version selection epics and bugs must be arrays");
  }

  const scope=[];
  for (let index=0;index<value.epics.length;index+=1) {
    const epic=value.epics[index];
    exact(epic,EPIC_KEYS,`Repository version selection epic[${index}]`);
    scope.push({
      id:epic.id,
      kind:"epic",
      change_class:epic.change_class,
      affects_published_product:false,
    });
  }
  for (let index=0;index<value.bugs.length;index+=1) {
    const bug=value.bugs[index];
    exact(bug,BUG_KEYS,`Repository version selection bug[${index}]`);
    scope.push({
      id:bug.id,
      kind:bug.kind,
      change_class:null,
      affects_published_product:bug.affects_published_product,
    });
  }

  const normalized=normalizeScope(scope);
  const rationale=categorizedRationale(normalized);
  const changeClass=selectedChangeClass(rationale);
  return Object.freeze({
    version:nextVersion(value.latestPublishedVersion,changeClass),
    change_class:changeClass,
    rationale,
  });
}
