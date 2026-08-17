import fs from "node:fs";

import {sha256Canonical} from "../../src/contracts/acp.js";
import {buildArchitecture} from "../../src/pipeline/architecture.js";
import {buildIssuePlan} from "../../src/pipeline/issue-plan.js";

export function fixture(path) {
  return JSON.parse(fs.readFileSync(new URL(
    `../fixtures/${path}`,
    import.meta.url,
  ),"utf8"));
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function rehash(artifact) {
  artifact.content_sha256=sha256Canonical(artifact.content);
  return artifact;
}

export function artifactReference(artifact) {
  return {
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  };
}

function buildAdr(pmAnalysis,architecture,{second=false}={}) {
  const content=fixture("architecture/valid/adr-content.json");
  if (second) {
    content.id="ADR-002";
    content.meaning="Keep read status projections isolated from request intake.";
    content.decision="Use an independently revisioned read-status projection.";
    content.rationale="The quality attribute can evolve without changing request intake.";
    content.affected_requirements=["NFR-001"];
  }
  return rehash({
    schema_version:"acp.v1",
    document_type:"adr",
    artifact_id:second ? "ADR-ARTIFACT-002" : "ADR-ARTIFACT-001",
    revision:1,
    run_id:"run-architecture-001",
    producer:{role:"architect",identity:"toss-architect"},
    runtime_identity:{kind:"deterministic",name:"toss-cli",version:"2.1.0"},
    created_at:"2026-08-17T13:00:00.000Z",
    provenance:clone(architecture.provenance),
    parents:[],
    inputs:[artifactReference(pmAnalysis),artifactReference(architecture)],
    content_sha256:"0".repeat(64),
    content,
  });
}

function requirementReferences(ids) {
  return ids.map(id => ({kind:"requirement",id}));
}

export function completeArtifacts({orphanAdr=false}={}) {
  const expected=fixture("traceability/valid/complete.json");
  const pmAnalysis=fixture("pm-analysis/valid/complete-artifact.json");
  pmAnalysis.content.open_questions[0].severity="P3";
  rehash(pmAnalysis);
  const architectureArtifact=buildArchitecture({
    pmAnalysis,
    decisions:fixture("architecture/valid/decisions.json"),
    artifactContext:fixture("architecture/valid/artifact-context.json"),
  });
  const adrs=[buildAdr(pmAnalysis,architectureArtifact)];
  if (orphanAdr) adrs.push(buildAdr(pmAnalysis,architectureArtifact,{second:true}));
  const finalization=fixture("issue-plan/valid/finalization-input.json");
  const requirementIds=orphanAdr ? expected.source_requirement_ids.filter(
    id => id!=="NFR-001",
  ) : expected.source_requirement_ids;
  const requirements=requirementReferences(requirementIds);
  finalization.plan.epics[0].source_requirements=clone(requirements);
  finalization.plan.issues[0].source_requirements=clone(requirements);
  finalization.plan.acceptance_criteria[0].verifies=clone(requirements);
  const issuePlan=buildIssuePlan({
    pmAnalysis,
    architecture:architectureArtifact,
    adrs,
    plan:finalization.plan,
    artifactContext:finalization.artifact_context,
  });
  return clone({
    pmAnalysis,
    architecture:{artifact:architectureArtifact,adrs},
    issuePlan,
  });
}

function storeCompatibleEnvelope(artifact) {
  const compatible=clone(artifact);
  const source=compatible.provenance.source;
  compatible.provenance={
    source_revision:compatible.provenance.source_revision,
    source_sha256:compatible.provenance.source_sha256,
    locations:[`${source.file}#${source.section}:${source.location}`],
  };
  return compatible;
}

export async function appendArtifacts(store,artifacts) {
  const records=[
    artifacts.pmAnalysis,
    artifacts.architecture.artifact,
    ...artifacts.architecture.adrs,
    artifacts.issuePlan,
  ].map(storeCompatibleEnvelope);
  for (const artifact of records) await store.append(artifact);
}
