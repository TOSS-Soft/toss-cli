import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {createArtifactStore} from "../../src/artifacts/store.js";
import {parseCommand} from "../../src/commands/router.js";
import {clone,completeArtifacts,rehash} from "./trace-fixture.js";

export async function commandStore(t) {
  const root=await mkdtemp(join(tmpdir(),"toss-command-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  return createArtifactStore({root});
}

export function memoryCommandStore() {
  const records=[];
  const copy=value => JSON.parse(JSON.stringify(value));
  const referenceOf=value => ({
    document_type:value.document_type,
    artifact_id:value.artifact_id,
    revision:value.revision,
    content_sha256:value.content_sha256,
  });
  const find=reference => records.find(record =>
    record.document_type===reference.document_type &&
    record.artifact_id===reference.artifact_id &&
    record.revision===reference.revision &&
    record.content_sha256===reference.content_sha256);
  async function verify(reference) {
    const record=find(reference);
    if (!record) throw new Error("Artifact reference was not found");
    return copy(record);
  }
  async function get(reference) {
    return verify(reference);
  }
  async function list(filter={}) {
    return records.filter(record => Object.entries(filter).every(
      ([key,value]) => record[key]===value,
    )).map(copy);
  }
  async function append(draft) {
    for (const reference of [...draft.parents,...draft.inputs]) await verify(reference);
    const same=records.find(record =>
      record.document_type===draft.document_type &&
      record.artifact_id===draft.artifact_id &&
      record.revision===draft.revision);
    if (same) {
      if (JSON.stringify(same)!==JSON.stringify(draft)) {
        throw new Error("Refusing to overwrite immutable artifact revision");
      }
      return copy(same);
    }
    const identity=records.filter(record =>
      record.document_type===draft.document_type &&
      record.artifact_id===draft.artifact_id);
    if (draft.revision!==identity.length+1) throw new Error("Non-monotonic revision");
    if (draft.parents.length>0 && JSON.stringify(draft.parents)!==
        JSON.stringify([referenceOf(identity.at(-1))])) {
      throw new Error("Invalid artifact parent lineage");
    }
    records.push(copy(draft));
    return copy(draft);
  }
  return {append,get,list,verify};
}

export function projectCommandInput({blockingDecision=false,pendingAdr=false}={}) {
  const graph=completeArtifacts();
  const raw=graph.pmAnalysis.provenance;
  const provenance={
    source_revision:raw.source_revision,
    source_sha256:raw.source_sha256,
    locations:[`${raw.source.file}#${raw.source.section}:${raw.source.location}`],
  };
  const artifacts=clone(graph);
  for (const artifact of [
    artifacts.pmAnalysis,
    artifacts.architecture.artifact,
    ...artifacts.architecture.adrs,
    artifacts.issuePlan,
  ]) artifact.provenance=clone(provenance);
  if (blockingDecision) {
    artifacts.pmAnalysis.content.open_questions[0].severity="P2";
    rehash(artifacts.pmAnalysis);
  }
  if (pendingAdr) {
    artifacts.architecture.adrs[0].content.status="proposed";
    artifacts.architecture.adrs[0].content.approval.state="pending";
    rehash(artifacts.architecture.adrs[0]);
  }
  return {
    schema_version:"project-command-input.v1",
    project_id:"support-workspace",
    analysis_id:"analysis-support-workspace",
    created_at:"2026-08-18T08:00:00.000Z",
    run_id:"run-project-command-001",
    runtime_identity:{kind:"deterministic",name:"toss-cli",version:"2.1.0"},
    provenance,
    artifacts:{
      pm_analysis:artifacts.pmAnalysis,
      decision_enrichments:[{
        id:"Q-001",
        context:"The source does not set a customer-visible response target.",
        impact:"Support outcomes cannot be evaluated consistently without the target.",
        reversibility:"reversible",
      }],
      architecture:artifacts.architecture.artifact,
      adrs:artifacts.architecture.adrs,
      issue_plan:artifacts.issuePlan,
    },
  };
}

export function featureCommandInput({findings=[]}={}) {
  return {
    schema_version:"feature-command-input.v1",
    project_id:"support-workspace",
    feature_id:"FEATURE-001",
    created_at:"2026-08-18T09:00:00.000Z",
    run_id:"run-feature-command-001",
    runtime_identity:{kind:"deterministic",name:"toss-cli",version:"2.1.0"},
    provenance:{
      source_revision:"feature-source@1",
      source_sha256:"b".repeat(64),
      locations:["feature.md#request:1-24"],
    },
    request:{
      summary:"Notify the requester when a support request is resolved.",
      source_locations:["feature.md#request:1-24"],
    },
    impact_analysis:{
      summary:"Adds one notification requirement without changing intake semantics.",
      affected_entities:[{kind:"requirement",id:"FR-001"}],
    },
    requirement_delta:{
      added:[{
        id:"FR-002",
        meaning:"The system sends a resolution notification to the requester.",
      }],
      changed:[],
    },
    architecture_impact:{
      summary:"The existing notification boundary can own the new event.",
      affected_adrs:["ADR-001"],
      requires_adr:false,
    },
    issue_plan_delta:{
      summary:"Adds one implementation issue after request persistence.",
      issue_ids:["ISSUE-002"],
    },
    findings,
  };
}

export function commandServices(store,input,{prompt,readInput}={}) {
  return {
    artifactStore:store,
    readInput:readInput ?? (async () => JSON.stringify(input)),
    ...(prompt ? {prompt} : {}),
  };
}

export function parsedCommand(name,options={}) {
  const argv=name.split(".");
  if (options.from) argv.push("--from",options.from);
  if (options.nonInteractive) argv.push("--non-interactive");
  if (options.continue) argv.push("--continue");
  return parseCommand(argv);
}
