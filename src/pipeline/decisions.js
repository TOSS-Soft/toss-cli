import {canonicalJson} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";

const QUESTION_ID_PATTERN=/^Q-[A-Z0-9]+(?:[._-][A-Z0-9]+)*$/;
const ENTITY_ID_PATTERN=/^(?:REQ|NFR|BR|FLOW|ARCHQ|ADR|EPIC|ISSUE|AC|RISK|ASM|Q)-[A-Z0-9]+(?:[._-][A-Z0-9]+)*$/;
const SEVERITY_RANK=Object.freeze({P0:0,P1:1,P2:2,P3:3,P4:4});
const BLOCKING_SEVERITIES=new Set(["P0","P1","P2"]);
const ASSUMPTION_SEVERITIES=new Set(["P3","P4"]);
const REVERSIBILITY_RANK=Object.freeze({
  reversible:0,
  "partially-reversible":1,
  irreversible:2,
});
const INPUT_FIELDS=new Set([
  "id",
  "kind",
  "meaning",
  "question",
  "severity",
  "owner",
  "authority",
  "decision_owner",
  "technical_preference",
  "business_input_missing",
  "context",
  "impact",
  "options",
  "recommendation",
  "rationale",
  "affected_entities",
  "provenance",
  "dependencies",
  "status",
  "resolved",
  "resolution",
  "reversibility",
]);

function isPlainObject(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function canonicalCopy(value) {
  return JSON.parse(canonicalJson(value));
}

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requiredText(value,label) {
  if (typeof value!=="string" || value.trim().length===0) {
    throw new TypeError(`${label} must be a non-blank string`);
  }
  return value.trim();
}

function compareCanonical(left,right) {
  const leftJson=canonicalJson(left);
  const rightJson=canonicalJson(right);
  if (leftJson===rightJson) return 0;
  return leftJson<rightJson ? -1 : 1;
}

function canonicalIds(ids,label,pattern,{allowEmpty=false}={}) {
  if (!Array.isArray(ids) || (!allowEmpty && ids.length===0)) {
    throw new TypeError(`${label} must be a ${allowEmpty ? "" : "non-empty "}array`);
  }
  const seen=new Set();
  for (const id of ids) {
    if (typeof id!=="string" || !pattern.test(id)) {
      throw new TypeError(`${label} contains an invalid identifier: ${String(id)}`);
    }
    if (seen.has(id)) throw new TypeError(`${label} must not contain duplicate identifier ${id}`);
    seen.add(id);
  }
  return [...seen].sort();
}

function questionStatus(question) {
  const hasStatus=Object.hasOwn(question,"status");
  const hasResolved=Object.hasOwn(question,"resolved");
  if (hasStatus && question.status!=="unresolved" && question.status!=="resolved") {
    throw new TypeError("Question status must be unresolved or resolved");
  }
  if (hasResolved && typeof question.resolved!=="boolean") {
    throw new TypeError("Question resolved must be a boolean when supplied");
  }
  const status=hasStatus ? question.status : question.resolved ? "resolved" : "unresolved";
  if (hasStatus && hasResolved && (question.resolved!==(status==="resolved"))) {
    throw new TypeError("Question status and resolved flag contradict each other");
  }
  return status;
}

function normalizeMeaning(value) {
  return requiredText(value,"Question meaning")
    .normalize("NFKC")
    .replace(/\s+/gu," ")
    .toLowerCase();
}

function normalizeDisplayText(value,label) {
  return requiredText(value,label).replace(/\s+/gu," ");
}

function normalizedKey(question) {
  return canonicalJson({
    affected_entities:question.affected_entities,
    meaning:question.normalized_meaning,
  });
}

function parseOptions(value) {
  if (!Array.isArray(value) || value.length===0) {
    throw new TypeError("Question options must be a non-empty array");
  }
  const byId=new Set();
  const options=value.map((option,index) => {
    if (!isPlainObject(option)) {
      throw new TypeError(`Question option ${index} must be an object`);
    }
    const id=requiredText(option.id,`Question option ${index} id`);
    if (byId.has(id)) throw new TypeError(`Question options duplicate id ${id}`);
    byId.add(id);
    return {id,label:normalizeDisplayText(option.label,`Question option ${index} label`)};
  });
  return options.sort(compareCanonical);
}

function parseProvenance(value) {
  const result=validateDocument(value,"provenance.v1");
  if (!result.valid) {
    const first=result.errors[0];
    throw new TypeError(
      `Question provenance is invalid${first?.instancePath ?? ""}: ${
        first?.message ?? "schema validation failed"
      }`,
    );
  }
  return canonicalCopy(value);
}

function parseReversibility(question,severity) {
  const hasReversibility=Object.hasOwn(question,"reversibility");
  if (ASSUMPTION_SEVERITIES.has(severity) && !hasReversibility) {
    throw new TypeError(`${severity} assumptions require reversibility`);
  }
  if (!hasReversibility) return undefined;
  if (!Object.hasOwn(REVERSIBILITY_RANK,question.reversibility)) {
    throw new TypeError("Question reversibility is invalid");
  }
  return question.reversibility;
}

function classifyCanonicalQuestion(question) {
  if (!isPlainObject(question)) {
    throw new TypeError("Question classification input must be a plain object");
  }
  if (!Object.hasOwn(SEVERITY_RANK,question.severity)) {
    throw new TypeError("Question severity must be one of P0, P1, P2, P3, or P4");
  }
  if (question.business_input_missing!==undefined &&
      typeof question.business_input_missing!=="boolean") {
    throw new TypeError("business_input_missing must be a boolean");
  }
  if (question.technical_preference!==undefined &&
      typeof question.technical_preference!=="boolean") {
    throw new TypeError("technical_preference must be a boolean");
  }
  if (question.business_input_missing!==undefined && question.severity!=="P1") {
    throw new TypeError("business_input_missing is only valid for P1 questions");
  }
  if (question.technical_preference===true &&
      (question.severity==="P0" || question.severity==="P2")) {
    throw new TypeError(
      "A technical preference cannot route directly to USER without P1 business input",
    );
  }

  let authority;
  let owner;
  let hardStop=false;
  let requiresAssumptionEvidence=false;
  let businessInputMissing=false;
  switch (question.severity) {
    case "P0":
      authority="A3";
      owner="USER";
      hardStop=true;
      break;
    case "P1":
      businessInputMissing=question.business_input_missing===true;
      authority=businessInputMissing ? "A3" : "A2";
      owner=businessInputMissing ? "USER" : "ARCHITECT";
      break;
    case "P2":
      authority="A3";
      owner="USER";
      break;
    case "P3":
    case "P4":
      authority="A1";
      owner="PM";
      requiresAssumptionEvidence=true;
      break;
    default:
      throw new TypeError(`Unsupported question severity ${String(question.severity)}`);
  }

  if (question.authority!==undefined && question.authority!==authority) {
    throw new TypeError(
      `Question authority ${String(question.authority)} contradicts ${question.severity} mapping`,
    );
  }
  if (question.decision_owner!==undefined && question.decision_owner!==owner) {
    throw new TypeError(
      `Question decision owner ${String(question.decision_owner)} contradicts ${question.severity} mapping`,
    );
  }
  return deepFreeze({
    severity:question.severity,
    authority,
    owner,
    hard_stop:hardStop,
    blocks_when_unresolved:BLOCKING_SEVERITIES.has(question.severity),
    requires_assumption_evidence:requiresAssumptionEvidence,
    business_input_missing:businessInputMissing,
  });
}

export function classifyQuestion(question) {
  let canonical;
  try {
    canonical=canonicalCopy(question);
  } catch (error) {
    throw new TypeError(
      `Cannot classify a non-canonical question: ${
        error instanceof Error ? error.message : "invalid value"
      }`,
      {cause:error},
    );
  }
  return classifyCanonicalQuestion(canonical);
}

function rejectUnknownInputFields(question) {
  for (const key of Object.keys(question)) {
    if (!INPUT_FIELDS.has(key)) {
      throw new TypeError(`Question contains unsupported field ${key}`);
    }
  }
}

function analyzeQuestion(question,index) {
  if (!isPlainObject(question)) {
    throw new TypeError(`Question at index ${index} must be a plain object`);
  }
  rejectUnknownInputFields(question);
  if (question.kind!==undefined && question.kind!=="question") {
    throw new TypeError(`Question ${index} kind must be question when supplied`);
  }
  const id=requiredText(question.id,`Question ${index} id`);
  if (!QUESTION_ID_PATTERN.test(id)) {
    throw new TypeError(`Question ${index} id must be a Q identifier`);
  }
  const classification=classifyCanonicalQuestion(question);
  const severity=classification.severity;
  const reportedOwner=question.owner===undefined ? undefined :
    requiredText(question.owner,`Question ${id} owner`);
  const resolution=question.resolution===undefined ? undefined :
    normalizeDisplayText(question.resolution,`Question ${id} resolution`);
  const result={
    id,
    meaning:normalizeDisplayText(question.meaning,`Question ${id} meaning`),
    normalized_meaning:normalizeMeaning(question.meaning),
    question:normalizeDisplayText(question.question,`Question ${id} text`),
    severity,
    status:questionStatus(question),
    context:normalizeDisplayText(question.context,`Question ${id} context`),
    impact:normalizeDisplayText(question.impact,`Question ${id} impact`),
    options:parseOptions(question.options),
    recommendation:normalizeDisplayText(question.recommendation,`Question ${id} recommendation`),
    rationale:normalizeDisplayText(question.rationale,`Question ${id} rationale`),
    affected_entities:canonicalIds(
      question.affected_entities,
      `Question ${id} affected_entities`,
      ENTITY_ID_PATTERN,
    ),
    provenance:parseProvenance(question.provenance),
    dependencies:canonicalIds(
      question.dependencies ?? [],
      `Question ${id} dependencies`,
      QUESTION_ID_PATTERN,
      {allowEmpty:true},
    ),
    classification,
  };
  if (reportedOwner!==undefined) result.owner=reportedOwner;
  if (resolution!==undefined) result.resolution=resolution;
  const reversibility=parseReversibility(question,severity);
  if (reversibility!==undefined) result.reversibility=reversibility;
  if (question.business_input_missing===true) result.business_input_missing=true;
  if (question.technical_preference===true) result.technical_preference=true;
  return result;
}

function evidenceFor(question) {
  const evidence={
    source_id:question.id,
    meaning:question.meaning,
    question:question.question,
    severity:question.severity,
    status:question.status,
    context:question.context,
    impact:question.impact,
    options:question.options,
    recommendation:question.recommendation,
    rationale:question.rationale,
    affected_entities:question.affected_entities,
    provenance:question.provenance,
    dependencies:question.dependencies,
  };
  for (const field of [
    "owner",
    "reversibility",
    "business_input_missing",
    "technical_preference",
    "resolution",
  ]) {
    if (question[field]!==undefined) evidence[field]=question[field];
  }
  return evidence;
}

function selectMostBlockingSeverity(members) {
  return members.reduce((selected,member) =>
    SEVERITY_RANK[member.severity]<SEVERITY_RANK[selected] ? member.severity : selected,
  members[0].severity);
}

function selectReversibility(members) {
  return members.reduce((selected,member) =>
    REVERSIBILITY_RANK[member.reversibility]>REVERSIBILITY_RANK[selected] ?
      member.reversibility : selected,
  members[0].reversibility);
}

function mergeOptions(members) {
  const labelsById=new Map();
  const optionsByCanonical=new Map();
  for (const member of members) {
    for (const option of member.options) {
      if (labelsById.has(option.id) && labelsById.get(option.id)!==option.label) {
        throw new TypeError(`Question options conflict for id ${option.id}`);
      }
      labelsById.set(option.id,option.label);
      optionsByCanonical.set(canonicalJson(option),option);
    }
  }
  return [...optionsByCanonical.values()].sort(compareCanonical);
}

function buildGroups(questions) {
  const bySourceId=new Map();
  const groups=new Map();
  for (const question of questions) {
    const key=normalizedKey(question);
    const existing=bySourceId.get(question.id);
    if (existing!==undefined && existing!==key) {
      throw new TypeError(
        `Duplicate question id ${question.id} has conflicting normalized meaning or affected entities`,
      );
    }
    bySourceId.set(question.id,key);
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(question);
  }
  return groups;
}

function mergeGroup(members,idBySource) {
  const orderedMembers=[...members].sort((left,right) =>
    compareCanonical(evidenceFor(left),evidenceFor(right)),
  );
  const id=[...new Set(members.map(member => member.id))].sort()[0];
  const severity=selectMostBlockingSeverity(members);
  const p1Members=members.filter(member => member.severity==="P1");
  const businessInputMissing=severity==="P1" && p1Members.some(member =>
    member.business_input_missing===true,
  );
  const technicalPreference=severity==="P1" && p1Members.some(member =>
    member.technical_preference===true,
  );
  const classification=classifyCanonicalQuestion({
    severity,
    ...(businessInputMissing ? {business_input_missing:true} : {}),
    ...(technicalPreference ? {technical_preference:true} : {}),
  });
  const primary=orderedMembers[0];
  const dependencies=new Set();
  for (const member of members) {
    for (const dependency of member.dependencies) {
      const canonicalId=idBySource.get(dependency);
      if (!canonicalId) {
        throw new TypeError(`Dangling decision dependency ${dependency} for ${id}`);
      }
      if (canonicalId===id) {
        throw new TypeError(`Decision ${id} has a self dependency after deduplication`);
      }
      dependencies.add(canonicalId);
    }
  }
  const evidenceByCanonical=new Map();
  for (const member of members) {
    const evidence=evidenceFor(member);
    evidenceByCanonical.set(canonicalJson(evidence),evidence);
  }
  const merged={
    id,
    meaning:primary.meaning,
    question:primary.question,
    severity,
    authority:classification.authority,
    owner:classification.owner,
    status:members.every(member => member.status==="resolved") ? "resolved" : "unresolved",
    context:primary.context,
    impact:primary.impact,
    options:mergeOptions(members),
    recommendation:primary.recommendation,
    rationale:primary.rationale,
    affected_entities:primary.affected_entities,
    provenance:primary.provenance,
    dependencies:[...dependencies].sort(),
    source_ids:[...new Set(members.map(member => member.id))].sort(),
    evidence:[...evidenceByCanonical.values()].sort(compareCanonical),
  };
  if (ASSUMPTION_SEVERITIES.has(severity)) {
    merged.reversibility=selectReversibility(members.filter(member =>
      ASSUMPTION_SEVERITIES.has(member.severity),
    ));
  }
  if (businessInputMissing) merged.business_input_missing=true;
  if (technicalPreference) merged.technical_preference=true;
  return merged;
}

function stableTopologicalOrder(questions) {
  const byId=new Map();
  const indegree=new Map();
  const dependents=new Map();
  for (const question of questions) {
    if (byId.has(question.id)) {
      throw new TypeError(`Duplicate canonical decision id ${question.id}`);
    }
    byId.set(question.id,question);
    indegree.set(question.id,0);
    dependents.set(question.id,[]);
  }
  for (const question of questions) {
    for (const dependency of question.dependencies) {
      if (!byId.has(dependency)) {
        throw new TypeError(`Dangling decision dependency ${dependency} for ${question.id}`);
      }
      if (dependency===question.id) {
        throw new TypeError(`Decision ${question.id} has a self dependency`);
      }
      indegree.set(question.id,indegree.get(question.id)+1);
      dependents.get(dependency).push(question.id);
    }
  }
  const ready=[...byId.keys()].filter(id => indegree.get(id)===0).sort();
  const ordered=[];
  while (ready.length>0) {
    const id=ready.shift();
    ordered.push(byId.get(id));
    for (const dependent of dependents.get(id).sort()) {
      const next=indegree.get(dependent)-1;
      indegree.set(dependent,next);
      if (next===0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (ordered.length!==questions.length) {
    throw new TypeError("Decision dependency graph contains a cycle");
  }
  return ordered;
}

function recomputeGate(questions) {
  const unresolvedBlockingQuestionIds=[];
  const unresolvedAssumptionQuestionIds=[];
  for (const question of questions) {
    if (question.status!=="unresolved") continue;
    if (BLOCKING_SEVERITIES.has(question.severity)) {
      unresolvedBlockingQuestionIds.push(question.id);
    } else if (ASSUMPTION_SEVERITIES.has(question.severity)) {
      unresolvedAssumptionQuestionIds.push(question.id);
    }
  }
  return {
    can_continue:unresolvedBlockingQuestionIds.length===0,
    status:unresolvedBlockingQuestionIds.length===0 ? "CLEAR" : "BLOCKED",
    unresolved_blocking_question_ids:unresolvedBlockingQuestionIds,
    unresolved_assumption_question_ids:unresolvedAssumptionQuestionIds,
  };
}

function schemaError(result,label) {
  const error=result.errors[0];
  return new TypeError(
    `${label} is invalid${error?.instancePath ?? ""}: ${
      error?.message ?? "schema validation failed"
    }`,
  );
}

function assertPackageQuestions(packageValue) {
  const seenKeys=new Set();
  for (const question of packageValue.questions) {
    const classification=classifyCanonicalQuestion(question);
    if (question.authority!==classification.authority ||
        question.owner!==classification.owner) {
      throw new TypeError(`Decision ${question.id} contradicts its derived authority route`);
    }
    const key=canonicalJson({
      affected_entities:question.affected_entities,
      meaning:normalizeMeaning(question.meaning),
    });
    if (seenKeys.has(key)) {
      throw new TypeError(`Decision package contains duplicate normalized decision ${question.id}`);
    }
    seenKeys.add(key);
  }
  const ordered=stableTopologicalOrder(packageValue.questions);
  const actual=packageValue.questions.map(question => question.id);
  const expected=ordered.map(question => question.id);
  if (canonicalJson(actual)!==canonicalJson(expected)) {
    throw new TypeError("Decision package questions are not in stable topological order");
  }
}

function canonicalPackage(value) {
  let packageValue;
  try {
    packageValue=canonicalCopy(value);
  } catch (error) {
    throw new TypeError(
      `Decision package must be canonical JSON: ${
        error instanceof Error ? error.message : "invalid value"
      }`,
      {cause:error},
    );
  }
  const shape=validateDocument(packageValue,"decision-package.v1");
  if (!shape.valid) throw schemaError(shape,"Decision package");
  assertPackageQuestions(packageValue);
  return packageValue;
}

export function buildDecisionPackage(questions) {
  let canonicalQuestions;
  try {
    canonicalQuestions=canonicalCopy(questions);
  } catch (error) {
    throw new TypeError(
      `Decision questions must be canonical JSON: ${
        error instanceof Error ? error.message : "invalid value"
      }`,
      {cause:error},
    );
  }
  if (!Array.isArray(canonicalQuestions)) {
    throw new TypeError("Decision questions must be an array");
  }
  const analyzed=canonicalQuestions.map(analyzeQuestion);
  const groups=buildGroups(analyzed);
  const idBySource=new Map();
  for (const members of groups.values()) {
    const canonicalId=[...new Set(members.map(member => member.id))].sort()[0];
    for (const member of members) idBySource.set(member.id,canonicalId);
  }
  const merged=[...groups.values()].map(members => mergeGroup(members,idBySource));
  const ordered=stableTopologicalOrder(merged);
  const packageValue={
    schema_version:"decision-package.v1",
    document_type:"decision-package",
    questions:ordered,
    gate:recomputeGate(ordered),
  };
  canonicalPackage(packageValue);
  return deepFreeze(packageValue);
}

export function evaluateDecisionGate(packageValue) {
  const canonical=canonicalPackage(packageValue);
  return deepFreeze(recomputeGate(canonical.questions));
}
