import {readFile} from "node:fs/promises";

import {canonicalJson,sha256Canonical} from "../../src/contracts/acp.js";
import {
  artifactReference,
  graphForLevel,
} from "./design-command-fixture.js";

const auditFixture=JSON.parse(await readFile(new URL(
  "../fixtures/design-audit/critical-pass.json",
  import.meta.url,
),"utf8"));

function canonicalCopy(value) {
  return JSON.parse(canonicalJson(value));
}

function replaceExactReferences(value,byArtifactId) {
  if (Array.isArray(value)) {
    return value.map(item => replaceExactReferences(item,byArtifactId));
  }
  if (!value || typeof value!=="object") return value;
  if (typeof value.artifact_id==="string" &&
      Number.isSafeInteger(value.revision) &&
      typeof value.content_sha256==="string") {
    const resolved=byArtifactId.get(value.artifact_id);
    if (resolved) {
      return {
        ...value,
        document_type:resolved.document_type,
        revision:resolved.revision,
        content_sha256:resolved.content_sha256,
      };
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [
    key,replaceExactReferences(item,byArtifactId),
  ]));
}

function rebuild(input) {
  const result=[];
  const byArtifactId=new Map();
  for (const source of input) {
    const artifact=canonicalCopy(source);
    artifact.parents=replaceExactReferences(artifact.parents,byArtifactId);
    artifact.inputs=replaceExactReferences(artifact.inputs,byArtifactId);
    artifact.content=replaceExactReferences(artifact.content,byArtifactId);
    if (artifact.document_type==="design-audit") {
      artifact.content.audited_artifacts=result.map(artifactReference).sort((left,right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)));
    }
    if (artifact.document_type==="design-approval") {
      artifact.content.graph_manifest=result.map(artifactReference).sort((left,right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)));
      artifact.content.graph_root_sha256=sha256Canonical(artifact.content.graph_manifest);
    }
    artifact.content_sha256=sha256Canonical(artifact.content);
    result.push(artifact);
    byArtifactId.set(artifact.artifact_id,artifact);
  }
  return result;
}

function passShape(graph) {
  const screen=graph.find(row => row.document_type==="screen-spec");
  const flow=graph.find(row => row.document_type==="user-flow");
  screen.content.responsive=canonicalCopy(auditFixture.responsive);
  screen.content.accessibility=canonicalCopy(auditFixture.accessibility);
  screen.content.states=auditFixture.state_names.map(name => ({
    state_id:`STATE-${name.toUpperCase()}`,
    name,
    component_ids:["COMP-BUTTON"],
    responsive_target_ids:["RESP-MOBILE","RESP-TABLET","RESP-DESKTOP"],
    accessibility_criterion_ids:["A11Y-NAME"],
  }));
  screen.content.rule_applications[0].state_ids=screen.content.states.map(row => row.state_id);
  flow.content.steps=screen.content.states.map((state,index,states) => ({
    step_id:`STEP-${state.name.toUpperCase()}`,
    screen_id:screen.content.screen_id,
    state_id:state.state_id,
    next_step_ids:index===states.length-1 ? [] : [`STEP-${states[index+1].name.toUpperCase()}`],
  }));
  const wireframes=graph.find(row => row.document_type==="wireframe-plan");
  wireframes.content.wireframes[0].state_ids=screen.content.states.map(row => row.state_id);
  const evidence=graph.find(row => row.document_type==="usability-evidence");
  evidence.content.critical_evidence=canonicalCopy(auditFixture.critical_evidence);
  return graph;
}

export function criticalWorkGraph() {
  return rebuild(passShape(graphForLevel("CRITICAL").filter(row =>
    !["design-audit","design-approval"].includes(row.document_type))));
}

export function criticalCompleteGraph() {
  const base=passShape(graphForLevel("CRITICAL"));
  const audit=base.find(row => row.document_type==="design-audit");
  audit.content.findings=[];
  return rebuild(base);
}

export function mutateGraph(graph,mutate) {
  const copy=canonicalCopy(graph);
  mutate(copy);
  return rebuild(copy);
}
