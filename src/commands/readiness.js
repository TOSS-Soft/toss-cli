import {evaluateProjectReadiness} from "../pipeline/readiness.js";
import {
  commandCatalog,
  deepFreeze,
  gateCommandServices,
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
    required:["artifactStore","authorityRegistry"],
  });
  const catalog=await commandCatalog(services.store);
  const bundle=await resolveGateBundle(catalog,{
    requirePlan:true,requireAudit:true,requireState:true,current:true,
  });
  const readiness=evaluateProjectReadiness(bundle,{
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
