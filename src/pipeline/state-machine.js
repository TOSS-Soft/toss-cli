import {canonicalJson} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";

export const ANALYSIS_STATES=Object.freeze([
  "ANALYZING",
  "QUESTIONS_PENDING",
  "USER_DECISION",
  "ARCHITECTURE_PENDING",
  "ADR_PENDING_APPROVAL",
  "PM_FINALIZATION",
  "SPEC_AUDIT",
  "READY_FOR_ISSUES",
  "BLOCKED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
]);

const STATE_SET=new Set(ANALYSIS_STATES);
const SHA256_PATTERN=/^[a-f0-9]{64}$/;
const OWNER_SET=new Set(["PM","ARCHITECT","USER","SPEC_AUDITOR"]);
const TERMINAL_STATES=new Set(["READY_FOR_ISSUES","FAILED_TERMINAL"]);

const DECLARED_TRANSITIONS=Object.freeze({
  ANALYZING:Object.freeze({
    QUESTIONS_FOUND:"QUESTIONS_PENDING",
    ANALYSIS_COMPLETED:"ARCHITECTURE_PENDING",
  }),
  QUESTIONS_PENDING:Object.freeze({
    DECISION_STARTED:"USER_DECISION",
  }),
  USER_DECISION:Object.freeze({
    DECISIONS_RESOLVED:"ARCHITECTURE_PENDING",
  }),
  ARCHITECTURE_PENDING:Object.freeze({
    ADR_APPROVAL_REQUIRED:"ADR_PENDING_APPROVAL",
    ARCHITECTURE_COMPLETED:"PM_FINALIZATION",
  }),
  ADR_PENDING_APPROVAL:Object.freeze({
    ADR_APPROVED:"PM_FINALIZATION",
  }),
  PM_FINALIZATION:Object.freeze({
    FINALIZATION_COMPLETED:"SPEC_AUDIT",
  }),
  SPEC_AUDIT:Object.freeze({
    AUDIT_PASSED:"READY_FOR_ISSUES",
    AUDIT_BLOCKED:"BLOCKED",
  }),
  BLOCKED:Object.freeze({RESUME:"$resume_state"}),
  FAILED_RETRYABLE:Object.freeze({RETRY:"$resume_state"}),
});

const REQUIRED_ARTIFACT_KEYS=Object.freeze({
  "ANALYZING\u0000QUESTIONS_FOUND":Object.freeze(["pm_analysis","decision_package"]),
  "ANALYZING\u0000ANALYSIS_COMPLETED":Object.freeze(["pm_analysis"]),
  "QUESTIONS_PENDING\u0000DECISION_STARTED":Object.freeze(["decision_package"]),
  "USER_DECISION\u0000DECISIONS_RESOLVED":Object.freeze(["decision_package"]),
  "ARCHITECTURE_PENDING\u0000ADR_APPROVAL_REQUIRED":Object.freeze([
    "pm_analysis",
    "architecture",
    "adrs",
    "decision_package",
  ]),
  "ARCHITECTURE_PENDING\u0000ARCHITECTURE_COMPLETED":Object.freeze([
    "pm_analysis",
    "architecture",
    "adrs",
  ]),
  "ADR_PENDING_APPROVAL\u0000ADR_APPROVED":Object.freeze([
    "pm_analysis",
    "architecture",
    "adrs",
  ]),
  "PM_FINALIZATION\u0000FINALIZATION_COMPLETED":Object.freeze([
    "pm_analysis",
    "architecture",
    "adrs",
    "issue_plan",
  ]),
  "SPEC_AUDIT\u0000AUDIT_PASSED":Object.freeze([
    "pm_analysis",
    "architecture",
    "adrs",
    "issue_plan",
    "spec_audit",
  ]),
});

function isPlainObject(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function canonicalCopy(value,label) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON`,{cause:error});
  }
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

function sourceContext(context) {
  const sourceRevision=requiredText(context.source_revision,"source_revision");
  const sourceSha256=requiredText(context.source_sha256,"source_sha256");
  if (!SHA256_PATTERN.test(sourceSha256)) {
    throw new TypeError("source_sha256 must be a lowercase SHA-256 digest");
  }
  return {source_revision:sourceRevision,source_sha256:sourceSha256};
}

function artifactReference(value) {
  if (!isPlainObject(value) ||
      typeof value.document_type!=="string" ||
      typeof value.artifact_id!=="string" ||
      !Number.isSafeInteger(value.revision) || value.revision<1 ||
      typeof value.content_sha256!=="string" || !SHA256_PATTERN.test(value.content_sha256)) {
    return undefined;
  }
  return {
    document_type:value.document_type,
    artifact_id:value.artifact_id,
    revision:value.revision,
    content_sha256:value.content_sha256,
  };
}

function referencesFor(value,references=[]) {
  if (Array.isArray(value)) {
    for (const child of value) referencesFor(child,references);
    return references;
  }
  const reference=artifactReference(value);
  if (reference) references.push(reference);
  return references;
}

function canonicalReferences(artifacts,keys) {
  const references=[];
  for (const key of keys) referencesFor(artifacts[key],references);
  const unique=new Map(references.map(reference => [canonicalJson(reference),reference]));
  return [...unique.values()].sort((left,right) =>
    left.document_type.localeCompare(right.document_type) ||
    left.artifact_id.localeCompare(right.artifact_id) ||
    left.revision-right.revision ||
    left.content_sha256.localeCompare(right.content_sha256),
  );
}

function assertRequiredArtifacts(state,event,artifacts) {
  const keys=REQUIRED_ARTIFACT_KEYS[`${state}\u0000${event}`] ?? [];
  for (const key of keys) {
    if (!Object.hasOwn(artifacts,key) || artifacts[key]===undefined) {
      throw new TypeError(`${state} ${event} requires artifact ${key}`);
    }
  }
  return keys;
}

function assertDecisionPackage(decisionPackage) {
  if (!isPlainObject(decisionPackage) ||
      decisionPackage.schema_version!=="decision-package.v1" ||
      decisionPackage.document_type!=="decision-package" ||
      !Array.isArray(decisionPackage.questions) || !isPlainObject(decisionPackage.gate)) {
    throw new TypeError("QUESTIONS_PENDING requires a decision-package.v1 decision package");
  }
  const validation=validateDocument(decisionPackage,"decision-package.v1");
  if (!validation.valid) {
    const first=validation.errors[0];
    throw new TypeError(
      `Decision package is invalid${first?.instancePath ?? ""}: ${
        first?.message ?? "schema validation failed"
      }`,
    );
  }
  return decisionPackage;
}

function questionNextAction(decisionPackage) {
  assertDecisionPackage(decisionPackage);
  if (decisionPackage.gate.can_continue!==false ||
      decisionPackage.gate.status!=="BLOCKED") {
    throw new TypeError("QUESTIONS_FOUND requires a blocked decision package");
  }
  const unresolved=new Set(decisionPackage.gate.unresolved_blocking_question_ids ?? []);
  const owners=decisionPackage.questions
    .filter(question => unresolved.has(question.id))
    .map(question => question.owner)
    .filter(owner => OWNER_SET.has(owner));
  const owner=owners.includes("USER") ? "USER" : [...new Set(owners)].sort()[0];
  if (!owner) throw new TypeError("Decision package has no owner for its blocking questions");
  return {
    action:"RESOLVE_QUESTIONS",
    owner,
    decision_package:decisionPackage,
  };
}

function adrNextAction(decisionPackage,adrs) {
  if (!isPlainObject(decisionPackage) ||
      decisionPackage.schema_version!=="adr-approval-package.v1" ||
      decisionPackage.document_type!=="adr-approval-package" ||
      decisionPackage.owner!=="USER" ||
      !Array.isArray(decisionPackage.adr_references) ||
      decisionPackage.adr_references.length===0 ||
      decisionPackage.adr_references.some(reference =>
        artifactReference(reference)?.document_type!=="adr")) {
    throw new TypeError(
      "ADR_PENDING_APPROVAL requires a USER-owned package of exact ADR references",
    );
  }
  const pendingAdrs=adrs.filter(adr => adr.content?.approval?.state!=="approved");
  const suppliedReferences=canonicalReferences({adrs:pendingAdrs},["adrs"]);
  const packagedReferences=[...decisionPackage.adr_references].sort((left,right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)));
  if (canonicalJson(suppliedReferences)!==canonicalJson(packagedReferences)) {
    throw new TypeError("ADR approval package must bind the exact supplied ADR revisions");
  }
  return {action:"APPROVE_ADRS",owner:"USER",decision_package:decisionPackage};
}

function canonicalNextAction(value) {
  const nextAction=canonicalCopy(value,"next_action");
  if (!isPlainObject(nextAction) ||
      typeof nextAction.action!=="string" || !OWNER_SET.has(nextAction.owner)) {
    throw new TypeError("next_action requires an action and a valid owner");
  }
  return nextAction;
}

function canonicalFailure(value) {
  const failure=canonicalCopy(value,"failure");
  if (!isPlainObject(failure) ||
      typeof failure.code!=="string" || failure.code.length===0 ||
      typeof failure.message!=="string" || failure.message.length===0) {
    throw new TypeError("failure requires non-empty code and message");
  }
  return failure;
}

function resolveDeclaredTarget(state,event,context) {
  if (!STATE_SET.has(state)) throw new TypeError(`Unknown analysis state ${String(state)}`);
  if (typeof event!=="string" || event.length===0) {
    throw new TypeError("Transition event must be a non-empty string");
  }
  const declared=DECLARED_TRANSITIONS[state]?.[event];
  if (declared!==undefined) {
    if (declared!=="$resume_state") return declared;
    const resumeState=requiredText(context.resume_state,"resume_state");
    if (!STATE_SET.has(resumeState) || TERMINAL_STATES.has(resumeState) ||
        resumeState==="BLOCKED" || resumeState==="FAILED_RETRYABLE") {
      throw new TypeError(`Invalid recovery state ${resumeState}`);
    }
    return resumeState;
  }
  if (!TERMINAL_STATES.has(state) && event==="BLOCK") return "BLOCKED";
  if (!TERMINAL_STATES.has(state) && event==="FAIL_RETRYABLE") return "FAILED_RETRYABLE";
  if (!TERMINAL_STATES.has(state) && event==="FAIL_TERMINAL") return "FAILED_TERMINAL";
  throw new TypeError(`Illegal transition from ${state} with event ${event}`);
}

export function transition(state,event,context={}) {
  if (!isPlainObject(context)) throw new TypeError("Transition context must be an object");
  const target=resolveDeclaredTarget(state,event,context);
  const source=sourceContext(context);
  const artifacts=canonicalCopy(context.artifacts ?? {},"Transition artifacts");
  if (!isPlainObject(artifacts)) throw new TypeError("Transition artifacts must be an object");
  const requiredKeys=assertRequiredArtifacts(state,event,artifacts);
  const result={
    previous_state:state,
    event,
    state:target,
    ...source,
    input_artifacts:canonicalReferences(artifacts,requiredKeys),
  };

  if (event==="QUESTIONS_FOUND" ||
      (state==="QUESTIONS_PENDING" && event==="DECISION_STARTED")) {
    result.next_action=questionNextAction(artifacts.decision_package);
  }
  if (event==="DECISIONS_RESOLVED") {
    assertDecisionPackage(artifacts.decision_package);
    if (artifacts.decision_package?.gate?.can_continue!==true ||
        artifacts.decision_package?.gate?.status!=="CLEAR") {
      throw new TypeError("DECISIONS_RESOLVED requires a clear decision package");
    }
  }
  if (event==="ADR_APPROVAL_REQUIRED") {
    result.next_action=adrNextAction(artifacts.decision_package,artifacts.adrs);
  }
  if (event==="AUDIT_BLOCKED" || event==="BLOCK") {
    result.next_action=canonicalNextAction(context.next_action);
  }
  if (event==="FAIL_RETRYABLE" || event==="FAIL_TERMINAL") {
    result.failure=canonicalFailure(context.failure);
    result.resume_state=state;
  }
  if (event==="RESUME" || event==="RETRY") result.resume_state=target;

  return deepFreeze(canonicalCopy(result,"Transition result"));
}
