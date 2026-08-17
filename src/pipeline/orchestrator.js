import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {validateArchitecture} from "./architecture.js";
import {validateIssuePlan} from "./issue-plan.js";
import {validatePmAnalysis} from "./pm-analysis.js";
import {transition} from "./state-machine.js";

const DOWNSTREAM_DOCUMENT_TYPES=new Set([
  "pm-analysis",
  "architecture",
  "adr",
  "issue-plan",
  "spec-audit",
]);
const SHA256_PATTERN=/^[a-f0-9]{64}$/;

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

function exactReference(artifact) {
  return {
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  };
}

function assertStore(store) {
  if (!isPlainObject(store) ||
      typeof store.list!=="function" ||
      typeof store.verify!=="function") {
    throw new TypeError("Analysis orchestration requires public store list and verify methods");
  }
}

function canonicalSource(sourceRevision) {
  const source=canonicalCopy(sourceRevision,"sourceRevision");
  if (!isPlainObject(source) ||
      typeof source.source_revision!=="string" || source.source_revision.length===0 ||
      typeof source.source_sha256!=="string" ||
      !SHA256_PATTERN.test(source.source_sha256)) {
    throw new TypeError("sourceRevision requires source_revision and source_sha256");
  }
  if (source.analysis_id!==undefined &&
      (typeof source.analysis_id!=="string" || source.analysis_id.length===0)) {
    throw new TypeError("sourceRevision analysis_id must be a non-empty string");
  }
  return source;
}

function sameSource(artifact,source) {
  return artifact.provenance?.source_revision===source.source_revision &&
    artifact.provenance?.source_sha256===source.source_sha256;
}

function staleReference(artifact) {
  return {
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
    source_revision:artifact.provenance?.source_revision,
    source_sha256:artifact.provenance?.source_sha256,
  };
}

export async function resumeAnalysis(store,sourceRevision) {
  assertStore(store);
  const source=canonicalSource(sourceRevision);
  const artifacts=await store.list();
  if (!Array.isArray(artifacts)) throw new TypeError("Artifact store list must return an array");
  const transitions=artifacts.filter(artifact =>
    artifact.document_type==="transition-event" &&
    (source.analysis_id===undefined || artifact.artifact_id===source.analysis_id),
  ).sort((left,right) => right.revision-left.revision ||
    left.artifact_id.localeCompare(right.artifact_id));
  const latest=transitions[0]===undefined ? undefined :
    await store.verify(exactReference(transitions[0]));
  if (latest!==undefined) {
    const validation=validateDocument(latest,"transition-event.v1");
    if (!validation.valid) {
      const first=validation.errors[0];
      throw new TypeError(
        `Verified transition event is invalid${first?.instancePath ?? ""}: ${
          first?.message ?? "schema validation failed"
        }`,
      );
    }
  }
  const staleArtifacts=artifacts
    .filter(artifact => DOWNSTREAM_DOCUMENT_TYPES.has(artifact.document_type))
    .filter(artifact => !sameSource(artifact,source))
    .map(staleReference)
    .sort((left,right) =>
      left.document_type.localeCompare(right.document_type) ||
      left.artifact_id.localeCompare(right.artifact_id) ||
      left.revision-right.revision,
    );
  const latestIsCurrent=latest!==undefined && sameSource(latest,source);
  const result={
    state:latestIsCurrent ? latest.content.state : "ANALYZING",
    revision:latest?.revision ?? 0,
    last_verified_revision:latest===undefined ? null : exactReference(latest),
    stale_artifacts:staleArtifacts,
  };
  if (latestIsCurrent && latest.content.state==="FAILED_RETRYABLE") {
    result.recovery_state=latest.content.resume_state;
  } else if (latestIsCurrent && latest.content.state==="BLOCKED") {
    result.recovery_state=latest.content.previous_state;
  }
  return deepFreeze(canonicalCopy(result,"Resume result"));
}

async function lastTransition(store,analysisId) {
  const artifacts=await store.list({
    document_type:"transition-event",
    artifact_id:analysisId,
  });
  if (!Array.isArray(artifacts)) throw new TypeError("Artifact store list must return an array");
  const latest=[...artifacts].sort((left,right) => right.revision-left.revision)[0];
  return latest===undefined ? undefined : store.verify(exactReference(latest));
}

function exactAdrApprovalPackage(adrs) {
  const references=adrs
    .filter(adr => adr.content?.approval?.state!=="approved")
    .map(exactReference)
    .sort((left,right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (references.length===0) {
    throw new TypeError("Architecture is incomplete without a pending ADR approval");
  }
  return {
    schema_version:"adr-approval-package.v1",
    document_type:"adr-approval-package",
    owner:"USER",
    adr_references:references,
  };
}

function blockedAction(findings,defaultOwner) {
  const owners=findings.map(finding => finding.owner).filter(Boolean);
  const owner=owners.includes("USER") ? "USER" :
    owners.includes("PM") ? "PM" : owners.includes("ARCHITECT") ? "ARCHITECT" : defaultOwner;
  return {action:"RESOLVE_BLOCKING_FINDINGS",owner};
}

function deriveEvent(context) {
  if (context.event!==undefined) return {event:context.event,context};
  const artifacts=context.artifacts ?? {};
  if (context.state==="ANALYZING") {
    const validation=validatePmAnalysis(artifacts.pm_analysis);
    if (!validation.valid) throw new TypeError("Cannot transition from invalid PM analysis");
    if (artifacts.decision_package?.gate?.can_continue===false) {
      return {event:"QUESTIONS_FOUND",context};
    }
    if ((artifacts.pm_analysis.content?.open_questions?.length ?? 0)>0 &&
        artifacts.decision_package===undefined) {
      throw new TypeError("PM analysis with open questions requires a decision package");
    }
    return {event:"ANALYSIS_COMPLETED",context};
  }
  if (context.state==="USER_DECISION") {
    if (artifacts.decision_package?.gate?.can_continue!==true) {
      throw new TypeError("User decisions are still pending");
    }
    return {event:"DECISIONS_RESOLVED",context};
  }
  if (context.state==="ARCHITECTURE_PENDING" ||
      context.state==="ADR_PENDING_APPROVAL") {
    const validation=validateArchitecture({
      pmAnalysis:artifacts.pm_analysis,
      architecture:artifacts.architecture,
      adrs:artifacts.adrs,
    });
    if (!validation.valid) throw new TypeError("Cannot transition from invalid architecture inputs");
    if (validation.complete) {
      return {
        event:context.state==="ADR_PENDING_APPROVAL" ?
          "ADR_APPROVED" : "ARCHITECTURE_COMPLETED",
        context,
      };
    }
    const pendingAdrs=(artifacts.adrs ?? []).filter(adr =>
      adr.content?.approval?.state!=="approved");
    if (context.state==="ARCHITECTURE_PENDING" && pendingAdrs.length>0) {
      return {
        event:"ADR_APPROVAL_REQUIRED",
        context:{
          ...context,
          artifacts:{
            ...artifacts,
            decision_package:exactAdrApprovalPackage(artifacts.adrs),
          },
        },
      };
    }
    return {
      event:"BLOCK",
      context:{...context,next_action:blockedAction(validation.findings,"ARCHITECT")},
    };
  }
  if (context.state==="PM_FINALIZATION") {
    const validation=validateIssuePlan({
      pmAnalysis:artifacts.pm_analysis,
      architecture:artifacts.architecture,
      adrs:artifacts.adrs,
      issuePlan:artifacts.issue_plan,
    });
    return validation.complete ? {event:"FINALIZATION_COMPLETED",context} : {
      event:"BLOCK",
      context:{...context,next_action:blockedAction(validation.findings,"PM")},
    };
  }
  if (context.state==="SPEC_AUDIT") {
    if (artifacts.spec_audit?.content?.ready_for_github===true) {
      return {event:"AUDIT_PASSED",context};
    }
    const findings=artifacts.spec_audit?.content?.findings ?? [];
    return {
      event:"AUDIT_BLOCKED",
      context:{...context,next_action:blockedAction(findings,"SPEC_AUDITOR")},
    };
  }
  throw new TypeError(`runNextStage cannot derive an event for state ${String(context.state)}`);
}

export async function runNextStage(context={}) {
  if (!isPlainObject(context)) throw new TypeError("runNextStage context must be an object");
  assertStore(context.store);
  if (typeof context.store.append!=="function") {
    throw new TypeError("runNextStage requires the public store append method");
  }

  // The pure state-machine guard always runs before any store read or append.
  const derived=deriveEvent(context);
  const event=transition(context.state,derived.event,derived.context);
  const effectiveContext=derived.context;
  const analysisId=typeof effectiveContext.analysis_id==="string" &&
      effectiveContext.analysis_id.length>0 ? effectiveContext.analysis_id : undefined;
  if (!analysisId) throw new TypeError("runNextStage requires analysis_id");
  const previous=await lastTransition(context.store,analysisId);
  const provenance=canonicalCopy(effectiveContext.provenance,"Transition provenance");
  if (provenance.source_revision!==event.source_revision ||
      provenance.source_sha256!==event.source_sha256) {
    throw new TypeError("Transition provenance must match the exact source revision");
  }
  const draft={
    schema_version:"acp.v1",
    document_type:"transition-event",
    artifact_id:analysisId,
    revision:(previous?.revision ?? 0)+1,
    run_id:effectiveContext.run_id,
    producer:canonicalCopy(effectiveContext.producer,"Transition producer"),
    runtime_identity:canonicalCopy(
      effectiveContext.runtime_identity,
      "Transition runtime identity",
    ),
    created_at:effectiveContext.created_at,
    provenance,
    parents:previous===undefined ? [] : [exactReference(previous)],
    inputs:event.input_artifacts,
    content_sha256:sha256Canonical(event),
    content:event,
  };
  const validation=validateDocument(draft,"transition-event.v1");
  if (!validation.valid) {
    const first=validation.errors[0];
    throw new TypeError(
      `Transition event is invalid${first?.instancePath ?? ""}: ${
        first?.message ?? "schema validation failed"
      }`,
    );
  }
  const appended=await context.store.append(draft);
  return deepFreeze(canonicalCopy(appended,"Appended transition event"));
}
