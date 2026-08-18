import {validateIssuePlan} from "../pipeline/issue-plan.js";
import {
  commandCatalog,
  deepFreeze,
  exactReference,
  gateCommandServices,
  OrchestrationError,
  resolveGateBundle,
} from "./gate-support.js";

export async function runPlanCommand(command,serviceInput) {
  if (command.name!=="plan.show") {
    throw new TypeError(`Unsupported plan command ${String(command.name)}`);
  }
  const services=gateCommandServices(serviceInput,{allowed:["artifactStore"]});
  const catalog=await commandCatalog(services.store);
  const bundle=await resolveGateBundle(catalog,{
    requirePlan:true,requireState:true,current:true,
  });
  const validation=validateIssuePlan({
    pmAnalysis:bundle.pmAnalysis,
    architecture:bundle.architecture.artifact,
    adrs:bundle.architecture.adrs,
    issuePlan:bundle.issuePlan,
  });
  if (!validation.valid) {
    throw new OrchestrationError(
      "ISSUE_PLAN_INVALID","Verified issue plan failed deterministic validation",5,
    );
  }
  const plan=bundle.issuePlan.content;
  const criteria=new Map(plan.acceptance_criteria.map(criterion => [criterion.id,criterion]));
  const issues=plan.issues.map(issue => ({
    id:issue.id,
    meaning:issue.meaning,
    epic_id:issue.epic?.id ?? null,
    standalone:issue.standalone ?? null,
    source_requirements:(issue.source_requirements ?? []).map(reference => reference.id),
    dependencies:issue.dependencies.map(reference => reference.id),
    required_adrs:issue.adr_refs.map(reference => reference.id),
    acceptance_criteria:issue.acceptance_criteria.map(reference => {
      const criterion=criteria.get(reference.id);
      if (!criterion) {
        throw new OrchestrationError(
          "ISSUE_PLAN_INVALID",`Acceptance criterion ${reference.id} is missing`,5,
        );
      }
      return {
        id:criterion.id,
        meaning:criterion.meaning,
        verifies:criterion.verifies.map(target => target.id),
      };
    }),
  }));
  return deepFreeze({
    schema_version:"issue-plan-view.v1",
    document_type:"issue-plan-view",
    summary:plan.summary,
    status:plan.status,
    issue_plan:exactReference(bundle.issuePlan),
    coverage:plan.coverage,
    epics:plan.epics.map(epic => ({
      id:epic.id,
      meaning:epic.meaning,
      source_requirements:epic.source_requirements.map(reference => reference.id),
      issue_ids:issues.filter(issue => issue.epic_id===epic.id).map(issue => issue.id),
    })),
    issues,
  });
}
