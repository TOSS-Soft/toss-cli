import {types as utilTypes} from "node:util";

import {canonicalJson} from "../contracts/acp.js";

const INPUT_KEYS=Object.freeze([
  "schema_version","scope","delivery_targets","affected_surfaces","risk_signals",
  "requested_level","source","purpose","success_criteria","approval_owner",
]);
const DELIVERY_TARGETS=new Set(["WEB","MOBILE","DESKTOP","API","CLI","BACKEND"]);
const UI_DELIVERY_TARGETS=new Set(["WEB","MOBILE","DESKTOP"]);
const SURFACES=new Set([
  "SCREEN","FLOW","INFORMATION_ARCHITECTURE","WIREFRAME","VISUAL_DIRECTION",
  "DESIGN_SYSTEM","COMPONENT","INTERACTION","PROTOTYPE","ACCESSIBILITY",
]);
const STANDARD_RISKS=new Set([
  "MULTI_SCREEN","NEW_INFORMATION_ARCHITECTURE","NEW_DESIGN_SYSTEM",
  "PROTOTYPE_REQUIRED","USER_RESEARCH",
]);
const CRITICAL_RISKS=new Set([
  "SAFETY_REGULATORY","SECURITY_PRIVACY","FINANCIAL","ACCESSIBILITY_HIGH",
  "IRREVERSIBLE","FAILURE_RECOVERY",
]);
const RISKS=new Set([...STANDARD_RISKS,...CRITICAL_RISKS]);
const LEVELS=Object.freeze(["NOT_APPLICABLE","LITE","STANDARD","CRITICAL"]);
const REQUESTED_LEVELS=new Set(["AUTO",...LEVELS]);
const SOURCES=new Set(["company_system","new_system","AUTO","NOT_APPLICABLE"]);

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalCopy(value,label) {
  try {
    if (utilTypes.isProxy(value)) throw new TypeError("proxies are unsupported");
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON`,{cause:error});
  }
}

function exactObject(value,label,keys) {
  if (!value || typeof value!=="object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a closed object`);
  }
  const actual=Object.keys(value).sort();
  const expected=[...keys].sort();
  if (canonicalJson(actual)!==canonicalJson(expected)) {
    throw new TypeError(`${label} is closed and contains an unexpected property`);
  }
  return value;
}

function text(value,label) {
  if (typeof value!=="string" || value.trim().length===0) {
    throw new TypeError(`${label} must be a non-blank string`);
  }
}

function enumArray(value,label,allowed,{allowEmpty=true}={}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length===0)) {
    throw new TypeError(`${label} must be a ${allowEmpty ? "" : "non-empty "}array`);
  }
  if (new Set(value).size!==value.length) {
    throw new TypeError(`${label} must contain unique values without duplicates`);
  }
  for (const item of value) {
    if (!allowed.has(item)) throw new TypeError(`${label} contains an invalid ${label}`);
  }
}

function normalizedInput(value) {
  const input=canonicalCopy(value,"design classification input");
  exactObject(input,"design classification input",INPUT_KEYS);
  if (input.schema_version!=="design-classification-input.v1") {
    throw new TypeError("design classification input schema_version is unsupported");
  }
  const scope=exactObject(input.scope,"design classification scope",["kind","id"]);
  if (!new Set(["project","feature"]).has(scope.kind)) {
    throw new TypeError("design classification scope kind must be project or feature");
  }
  text(scope.id,"design classification scope id");
  enumArray(input.delivery_targets,"design delivery target",DELIVERY_TARGETS,{allowEmpty:false});
  enumArray(input.affected_surfaces,"design affected surface",SURFACES);
  enumArray(input.risk_signals,"design risk signal",RISKS);
  if (!REQUESTED_LEVELS.has(input.requested_level)) {
    throw new TypeError("design requested level is invalid");
  }
  if (!SOURCES.has(input.source)) throw new TypeError("design source is invalid");
  text(input.purpose,"design purpose");
  if (!Array.isArray(input.success_criteria) || input.success_criteria.length===0 ||
      new Set(input.success_criteria).size!==input.success_criteria.length) {
    throw new TypeError("design success criteria must be a unique non-empty array");
  }
  for (const criterion of input.success_criteria) text(criterion,"design success criterion");
  const owner=exactObject(input.approval_owner,"design approval owner",["role","identity"]);
  text(owner.role,"design approval owner role");
  text(owner.identity,"design approval owner identity");
  return input;
}

function recommendedLevel(input) {
  const hasUiTarget=input.delivery_targets.some(target => UI_DELIVERY_TARGETS.has(target));
  const uiApplicable=hasUiTarget || input.affected_surfaces.length>0;
  if (!uiApplicable) return "NOT_APPLICABLE";
  if (input.risk_signals.some(signal => CRITICAL_RISKS.has(signal))) return "CRITICAL";
  if (input.risk_signals.some(signal => STANDARD_RISKS.has(signal))) return "STANDARD";
  return "LITE";
}

function effectiveLevel(input,recommended) {
  if (input.requested_level==="AUTO") return recommended;
  if (recommended==="NOT_APPLICABLE") return input.requested_level;
  if (input.requested_level==="NOT_APPLICABLE") {
    throw new TypeError("UI-affecting design scope cannot request NOT_APPLICABLE");
  }
  if (recommended==="CRITICAL" && input.requested_level!=="CRITICAL") return "CRITICAL";
  return LEVELS.indexOf(input.requested_level)>LEVELS.indexOf(recommended) ?
    input.requested_level : input.requested_level;
}

export function classifyDesignLevel(value) {
  const input=normalizedInput(value);
  const recommended=recommendedLevel(input);
  const effective=effectiveLevel(input,recommended);
  if (recommended==="NOT_APPLICABLE" && effective==="NOT_APPLICABLE" &&
      input.source!=="NOT_APPLICABLE") {
    throw new TypeError("NOT_APPLICABLE design classification requires NOT_APPLICABLE source");
  }
  if (effective!=="NOT_APPLICABLE" && input.source==="NOT_APPLICABLE") {
    throw new TypeError("Applicable design classification cannot use NOT_APPLICABLE source");
  }
  const criticalSignals=input.risk_signals.filter(signal => CRITICAL_RISKS.has(signal));
  const standardSignals=input.risk_signals.filter(signal => STANDARD_RISKS.has(signal));
  return deepFreeze({
    classification_input:input,
    recommended_level:recommended,
    effective_level:effective,
    basis:{
      ui_applicable:recommended!=="NOT_APPLICABLE",
      delivery_targets:[...input.delivery_targets],
      affected_surfaces:[...input.affected_surfaces],
      critical_risk_signals:criticalSignals,
      standard_risk_signals:standardSignals,
    },
    requires_downgrade_approval:recommended==="CRITICAL" &&
      input.requested_level!=="AUTO" && input.requested_level!=="CRITICAL",
  });
}
