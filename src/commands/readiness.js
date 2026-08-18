import {evaluateProjectReadiness} from "../pipeline/readiness.js";
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
  return deepFreeze({
    ...readiness,
    failures,
    warnings,
    ...(readiness.ready_for_issue_generation ? {} : {
      blocked:true,
      command_exit_code:4,
    }),
  });
}
