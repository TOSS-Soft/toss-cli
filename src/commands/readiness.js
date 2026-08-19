import {evaluateProjectReadiness} from "../pipeline/readiness.js";
import {createDesignOrchestrator} from "../pipeline/design-orchestrator.js";
import {evaluateDesignReadiness} from "../pipeline/design-readiness.js";
import {buildTraceGraph} from "../pipeline/traceability.js";
import {verifiedGateEvidence} from "./evidence.js";
import {
  commandCatalog,
  deepFreeze,
  gateCommandServices,
  OrchestrationError,
  resolveGateBundle,
} from "./gate-support.js";

const NEXT_ACTIONS=Object.freeze({
  "PDOR-001-ARTIFACT-INTEGRITY":{command:"project prepare",owner:"PM"},
  "PDOR-010-PROJECT-FRAMING":{command:"project analyze",owner:"PM"},
  "PDOR-020-PRODUCT-DEFINITION":{command:"project analyze",owner:"PM"},
  "PDOR-030-SYSTEM-CONTEXT":{command:"project analyze",owner:"PM"},
  "PDOR-040-BLOCKING-DECISIONS":{command:"decisions list",owner:"USER"},
  "PDOR-050-ARCHITECTURE-QUESTIONS":{command:"architecture review",owner:"ARCHITECT"},
  "PDOR-060-APPROVED-ADRS":{command:"architecture approve",owner:"USER"},
  "PDOR-070-DELIVERY-RECORDS":{command:"project prepare",owner:"PM_FINALIZATION"},
  "PDOR-080-EPIC-MAP":{command:"project prepare",owner:"PM_FINALIZATION"},
  "PDOR-090-REQUIREMENT-AC-COVERAGE":{command:"project prepare",owner:"PM_FINALIZATION"},
  "PDOR-100-LATEST-SPEC-AUDIT":{command:"audit run",owner:"PM_FINALIZATION"},
  "PDOR-110-ANALYSIS-STATE":{command:"project resume",owner:"PM"},
  "PDOR-120-UNRESOLVED-ASSUMPTIONS":{command:"decisions list",owner:"PM"},
});

function actionable(rows) {
  return rows.map(row => ({
    ...row,
    next_action:NEXT_ACTIONS[row.rule_id],
  }));
}

function backendOnlyDesignReadiness(projectReadiness) {
  return deepFreeze({
    schema_version:"ui-design-dor-result.v1",
    document_type:"ui-design-dor-result",
    rules_version:"ui-design-dor-rules.v1",
    source_revision:projectReadiness.source_revision,
    source_sha256:projectReadiness.source_sha256,
    design_level:null,
    graph_root_sha256:null,
    ready_for_ui_issue_generation:true,
    ui_issue_ids:[],
    failures:[],
    warnings:[],
  });
}

async function designReadinessFromCatalog(catalog,bundle,authorityRegistry,projectReadiness) {
  const uiIssues=bundle.issuePlan.content.issues.filter(issue =>
    Object.hasOwn(issue,"ui_design_trace"));
  const states=await catalog.list({document_type:"design-orchestration-state"});
  if (states.length===0) {
    if (uiIssues.length===0) return backendOnlyDesignReadiness(projectReadiness);
    return evaluateDesignReadiness({designGraph:[],audit:null,approval:null,
      issuePlan:bundle.issuePlan});
  }
  const verified=[];
  const orchestrator=createDesignOrchestrator({authorityRegistry});
  for (const state of states) {
    try {
      const snapshot=orchestrator.verifyStateSnapshot({
        content:state.content,provenance:state.provenance,
      });
      if (new Set(["COMPLETE","NOT_APPLICABLE"]).has(snapshot.content.gate)) {
        verified.push({state,snapshot});
      }
    } catch {
      // An invalid historical state cannot establish current readiness.
    }
  }
  if (verified.length!==1) {
    if (uiIssues.length===0) return backendOnlyDesignReadiness(projectReadiness);
    return evaluateDesignReadiness({designGraph:[],audit:null,approval:null,
      issuePlan:bundle.issuePlan});
  }
  const {snapshot}=verified[0];
  const graph=[];
  for (const reference of snapshot.content.artifact_refs) {
    graph.push(await catalog.get(reference));
  }
  if (snapshot.content.gate==="NOT_APPLICABLE") {
    if (uiIssues.length>0) return evaluateDesignReadiness({
      designGraph:graph,audit:null,approval:null,issuePlan:bundle.issuePlan,
    });
    const brief=graph.find(row => row.document_type==="design-brief");
    return deepFreeze({
      ...backendOnlyDesignReadiness(projectReadiness),
      source_revision:brief.provenance.source_revision,
      source_sha256:brief.provenance.source_sha256,
      design_level:"NOT_APPLICABLE",
    });
  }
  return evaluateDesignReadiness({
    designGraph:graph,
    audit:graph.find(row => row.document_type==="design-audit"),
    approval:graph.find(row => row.document_type==="design-approval"),
    issuePlan:bundle.issuePlan,
  });
}

export async function runReadinessCommand(command,serviceInput) {
  if (command.name!=="readiness.check") {
    throw new TypeError(`Unsupported readiness command ${String(command.name)}`);
  }
  const services=gateCommandServices(serviceInput,{
    allowed:["artifactStore","authorityRegistry"],
  });
  if (services.authorityRegistry===undefined) {
    throw new OrchestrationError(
      "READINESS_AUTHORITY_REQUIRED",
      "Readiness evaluation requires an independent trusted authority registry",4,
    );
  }
  const catalog=await commandCatalog(services.store);
  const bundle=await resolveGateBundle(catalog,{
    requirePlan:true,requireAudit:true,requireState:true,requireTrace:false,current:true,
  });
  const evidence=await verifiedGateEvidence(catalog,bundle,services.authorityRegistry);
  const completeBundle={
    ...bundle,
    ...evidence,
    traceGraph:buildTraceGraph({
      pmAnalysis:bundle.pmAnalysis,
      architecture:bundle.architecture,
      approvals:evidence.adrApprovals,
      ...(evidence.decisionPackage===undefined ? {} : {
        decisionPackage:evidence.decisionPackage,
      }),
      decisionAnswers:evidence.decisionAnswers,
      issuePlan:bundle.issuePlan,
    }),
  };
  const readiness=evaluateProjectReadiness(completeBundle,{
    authorityRegistry:services.authorityRegistry,
  });
  const failures=actionable(readiness.failures);
  const warnings=actionable(readiness.warnings);
  const projectReadiness=deepFreeze({...readiness,failures,warnings});
  const uiDesignReadiness=await designReadinessFromCatalog(
    catalog,bundle,services.authorityRegistry,projectReadiness,
  );
  const blocked=readiness.ready_for_issue_generation!==true ||
    uiDesignReadiness.ready_for_ui_issue_generation!==true;
  return deepFreeze({
    ...readiness,
    failures,
    warnings,
    project_readiness:projectReadiness,
    ui_design_readiness:uiDesignReadiness,
    ...(!blocked ? {} : {
      blocked:true,
      command_exit_code:4,
    }),
  });
}
