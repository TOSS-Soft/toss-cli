import {canonicalJson, sha256Canonical} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {validatePmAnalysis} from "./pm-analysis.js";

const PM_ENTITY_SECTIONS=Object.freeze([
  "functional_requirements",
  "non_functional_requirements",
  "business_rules",
  "constraints",
]);

const PM_REQUIREMENT_SECTIONS=Object.freeze([
  "functional_requirements",
  "non_functional_requirements",
  "constraints",
]);

const BUILD_DECISION_FIELDS=new Set([
  "summary",
  "components",
  "constraints",
  "architecture_questions",
  "unresolved_findings",
]);

const BLOCKING_SEVERITIES=new Set(["P0","P1","P2"]);

export const ADR_STATUS_APPROVAL_MATRIX=Object.freeze({
  proposed:Object.freeze(["pending"]),
  accepted:Object.freeze(["approved"]),
  blocked:Object.freeze(["pending"]),
  superseded:Object.freeze(["approved"]),
  rejected:Object.freeze(["rejected"]),
});

function isPlainObject(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function canonicalCopy(value) {
  return JSON.parse(canonicalJson(value));
}

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function escapePointerSegment(value) {
  return String(value).replaceAll("~","~0").replaceAll("/","~1");
}

function freezeFinding({
  type,
  path,
  message,
  owner="Architect",
  severity="P2",
  affected_entities=[],
}) {
  return Object.freeze({
    type,
    path,
    message,
    owner,
    severity,
    affected_entities:Object.freeze([...affected_entities]),
  });
}

function validationFinding(error) {
  const missing=error.keyword==="required" ? error.params?.missingProperty : undefined;
  const path=missing===undefined ? error.instancePath :
    `${error.instancePath}/${escapePointerSegment(missing)}`;
  return freezeFinding({
    type:"SCHEMA_VALIDATION",
    path:path || "/",
    message:error.message ?? "Architecture contract shape is invalid",
  });
}

function canonicalFinding(error) {
  return freezeFinding({
    type:"CANONICAL_JSON",
    path:"/",
    message:error instanceof Error ? error.message : "Value is not canonical JSON",
  });
}

function artifactReference(artifact) {
  return {
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
    document_type:artifact.document_type,
  };
}

function sameArtifactReference(reference,artifact) {
  return isPlainObject(reference) &&
    reference.artifact_id===artifact.artifact_id &&
    reference.revision===artifact.revision &&
    reference.content_sha256===artifact.content_sha256 &&
    reference.document_type===artifact.document_type;
}

function sameArtifactIdentity(reference,artifact) {
  return isPlainObject(reference) &&
    reference.artifact_id===artifact.artifact_id &&
    reference.revision===artifact.revision &&
    reference.document_type===artifact.document_type;
}

function referenceIdentity(reference) {
  return [
    reference.document_type,
    reference.artifact_id,
    reference.revision,
    reference.content_sha256,
  ].join("\u0000");
}

function artifactIdentity(artifact) {
  return referenceIdentity(artifactReference(artifact));
}

function contentIntegrityFindings(artifact) {
  if (!isPlainObject(artifact) || !Object.hasOwn(artifact,"content")) return [];
  let hash;
  try {
    hash=sha256Canonical(artifact.content);
  } catch (error) {
    return [canonicalFinding(error)];
  }
  if (artifact.content_sha256===hash) return [];
  return [freezeFinding({
    type:"CONTENT_SHA256_MISMATCH",
    path:"/content_sha256",
    message:"content_sha256 must equal the SHA-256 digest of canonical content",
  })];
}

function schemaAndIntegrityFindings(artifact,schemaId) {
  const shape=validateDocument(artifact,schemaId);
  if (!shape.valid) return shape.errors.map(validationFinding);
  return contentIntegrityFindings(artifact);
}

function ownedPmEntities(pmAnalysis) {
  return PM_ENTITY_SECTIONS.flatMap(section =>
    Array.isArray(pmAnalysis.content?.[section]) ? pmAnalysis.content[section] : [],
  );
}

function pmRequirementIds(pmAnalysis) {
  return new Set(PM_REQUIREMENT_SECTIONS.flatMap(section =>
    Array.isArray(pmAnalysis.content?.[section]) ?
      pmAnalysis.content[section].map(entity => entity.id) : [],
  ));
}

function pmArchitectureQuestionIds(pmAnalysis) {
  return new Set(Array.isArray(pmAnalysis.content?.architecture_questions) ?
    pmAnalysis.content.architecture_questions.map(question => question.id) : []);
}

function snapshotFor(entity) {
  const snapshot=canonicalCopy(entity);
  return {
    id:snapshot.id,
    kind:snapshot.kind,
    canonical_sha256:sha256Canonical(snapshot),
    snapshot,
  };
}

function roleBoundaryError(detail) {
  return new Error(
    "Architect may not create, change, or delete PM-owned requirements or " +
    `business rules: ${detail}`,
  );
}

function assertExactPmSnapshots(pmAnalysis,architecture) {
  const expected=new Map(ownedPmEntities(pmAnalysis).map(entity => [
    entity.id,
    {entity,canonical:canonicalJson(entity),hash:sha256Canonical(entity)},
  ]));
  const snapshots=architecture.content.pm_entity_snapshots;
  const actual=new Map();

  for (const snapshot of snapshots) {
    if (actual.has(snapshot.id)) {
      throw roleBoundaryError(`duplicate snapshot for ${snapshot.id}`);
    }
    if (snapshot.snapshot.id!==snapshot.id || snapshot.snapshot.kind!==snapshot.kind) {
      throw roleBoundaryError(`snapshot identity does not match its copied PM entity ${snapshot.id}`);
    }
    const actualHash=sha256Canonical(snapshot.snapshot);
    if (snapshot.canonical_sha256!==actualHash) {
      throw roleBoundaryError(`snapshot hash does not match copied PM entity ${snapshot.id}`);
    }
    if (!expected.has(snapshot.id)) {
      throw roleBoundaryError(`attempted creation of PM-owned requirement or business rule ${snapshot.id}`);
    }
    const source=expected.get(snapshot.id);
    if (source.hash!==snapshot.canonical_sha256 ||
        source.canonical!==canonicalJson(snapshot.snapshot)) {
      throw roleBoundaryError(`attempted mutation of PM-owned requirement or business rule ${snapshot.id}`);
    }
    actual.set(snapshot.id,snapshot);
  }

  for (const id of expected.keys()) {
    if (!actual.has(id)) {
      throw roleBoundaryError(`attempted deletion of PM-owned requirement or business rule ${id}`);
    }
  }
}

function exactInputSetFindings(artifact,expectedInputs) {
  if (!Array.isArray(artifact.inputs)) return [];
  const findings=[];
  const seen=new Set();
  for (const reference of artifact.inputs) {
    const identity=referenceIdentity(reference);
    if (seen.has(identity)) {
      findings.push(freezeFinding({
        type:"DUPLICATE_ARTIFACT_INPUT",
        path:"/inputs",
        message:"Artifact inputs must not repeat an exact reference",
      }));
    }
    seen.add(identity);
    if (sameArtifactIdentity(reference,artifact)) {
      findings.push(freezeFinding({
        type:"SELF_ARTIFACT_INPUT",
        path:"/inputs",
        message:"An artifact must not consume itself as an input",
      }));
      findings.push(freezeFinding({
        type:"CYCLIC_ARTIFACT_INPUT",
        path:"/inputs",
        message:"An artifact input cycle is forbidden",
      }));
    }
    if (!expectedInputs.some(expected => sameArtifactReference(reference,expected.artifact))) {
      findings.push(freezeFinding({
        type:"EXTRA_ARTIFACT_INPUT",
        path:"/inputs",
        message:"Artifact inputs must contain only the contractually required inputs",
      }));
    }
  }
  for (const expected of expectedInputs) {
    if (artifact.inputs.some(reference => sameArtifactReference(reference,expected.artifact))) {
      continue;
    }
    const sameIdentity=artifact.inputs.some(reference => isPlainObject(reference) &&
      reference.artifact_id===expected.artifact.artifact_id &&
      reference.revision===expected.artifact.revision);
    findings.push(freezeFinding({
      type:sameIdentity ?
        `MISMATCHED_${expected.label}_INPUT` : `MISSING_${expected.label}_INPUT`,
      path:"/inputs",
      message:sameIdentity ?
        `${expected.label} input must have the exact identity, revision, hash, and document type` :
        `${expected.label} input is required`,
    }));
  }
  return findings;
}

function artifactCycleFindings(artifacts) {
  const documents=new Map(artifacts.map(artifact => [artifactIdentity(artifact),artifact]));
  const visiting=new Set();
  const visited=new Set();
  const findings=[];

  function visit(artifact) {
    const identity=artifactIdentity(artifact);
    if (visiting.has(identity)) {
      findings.push(freezeFinding({
        type:"CYCLIC_ARTIFACT_INPUT",
        path:"/inputs",
        message:"Artifact input cycle is forbidden",
      }));
      return;
    }
    if (visited.has(identity)) return;
    visiting.add(identity);
    for (const reference of artifact.inputs ?? []) {
      const target=documents.get(referenceIdentity(reference));
      if (target) visit(target);
    }
    visiting.delete(identity);
    visited.add(identity);
  }

  for (const artifact of artifacts) visit(artifact);
  return findings;
}

function architectureLinkFindings(pmAnalysis,architecture) {
  const findings=[];
  const requirementIds=pmRequirementIds(pmAnalysis);
  const questionIds=pmArchitectureQuestionIds(pmAnalysis);
  const resolvedIds=new Set();

  for (const [index,component] of architecture.content.components.entries()) {
    for (const [requirementIndex,id] of component.affected_requirements.entries()) {
      if (!requirementIds.has(id)) {
        findings.push(freezeFinding({
          type:"DANGLING_ARCHITECTURE_REQUIREMENT",
          path:`/content/components/${index}/affected_requirements/${requirementIndex}`,
          message:`Architecture component references missing PM requirement ${id}`,
          affected_entities:[id],
        }));
      }
    }
  }
  for (const [index,constraint] of architecture.content.constraints.entries()) {
    for (const [requirementIndex,id] of constraint.affected_requirements.entries()) {
      if (!requirementIds.has(id)) {
        findings.push(freezeFinding({
          type:"DANGLING_ARCHITECTURE_REQUIREMENT",
          path:`/content/constraints/${index}/affected_requirements/${requirementIndex}`,
          message:`Architecture constraint references missing PM requirement ${id}`,
          affected_entities:[id],
        }));
      }
    }
  }
  for (const [index,question] of architecture.content.architecture_questions.entries()) {
    if (resolvedIds.has(question.id)) {
      findings.push(freezeFinding({
        type:"DUPLICATE_ARCHITECTURE_QUESTION",
        path:`/content/architecture_questions/${index}/id`,
        message:`Architecture question ${question.id} is resolved more than once`,
        affected_entities:[question.id],
      }));
    }
    resolvedIds.add(question.id);
    if (!questionIds.has(question.id)) {
      findings.push(freezeFinding({
        type:"DANGLING_ARCHITECTURE_QUESTION",
        path:`/content/architecture_questions/${index}/id`,
        message:`Architecture references unknown PM architecture question ${question.id}`,
        affected_entities:[question.id],
      }));
    }
  }
  return findings;
}

function architectureEntityIdentityFindings(architecture) {
  const findings=[];
  const seen=new Map();
  const collections=[
    ["components",architecture.content.components],
    ["constraints",architecture.content.constraints],
    ["unresolved_findings",architecture.content.unresolved_findings],
  ];
  for (const [collection,entities] of collections) {
    for (const [index,entity] of entities.entries()) {
      if (seen.has(entity.id)) {
        findings.push(freezeFinding({
          type:"DUPLICATE_ARCHITECTURE_ENTITY_ID",
          path:`/content/${collection}/${index}/id`,
          message:`Architecture entity identity ${entity.id} is duplicated`,
          affected_entities:[entity.id],
        }));
      } else {
        seen.set(entity.id,`/content/${collection}/${index}/id`);
      }
    }
  }
  return findings;
}

function pmQuestionFindings(pmAnalysis,resolvedQuestionIds=new Set()) {
  const findings=[];
  const questions=pmAnalysis.content.open_questions ?? [];
  for (const [index,question] of questions.entries()) {
    if (!BLOCKING_SEVERITIES.has(question.severity)) continue;
    if (resolvedQuestionIds.has(question.id)) continue;
    findings.push(freezeFinding({
      type:"UNRESOLVED_PM_BUSINESS_INFORMATION",
      path:`/content/open_questions/${index}`,
      message:question.question,
      owner:question.owner,
      severity:question.severity,
      affected_entities:question.affected_entities,
    }));
  }
  return findings;
}

function decisionEvidence(pmAnalysis,decisionPackage) {
  if (decisionPackage===undefined) return {findings:[],resolved:new Set()};
  const validation=validateDocument(decisionPackage,"decision-package.v1");
  if (!validation.valid) return {findings:[freezeFinding({
    type:"DECISION_PACKAGE_INVALID",
    path:"/decisionPackage",
    message:`Decision package is invalid: ${validation.errors[0]?.message ?? "schema failure"}`,
  })],resolved:new Set()};
  const pmById=new Map(pmAnalysis.content.open_questions.map(question => [question.id,question]));
  const retained=[
    "meaning","question","severity","owner","options","recommendation","rationale",
    "affected_entities","provenance",
  ];
  const evidence=decisionPackage.questions.flatMap(question => question.evidence);
  const exact=evidence.length===pmById.size && new Set(evidence.map(row => row.source_id)).size===
    evidence.length && evidence.every(row => {
    const pm=pmById.get(row.source_id);
    return pm && retained.every(field => canonicalJson(row[field])===canonicalJson(pm[field]));
  });
  if (!exact || decisionPackage.gate.can_continue!==true ||
      decisionPackage.gate.status!=="CLEAR") {
    return {findings:[freezeFinding({
      type:"DECISION_PACKAGE_STALE",
      path:"/decisionPackage",
      message:"Decision package must exactly resolve the current PM question set",
    })],resolved:new Set()};
  }
  const resolved=new Set(decisionPackage.questions.filter(question =>
    question.status==="resolved").flatMap(question => question.source_ids));
  return {findings:[],resolved};
}

function unresolvedFindingGates(architecture) {
  const findings=[];
  for (const [index,finding] of architecture.content.unresolved_findings.entries()) {
    if (!BLOCKING_SEVERITIES.has(finding.severity)) continue;
    findings.push(freezeFinding({
      type:"UNRESOLVED_PM_BUSINESS_INFORMATION",
      path:`/content/unresolved_findings/${index}`,
      message:finding.message,
      owner:"PM",
      severity:finding.severity,
      affected_entities:finding.affected_entities,
    }));
  }
  return findings;
}

function architectureReadinessFindings(pmAnalysis,architecture,adrs,approvedAdrReferences=new Set()) {
  const findings=[];
  const pmQuestionIds=pmArchitectureQuestionIds(pmAnalysis);
  const resolutions=new Map(architecture.content.architecture_questions.map(question => [
    question.id,
    question,
  ]));
  const adrQuestionIds=new Set();

  for (const id of pmQuestionIds) {
    const resolution=resolutions.get(id);
    if (!resolution || resolution.status!=="resolved") {
      findings.push(freezeFinding({
        type:"ARCHITECTURE_QUESTION_PENDING",
        path:"/content/architecture_questions",
        message:`Architecture question ${id} is not resolved`,
        affected_entities:[id],
      }));
    }
  }

  if (adrs.length===0) {
    findings.push(freezeFinding({
      type:"ADR_REQUIRED",
      path:"/adrs",
      message:"At least one complete ADR is required before PM finalization",
    }));
    return findings;
  }

  for (const adr of adrs) {
    const content=adr.content;
    const externallyApproved=approvedAdrReferences.has(artifactIdentity(adr));
    for (const id of content.resolved_architecture_questions) adrQuestionIds.add(id);
    if (content.status==="blocked") {
      findings.push(freezeFinding({
        type:"ADR_BLOCKED",
        path:"/content/status",
        message:`ADR ${content.id} is blocked`,
        affected_entities:[content.id],
      }));
    } else if (content.status!=="accepted" && !externallyApproved) {
      findings.push(freezeFinding({
        type:"ADR_PENDING",
        path:"/content/status",
        message:`ADR ${content.id} is not accepted`,
        affected_entities:[content.id],
      }));
    }
    if (content.approval.state!=="approved" && !externallyApproved) {
      findings.push(freezeFinding({
        type:"ADR_UNAPPROVED",
        path:"/content/approval/state",
        message:`ADR ${content.id} is not approved`,
        affected_entities:[content.id],
      }));
    }
  }

  for (const [id,resolution] of resolutions.entries()) {
    if (resolution.status==="resolved" && !adrQuestionIds.has(id)) {
      findings.push(freezeFinding({
        type:"ARCHITECTURE_QUESTION_WITHOUT_ADR",
        path:"/content/architecture_questions",
        message:`Resolved architecture question ${id} is not linked by an ADR`,
        affected_entities:[id],
      }));
    }
  }
  return findings;
}

function approvalEvidence(approvals,adrs) {
  if (!Array.isArray(approvals)) {
    return {findings:[freezeFinding({
      type:"ADR_APPROVALS_NOT_ARRAY",
      path:"/approvals",
      message:"ADR approvals must be an array",
    })],approved:new Set()};
  }
  const current=new Map(adrs.map(adr => [artifactIdentity(adr),adr]));
  const approved=new Set();
  const findings=[];
  for (const [index,approval] of approvals.entries()) {
    const rowFindings=schemaAndIntegrityFindings(approval,"adr-approval.v1");
    findings.push(...rowFindings);
    if (rowFindings.length>0) continue;
    const key=referenceIdentity(approval.content.adr);
    const adr=current.get(key);
    if (!adr) {
      findings.push(freezeFinding({
        type:"STALE_ADR_APPROVAL",
        path:`/approvals/${index}/content/adr`,
        message:"ADR approval must bind one exact current ADR revision",
      }));
      continue;
    }
    if (approved.has(key)) {
      findings.push(freezeFinding({
        type:"DUPLICATE_ADR_APPROVAL",
        path:`/approvals/${index}`,
        message:"Each current ADR revision may have exactly one approval",
      }));
      continue;
    }
    if (approval.provenance?.source_revision!==adr.provenance.source_revision ||
        approval.provenance?.source_sha256!==adr.provenance.source_sha256) {
      findings.push(freezeFinding({
        type:"STALE_ADR_APPROVAL",
        path:`/approvals/${index}/provenance`,
        message:"ADR approval provenance must match its exact ADR source",
      }));
      continue;
    }
    approved.add(key);
  }
  return {findings,approved};
}

function adrSemanticFindings(pmAnalysis,architecture,adrs) {
  const findings=[];
  const requirementIds=pmRequirementIds(pmAnalysis);
  const pmQuestionIds=pmArchitectureQuestionIds(pmAnalysis);
  const architectureQuestions=new Map(architecture.content.architecture_questions.map(
    question => [question.id,question],
  ));
  const adrIds=new Set();

  for (const [index,adr] of adrs.entries()) {
    const content=adr.content;
    if (adrIds.has(content.id)) {
      findings.push(freezeFinding({
        type:"DUPLICATE_ADR",
        path:`/adrs/${index}/content/id`,
        message:`ADR ${content.id} appears more than once`,
        affected_entities:[content.id],
      }));
    }
    adrIds.add(content.id);
    for (const [questionIndex,id] of content.resolved_architecture_questions.entries()) {
      if (!pmQuestionIds.has(id)) {
        findings.push(freezeFinding({
          type:"DANGLING_ADR_ARCHITECTURE_QUESTION",
          path:`/adrs/${index}/content/resolved_architecture_questions/${questionIndex}`,
          message:`ADR ${content.id} references missing PM architecture question ${id}`,
          affected_entities:[content.id,id],
        }));
        continue;
      }
      if (architectureQuestions.get(id)?.status!=="resolved") {
        findings.push(freezeFinding({
          type:"UNRESOLVED_ADR_ARCHITECTURE_QUESTION",
          path:`/adrs/${index}/content/resolved_architecture_questions/${questionIndex}`,
          message:`ADR ${content.id} must link a resolved architecture question ${id}`,
          affected_entities:[content.id,id],
        }));
      }
    }
    for (const [requirementIndex,id] of content.affected_requirements.entries()) {
      if (!requirementIds.has(id)) {
        findings.push(freezeFinding({
          type:"DANGLING_ADR_REQUIREMENT",
          path:`/adrs/${index}/content/affected_requirements/${requirementIndex}`,
          message:`ADR ${content.id} references missing PM requirement ${id}`,
          affected_entities:[content.id,id],
        }));
      }
    }
  }
  return findings;
}

function adrStatusApprovalFindings(adrs) {
  const findings=[];
  for (const [index,adr] of adrs.entries()) {
    const {status,approval}=adr.content;
    if (ADR_STATUS_APPROVAL_MATRIX[status]?.includes(approval.state)) continue;
    findings.push(freezeFinding({
      type:"ADR_STATUS_APPROVAL_CONFLICT",
      path:`/adrs/${index}/content/approval/state`,
      message:`ADR ${adr.content.id} cannot use approval ${approval.state} while ${status}`,
      affected_entities:[adr.content.id],
    }));
  }
  return findings;
}

function adrArtifactIdentityFindings(adrs) {
  const findings=[];
  const identities=new Set();
  for (const [index,adr] of adrs.entries()) {
    const identity=`${adr.artifact_id}\u0000${adr.revision}`;
    if (identities.has(identity)) {
      findings.push(freezeFinding({
        type:"DUPLICATE_ADR_ARTIFACT_IDENTITY",
        path:`/adrs/${index}`,
        message:`ADR artifact identity ${adr.artifact_id}@${adr.revision} is duplicated`,
        affected_entities:[adr.content.id],
      }));
    }
    identities.add(identity);
  }
  return findings;
}

function resultFor({contractFindings=[],gateFindings=[]}={}) {
  const findings=Object.freeze([...contractFindings,...gateFindings]);
  const valid=contractFindings.length===0;
  const complete=valid && gateFindings.length===0;
  return Object.freeze({
    valid,
    complete,
    ready_for_pm_finalization:complete,
    findings,
  });
}

function assertBuildArguments(pmAnalysis,decisions,artifactContext) {
  if (!isPlainObject(decisions)) {
    throw new TypeError("Architecture decisions must be an object");
  }
  for (const key of Object.keys(decisions)) {
    if (!BUILD_DECISION_FIELDS.has(key)) {
      throw new TypeError(`Architecture decisions contain unsupported field ${key}`);
    }
  }
  for (const key of BUILD_DECISION_FIELDS) {
    if (!Object.hasOwn(decisions,key)) {
      throw new TypeError(`Architecture decisions require ${key}`);
    }
  }
  if (!isPlainObject(artifactContext)) {
    throw new TypeError("Architecture artifactContext must be an object");
  }
  if (artifactContext.producer?.role!=="architect") {
    throw new TypeError("Architecture artifactContext producer must be architect");
  }
  if (!Array.isArray(artifactContext.parents) || !Array.isArray(artifactContext.inputs)) {
    throw new TypeError("Architecture artifactContext parents and inputs must be arrays");
  }
  const pmResult=validatePmAnalysis(pmAnalysis);
  if (!pmResult.valid) {
    throw new TypeError("Cannot build architecture from invalid PM analysis");
  }
}

export function buildArchitecture({pmAnalysis,decisions,artifactContext}={}) {
  let normalized;
  try {
    normalized=canonicalCopy({pmAnalysis,decisions,artifactContext});
  } catch (error) {
    throw new TypeError(
      `Cannot build architecture from non-canonical inputs: ${
        error instanceof Error ? error.message : "invalid input"
      }`,
      {cause:error},
    );
  }
  const {
    pmAnalysis:pm,
    decisions:decisionInput,
    artifactContext:context,
  }=normalized;
  assertBuildArguments(pm,decisionInput,context);

  const pmReference=artifactReference(pm);
  if (context.inputs.length>0 &&
      (context.inputs.length!==1 || !sameArtifactReference(context.inputs[0],pm))) {
    throw new TypeError("Architecture artifactContext inputs must contain only the exact PM analysis");
  }
  const content={
    ...decisionInput,
    pm_entity_snapshots:ownedPmEntities(pm).map(snapshotFor),
  };
  const architecture={
    schema_version:"acp.v1",
    document_type:"architecture",
    artifact_id:context.artifact_id,
    revision:context.revision,
    run_id:context.run_id,
    producer:context.producer,
    runtime_identity:context.runtime_identity,
    created_at:context.created_at,
    provenance:context.provenance,
    parents:context.parents,
    inputs:[pmReference],
    content_sha256:sha256Canonical(content),
    content,
  };
  const result=validateArchitecture({pmAnalysis:pm,architecture,adrs:[]});
  if (!result.valid) {
    throw new TypeError(`Cannot build invalid architecture: ${result.findings.map(item =>
      `${item.type} at ${item.path}`,
    ).join("; ")}`);
  }
  return deepFreeze(architecture);
}

export function validateArchitecture({
  pmAnalysis,architecture,adrs=[],approvals=[],decisionPackage,
}={}) {
  let normalized;
  try {
    normalized=canonicalCopy({
      pmAnalysis,architecture,adrs,approvals,
      ...(decisionPackage===undefined ? {} : {decisionPackage}),
    });
  } catch (error) {
    return resultFor({contractFindings:[canonicalFinding(error)]});
  }
  const {
    pmAnalysis:pm,
    architecture:architectureArtifact,
    adrs:adrArtifacts,
    approvals:approvalArtifacts,
    decisionPackage:decisionEvidencePackage,
  }=normalized;
  const contractFindings=[];
  const gateFindings=[];
  const pmResult=validatePmAnalysis(pm);
  if (!pmResult.valid) {
    contractFindings.push(...pmResult.findings.map(finding => freezeFinding({
      type:`PM_ANALYSIS_${finding.type}`,
      path:finding.path,
      message:finding.message,
    })));
    return resultFor({contractFindings});
  }

  const decisions=decisionEvidence(pm,decisionEvidencePackage);
  contractFindings.push(...decisions.findings);
  gateFindings.push(...pmQuestionFindings(pm,decisions.resolved));
  contractFindings.push(
    ...schemaAndIntegrityFindings(architectureArtifact,"architecture.v1"),
  );
  if (contractFindings.length>0) return resultFor({contractFindings,gateFindings});

  assertExactPmSnapshots(pm,architectureArtifact);
  contractFindings.push(...architectureLinkFindings(pm,architectureArtifact));
  contractFindings.push(...architectureEntityIdentityFindings(architectureArtifact));
  contractFindings.push(...exactInputSetFindings(
    architectureArtifact,
    [{artifact:pm,label:"PM"}],
  ));

  if (!Array.isArray(adrArtifacts)) {
    contractFindings.push(freezeFinding({
      type:"ADRS_NOT_ARRAY",
      path:"/adrs",
      message:"ADRs must be an array",
    }));
    return resultFor({contractFindings,gateFindings});
  }
  const validAdrs=[];
  for (const adr of adrArtifacts) {
    const findings=schemaAndIntegrityFindings(adr,"adr.v1");
    contractFindings.push(...findings);
    if (findings.length===0) validAdrs.push(adr);
  }
  if (contractFindings.length>0) return resultFor({contractFindings,gateFindings});

  for (const adr of validAdrs) {
    contractFindings.push(...exactInputSetFindings(
      adr,
      [
        {artifact:pm,label:"PM"},
        {artifact:architectureArtifact,label:"ARCHITECTURE"},
      ],
    ));
  }
  contractFindings.push(...artifactCycleFindings([
    pm,
    architectureArtifact,
    ...validAdrs,
  ]));
  contractFindings.push(...adrArtifactIdentityFindings(validAdrs));
  contractFindings.push(...adrSemanticFindings(pm,architectureArtifact,validAdrs));
  contractFindings.push(...adrStatusApprovalFindings(validAdrs));
  const approvalResult=approvalEvidence(approvalArtifacts,validAdrs);
  contractFindings.push(...approvalResult.findings);
  gateFindings.push(...unresolvedFindingGates(architectureArtifact));
  gateFindings.push(...architectureReadinessFindings(
    pm,
    architectureArtifact,
    validAdrs,
    approvalResult.approved,
  ));
  return resultFor({contractFindings,gateFindings});
}
