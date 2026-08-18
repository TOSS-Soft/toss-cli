import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {
  appendVerified,
  canonicalCopy,
  deepFreeze,
  exactReference,
  listedArtifacts,
  OrchestrationError,
  verifiedExact,
} from "./project-input.js";

const INPUT_KEYS=new Set([
  "schema_version","project_id","feature_id","created_at","run_id",
  "runtime_identity","provenance","request","impact_analysis",
  "requirement_delta","architecture_impact","issue_plan_delta","findings",
]);
const SHAPES=Object.freeze({
  request:new Set(["summary","source_locations"]),
  impact_analysis:new Set(["summary","affected_entities"]),
  requirement_delta:new Set(["added","changed"]),
  architecture_impact:new Set(["summary","affected_adrs","requires_adr"]),
  issue_plan_delta:new Set(["summary","issue_ids"]),
  finding:new Set(["id","severity","owner","message"]),
  added_requirement:new Set(["id","meaning"]),
  changed_requirement:new Set(["id","base_id","meaning","reason"]),
  reference:new Set(["kind","id"]),
  provenance:new Set(["source_revision","source_sha256","locations"]),
  runtime_identity:new Set(["kind","name","version"]),
});
const BLOCKING=new Set(["P0","P1","P2"]);
const ADR_REQUIRED_FINDING=Object.freeze({
  id:"FEATURE-ADR-REQUIRED",
  severity:"P2",
  owner:"ARCHITECT",
  message:"The feature declares a new ADR requirement, but no exact approved ADR evidence is authorized.",
});

function exactRecord(value,label,keys) {
  const copied=canonicalCopy(value,label);
  if (!copied || typeof copied!=="object" || Array.isArray(copied)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual=Object.keys(copied).sort();
  const expected=[...keys].sort();
  if (canonicalJson(actual)!==canonicalJson(expected)) {
    throw new TypeError(`${label} must contain exactly ${expected.join(", ")}`);
  }
  return copied;
}

function text(value,label) {
  if (typeof value!=="string" || value.trim().length===0) {
    throw new TypeError(`${label} must be a non-blank string`);
  }
}

function stringArray(value,label,{allowEmpty=true}={}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length===0) ||
      value.some(item => typeof item!=="string" || item.length===0) ||
      new Set(value).size!==value.length) {
    throw new TypeError(`${label} must be a unique ${allowEmpty ? "" : "non-empty "}string array`);
  }
}

export function normalizeFeatureInput(value) {
  const input=exactRecord(value,"feature input",INPUT_KEYS);
  if (input.schema_version!=="feature-command-input.v1") {
    throw new TypeError("feature input schema_version must be feature-command-input.v1");
  }
  for (const key of ["project_id","feature_id","created_at","run_id"]) {
    text(input[key],`feature input ${key}`);
  }
  exactRecord(input.runtime_identity,"feature runtime_identity",SHAPES.runtime_identity);
  const provenance=exactRecord(input.provenance,"feature provenance",SHAPES.provenance);
  text(provenance.source_revision,"feature provenance source_revision");
  if (typeof provenance.source_sha256!=="string" || !/^[a-f0-9]{64}$/.test(
    provenance.source_sha256,
  )) throw new TypeError("feature provenance source_sha256 must be a SHA-256 hash");
  stringArray(provenance.locations,"feature provenance locations",{allowEmpty:false});

  const request=exactRecord(input.request,"feature request",SHAPES.request);
  text(request.summary,"feature request summary");
  stringArray(request.source_locations,"feature request source_locations",{allowEmpty:false});
  const impact=exactRecord(input.impact_analysis,"feature impact_analysis",SHAPES.impact_analysis);
  text(impact.summary,"feature impact summary");
  if (!Array.isArray(impact.affected_entities)) {
    throw new TypeError("feature affected_entities must be an array");
  }
  for (const ref of impact.affected_entities) {
    const normalized=exactRecord(ref,"feature affected entity",SHAPES.reference);
    text(normalized.kind,"feature affected entity kind");
    text(normalized.id,"feature affected entity id");
  }
  const requirements=exactRecord(
    input.requirement_delta,"feature requirement_delta",SHAPES.requirement_delta,
  );
  if (!Array.isArray(requirements.added) || !Array.isArray(requirements.changed)) {
    throw new TypeError("feature requirement delta arrays are required");
  }
  for (const added of requirements.added) {
    const normalized=exactRecord(added,"added feature requirement",SHAPES.added_requirement);
    text(normalized.id,"added feature requirement id");
    text(normalized.meaning,"added feature requirement meaning");
  }
  for (const changed of requirements.changed) {
    const normalized=exactRecord(
      changed,"changed feature requirement",SHAPES.changed_requirement,
    );
    for (const key of SHAPES.changed_requirement) {
      text(normalized[key],`changed feature requirement ${key}`);
    }
  }
  const architecture=exactRecord(
    input.architecture_impact,"feature architecture_impact",SHAPES.architecture_impact,
  );
  text(architecture.summary,"feature architecture impact summary");
  stringArray(architecture.affected_adrs,"feature affected_adrs");
  if (typeof architecture.requires_adr!=="boolean") {
    throw new TypeError("feature requires_adr must be boolean");
  }
  const plan=exactRecord(input.issue_plan_delta,"feature issue_plan_delta",SHAPES.issue_plan_delta);
  text(plan.summary,"feature issue plan delta summary");
  stringArray(plan.issue_ids,"feature issue_ids");
  if (!Array.isArray(input.findings)) throw new TypeError("feature findings must be an array");
  for (const finding of input.findings) {
    const normalized=exactRecord(finding,"feature finding",SHAPES.finding);
    text(normalized.id,"feature finding id");
    if (normalized.id===ADR_REQUIRED_FINDING.id) {
      throw new TypeError(`${ADR_REQUIRED_FINDING.id} is reserved for derived ADR readiness`);
    }
    text(normalized.message,"feature finding message");
    if (!new Set(["P0","P1","P2","P3","P4"]).has(normalized.severity) ||
        !new Set(["PM","ARCHITECT","PM_FINALIZATION","USER"]).has(normalized.owner)) {
      throw new TypeError("feature finding severity or owner is invalid");
    }
  }
  return deepFreeze(input);
}

export function featureInputFromDelta(artifact) {
  const validation=validateDocument(artifact,"feature-delta.v1");
  if (!validation.valid) throw new OrchestrationError(
    "ORCHESTRATION_VALIDATION_FAILED","Persisted feature delta is invalid",5,
  );
  const content=artifact.content;
  return normalizeFeatureInput({
    schema_version:"feature-command-input.v1",
    project_id:content.project_id,
    feature_id:content.feature_id,
    created_at:artifact.created_at,
    run_id:artifact.run_id,
    runtime_identity:artifact.runtime_identity,
    provenance:artifact.provenance,
    request:content.request,
    impact_analysis:content.impact_analysis,
    requirement_delta:content.requirement_delta,
    architecture_impact:content.architecture_impact,
    issue_plan_delta:content.issue_plan_delta,
    findings:content.findings,
  });
}

function sourceProjection(input) {
  return {
    project_id:input.project_id,
    feature_id:input.feature_id,
    provenance:input.provenance,
    request:input.request,
    impact_analysis:input.impact_analysis,
    requirement_delta:input.requirement_delta,
    architecture_impact:input.architecture_impact,
    issue_plan_delta:input.issue_plan_delta,
    findings:input.findings,
  };
}

export function featureSourceProjection(value) {
  return deepFreeze(canonicalCopy(sourceProjection(value),"feature source projection"));
}

function effectiveFindings(input) {
  const supplied=input.findings.filter(finding => finding.id!==ADR_REQUIRED_FINDING.id);
  return input.architecture_impact.requires_adr ?
    [...supplied,ADR_REQUIRED_FINDING] : [...supplied];
}

function deltaContent(input,stage,base) {
  const evaluated=effectiveFindings(input);
  const failures=evaluated.filter(finding => BLOCKING.has(finding.severity));
  const warnings=evaluated.filter(finding => !BLOCKING.has(finding.severity));
  const ready=failures.length===0;
  const status=failures.length>0 ? "FAIL" : warnings.length>0 ? "WARN" : "PASS";
  const next=stage==="ADDED" ? "feature analyze" :
    stage==="ANALYZED" ? "feature prepare" : ready ? "issues preview" : "feature prepare";
  return {
    kind:"feature-delta",
    stage,
    project_id:input.project_id,
    feature_id:input.feature_id,
    source_revision:input.provenance.source_revision,
    source_sha256:input.provenance.source_sha256,
    request:input.request,
    impact_analysis:input.impact_analysis,
    requirement_delta:input.requirement_delta,
    architecture_impact:input.architecture_impact,
    issue_plan_delta:input.issue_plan_delta,
    findings:input.findings,
    audit:{status,findings:evaluated},
    readiness:{ready,failures,warnings},
    base_project:base,
    next_command:next,
  };
}

export async function appendFeatureStage(store,input,stage,base,previous) {
  const content=deltaContent(input,stage,base);
  const stateReferences=base.artifacts.filter(
    reference => reference.document_type==="transition-event",
  );
  if (stateReferences.length!==1) {
    throw new OrchestrationError(
      "AMBIGUOUS_FEATURE_BASE","Feature base requires one exact READY transition",5,
    );
  }
  const draft={
    schema_version:"acp.v1",
    document_type:"feature-delta",
    artifact_id:`feature-delta:${input.project_id}:${input.feature_id}`,
    revision:(previous?.revision ?? 0)+1,
    run_id:input.run_id,
    producer:{role:"orchestrator",identity:"toss-feature-orchestrator"},
    runtime_identity:input.runtime_identity,
    created_at:input.created_at,
    provenance:input.provenance,
    parents:previous ? [exactReference(previous)] : [],
    inputs:stateReferences,
    content_sha256:sha256Canonical(content),
    content,
  };
  return appendVerified(store,draft,"feature-delta.v1");
}

export async function featureHistory(store,projectId,featureId) {
  const artifactId=`feature-delta:${projectId}:${featureId}`;
  const rows=await listedArtifacts(store,{document_type:"feature-delta",artifact_id:artifactId});
  rows.sort((left,right) => left.revision-right.revision);
  const stages=["ADDED","ANALYZED","PREPARED"];
  for (const [index,row] of rows.entries()) {
    const rank=stages.indexOf(row.content.stage);
    const previousRank=index===0 ? -1 : stages.indexOf(rows[index-1].content.stage);
    if (row.revision!==index+1 || rank<0 || rank<=previousRank) {
      throw new OrchestrationError(
        "AMBIGUOUS_FEATURE_HISTORY","Feature delta history is not one monotonic stage chain",5,
      );
    }
    if (index>0 && canonicalJson(row.content.base_project)!==
        canonicalJson(rows[0].content.base_project)) {
      throw new OrchestrationError(
        "AMBIGUOUS_FEATURE_HISTORY","Feature delta base snapshot changed within a stage chain",5,
      );
    }
    if (row.content.source_revision!==row.provenance.source_revision ||
        row.content.source_sha256!==row.provenance.source_sha256) {
      throw new OrchestrationError(
        "AMBIGUOUS_FEATURE_HISTORY","Feature content contradicts its source provenance",5,
      );
    }
    const reconstructedInput=featureInputFromDelta(row);
    if (index>0 && canonicalJson(featureSourceProjection(reconstructedInput))!==
        canonicalJson(featureSourceProjection(featureInputFromDelta(rows[0])))) {
      throw new OrchestrationError(
        "AMBIGUOUS_FEATURE_HISTORY","Feature source content changed within one identity",5,
      );
    }
    if (canonicalJson(deltaContent(
      reconstructedInput,row.content.stage,row.content.base_project,
    ))!==canonicalJson(row.content)) {
      throw new OrchestrationError(
        "AMBIGUOUS_FEATURE_HISTORY","Feature stage-derived content is not deterministic",5,
      );
    }
  }
  return rows;
}

export async function latestAnyFeature(store) {
  const rows=await listedArtifacts(store,{document_type:"feature-delta"});
  const identities=[...new Set(rows.map(row => row.artifact_id))];
  if (identities.length===0) {
    throw new OrchestrationError("FEATURE_INPUT_REQUIRED","No persisted feature input exists",3);
  }
  if (identities.length!==1) {
    throw new OrchestrationError(
      "AMBIGUOUS_FEATURE_HISTORY","The artifact store contains multiple feature identities",5,
    );
  }
  return rows
    .filter(row => row.artifact_id===identities[0])
    .sort((left,right) => left.revision-right.revision)
    .at(-1);
}

export async function verifyExactBaseReferences(store,base) {
  const verified=[];
  for (const reference of base.artifacts) verified.push(await verifiedExact(store,reference));
  return verified;
}

export async function verifyBaseSnapshot(store,base) {
  const rows=await listedArtifacts(store,{});
  const latestByIdentity=new Map();
  const seen=new Set();
  for (const row of rows) {
    const reference=exactReference(row);
    const exactKey=canonicalJson({
      document_type:reference.document_type,
      artifact_id:reference.artifact_id,
      revision:reference.revision,
    });
    if (seen.has(exactKey)) {
      throw new OrchestrationError(
        "DUPLICATE_REVISION_IDENTITY",
        "Artifact store list returned conflicting rows for one revision identity",5,
      );
    }
    seen.add(exactKey);
    const identity=`${row.document_type}\u0000${row.artifact_id}`;
    const previous=latestByIdentity.get(identity);
    if (!previous || row.revision>previous.revision) latestByIdentity.set(identity,row);
  }
  const verified=[];
  for (const reference of base.artifacts) {
    const artifact=await verifiedExact(store,reference);
    const latest=latestByIdentity.get(`${artifact.document_type}\u0000${artifact.artifact_id}`);
    if (!latest || canonicalJson(exactReference(latest))!==canonicalJson(reference)) {
      throw new OrchestrationError(
        "STALE_FEATURE_BASE","The exact base project snapshot has a newer artifact revision",6,
      );
    }
    verified.push(artifact);
  }
  return verified;
}
