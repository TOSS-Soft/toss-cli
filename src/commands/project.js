import {canonicalJson} from "../contracts/acp.js";
import {buildDecisionPackageFromPmAnalysis} from "../pipeline/decisions.js";
import {validateArchitecture} from "../pipeline/architecture.js";
import {validateIssuePlan} from "../pipeline/issue-plan.js";
import {resumeAnalysis,runNextStage} from "../pipeline/orchestrator.js";
import {validatePmAnalysis} from "../pipeline/pm-analysis.js";
import {
  acquireInput,
  appendVerified,
  canonicalCopy,
  commandServices,
  deepFreeze,
  exactReference,
  latestArtifact,
  listedArtifacts,
  normalizeProjectInput,
  OrchestrationError,
  persistProjectInput,
  projectInputFromArtifact,
  verifiedOrchestrationStore,
  verifiedExact,
} from "../pipeline/project-input.js";
import {evaluateProjectReadiness} from "../pipeline/readiness.js";
import {auditSpecification} from "../pipeline/spec-auditor.js";
import {buildTraceGraph} from "../pipeline/traceability.js";

const PROJECT_COMMANDS=new Set([
  "project.create","project.analyze","project.prepare","project.status","project.resume",
]);
const STAGE_SCHEMAS=Object.freeze({
  "pm-analysis":"pm-analysis.v1",
  architecture:"architecture.v1",
  adr:"adr.v1",
  "issue-plan":"issue-plan.v1",
  "spec-audit":"spec-audit.v1",
});

function sameReference(left,right) {
  return canonicalJson(left)===canonicalJson(right);
}

async function latestInput(store) {
  const rows=await listedArtifacts(store,{document_type:"project-input"});
  const identities=[...new Set(rows.map(row => row.artifact_id))];
  if (identities.length===0) {
    throw new OrchestrationError("PROJECT_INPUT_REQUIRED","No persisted project input exists",3);
  }
  if (identities.length!==1) {
    throw new OrchestrationError(
      "AMBIGUOUS_PROJECT_HISTORY","The artifact store contains more than one project input identity",5,
    );
  }
  const latest=await latestArtifact(store,"project-input",identities[0]);
  return {artifact:latest,input:projectInputFromArtifact(latest)};
}

async function resolveInput(command,services) {
  if (command.options.from!==null ||
      (command.name==="project.create" && command.interactive)) {
    const input=await acquireInput(command,services,{
      kind:"project",
      normalize:normalizeProjectInput,
      missingCode:"PROJECT_INPUT_REQUIRED",
    });
    const persisted=await persistProjectInput(services.store,input);
    return {...persisted,input};
  }
  if (command.name==="project.create") {
    throw new OrchestrationError("PROJECT_INPUT_REQUIRED","Project input is required",3);
  }
  const persisted=await latestInput(services.store);
  return {...persisted,reused:true};
}

async function persistStage(store,draft,reused) {
  const previous=await latestArtifact(store,draft.document_type,draft.artifact_id);
  if (previous && previous.revision===draft.revision &&
      previous.content_sha256===draft.content_sha256) {
    const verified=await verifiedExact(store,exactReference(previous));
    reused.push(exactReference(verified));
    return verified;
  }
  if (previous && previous.revision>=draft.revision) {
    throw new OrchestrationError(
      "STALE_PROJECT_SOURCE",
      `Supplied ${draft.document_type} revision conflicts with persisted history`,
      6,
    );
  }
  return appendVerified(store,draft,STAGE_SCHEMAS[draft.document_type]);
}

function orchestrationContext(input,state,artifacts) {
  return {
    store:null,
    analysis_id:input.analysis_id,
    state,
    source_revision:input.provenance.source_revision,
    source_sha256:input.provenance.source_sha256,
    artifacts,
    provenance:input.provenance,
    run_id:input.run_id,
    producer:{role:"orchestrator",identity:"toss-project-orchestrator"},
    runtime_identity:input.runtime_identity,
    created_at:input.created_at,
  };
}

async function advance(store,input,state,artifacts) {
  const context=orchestrationContext(input,state,artifacts);
  context.store=verifiedOrchestrationStore(store);
  const appended=await runNextStage(context);
  return verifiedExact(store,exactReference(appended));
}

function blockingOwner(event) {
  return event?.content?.next_action?.owner ??
    event?.content?.decision_package?.owner ?? null;
}

function nextCommand(state,event) {
  if (state==="READY_FOR_ISSUES") return "issues preview";
  if (state==="QUESTIONS_PENDING" || state==="USER_DECISION") return "decisions list";
  if (state==="ADR_PENDING_APPROVAL") return "architecture approve";
  if (state==="FAILED_RETRYABLE" || state==="BLOCKED") return "project resume";
  if (state==="FAILED_TERMINAL") return null;
  if (state==="ANALYZING") return "project analyze";
  if (event?.content?.next_action?.action==="RESOLVE_BLOCKING_FINDINGS") {
    return "project resume";
  }
  return "project prepare";
}

async function projectStatus(store,input,{inputArtifact,reused=[]}={}) {
  const resume=await resumeAnalysis(verifiedOrchestrationStore(store),{
    analysis_id:input.analysis_id,
    source_revision:input.provenance.source_revision,
    source_sha256:input.provenance.source_sha256,
  });
  const event=resume.last_verified_revision ?
    await verifiedExact(store,resume.last_verified_revision) : null;
  const artifactRevisions=[
    ...(inputArtifact ? [exactReference(inputArtifact)] : []),
    ...(event ? [...event.inputs,exactReference(event)] : []),
  ];
  return deepFreeze({
    project_id:input.project_id,
    analysis_id:input.analysis_id,
    state:resume.state,
    blocking_owner:blockingOwner(event),
    source_revision:input.provenance.source_revision,
    source_sha256:input.provenance.source_sha256,
    last_verified_revision:resume.last_verified_revision,
    artifact_revisions:artifactRevisions,
    stale_artifacts:resume.stale_artifacts,
    reused_revisions:reused,
    next_command:nextCommand(resume.state,event),
    ...(event?.content?.decision_package ? {package:event.content.decision_package} : {}),
  });
}

function blockedResult(command,status) {
  return deepFreeze({
    ...status,
    blocked:true,
    ...(command.options.nonInteractive ? {command_exit_code:4} : {}),
  });
}

function assertRecoveryEvidence(input) {
  try {
    const supplied=input.artifacts;
    const pm=validatePmAnalysis(supplied.pm_analysis);
    const architecture=validateArchitecture({
      pmAnalysis:supplied.pm_analysis,
      architecture:supplied.architecture,
      adrs:supplied.adrs,
    });
    const issuePlan=validateIssuePlan({
      pmAnalysis:supplied.pm_analysis,
      architecture:supplied.architecture,
      adrs:supplied.adrs,
      issuePlan:supplied.issue_plan,
    });
    if (pm.valid && architecture.valid && issuePlan.valid) return;
  } catch {
    // Normalize all pure validation failures to the closed recovery boundary below.
  }
  throw new OrchestrationError(
    "INVALID_RECOVERY_EVIDENCE",
    "Project resume requires the exact valid supplied aggregate before recording recovery",
    5,
  );
}

async function recoverProject(store,input,resume) {
  assertRecoveryEvidence(input);
  const event=resume.state==="BLOCKED" ? "RESUME" : "RETRY";
  const context=orchestrationContext(input,resume.state,{});
  context.store=verifiedOrchestrationStore(store);
  context.event=event;
  context.resume_state=resume.recovery_state;
  const appended=await runNextStage(context);
  return verifiedExact(store,exactReference(appended));
}

async function prepareProject(
  command,store,input,{analyzeOnly=false,inputArtifact,reused=[]}={},
) {
  const source={
    analysis_id:input.analysis_id,
    source_revision:input.provenance.source_revision,
    source_sha256:input.provenance.source_sha256,
  };
  let resume=await resumeAnalysis(verifiedOrchestrationStore(store),source);
  let state=resume.state;
  const supplied=input.artifacts;
  let pm;
  let decisions;
  let architecture;
  let adrs=[];
  let issuePlan;
  let specAudit;

  if (["BLOCKED","FAILED_RETRYABLE"].includes(state)) {
    if (command.name!=="project.resume") {
      return blockedResult(command,await projectStatus(store,input,{inputArtifact,reused}));
    }
    await recoverProject(store,input,resume);
    resume=await resumeAnalysis(verifiedOrchestrationStore(store),source);
    state=resume.state;
  }

  if (state==="ANALYZING") {
    pm=await persistStage(store,supplied.pm_analysis,reused);
    decisions=pm.content.open_questions.length>0 ?
      buildDecisionPackageFromPmAnalysis(pm,supplied.decision_enrichments) : undefined;
    const artifacts={pm_analysis:pm};
    if (decisions) artifacts.decision_package=decisions;
    for (let step=0;state==="ANALYZING" && step<2;step+=1) {
      await advance(store,input,state,artifacts);
      resume=await resumeAnalysis(verifiedOrchestrationStore(store),source);
      state=resume.state;
    }
    if (state==="ANALYZING") throw new OrchestrationError(
      "ORCHESTRATION_VALIDATION_FAILED",
      "Project analysis did not advance beyond the verified source boundary",
      5,
    );
    if (state==="QUESTIONS_PENDING") {
      return blockedResult(command,await projectStatus(store,input,{inputArtifact,reused}));
    }
    if (analyzeOnly) return projectStatus(store,input,{inputArtifact,reused});
  }

  if (["QUESTIONS_PENDING","USER_DECISION","BLOCKED","FAILED_RETRYABLE",
    "FAILED_TERMINAL"].includes(state)) {
    return blockedResult(command,await projectStatus(store,input,{inputArtifact,reused}));
  }

  pm=pm ?? await verifiedExact(store,exactReference(supplied.pm_analysis));
  decisions=pm.content.open_questions.length>0 ?
    buildDecisionPackageFromPmAnalysis(pm,supplied.decision_enrichments) : undefined;

  if (state==="ARCHITECTURE_PENDING") {
    architecture=await persistStage(store,supplied.architecture,reused);
    adrs=[];
    for (const adr of supplied.adrs) adrs.push(await persistStage(store,adr,reused));
    const artifacts={pm_analysis:pm,architecture,adrs};
    if (decisions) artifacts.decision_package=decisions;
    await advance(store,input,state,artifacts);
    resume=await resumeAnalysis(verifiedOrchestrationStore(store),source);
    state=resume.state;
    if (state==="ADR_PENDING_APPROVAL" || state==="BLOCKED") {
      return blockedResult(command,await projectStatus(store,input,{inputArtifact,reused}));
    }
  }

  if (state==="ADR_PENDING_APPROVAL") {
    return blockedResult(command,await projectStatus(store,input,{inputArtifact,reused}));
  }

  architecture=architecture ?? await verifiedExact(store,exactReference(supplied.architecture));
  if (adrs.length===0) {
    for (const adr of supplied.adrs) adrs.push(await verifiedExact(store,exactReference(adr)));
  }

  if (state==="PM_FINALIZATION") {
    issuePlan=await persistStage(store,supplied.issue_plan,reused);
    const artifacts={pm_analysis:pm,architecture,adrs,issue_plan:issuePlan};
    if (decisions) artifacts.decision_package=decisions;
    await advance(store,input,state,artifacts);
    resume=await resumeAnalysis(verifiedOrchestrationStore(store),source);
    state=resume.state;
    if (state==="BLOCKED") {
      return blockedResult(command,await projectStatus(store,input,{inputArtifact,reused}));
    }
  }

  issuePlan=issuePlan ?? await verifiedExact(store,exactReference(supplied.issue_plan));

  if (state==="SPEC_AUDIT") {
    const audited=auditSpecification({
      pmAnalysis:pm,
      architecture:{artifact:architecture,adrs},
      issuePlan,
    });
    specAudit=await persistStage(store,audited.artifact,reused);
    const artifacts={
      pm_analysis:pm,architecture,adrs,issue_plan:issuePlan,spec_audit:specAudit,
    };
    if (decisions) artifacts.decision_package=decisions;
    await advance(store,input,state,artifacts);
    resume=await resumeAnalysis(verifiedOrchestrationStore(store),source);
    state=resume.state;
    if (state==="BLOCKED") {
      return blockedResult(command,await projectStatus(store,input,{inputArtifact,reused}));
    }
  }

  if (state!=="READY_FOR_ISSUES") {
    return projectStatus(store,input,{inputArtifact,reused});
  }
  const latestEvent=await verifiedExact(store,resume.last_verified_revision);
  const auditReferences=latestEvent.inputs.filter(
    reference => reference.document_type==="spec-audit",
  );
  if (auditReferences.length!==1) throw new OrchestrationError(
    "AMBIGUOUS_READY_AUDIT","READY state requires exactly one referenced spec audit",5,
  );
  const referencedAudit=await verifiedExact(store,auditReferences[0]);
  if (specAudit && !sameReference(exactReference(specAudit),auditReferences[0])) {
    throw new OrchestrationError(
      "AMBIGUOUS_READY_AUDIT","READY transition contradicts the prepared spec audit",5,
    );
  }
  specAudit=referencedAudit;
  const issueReferences=specAudit.inputs.filter(
    reference => reference.document_type==="issue-plan",
  );
  if (issueReferences.length!==1 ||
      !sameReference(issueReferences[0],exactReference(issuePlan))) {
    throw new OrchestrationError(
      "AMBIGUOUS_READY_AUDIT","READY spec audit does not bind the exact issue plan",5,
    );
  }
  const traceGraph=buildTraceGraph({
    pmAnalysis:pm,
    architecture:{artifact:architecture,adrs},
    issuePlan,
  });
  const aggregate={
    pmAnalysis:pm,
    architecture:{artifact:architecture,adrs},
    issuePlan,
    specAudits:[specAudit],
    traceGraph,
    analysisState:latestEvent,
  };
  if (decisions) aggregate.decisionPackage=decisions;
  const readiness=evaluateProjectReadiness(aggregate);
  if (!readiness.ready_for_issue_generation) {
    throw new OrchestrationError(
      "ORCHESTRATION_VALIDATION_FAILED","READY state failed deterministic readiness evaluation",5,
    );
  }
  const status=await projectStatus(store,input,{inputArtifact,reused});
  return deepFreeze({...status,readiness});
}

export async function runProjectCommand(command,serviceInput) {
  const normalized=canonicalCopy(command,"project command");
  if (!PROJECT_COMMANDS.has(normalized.name)) {
    throw new TypeError(`Unsupported project command ${String(normalized.name)}`);
  }
  const services=commandServices(serviceInput);
  const resolved=await resolveInput(normalized,services);
  const reused=resolved.reused ? [exactReference(resolved.artifact)] : [];
  if (normalized.name==="project.create") {
    return projectStatus(services.store,resolved.input,{
      inputArtifact:resolved.artifact,reused,
    });
  }
  if (normalized.name==="project.status") {
    return projectStatus(services.store,resolved.input,{
      inputArtifact:resolved.artifact,reused,
    });
  }
  return prepareProject(normalized,services.store,resolved.input,{
    analyzeOnly:normalized.name==="project.analyze",
    inputArtifact:resolved.artifact,
    reused,
  });
}
