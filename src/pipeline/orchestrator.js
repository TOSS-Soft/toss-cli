import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {validateArchitecture} from "./architecture.js";
import {validateIssuePlan} from "./issue-plan.js";
import {validatePmAnalysis} from "./pm-analysis.js";
import {auditSpecification} from "./spec-auditor.js";
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

function sameReference(left,right) {
  return canonicalJson(left)===canonicalJson(right);
}

function artifactsForTransition(inputs,decisionPackage) {
  const byType=new Map();
  for (const artifact of inputs) {
    const values=byType.get(artifact.document_type) ?? [];
    values.push(artifact);
    byType.set(artifact.document_type,values);
  }
  const artifacts={};
  const single={
    "pm-analysis":"pm_analysis",
    architecture:"architecture",
    "issue-plan":"issue_plan",
    "spec-audit":"spec_audit",
  };
  for (const [documentType,key] of Object.entries(single)) {
    const values=byType.get(documentType) ?? [];
    if (values.length>1) throw new TypeError(`Transition has duplicate ${documentType} inputs`);
    if (values[0]!==undefined) artifacts[key]=values[0];
  }
  if (byType.has("adr")) artifacts.adrs=byType.get("adr");
  if (byType.has("decision-answer")) artifacts.decision_answers=byType.get("decision-answer");
  if (byType.has("adr-approval")) artifacts.adr_approvals=byType.get("adr-approval");
  if (decisionPackage!==undefined) artifacts.decision_package=decisionPackage;
  return artifacts;
}

function sortReferences(references) {
  return [...references].sort((left,right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

async function historicalStaleReferences(store,events,source) {
  const references=new Map();
  for (const event of events) {
    for (const reference of event.inputs) {
      references.set(canonicalJson(reference),reference);
    }
  }
  const stale=[];
  for (const reference of references.values()) {
    const artifact=await store.verify(reference);
    if (!sameSource(artifact,source)) stale.push(exactReference(artifact));
  }
  return sortReferences(stale);
}

async function verifyTransitionChain(store,transitions) {
  const ordered=[...transitions].sort((left,right) => left.revision-right.revision);
  const verified=[];
  const generationSources=new Set();
  for (const [index,envelope] of ordered.entries()) {
    if (envelope.revision!==index+1) {
      throw new TypeError("Transition revision chain must be contiguous and begin at revision 1");
    }
    const current=await store.verify(exactReference(envelope));
    const validation=validateDocument(current,"transition-event.v1");
    if (!validation.valid) {
      const first=validation.errors[0];
      throw new TypeError(
        `Verified transition event is invalid${first?.instancePath ?? ""}: ${
          first?.message ?? "schema validation failed"
        }`,
      );
    }
    if (current.content_sha256!==sha256Canonical(current.content)) {
      throw new TypeError("Verified transition event content hash is stale");
    }
    if (current.content.source_revision!==current.provenance?.source_revision ||
        current.content.source_sha256!==current.provenance?.source_sha256) {
      throw new TypeError("Transition content and envelope source provenance contradict");
    }
    if (!sameReference(current.inputs,current.content.input_artifacts)) {
      throw new TypeError("Transition content and envelope inputs contradict");
    }
    const previous=verified[index-1];
    const expectedParents=previous===undefined ? [] : [exactReference(previous)];
    if (!sameReference(current.parents,expectedParents)) {
      throw new TypeError("Transition parent chain is broken");
    }
    const sourceChanged=previous!==undefined &&
      (current.content.source_revision!==previous.content.source_revision ||
       current.content.source_sha256!==previous.content.source_sha256);
    const sourceIdentity=canonicalJson({
      source_revision:current.content.source_revision,
      source_sha256:current.content.source_sha256,
    });
    if (previous===undefined && current.content.event==="SOURCE_RESTARTED") {
      throw new TypeError("A source generation boundary requires a verified predecessor");
    }
    if (previous===undefined) generationSources.add(sourceIdentity);
    if (sourceChanged) {
      if (generationSources.has(sourceIdentity)) {
        throw new TypeError("A source generation cannot reuse an earlier source identity");
      }
      if (current.content.previous_state!=="ANALYZING" ||
          current.content.event!=="SOURCE_RESTARTED" ||
          current.content.state!=="ANALYZING") {
        throw new TypeError("Source changes require an explicit ANALYZING generation boundary");
      }
      const expectedStale=await historicalStaleReferences(store,verified,{
        source_revision:current.content.source_revision,
        source_sha256:current.content.source_sha256,
      });
      if (current.content.source_boundary?.previous_source_revision!==
            previous.content.source_revision ||
          current.content.source_boundary?.previous_source_sha256!==
            previous.content.source_sha256 ||
          !sameReference(current.content.source_boundary?.stale_artifacts,expectedStale) ||
          !sameReference(current.inputs,expectedStale)) {
        throw new TypeError("Source generation boundary has a missing or stale relationship");
      }
      generationSources.add(sourceIdentity);
    } else {
      if (current.content.event==="SOURCE_RESTARTED" ||
          current.content.source_boundary!==undefined) {
        throw new TypeError("SOURCE_RESTARTED requires a changed source revision");
      }
      if (previous!==undefined && current.content.previous_state!==previous.content.state) {
        throw new TypeError("Transition predecessor-state continuity is broken");
      }
      const requiresPendingPackage=previous!==undefined && (
        (previous.content.state==="QUESTIONS_PENDING" &&
         current.content.event==="DECISION_STARTED") ||
        (previous.content.state==="ADR_PENDING_APPROVAL" &&
         current.content.event==="ADR_APPROVED")
      );
      if (requiresPendingPackage &&
          (current.content.decision_package===undefined ||
           previous.content.decision_package===undefined ||
           canonicalJson(current.content.decision_package)!==
             canonicalJson(previous.content.decision_package))) {
        throw new TypeError("Pending decision package continuity is broken");
      }
    }
    const inputArtifacts=[];
    for (const reference of current.inputs) {
      const artifact=await store.verify(reference);
      if (!sameReference(exactReference(artifact),reference)) {
        throw new TypeError("Verified transition input does not match its exact reference");
      }
      inputArtifacts.push(artifact);
    }
    const reconstructed=transition(current.content.previous_state,current.content.event,{
      source_revision:current.content.source_revision,
      source_sha256:current.content.source_sha256,
      artifacts:current.content.event==="SOURCE_RESTARTED" ? {} :
        artifactsForTransition(inputArtifacts,current.content.decision_package),
      next_action:current.content.next_action,
      failure:current.content.failure,
      resume_state:current.content.resume_state,
      source_boundary:current.content.source_boundary,
    });
    if (canonicalJson(reconstructed)!==canonicalJson(current.content)) {
      throw new TypeError("Transition event content contradicts its verified inputs");
    }
    verified.push(current);
  }
  return verified;
}

export async function resumeAnalysis(store,sourceRevision) {
  assertStore(store);
  const source=canonicalSource(sourceRevision);
  const artifacts=await store.list();
  if (!Array.isArray(artifacts)) throw new TypeError("Artifact store list must return an array");
  const transitions=artifacts.filter(artifact =>
    artifact.document_type==="transition-event" &&
    (source.analysis_id===undefined || artifact.artifact_id===source.analysis_id),
  );
  const verifiedTransitions=await verifyTransitionChain(store,transitions);
  const latest=verifiedTransitions.at(-1);
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

async function transitionHistory(store,analysisId) {
  const artifacts=await store.list({
    document_type:"transition-event",
    artifact_id:analysisId,
  });
  if (!Array.isArray(artifacts)) throw new TypeError("Artifact store list must return an array");
  return verifyTransitionChain(store,artifacts);
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

function blockedAction(findings) {
  const blocking=findings.find(finding => ["P0","P1","P2"].includes(finding.severity));
  if (!blocking) throw new TypeError("Blocking transition requires an owned blocking finding");
  const owner=blocking.owner==="Architect" ? "ARCHITECT" : blocking.owner;
  if (!["PM","ARCHITECT","PM_FINALIZATION","USER"].includes(owner)) {
    throw new TypeError(`Blocking finding has unsupported owner ${String(blocking.owner)}`);
  }
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
      approvals:artifacts.adr_approvals,
      ...(artifacts.decision_package?.document_type==="decision-package" ? {
        decisionPackage:artifacts.decision_package,
      } : {}),
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
      context:{...context,next_action:blockedAction(validation.findings)},
    };
  }
  if (context.state==="PM_FINALIZATION") {
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
    return validation.complete ? {event:"FINALIZATION_COMPLETED",context} : {
      event:"BLOCK",
      context:{...context,next_action:blockedAction(validation.findings)},
    };
  }
  if (context.state==="SPEC_AUDIT") {
    const audit=auditSpecification({
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
    });
    if (canonicalJson(artifacts.spec_audit)!==canonicalJson(audit.artifact)) {
      throw new TypeError("Supplied spec audit must equal the deterministic audit result");
    }
    if (audit.ready_for_github) {
      return {event:"AUDIT_PASSED",context};
    }
    return {
      event:"AUDIT_BLOCKED",
      context:{...context,next_action:blockedAction(audit.findings)},
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
  if (context.event==="SOURCE_RESTARTED" || context.source_boundary!==undefined) {
    throw new TypeError(
      "SOURCE_RESTARTED and source_boundary are orchestrator-derived and cannot be caller supplied",
    );
  }

  const analysisId=typeof context.analysis_id==="string" &&
      context.analysis_id.length>0 ? context.analysis_id : undefined;
  if (!analysisId) throw new TypeError("runNextStage requires analysis_id");
  const history=await transitionHistory(context.store,analysisId);
  const previous=history.at(-1);
  let derived;
  if (previous!==undefined) {
    const sourceChanged=context.source_revision!==previous.content.source_revision ||
      context.source_sha256!==previous.content.source_sha256;
    if (sourceChanged) {
      if (context.state!=="ANALYZING" || context.event!==undefined ||
          context.source_boundary!==undefined) {
        throw new TypeError(
          "A changed source can only auto-derive a new ANALYZING generation boundary",
        );
      }
      if (history.some(item =>
        item.content.source_revision===context.source_revision &&
        item.content.source_sha256===context.source_sha256)) {
        throw new TypeError("A source generation cannot reuse an earlier source identity");
      }
      const staleArtifacts=await historicalStaleReferences(context.store,history,{
        source_revision:context.source_revision,
        source_sha256:context.source_sha256,
      });
      derived={
        event:"SOURCE_RESTARTED",
        context:{
          ...context,
          artifacts:{},
          source_boundary:{
            previous_source_revision:previous.content.source_revision,
            previous_source_sha256:previous.content.source_sha256,
            stale_artifacts:staleArtifacts,
          },
        },
      };
    } else {
      if (context.state!==previous.content.state) {
        throw new TypeError("Caller state does not match the verified predecessor state");
      }
      if (["QUESTIONS_PENDING","ADR_PENDING_APPROVAL"].includes(context.state)) {
        const supplied=context.artifacts?.decision_package;
        if (supplied===undefined || previous.content.decision_package===undefined ||
            canonicalJson(supplied)!==canonicalJson(previous.content.decision_package)) {
          throw new TypeError("Pending decision package must match the verified predecessor");
        }
      }
      derived=deriveEvent(context);
    }
  } else {
    derived=deriveEvent(context);
  }

  const event=transition(context.state,derived.event,derived.context);
  const effectiveContext=derived.context;
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
