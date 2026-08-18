import {canonicalJson} from "../contracts/acp.js";
import {auditSpecification} from "../pipeline/spec-auditor.js";
import {
  commandCatalog,
  deepFreeze,
  gateCommandServices,
  OrchestrationError,
  resolveGateBundle,
  validationError,
} from "./gate-support.js";

export async function runAuditCommand(command,serviceInput) {
  if (command.name!=="audit.run") {
    throw new TypeError(`Unsupported audit command ${String(command.name)}`);
  }
  const services=gateCommandServices(serviceInput,{allowed:["artifactStore"]});
  const catalog=await commandCatalog(services.store);
  const bundle=await resolveGateBundle(catalog,{
    requirePlan:true,
    requireTrace:false,
    current:true,
  });
  const result=auditSpecification({
    pmAnalysis:bundle.pmAnalysis,
    architecture:bundle.architecture,
    issuePlan:bundle.issuePlan,
  });
  validationError(result.artifact,"spec-audit.v1","Spec Audit");
  const sameIdentity=(await catalog.list({
    document_type:"spec-audit",
    artifact_id:result.artifact.artifact_id,
    revision:result.artifact.revision,
  }));
  if (sameIdentity.length>1) {
    throw new OrchestrationError(
      "SPEC_AUDIT_CONFLICT","Spec Audit history duplicates an immutable identity",6,
    );
  }
  const previous=sameIdentity[0];
  if (previous && canonicalJson(previous)!==canonicalJson(result.artifact)) {
    throw new OrchestrationError(
      "SPEC_AUDIT_CONFLICT","Current Spec Audit conflicts with deterministic recomputation",6,
    );
  }
  const artifact=previous ?? await catalog.append(result.artifact);
  if (catalog.hasChanges()) await catalog.refresh();
  return deepFreeze({
    schema_version:"spec-audit-command-result.v1",
    document_type:"spec-audit-command-result",
    status:result.status,
    ready_for_github:result.ready_for_github,
    findings:result.findings,
    artifact,
    persisted:!previous,
    ...(result.status==="FAIL" ? {blocked:true,command_exit_code:5} : {}),
  });
}
