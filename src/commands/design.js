import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateDesignArtifact} from "../pipeline/design-contracts.js";
import {classifyDesignLevel} from "../pipeline/design-level.js";
import {createDesignOrchestrator} from "../pipeline/design-orchestrator.js";
import {
  acquireInput,
  canonicalCopy,
  commandServices,
  createVerifiedArtifactCatalog,
  deepFreeze,
  exactReference,
  OrchestrationError,
} from "../pipeline/project-input.js";

const DESIGN_COMMANDS=new Set([
  "design.init","design.analyze","design.prepare","design.status","design.flows",
  "design.wireframes","design.direction","design.system","design.screens",
  "design.prototype","design.audit","design.review","design.approve",
]);
const INPUT_KEYS=new Set([
  "schema_version","design_id","created_at","run_id","runtime_identity",
  "provenance","classification_input","artifacts","approval_records",
]);
const DESIGN_TYPES=new Set([
  "design-brief","ux-analysis","user-flow","information-architecture",
  "wireframe-plan","visual-direction","design-system","screen-spec",
  "prototype-manifest","usability-evidence","design-audit","design-approval",
]);
const TYPES_BY_LEVEL=Object.freeze({
  NOT_APPLICABLE:Object.freeze(["design-brief"]),
  LITE:Object.freeze([
    "design-brief","user-flow","design-system","screen-spec","design-audit",
    "design-approval",
  ]),
  STANDARD:Object.freeze([
    "design-brief","ux-analysis","user-flow","information-architecture",
    "wireframe-plan","visual-direction","design-system","screen-spec",
    "prototype-manifest","design-audit","design-approval",
  ]),
  CRITICAL:Object.freeze([
    "design-brief","ux-analysis","user-flow","information-architecture",
    "wireframe-plan","visual-direction","design-system","screen-spec",
    "prototype-manifest","usability-evidence","design-audit","design-approval",
  ]),
});
const STAGES_BY_LEVEL=Object.freeze({
  NOT_APPLICABLE:Object.freeze(["BRIEF"]),
  LITE:Object.freeze(["BRIEF","FLOWS","SCREENS","AUDIT","FINAL_APPROVAL"]),
  STANDARD:Object.freeze([
    "BRIEF","ANALYSIS","FLOWS","INFORMATION_ARCHITECTURE","WIREFRAMES",
    "DIRECTION","DESIGN_SYSTEM","SCREENS","PROTOTYPE","AUDIT","FINAL_APPROVAL",
  ]),
  CRITICAL:Object.freeze([
    "BRIEF","ANALYSIS","FLOWS","INFORMATION_ARCHITECTURE","WIREFRAMES",
    "DIRECTION","DESIGN_SYSTEM","SCREENS","PROTOTYPE","USABILITY_EVIDENCE",
    "AUDIT","FINAL_APPROVAL",
  ]),
});

function closedRecord(value,label,keys) {
  if (!value || typeof value!=="object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a closed object`);
  }
  const actual=Object.keys(value).sort();
  const expected=[...keys].sort();
  if (canonicalJson(actual)!==canonicalJson(expected)) {
    throw new TypeError(`${label} is closed and contains an unexpected property`);
  }
  return value;
}

function text(value,label) {
  if (typeof value!=="string" || value.trim().length===0) {
    throw new TypeError(`${label} must be a non-blank string`);
  }
}

function compareArtifacts(left,right) {
  return String(left?.document_type).localeCompare(String(right?.document_type)) ||
    String(left?.artifact_id).localeCompare(String(right?.artifact_id)) ||
    Number(left?.revision)-Number(right?.revision);
}

function orderedArtifacts(value) {
  return [...value].sort(compareArtifacts);
}

function normalizeDesignInput(value) {
  const input=canonicalCopy(value,"design command input");
  closedRecord(input,"design command input",INPUT_KEYS);
  if (input.schema_version!=="design-command-input.v1") {
    throw new TypeError("design command input schema_version is unsupported");
  }
  for (const key of ["design_id","created_at","run_id"]) text(input[key],`design input ${key}`);
  if (!Array.isArray(input.artifacts) || input.artifacts.length===0) {
    throw new TypeError("design command input artifacts must be a non-empty array");
  }
  if (!Array.isArray(input.approval_records)) {
    throw new TypeError("design command input approval_records must be an array");
  }
  input.artifacts.sort(compareArtifacts);
  const brief=input.artifacts.find(row => row?.document_type==="design-brief");
  if (brief?.content?.design_id!==input.design_id) {
    throw new OrchestrationError(
      "INPUT_STALE","Design input identity does not match its design brief",6,
    );
  }
  for (const artifact of input.artifacts) {
    if (!DESIGN_TYPES.has(artifact?.document_type) ||
        artifact.provenance?.source_revision!==input.provenance?.source_revision ||
        artifact.provenance?.source_sha256!==input.provenance?.source_sha256) {
      throw new OrchestrationError(
        "INPUT_STALE","Every design artifact must bind the exact input provenance",6,
      );
    }
  }
  for (const artifact of input.artifacts) {
    const validation=validateDesignArtifact(artifact,input.artifacts);
    if (!validation.valid) {
      throw new OrchestrationError(
        "DESIGN_GRAPH_INVALID",
        `Design graph validation failed for ${artifact.document_type}: ${validation.findings[0]?.message ?? "invalid graph"}`,
        5,
      );
    }
  }
  return deepFreeze(input);
}

function commitmentKey(row) {
  return canonicalJson({
    expected_document_type:row.expected_document_type,
    payload_sha256:row.payload_sha256,
  });
}

function graphCommitmentKeys(graph) {
  return graph.map(artifact => canonicalJson({
    expected_document_type:artifact.document_type,
    payload_sha256:sha256Canonical(artifact),
  })).sort();
}

function assertExactReplay(input,previous) {
  const expected=previous.content.payload_commitments.map(commitmentKey).sort();
  const actual=graphCommitmentKeys(input.artifacts);
  const exact=canonicalJson(expected)===canonicalJson(actual);
  const initializedSubset=previous.content.state==="INITIALIZED" && expected.every(key =>
    actual.includes(key));
  if (!exact && !initializedSubset) {
    throw new OrchestrationError(
      "INPUT_STALE","Design payload does not match the exact committed gate input",6,
    );
  }
  const classification=previous.content.classification.classification_input;
  if (canonicalJson(classification)!==canonicalJson(input.classification_input) ||
      previous.provenance.source_revision!==input.provenance.source_revision ||
      previous.provenance.source_sha256!==input.provenance.source_sha256) {
    throw new OrchestrationError(
      "INPUT_STALE","Design classification or source changed after gate collection",6,
    );
  }
}

function featureDesignBrief(featureArtifact,classification) {
  const impact=featureArtifact.content.design_impact;
  const level=classification.effective_level;
  const designId=`DESIGN-${featureArtifact.content.feature_id}`;
  const content={
    design_id:designId,
    source:impact.source,
    purpose:impact.purpose,
    success_criteria:impact.success_criteria,
    approval_owner:impact.approval_owner,
    orchestration:{
      level,
      basis:[
        `PM classification ${classification.recommended_level} for exact feature source ${featureArtifact.provenance.source_revision}.`,
      ],
    },
  };
  return deepFreeze({
    schema_version:"acp.v1",
    document_type:"design-brief",
    artifact_id:`design-brief:${designId}`,
    revision:1,
    run_id:featureArtifact.run_id,
    producer:{role:"pm",identity:"toss-feature-design-classifier"},
    runtime_identity:featureArtifact.runtime_identity,
    created_at:featureArtifact.created_at,
    provenance:featureArtifact.provenance,
    parents:[],
    inputs:[],
    content_sha256:sha256Canonical(content),
    content,
  });
}

function initialFeatureState(featureArtifact,classification,brief,persistedBrief) {
  const level=classification.effective_level;
  const designId=brief.content.design_id;
  const briefReference=persistedBrief ? exactReference(persistedBrief) : null;
  const state=level==="NOT_APPLICABLE" ? "NOT_APPLICABLE" : "INITIALIZED";
  const gate=level==="NOT_APPLICABLE" ? "NOT_APPLICABLE" : "NONE";
  const nextAction=level==="NOT_APPLICABLE" ?
    {command:"toss design status",owner:"DESIGN_SPECIALIST",reason:"Design is not applicable."} :
    {command:"toss design prepare --from <FILE>",owner:"DESIGN_SPECIALIST",reason:"Collect and replay the exact level-specific design graph."};
  const content={
    design_id:designId,
    scope:classification.classification_input.scope,
    classification,
    required_stages:STAGES_BY_LEVEL[level],
    required_artifact_types:TYPES_BY_LEVEL[level],
    state,
    gate,
    artifact_refs:briefReference ? [briefReference] : [],
    payload_commitments:[{
      stage:"BRIEF",
      expected_document_type:"design-brief",
      payload_sha256:sha256Canonical(brief),
      status:briefReference ? "PERSISTED" : "COLLECTED",
      artifact_ref:briefReference,
    }],
    approvals:[],
    next_action:nextAction,
    findings:[],
  };
  return deepFreeze({
    schema_version:"acp.v1",
    document_type:"design-orchestration-state",
    artifact_id:`design-orchestration-state:${designId}`,
    revision:1,
    run_id:featureArtifact.run_id,
    producer:{role:"orchestrator",identity:"toss-feature-design-orchestrator"},
    runtime_identity:featureArtifact.runtime_identity,
    created_at:featureArtifact.created_at,
    provenance:featureArtifact.provenance,
    parents:[],
    inputs:[exactReference(featureArtifact),...(briefReference ? [briefReference] : [])],
    content_sha256:sha256Canonical(content),
    content,
  });
}

export async function startFeatureDesign(store,featureArtifact,{readOnly=false}={}) {
  if (featureArtifact?.document_type!=="feature-delta" ||
      featureArtifact.content?.stage!=="PREPARED") {
    throw new OrchestrationError(
      "FEATURE_DESIGN_NOT_READY","Design starts only from an exact PREPARED feature delta",4,
    );
  }
  const impact=featureArtifact.content.design_impact;
  const classification=classifyDesignLevel({
    schema_version:"design-classification-input.v1",
    scope:{kind:"feature",id:featureArtifact.content.feature_id},
    ...impact,
  });
  const brief=featureDesignBrief(featureArtifact,classification);
  let persistedBrief=null;
  if (classification.effective_level==="NOT_APPLICABLE") {
    const existing=(await store.list({
      document_type:"design-brief",artifact_id:brief.artifact_id,
    })).at(-1);
    if (existing && canonicalJson(existing)!==canonicalJson(brief)) {
      throw new OrchestrationError(
        "STALE_FEATURE_SOURCE","Existing N/A design brief contradicts the exact feature source",6,
      );
    }
    if (!existing && readOnly) {
      throw new OrchestrationError(
        "FEATURE_DESIGN_NOT_READY","Prepared feature is missing its N/A design brief",4,
      );
    }
    persistedBrief=existing ?? await store.append(brief);
  }
  const draft=initialFeatureState(featureArtifact,classification,brief,persistedBrief);
  const existing=(await store.list({
    document_type:"design-orchestration-state",artifact_id:draft.artifact_id,
  })).at(-1);
  if (existing && canonicalJson(existing)!==canonicalJson(draft)) {
    throw new OrchestrationError(
      "STALE_FEATURE_SOURCE","Existing design state contradicts the exact feature source",6,
    );
  }
  if (!existing && readOnly) {
    throw new OrchestrationError(
      "FEATURE_DESIGN_NOT_READY","Prepared feature is missing its design state",4,
    );
  }
  const state=existing ?? await store.append(draft);
  return deepFreeze({
    level:classification.effective_level,
    state:state.content.state,
    state_revision:exactReference(state),
    artifact_revisions:state.content.artifact_refs,
  });
}

function stateResult(artifact,{reused=[],projection=artifact.content}={}) {
  const content=projection;
  const approvedKinds=new Set(content.approvals.map(record => record.approval_kind));
  const approved=[
    ...(approvedKinds.has("CRITICAL_DOWNGRADE") ? ["CRITICAL_DOWNGRADE"] : []),
    ...(approvedKinds.has("VISUAL_DIRECTION") ? ["DIRECTION"] : []),
    ...(approvedKinds.has("DESIGN_SYSTEM") ? ["DESIGN_SYSTEM"] : []),
  ];
  return deepFreeze({
    design_id:content.design_id,
    level:content.classification.effective_level,
    recommended_level:content.classification.recommended_level,
    state:content.state,
    gate:content.gate,
    blocked:new Set([
      "DIRECTION_APPROVAL","DESIGN_SYSTEM_APPROVAL","FINAL_APPROVAL",
    ]).has(content.gate),
    ready_to_persist:content.gate==="NONE" && content.state==="SYSTEM_APPROVED",
    collected:[...new Set(content.payload_commitments.map(row => row.stage))],
    approved,
    persisted:[...new Set(content.payload_commitments.filter(row =>
      row.status==="PERSISTED").map(row => row.stage))],
    artifact_revisions:content.artifact_refs,
    reused_revisions:reused,
    payload_commitments:content.payload_commitments,
    next_action:content.next_action,
    state_artifact:artifact,
  });
}

async function reconciledStatus(store,artifact) {
  const rows=(await store.list({})).filter(row => DESIGN_TYPES.has(row.document_type));
  const commitments=artifact.content.payload_commitments.map(commitment => {
    const matches=rows.filter(row =>
      row.document_type===commitment.expected_document_type &&
      row.provenance?.source_revision===artifact.provenance.source_revision &&
      row.provenance?.source_sha256===artifact.provenance.source_sha256 &&
      sha256Canonical(row)===commitment.payload_sha256);
    if (matches.length>1) {
      throw new OrchestrationError(
        "AMBIGUOUS_DESIGN_HISTORY","One design commitment resolves to multiple revisions",5,
      );
    }
    const match=matches[0];
    if (!match) {
      if (commitment.artifact_ref!==null) {
        throw new OrchestrationError(
          "INPUT_STALE","Persisted design state references a missing exact artifact",6,
        );
      }
      return commitment;
    }
    const reference=exactReference(match);
    if (commitment.artifact_ref!==null &&
        canonicalJson(commitment.artifact_ref)!==canonicalJson(reference)) {
      throw new OrchestrationError(
        "INPUT_STALE","Persisted design state retargets an exact artifact commitment",6,
      );
    }
    return {...commitment,status:"PERSISTED",artifact_ref:reference};
  });
  const artifactRefs=orderedArtifacts(commitments.filter(row => row.artifact_ref!==null)
    .map(row => row.artifact_ref));
  return stateResult(artifact,{
    projection:deepFreeze({
      ...artifact.content,
      artifact_refs:artifactRefs,
      payload_commitments:commitments,
    }),
  });
}

async function stateHistory(store,designId) {
  const artifactId=`design-orchestration-state:${designId}`;
  const rows=await store.list({
    document_type:"design-orchestration-state",artifact_id:artifactId,
  });
  return [...rows].sort((left,right) => left.revision-right.revision);
}

async function latestAnyState(store) {
  const rows=await store.list({document_type:"design-orchestration-state"});
  const identities=[...new Set(rows.map(row => row.artifact_id))];
  if (identities.length===0) {
    throw new OrchestrationError("INPUT_REQUIRED","No verified design state exists",3);
  }
  if (identities.length!==1) {
    throw new OrchestrationError(
      "AMBIGUOUS_DESIGN_HISTORY","Status requires exactly one design identity",5,
    );
  }
  return [...rows].sort((left,right) => left.revision-right.revision).at(-1);
}

async function persistedCandidates(store,graph) {
  const rows=await store.list({});
  const byIdentity=new Map(rows.filter(row => DESIGN_TYPES.has(row.document_type)).map(row => [
    `${row.document_type}\u0000${row.artifact_id}\u0000${row.revision}`,row,
  ]));
  const persisted=[];
  for (const candidate of graph) {
    const identity=`${candidate.document_type}\u0000${candidate.artifact_id}\u0000${candidate.revision}`;
    const existing=byIdentity.get(identity);
    if (!existing) continue;
    if (canonicalJson(existing)!==canonicalJson(candidate)) {
      throw new OrchestrationError(
        "INPUT_STALE","Persisted design revision conflicts with the replayed payload",6,
      );
    }
    persisted.push(existing);
  }
  return orderedArtifacts(persisted);
}

function topologicalArtifacts(graph,{includeFinal}) {
  const included=graph.filter(row => includeFinal || row.document_type!=="design-approval");
  const byReference=new Map(included.map(row => [canonicalJson(exactReference(row)),row]));
  const remaining=new Map(included.map(row => [canonicalJson(exactReference(row)),row]));
  const ordered=[];
  while (remaining.size>0) {
    const ready=[...remaining].filter(([,artifact]) => [...artifact.parents,...artifact.inputs]
      .every(reference => !byReference.has(canonicalJson(reference)) ||
        !remaining.has(canonicalJson(reference))))
      .sort((left,right) => left[1].document_type.localeCompare(right[1].document_type));
    if (ready.length===0) {
      throw new OrchestrationError(
        "DESIGN_GRAPH_INVALID","Design graph dependencies contain a persistence cycle",5,
      );
    }
    for (const [key,artifact] of ready) {
      remaining.delete(key);
      ordered.push(artifact);
    }
  }
  return ordered;
}

async function appendState(store,input,outcome,previous) {
  const content=outcome.next_state_content;
  const contentSha256=sha256Canonical(content);
  if (previous?.content_sha256===contentSha256) return previous;
  const artifact={
    schema_version:"acp.v1",
    document_type:"design-orchestration-state",
    artifact_id:`design-orchestration-state:${input.design_id}`,
    revision:(previous?.revision ?? 0)+1,
    run_id:input.run_id,
    producer:{role:"orchestrator",identity:"toss-design-orchestrator"},
    runtime_identity:input.runtime_identity,
    created_at:input.created_at,
    provenance:input.provenance,
    parents:previous ? [exactReference(previous)] : [],
    inputs:outcome.artifact_revisions,
    content_sha256:contentSha256,
    content,
  };
  return store.append(deepFreeze(artifact));
}

function preparedOutcome(orchestrator,input,persisted,targetCommand) {
  return orchestrator.prepareDesign({
    classification_input:input.classification_input,
    design_artifacts:input.artifacts,
    persisted_artifacts:persisted,
    approval_records:input.approval_records,
    target_command:targetCommand,
  });
}

async function acquireDesignInput(command,services) {
  if (command.options.from!==null || command.interactive) {
    return acquireInput(command,services,{
      kind:"design",normalize:normalizeDesignInput,missingCode:"INPUT_REQUIRED",
    });
  }
  throw new OrchestrationError(
    "INPUT_REQUIRED","The exact committed design payload must be replayed with --from",3,
  );
}

async function runWithInput(command,services,store,input) {
  const history=await stateHistory(store,input.design_id);
  let previous=history.at(-1) ?? null;
  if (command.name==="design.approve") {
    const pending=previous?.content.gate;
    const approvalKinds=new Set(input.approval_records.map(row => row.approval_kind));
    const legal=(pending==="DIRECTION_APPROVAL" && approvalKinds.has("VISUAL_DIRECTION")) ||
      (pending==="DESIGN_SYSTEM_APPROVAL" && approvalKinds.has("DESIGN_SYSTEM")) ||
      pending==="FINAL_APPROVAL" || pending==="COMPLETE";
    if (!legal) {
      throw new OrchestrationError(
        "ILLEGAL_DESIGN_TRANSITION","Design approval requires one persisted pending gate",6,
      );
    }
  }
  if (previous) assertExactReplay(input,previous);
  let persisted=await persistedCandidates(store,input.artifacts);
  const reused=persisted.map(exactReference);
  const orchestrator=createDesignOrchestrator({
    authorityRegistry:services.authorityRegistry ?? {actors:[]},
  });
  let outcome=preparedOutcome(orchestrator,input,persisted,command.name);

  if (!previous && outcome.level!=="NOT_APPLICABLE") {
    previous=await appendState(store,input,outcome,null);
  } else if (previous && (outcome.state!==previous.content.state ||
      canonicalJson(outcome.next_state_content)!==canonicalJson(previous.content))) {
    previous=await appendState(store,input,outcome,previous);
  }

  const shouldPersistNonFinal=outcome.ready_to_persist && command.name!=="design.approve";
  const shouldPersistFinal=outcome.state==="FINAL_APPROVAL_PENDING" &&
    command.name==="design.approve";
  if (outcome.level==="NOT_APPLICABLE" || shouldPersistNonFinal || shouldPersistFinal) {
    const already=new Set(persisted.map(row => canonicalJson(exactReference(row))));
    const ordered=topologicalArtifacts(input.artifacts,{
      includeFinal:outcome.level==="NOT_APPLICABLE" || shouldPersistFinal,
    });
    for (const artifact of ordered) {
      const key=canonicalJson(exactReference(artifact));
      if (already.has(key)) continue;
      const appended=await store.append(artifact);
      persisted=orderedArtifacts([...persisted,appended]);
      already.add(key);
      outcome=preparedOutcome(orchestrator,input,persisted,command.name);
    }
  }

  outcome=preparedOutcome(orchestrator,input,persisted,command.name);
  previous=await appendState(store,input,outcome,previous);
  return stateResult(previous,{reused});
}

export async function runDesignCommand(command,serviceInput) {
  const normalized=canonicalCopy(command,"design command");
  if (!DESIGN_COMMANDS.has(normalized.name)) {
    throw new TypeError(`Unsupported design command ${String(normalized.name)}`);
  }
  const rawServices=commandServices(serviceInput);
  const store=createVerifiedArtifactCatalog(rawServices.store);
  await store.refresh();
  if (normalized.name==="design.status") {
    const status=await reconciledStatus(store,await latestAnyState(store));
    await store.refresh();
    return status;
  }
  const input=await acquireDesignInput(normalized,rawServices);
  const result=await runWithInput(normalized,rawServices,store,input);
  await store.refresh();
  return result;
}
