import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {validateArchitecture} from "./architecture.js";
import {validateIssuePlan} from "./issue-plan.js";
import {validatePmAnalysis} from "./pm-analysis.js";
import {auditSpecification} from "./spec-auditor.js";

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
const OWNER_SET=new Set(["PM","ARCHITECT","PM_FINALIZATION","USER"]);
const TERMINAL_STATES=new Set(["READY_FOR_ISSUES","FAILED_TERMINAL"]);

const DECLARED_TRANSITIONS=Object.freeze({
  ANALYZING:Object.freeze({
    SOURCE_RESTARTED:"ANALYZING",
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
  "QUESTIONS_PENDING\u0000DECISION_STARTED":Object.freeze([
    "pm_analysis","decision_package",
  ]),
  "USER_DECISION\u0000DECISIONS_RESOLVED":Object.freeze([
    "pm_analysis","decision_package",
  ]),
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
    "decision_package",
  ]),
  "ARCHITECTURE_PENDING\u0000BLOCK":Object.freeze([
    "pm_analysis",
    "architecture",
    "adrs",
  ]),
  "PM_FINALIZATION\u0000BLOCK":Object.freeze([
    "pm_analysis",
    "architecture",
    "adrs",
    "issue_plan",
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
  "SPEC_AUDIT\u0000AUDIT_BLOCKED":Object.freeze([
    "pm_analysis",
    "architecture",
    "adrs",
    "issue_plan",
    "spec_audit",
  ]),
});

const ARTIFACT_CONTRACTS=Object.freeze({
  pm_analysis:Object.freeze({documentType:"pm-analysis",schemaId:"pm-analysis.v1"}),
  architecture:Object.freeze({documentType:"architecture",schemaId:"architecture.v1"}),
  adrs:Object.freeze({documentType:"adr",schemaId:"adr.v1",array:true}),
  issue_plan:Object.freeze({documentType:"issue-plan",schemaId:"issue-plan.v1"}),
  spec_audit:Object.freeze({documentType:"spec-audit",schemaId:"spec-audit.v1"}),
  decision_answers:Object.freeze({
    documentType:"decision-answer",schemaId:"decision-answer.v1",array:true,
  }),
  adr_approvals:Object.freeze({
    documentType:"adr-approval",schemaId:"adr-approval.v1",array:true,
  }),
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

function canonicalArtifactReferences(value,label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const references=value.map((item,index) => {
    const reference=artifactReference(item);
    if (!reference) throw new TypeError(`${label}[${index}] must be an exact artifact reference`);
    return reference;
  });
  const canonical=referenceSet(references);
  if (new Set(canonical.map(reference => canonicalJson(reference))).size!==canonical.length) {
    throw new TypeError(`${label} must not contain duplicate references`);
  }
  if (canonicalJson(references)!==canonicalJson(canonical)) {
    throw new TypeError(`${label} must use canonical reference order`);
  }
  return canonical;
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

function validationError(label,validation) {
  const first=validation.errors[0];
  return new TypeError(
    `${label} is invalid${first?.instancePath ?? ""}: ${
      first?.message ?? "schema validation failed"
    }`,
  );
}

function assertArtifact(value,key,source,index) {
  const contract=ARTIFACT_CONTRACTS[key];
  const label=index===undefined ? key : `${key}[${index}]`;
  if (!isPlainObject(value) || value.document_type!==contract.documentType) {
    throw new TypeError(`${label} must be an exact ${contract.documentType} artifact`);
  }
  const validation=validateDocument(value,contract.schemaId);
  if (!validation.valid) throw validationError(label,validation);
  if (value.content_sha256!==sha256Canonical(value.content)) {
    throw new TypeError(`${label} content hash does not match canonical content`);
  }
  if (value.provenance?.source_revision!==source.source_revision ||
      value.provenance?.source_sha256!==source.source_sha256) {
    throw new TypeError(`${label} must be bound to the exact current source revision`);
  }
}

function referenceSet(value) {
  return [...value].sort((left,right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function assertExactInputs(artifact,expected,label) {
  const actual=Array.isArray(artifact.inputs) ? artifact.inputs : [];
  const wanted=referenceSet(expected.map(item => artifactReference(item)));
  if (canonicalJson(referenceSet(actual))!==canonicalJson(wanted)) {
    throw new TypeError(`${label} must bind the exact immutable input lineage`);
  }
}

function assertDecisionSource(decisionPackage,pmAnalysis,source) {
  const questions=decisionPackage.questions ?? [];
  const pmQuestions=new Map((pmAnalysis.content?.open_questions ?? []).map(question => [
    question.id,
    question,
  ]));
  for (const question of questions) {
    if (!pmQuestions.has(question.id)) {
      throw new TypeError(`Decision package question ${String(question.id)} is not in PM evidence`);
    }
    if (question.provenance?.source_revision!==source.source_revision ||
        question.provenance?.source_sha256!==source.source_sha256) {
      throw new TypeError("Decision package must be bound to the exact current source revision");
    }
  }
}

function assertGraphEvidence(state,event,artifacts,requiredKeys,source) {
  const evidenceKeys=[...requiredKeys];
  for (const key of ["decision_answers","adr_approvals"]) {
    if (artifacts[key]!==undefined && !evidenceKeys.includes(key)) evidenceKeys.push(key);
  }
  for (const key of evidenceKeys) {
    const contract=ARTIFACT_CONTRACTS[key];
    if (!contract) continue;
    const value=artifacts[key];
    if (contract.array) {
      if (!Array.isArray(value) || value.length===0) {
        throw new TypeError(`${key} must be a non-empty artifact array`);
      }
      value.forEach((item,index) => assertArtifact(item,key,source,index));
    } else {
      assertArtifact(value,key,source);
    }
  }

  if (requiredKeys.includes("pm_analysis")) {
    const validation=validatePmAnalysis(artifacts.pm_analysis);
    if (!validation.valid) throw new TypeError("PM analysis evidence is not semantically valid");
  }
  if (requiredKeys.includes("architecture")) {
    assertExactInputs(artifacts.architecture,[artifacts.pm_analysis],"architecture");
    for (const adr of artifacts.adrs) {
      assertExactInputs(adr,[artifacts.pm_analysis,artifacts.architecture],"ADR");
    }
    if (state!=="SPEC_AUDIT") {
      const validation=validateArchitecture({
        pmAnalysis:artifacts.pm_analysis,
        architecture:artifacts.architecture,
        adrs:artifacts.adrs,
        ...(artifacts.adr_approvals===undefined ? {} : {
          approvals:artifacts.adr_approvals,
        }),
        ...(artifacts.decision_package?.document_type!=="decision-package" ? {} : {
          decisionPackage:artifacts.decision_package,
        }),
      });
      if (!validation.valid) throw new TypeError("Architecture evidence is not semantically valid");
      if (["ARCHITECTURE_COMPLETED","ADR_APPROVED"].includes(event) && !validation.complete) {
        throw new TypeError(`${event} requires complete architecture evidence`);
      }
    }
  }
  if (requiredKeys.includes("issue_plan")) {
    assertExactInputs(
      artifacts.issue_plan,
      [artifacts.pm_analysis,artifacts.architecture,...artifacts.adrs],
      "issue plan",
    );
    if (state!=="SPEC_AUDIT") {
      const validation=validateIssuePlan({
        pmAnalysis:artifacts.pm_analysis,
        architecture:artifacts.architecture,
        adrs:artifacts.adrs,
        ...(artifacts.adr_approvals===undefined ? {} : {
          approvals:artifacts.adr_approvals,
        }),
        ...(artifacts.decision_package?.document_type!=="decision-package" ? {} : {
          decisionPackage:artifacts.decision_package,
        }),
        issuePlan:artifacts.issue_plan,
      });
      if (!validation.valid) throw new TypeError("Issue-plan evidence is not semantically valid");
      if (event==="FINALIZATION_COMPLETED" && !validation.complete) {
        throw new TypeError("FINALIZATION_COMPLETED requires complete issue-plan evidence");
      }
    }
  }
  if (requiredKeys.includes("spec_audit")) {
    assertExactInputs(
      artifacts.spec_audit,
      [
        artifacts.pm_analysis,artifacts.architecture,...artifacts.adrs,
        ...(artifacts.adr_approvals ?? []),...(artifacts.decision_answers ?? []),
        artifacts.issue_plan,
      ],
      "spec audit",
    );
    const expected=auditSpecification({
      pmAnalysis:artifacts.pm_analysis,
      architecture:{artifact:artifacts.architecture,adrs:artifacts.adrs},
      ...(artifacts.adr_approvals===undefined ? {} : {
        approvals:artifacts.adr_approvals,
      }),
      ...(artifacts.decision_package?.document_type!=="decision-package" ? {} : {
        decisionPackage:artifacts.decision_package,
      }),
      ...(artifacts.decision_answers===undefined ? {} : {
        decisionAnswers:artifacts.decision_answers,
      }),
      issuePlan:artifacts.issue_plan,
    }).artifact;
    if (canonicalJson(artifacts.spec_audit)!==canonicalJson(expected)) {
      throw new TypeError("Spec-audit evidence must equal the deterministic audit result");
    }
    const ready=artifacts.spec_audit.content.ready_for_github;
    if ((event==="AUDIT_PASSED" && ready!==true) ||
        (event==="AUDIT_BLOCKED" && ready!==false)) {
      throw new TypeError(`${event} contradicts the verified spec-audit result`);
    }
  }
  if (requiredKeys.includes("decision_package") &&
      artifacts.decision_package?.document_type==="decision-package") {
    assertDecisionPackage(artifacts.decision_package);
    assertDecisionSource(artifacts.decision_package,artifacts.pm_analysis,source);
  }
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

function assertAdrApprovalPackage(decisionPackage) {
  const expectedKeys=["adr_references","document_type","owner","schema_version"];
  if (!isPlainObject(decisionPackage) ||
      canonicalJson(Object.keys(decisionPackage).sort())!==canonicalJson(expectedKeys) ||
      decisionPackage.schema_version!=="adr-approval-package.v1" ||
      decisionPackage.document_type!=="adr-approval-package" ||
      decisionPackage.owner!=="USER" ||
      !Array.isArray(decisionPackage.adr_references) ||
      decisionPackage.adr_references.length===0 ||
      decisionPackage.adr_references.some(reference =>
        artifactReference(reference)?.document_type!=="adr")) {
    throw new TypeError(
      "ADR approval package must be USER-owned and contain exact ADR references",
    );
  }
  canonicalArtifactReferences(decisionPackage.adr_references,"ADR approval references");
  return decisionPackage;
}

function adrNextAction(decisionPackage,adrs) {
  assertAdrApprovalPackage(decisionPackage);
  const pendingAdrs=adrs.filter(adr => adr.content?.approval?.state!=="approved");
  const suppliedReferences=canonicalReferences({adrs:pendingAdrs},["adrs"]);
  const packagedReferences=[...decisionPackage.adr_references].sort((left,right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)));
  if (canonicalJson(suppliedReferences)!==canonicalJson(packagedReferences)) {
    throw new TypeError("ADR approval package must bind the exact supplied ADR revisions");
  }
  return {action:"APPROVE_ADRS",owner:"USER",decision_package:decisionPackage};
}

function canonicalSourceBoundary(value,source) {
  const boundary=canonicalCopy(value,"source_boundary");
  const keys=["previous_source_revision","previous_source_sha256","stale_artifacts"];
  if (!isPlainObject(boundary) ||
      canonicalJson(Object.keys(boundary).sort())!==canonicalJson(keys) ||
      typeof boundary.previous_source_revision!=="string" ||
      boundary.previous_source_revision.length===0 ||
      !SHA256_PATTERN.test(boundary.previous_source_sha256) ||
      (boundary.previous_source_revision===source.source_revision &&
       boundary.previous_source_sha256===source.source_sha256)) {
    throw new TypeError("SOURCE_RESTARTED requires an exact prior source boundary");
  }
  boundary.stale_artifacts=canonicalArtifactReferences(
    boundary.stale_artifacts,
    "source_boundary stale_artifacts",
  );
  return boundary;
}

function canonicalNextAction(value) {
  const nextAction=canonicalCopy(value,"next_action");
  if (!isPlainObject(nextAction) ||
      typeof nextAction.action!=="string" || !OWNER_SET.has(nextAction.owner)) {
    throw new TypeError("next_action requires an action and a valid owner");
  }
  return nextAction;
}

function auditBlockedNextAction(specAudit) {
  const finding=specAudit.content.findings.find(item =>
    ["P0","P1","P2"].includes(item.severity));
  if (!finding || !OWNER_SET.has(finding.owner)) {
    throw new TypeError("AUDIT_BLOCKED requires an owned blocking audit finding");
  }
  return {action:"RESOLVE_BLOCKING_FINDINGS",owner:finding.owner};
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
  assertGraphEvidence(state,event,artifacts,requiredKeys,source);
  const inputKeys=[...requiredKeys];
  for (const key of ["decision_answers","adr_approvals"]) {
    if (artifacts[key]!==undefined && !inputKeys.includes(key)) inputKeys.push(key);
  }
  const sourceBoundary=event==="SOURCE_RESTARTED" ?
    canonicalSourceBoundary(context.source_boundary,source) : undefined;
  const result={
    previous_state:state,
    event,
    state:target,
    ...source,
    input_artifacts:sourceBoundary?.stale_artifacts ??
      canonicalReferences(artifacts,inputKeys),
  };

  if (sourceBoundary!==undefined) result.source_boundary=sourceBoundary;

  if (event==="QUESTIONS_FOUND" ||
      (state==="QUESTIONS_PENDING" && event==="DECISION_STARTED")) {
    result.next_action=questionNextAction(artifacts.decision_package);
    result.decision_package=artifacts.decision_package;
  }
  if (event==="DECISIONS_RESOLVED") {
    assertDecisionPackage(artifacts.decision_package);
    if (artifacts.decision_package?.gate?.can_continue!==true ||
        artifacts.decision_package?.gate?.status!=="CLEAR") {
      throw new TypeError("DECISIONS_RESOLVED requires a clear decision package");
    }
    result.decision_package=artifacts.decision_package;
  }
  if (event==="ADR_APPROVAL_REQUIRED") {
    result.next_action=adrNextAction(artifacts.decision_package,artifacts.adrs);
    result.decision_package=artifacts.decision_package;
  }
  if (event==="ADR_APPROVED") {
    assertAdrApprovalPackage(artifacts.decision_package);
    result.decision_package=artifacts.decision_package;
  }
  if ((artifacts.decision_answers?.length ?? 0)>0 &&
      artifacts.decision_package?.document_type==="decision-package" &&
      result.decision_package===undefined) {
    assertDecisionPackage(artifacts.decision_package);
    assertDecisionSource(artifacts.decision_package,artifacts.pm_analysis,source);
    result.decision_package=artifacts.decision_package;
  }
  if (event==="AUDIT_BLOCKED") {
    const supplied=canonicalNextAction(context.next_action);
    const expected=auditBlockedNextAction(artifacts.spec_audit);
    if (canonicalJson(supplied)!==canonicalJson(expected)) {
      throw new TypeError("AUDIT_BLOCKED next_action must preserve the blocking finding owner");
    }
    result.next_action=expected;
  }
  if (event==="BLOCK") {
    result.next_action=canonicalNextAction(context.next_action);
  }
  if (event==="FAIL_RETRYABLE" || event==="FAIL_TERMINAL") {
    result.failure=canonicalFailure(context.failure);
    result.resume_state=state;
  }
  if (event==="RESUME" || event==="RETRY") result.resume_state=target;

  return deepFreeze(canonicalCopy(result,"Transition result"));
}
