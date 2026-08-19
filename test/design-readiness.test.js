import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {sha256Canonical} from "../src/contracts/acp.js";
import {
  criticalCompleteGraph,
  mutateGraph,
} from "./support/design-audit-fixture.js";
import {graphForLevel} from "./support/design-command-fixture.js";

const {evaluateDesignReadiness}=await import("../src/pipeline/design-readiness.js");
const issuePlanFixture=JSON.parse(await readFile(new URL(
  "./fixtures/issue-plan/valid/complete-artifact.json",
  import.meta.url,
),"utf8"));

function entityReference(artifact,entityId) {
  return {...{
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  },entity_id:entityId};
}

function uiIssuePlan(graph) {
  const plan=structuredClone(issuePlanFixture);
  const flow=graph.find(row => row.document_type==="user-flow");
  const screen=graph.find(row => row.document_type==="screen-spec");
  const system=graph.find(row => row.document_type==="design-system");
  plan.content.issues[0].ui_design_trace={
    design_system_ref:{
      document_type:system.document_type,
      artifact_id:system.artifact_id,
      revision:system.revision,
      content_sha256:system.content_sha256,
    },
    flow_refs:[entityReference(flow,flow.content.flow_id)],
    screen_refs:[entityReference(screen,screen.content.screen_id)],
    component_refs:[entityReference(system,"COMP-BUTTON")],
    state_refs:screen.content.states.map(row => entityReference(screen,row.state_id)),
    responsive_refs:screen.content.responsive.map(row => entityReference(screen,row.target_id)),
    accessibility_refs:screen.content.accessibility.map(row =>
      entityReference(screen,row.criterion_id)),
  };
  plan.content_sha256=sha256Canonical(plan.content);
  return plan;
}

function readinessInput(graph) {
  return {
    designGraph:graph,
    audit:graph.find(row => row.document_type==="design-audit"),
    approval:graph.find(row => row.document_type==="design-approval"),
  };
}

test("UI Design DoR passes a fresh exact Critical graph separately from Project PDoR",() => {
  const graph=criticalCompleteGraph();
  const result=evaluateDesignReadiness(readinessInput(graph));
  assert.equal(result.schema_version,"ui-design-dor-result.v1");
  assert.equal(result.ready_for_ui_issue_generation,true);
  assert.equal(result.failures.length,0);
  assert.equal(result.design_level,"CRITICAL");
});

test("UI Design DoR rejects a stale approval bound to a different graph root",() => {
  const graph=criticalCompleteGraph();
  const stale=structuredClone(graph.find(row => row.document_type==="design-approval"));
  stale.content.graph_root_sha256="f".repeat(64);
  stale.content_sha256=sha256Canonical(stale.content);
  const result=evaluateDesignReadiness({...readinessInput(graph),approval:stale});
  assert.equal(result.ready_for_ui_issue_generation,false);
  assert.ok(result.failures.some(row => row.rule_id==="UIDOR-080-EXACT-APPROVAL"));
});

test("UI Design DoR recomputes audit findings and rejects a stale PASS claim",() => {
  const pass=criticalCompleteGraph();
  const staleAudit=pass.find(row => row.document_type==="design-audit");
  const changed=mutateGraph(pass,rows => {
    const screen=rows.find(row => row.document_type==="screen-spec");
    screen.content.states=screen.content.states.filter(row => row.name!=="Permission");
    screen.content.rule_applications[0].state_ids=screen.content.states.map(row => row.state_id);
    const flow=rows.find(row => row.document_type==="user-flow");
    flow.content.steps=flow.content.steps.filter(row => row.state_id!=="STATE-PERMISSION");
    flow.content.steps.at(-1).next_step_ids=[];
  });
  const result=evaluateDesignReadiness({
    designGraph:changed,
    audit:staleAudit,
    approval:changed.find(row => row.document_type==="design-approval"),
  });
  assert.equal(result.ready_for_ui_issue_generation,false);
  assert.ok(result.failures.some(row => row.rule_id==="UIDOR-070-LATEST-AUDIT"));
});

test("UI Design DoR derives UI issue identity only from authoritative exact issue-plan traces",() => {
  const graph=criticalCompleteGraph();
  const issuePlan=uiIssuePlan(graph);
  const pass=evaluateDesignReadiness({...readinessInput(graph),issuePlan});
  assert.equal(pass.ready_for_ui_issue_generation,true);
  assert.deepEqual(pass.ui_issue_ids,["ISSUE-001"]);

  issuePlan.content.issues[0].ui_design_trace.screen_refs[0].revision=99;
  issuePlan.content_sha256=sha256Canonical(issuePlan.content);
  const stale=evaluateDesignReadiness({...readinessInput(graph),issuePlan});
  assert.equal(stale.ready_for_ui_issue_generation,false);
  assert.ok(stale.failures.some(row => row.rule_id==="UIDOR-090-ISSUE-TRACE"));
});

test("UI Design DoR routes Critical evidence to its versioned rule",() => {
  const graph=mutateGraph(criticalCompleteGraph(),rows => {
    const item=rows.find(row => row.document_type==="usability-evidence");
    item.content.critical_evidence=item.content.critical_evidence.filter(row =>
      row.kind!=="SECURITY");
  });
  const result=evaluateDesignReadiness(readinessInput(graph));
  assert.equal(result.ready_for_ui_issue_generation,false);
  assert.ok(result.failures.some(row => row.rule_id==="UIDOR-060-CRITICAL-EVIDENCE"));
});

test("NOT_APPLICABLE Design DoR passes without fabricated audit or approval",() => {
  const graph=graphForLevel("NOT_APPLICABLE");
  const result=evaluateDesignReadiness({designGraph:graph,audit:null,approval:null});
  assert.equal(result.design_level,"NOT_APPLICABLE");
  assert.equal(result.ready_for_ui_issue_generation,true);
  assert.deepEqual(result.failures,[]);
});
