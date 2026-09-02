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

function normalizeScope(scopeInput) {
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
