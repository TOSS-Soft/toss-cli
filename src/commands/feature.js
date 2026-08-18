import {canonicalJson} from "../contracts/acp.js";
import {
  appendFeatureStage,
  featureHistory,
  featureInputFromDelta,
  featureSourceProjection,
  latestAnyFeature,
  normalizeFeatureInput,
  verifyBaseSnapshot,
  verifyExactBaseReferences,
} from "../pipeline/feature-delta.js";
import {resumeAnalysis} from "../pipeline/orchestrator.js";
import {
  acquireInput,
  canonicalCopy,
  commandServices,
  createVerifiedArtifactCatalog,
  deepFreeze,
  exactReference,
  listedArtifacts,
  OrchestrationError,
  projectInputFromArtifact,
  verifiedOrchestrationStore,
  verifiedExact,
} from "../pipeline/project-input.js";

const FEATURE_COMMANDS=new Set([
  "feature.add","feature.analyze","feature.prepare","feature.status",
]);
const STAGES=Object.freeze(["ADDED","ANALYZED","PREPARED"]);

async function persistedProject(store) {
  const rows=await listedArtifacts(store,{document_type:"project-input"});
  const identities=[...new Set(rows.map(row => row.artifact_id))];
  if (identities.length===0) {
    throw new OrchestrationError("PROJECT_INPUT_REQUIRED","Feature commands require a project",3);
  }
  if (identities.length!==1) {
    throw new OrchestrationError(
      "AMBIGUOUS_PROJECT_HISTORY","Feature commands require exactly one project identity",5,
    );
  }
  const artifact=rows
    .filter(row => row.artifact_id===identities[0])
    .sort((left,right) => left.revision-right.revision)
    .at(-1);
  return {artifact,input:projectInputFromArtifact(artifact)};
}

async function readyBase(store,expectedProjectId) {
  const project=await persistedProject(store);
  if (project.input.project_id!==expectedProjectId) {
    throw new OrchestrationError(
      "STALE_FEATURE_BASE","Feature input project_id does not match the persisted project",6,
    );
  }
  const resume=await resumeAnalysis(verifiedOrchestrationStore(store),{
    analysis_id:project.input.analysis_id,
    source_revision:project.input.provenance.source_revision,
    source_sha256:project.input.provenance.source_sha256,
  });
  if (resume.state!=="READY_FOR_ISSUES" || !resume.last_verified_revision) {
    throw new OrchestrationError(
      "FEATURE_BASE_NOT_READY","Feature commands require a verified READY_FOR_ISSUES project",4,
    );
  }
  const transition=await verifiedExact(store,resume.last_verified_revision);
  const specAudits=transition.inputs.filter(reference => reference.document_type==="spec-audit");
  const issuePlans=transition.inputs.filter(reference => reference.document_type==="issue-plan");
  if (specAudits.length!==1 || issuePlans.length!==1) {
    throw new OrchestrationError(
      "AMBIGUOUS_FEATURE_BASE",
      "Feature base READY transition requires one exact issue plan and spec audit",
      5,
    );
  }
  const specAudit=await verifiedExact(store,specAudits[0]);
  const boundPlans=specAudit.inputs.filter(reference => reference.document_type==="issue-plan");
  if (boundPlans.length!==1 || canonicalJson(boundPlans[0])!==canonicalJson(issuePlans[0])) {
    throw new OrchestrationError(
      "AMBIGUOUS_FEATURE_BASE","Feature base spec audit does not bind its exact issue plan",5,
    );
  }
  const artifacts=[
    exactReference(project.artifact),
    ...transition.inputs,
    exactReference(transition),
  ];
  const base=deepFreeze({
    analysis_id:project.input.analysis_id,
    state:"READY_FOR_ISSUES",
    source_revision:project.input.provenance.source_revision,
    source_sha256:project.input.provenance.source_sha256,
    authority:"reference-only",
    artifacts,
  });
  await verifyBaseSnapshot(store,base);
  return base;
}

async function resolveFeature(command,services) {
  if (command.options.from!==null || (command.name==="feature.add" && command.interactive)) {
    return acquireInput(command,services,{
      kind:"feature",
      normalize:normalizeFeatureInput,
      missingCode:"FEATURE_INPUT_REQUIRED",
    });
  }
  if (command.name==="feature.add") {
    throw new OrchestrationError("FEATURE_INPUT_REQUIRED","Feature input is required",3);
  }
  const latest=await latestAnyFeature(services.store);
  return featureInputFromDelta(latest);
}

function sameBase(left,right) {
  return canonicalJson(left)===canonicalJson(right);
}

function statusResult(artifact,reused=[]) {
  const failure=artifact.content.readiness.failures[0];
  return deepFreeze({
    project_id:artifact.content.project_id,
    feature_id:artifact.content.feature_id,
    stage:artifact.content.stage,
    ready:artifact.content.readiness.ready,
    blocked:!artifact.content.readiness.ready,
    blocking_owner:failure?.owner ?? null,
    findings:artifact.content.readiness.failures,
    artifact,
    base_artifact_revisions:artifact.content.base_project.artifacts,
    reused_revisions:reused,
    next_command:artifact.content.next_command,
  });
}

function blockAutomation(command,result) {
  if (result.ready || !command.options.nonInteractive) return result;
  return deepFreeze({...result,command_exit_code:4});
}

async function currentFeature(store,input) {
  const history=await featureHistory(store,input.project_id,input.feature_id);
  if (history.length===0) return {history,latest:null};
  const latest=history.at(-1);
  if (latest.provenance.source_revision!==input.provenance.source_revision ||
      latest.provenance.source_sha256!==input.provenance.source_sha256) {
    throw new OrchestrationError(
      "STALE_FEATURE_SOURCE","Feature source identity changed after capture",6,
    );
  }
  if (canonicalJson(featureSourceProjection(featureInputFromDelta(latest)))!==
      canonicalJson(featureSourceProjection(input))) {
    throw new OrchestrationError(
      "STALE_FEATURE_SOURCE","Feature content changed under the same source identity",6,
    );
  }
  return {history,latest};
}

async function runStages(command,store,input,targetStage) {
  const base=await readyBase(store,input.project_id);
  let {history,latest}=await currentFeature(store,input);
  if (latest && !sameBase(latest.content.base_project,base)) {
    throw new OrchestrationError(
      "STALE_FEATURE_BASE","Persisted feature delta references a stale project snapshot",6,
    );
  }
  const reused=history.map(exactReference);
  const targetIndex=STAGES.indexOf(targetStage);
  const currentIndex=latest ? STAGES.indexOf(latest.content.stage) : -1;
  if (currentIndex<targetIndex) {
    latest=await appendFeatureStage(store,input,targetStage,base,latest);
    history=[...history,latest];
    await verifyExactBaseReferences(store,base);
  }
  await verifyBaseSnapshot(store,base);
  const result=statusResult(latest,reused);
  return targetStage==="PREPARED" ? blockAutomation(command,result) : result;
}

async function featureStatus(store) {
  const latest=await latestAnyFeature(store);
  const input=featureInputFromDelta(latest);
  const base=await readyBase(store,input.project_id);
  if (!sameBase(latest.content.base_project,base)) {
    throw new OrchestrationError(
      "STALE_FEATURE_BASE","Persisted feature delta references a stale project snapshot",6,
    );
  }
  return statusResult(latest);
}

export async function runFeatureCommand(command,serviceInput) {
  const normalized=canonicalCopy(command,"feature command");
  if (!FEATURE_COMMANDS.has(normalized.name)) {
    throw new TypeError(`Unsupported feature command ${String(normalized.name)}`);
  }
  const rawServices=commandServices(serviceInput);
  const store=createVerifiedArtifactCatalog(rawServices.store);
  await store.refresh();
  const services={...rawServices,store};
  let result;
  if (normalized.name==="feature.status") {
    result=await featureStatus(services.store);
  } else {
    const input=await resolveFeature(normalized,services);
    const target={
      "feature.add":"ADDED",
      "feature.analyze":"ANALYZED",
      "feature.prepare":"PREPARED",
    }[normalized.name];
    result=await runStages(normalized,services.store,input,target);
  }
  await store.refresh();
  return result;
}
