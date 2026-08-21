import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {createArtifactStore} from "../../src/artifacts/store.js";
import {parseCommand} from "../../src/commands/router.js";
import {canonicalJson,sha256Canonical} from "../../src/contracts/acp.js";
import {clone,completeArtifacts,rehash} from "./trace-fixture.js";

export async function commandStoreFixture(t,{prefix="toss-command-",remove=rm}={}) {
  if (typeof prefix!=="string" || !/^toss-command-[a-z-]*$/u.test(prefix)) {
    throw new TypeError("command store prefix must be a safe toss-command prefix");
  }
  if (typeof remove!=="function") {
    throw new TypeError("command store remove must be a function");
  }
  const root=await mkdtemp(join(tmpdir(),prefix));
  let cleaned=false;
  const cleanup=async () => {
    if (cleaned) return;
    await remove(root,{recursive:true,force:true});
    cleaned=true;
  };
  t.after(cleanup);
  return Object.freeze({root,store:createArtifactStore({root}),cleanup});
}

export async function commandStore(t) {
  return (await commandStoreFixture(t)).store;
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
    (reference.document_type===undefined || record.document_type===reference.document_type) &&
    record.artifact_id===reference.artifact_id &&
    record.revision===reference.revision &&
    record.content_sha256===reference.content_sha256);
  const ordered=records => [...records].sort((left,right) =>
    left.document_type.localeCompare(right.document_type) ||
    left.artifact_id.localeCompare(right.artifact_id) ||
    left.revision-right.revision,
  );
  const exactReference=(reference,record) =>
    reference.artifact_id===record.artifact_id &&
    reference.revision===record.revision &&
    reference.content_sha256===record.content_sha256 &&
    (reference.document_type===undefined || reference.document_type===record.document_type);
  async function verify(reference,visited=new Set()) {
    const record=find(reference);
    if (!record) throw new Error("Artifact reference was not found");
    const key=`${record.document_type}\u0000${record.artifact_id}\u0000${record.revision}`;
    if (visited.has(key)) throw new Error("Cyclic artifact reference");
    visited.add(key);
    try {
      if (record.revision===1 && record.parents.length!==0) {
        throw new Error("Revision 1 must have empty parents");
      }
      if (record.revision>1) {
        const predecessor=records.find(candidate =>
          candidate.document_type===record.document_type &&
          candidate.artifact_id===record.artifact_id &&
          candidate.revision===record.revision-1);
        if (!predecessor || record.parents.length!==1 ||
            !exactReference(record.parents[0],predecessor)) {
          throw new Error("Invalid artifact parent lineage");
        }
      }
      for (const source of [...record.parents,...record.inputs]) await verify(source,visited);
    } finally {
      visited.delete(key);
    }
    return copy(record);
  }
  async function get(reference) {
    return verify(reference);
  }
  async function list(filter={}) {
    return ordered(records.filter(record => Object.entries(filter).every(
      ([key,value]) => record[key]===value,
    ))).map(copy);
  }
  async function append(draft) {
    const artifact=copy(draft);
    artifact.content_sha256=sha256Canonical(artifact.content);
    for (const reference of [...artifact.parents,...artifact.inputs]) await verify(reference);
    const identity=ordered(records.filter(record =>
      record.document_type===artifact.document_type &&
      record.artifact_id===artifact.artifact_id));
    const requestedRevision=artifact.revision;
    const same=requestedRevision===undefined ? undefined : identity.find(record =>
      record.revision===requestedRevision);
    if (same) {
      if (same.content_sha256!==artifact.content_sha256 ||
          canonicalJson(same)!==canonicalJson({...artifact,revision:same.revision})) {
        throw new Error("Refusing to overwrite immutable artifact revision");
      }
      return copy(same);
    }
    if (requestedRevision===undefined) {
      const equivalent=identity.find(record => record.content_sha256===artifact.content_sha256 &&
        canonicalJson(record)===canonicalJson({...artifact,revision:record.revision}));
      if (equivalent) return copy(equivalent);
    }
    const predecessor=identity.at(-1);
    const nextRevision=(predecessor?.revision ?? 0)+1;
    if (requestedRevision!==undefined && requestedRevision!==nextRevision) {
      throw new Error("Non-monotonic revision");
    }
    artifact.revision=requestedRevision ?? nextRevision;
    if (!predecessor && artifact.parents.length!==0) {
      throw new Error("Invalid artifact parent lineage");
    }
    if (predecessor && (artifact.parents.length!==1 ||
        !exactReference(artifact.parents[0],referenceOf(predecessor)))) {
      throw new Error("Invalid artifact parent lineage");
    }
    records.push(copy(artifact));
    return copy(artifact);
  }
  return Object.freeze({append,get,list,verify});
}

export function countedCommandStore(delegate) {
  const calls={append:0,get:0,list:0,verify:0};
  const store={};
  for (const method of Object.keys(calls)) {
    store[method]=async (...args) => {
      calls[method]+=1;
      return delegate[method](...args);
    };
  }
  return {
    store,
    calls,
    reset() {
      for (const method of Object.keys(calls)) calls[method]=0;
    },
  };
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

export function featureCommandInput({findings=[],designImpact}={}) {
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
    design_impact:designImpact ?? {
      delivery_targets:["API","BACKEND"],
      affected_surfaces:[],
      risk_signals:[],
      requested_level:"AUTO",
      source:"NOT_APPLICABLE",
      purpose:"The feature changes backend notification delivery only.",
      success_criteria:["No user-interface design artifact is required."],
      approval_owner:{role:"USER",identity:"verified-user"},
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
