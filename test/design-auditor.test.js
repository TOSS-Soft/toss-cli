import assert from "node:assert/strict";
import test from "node:test";

import {canonicalJson} from "../src/contracts/acp.js";
import {
  criticalWorkGraph,
  mutateGraph,
} from "./support/design-audit-fixture.js";

const {auditDesign}=await import("../src/pipeline/design-auditor.js");

test("Design Auditor returns deterministic PASS without mutating a complete graph",() => {
  const graph=criticalWorkGraph();
  const before=canonicalJson(graph);
  const first=auditDesign(graph);
  const second=auditDesign(graph);
  assert.equal(first.status,"PASS");
  assert.deepEqual(first,second);
  assert.equal(canonicalJson(graph),before);
  assert.equal(Object.isFrozen(first),true);
  assert.equal(Object.isFrozen(first.findings),true);
});

test("Design Auditor returns WARN for a non-blocking orphan interaction state",() => {
  const graph=mutateGraph(criticalWorkGraph(),rows => {
    const screen=rows.find(row => row.document_type==="screen-spec");
    screen.content.states.push({
      state_id:"STATE-OPTIONAL",
      name:"Optional hint",
      component_ids:["COMP-BUTTON"],
      responsive_target_ids:["RESP-MOBILE","RESP-TABLET","RESP-DESKTOP"],
      accessibility_criterion_ids:["A11Y-NAME"],
    });
    screen.content.rule_applications[0].state_ids.push("STATE-OPTIONAL");
  });
  const result=auditDesign(graph);
  assert.equal(result.status,"WARN");
  assert.ok(result.findings.some(row => row.type==="ORPHAN_SCREEN_STATE" && row.severity==="P3"));
});

test("Design Auditor fails closed on an exact company binding violation",() => {
  const graph=mutateGraph(criticalWorkGraph(),rows => {
    const screen=rows.find(row => row.document_type==="screen-spec");
    screen.content.rule_applications[0].value={token:"color.project.override"};
  });
  const result=auditDesign(graph);
  assert.equal(result.status,"FAIL");
  assert.ok(result.findings.some(row => row.type==="BINDING_RULE_VIOLATION"));
});

test("Critical audit fails when structured security or privacy evidence is missing",() => {
  const graph=mutateGraph(criticalWorkGraph(),rows => {
    const evidence=rows.find(row => row.document_type==="usability-evidence");
    evidence.content.critical_evidence=evidence.content.critical_evidence.filter(
      row => row.kind!=="PRIVACY",
    );
  });
  const result=auditDesign(graph);
  assert.equal(result.status,"FAIL");
  assert.ok(result.findings.some(row =>
    row.type==="CRITICAL_EVIDENCE_MISSING" && row.evidence.some(item =>
      item.includes("PRIVACY")),
  ));
});

test("Design Auditor reports missing normal and exception states with exact screen evidence",() => {
  const graph=mutateGraph(criticalWorkGraph(),rows => {
    const screen=rows.find(row => row.document_type==="screen-spec");
    screen.content.states=screen.content.states.filter(row => row.name!=="Recovery");
    screen.content.rule_applications[0].state_ids=screen.content.states.map(row => row.state_id);
    const flow=rows.find(row => row.document_type==="user-flow");
    flow.content.steps=flow.content.steps.filter(row => row.state_id!=="STATE-RECOVERY");
    flow.content.steps.at(-1).next_step_ids=[];
  });
  const result=auditDesign(graph);
  assert.equal(result.status,"FAIL");
  assert.ok(result.findings.some(row =>
    row.type==="SCREEN_STATE_COVERAGE" && row.affected_refs.some(reference =>
      reference.entity_id==="SCREEN-CHECKOUT"),
  ));
});

test("Design Auditor fails when the level-aware graph omits a required artifact type",() => {
  const graph=criticalWorkGraph().filter(row => row.document_type!=="prototype-manifest");
  const result=auditDesign(graph);
  assert.equal(result.status,"FAIL");
  assert.ok(result.findings.some(row => row.type==="LEVEL_GRAPH_INCOMPLETE"));
});
