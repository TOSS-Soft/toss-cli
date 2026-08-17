import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {validateArchitecture} from "./architecture.js";
import {validateIssuePlan} from "./issue-plan.js";

const BLOCKING_SEVERITIES=new Set(["P0","P1","P2"]);
const SEVERITY_ORDER=new Map(["P0","P1","P2","P3","P4"].map(
  (severity,index) => [severity,index],
));
const OPTION_KEYS=Object.freeze(["architecture","issuePlan","pmAnalysis"]);
const SHA256_PATTERN=/^[a-f0-9]{64}$/;
const ARTIFACT_ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const DOCUMENT_TYPE_PATTERN=/^[a-z][a-z0-9-]*$/;

export class SpecAuditInputError extends TypeError {
  constructor(message,{path="/",cause}={}) {
    super(message,{cause});
    this.name="SpecAuditInputError";
    this.code="SPEC_AUDIT_INPUT_INVALID";
    this.path=path;
  }
}

function isPlainObject(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function canonicalCopy(value) {
  return JSON.parse(canonicalJson(value));
}

function compareText(left,right) {
  if (left===right) return 0;
  return left<right ? -1 : 1;
}

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function escapePointerSegment(value) {
  return String(value).replaceAll("~","~0").replaceAll("/","~1");
}

function artifactReference(artifact) {
  return {
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  };
}

function referenceIdentity(reference) {
  return canonicalJson({
    document_type:reference?.document_type,
    artifact_id:reference?.artifact_id,
    revision:reference?.revision,
    content_sha256:reference?.content_sha256,
  });
}

function sameReference(left,right) {
  try {
    return referenceIdentity(left)===referenceIdentity(right);
  } catch {
    return false;
  }
}

function rawFinding({
  type,
  owner,
  severity,
  path,
  message,
  affected_entities,
  artifact_id,
  detail=message,
}) {
  const affected=[...new Set((affected_entities ?? []).filter(value =>
    typeof value==="string" && value.length>0,
  ))].sort();
  const fallback=typeof artifact_id==="string" && artifact_id.length>0 ?
    artifact_id : "UNKNOWN-ARTIFACT";
  return {
    kind:"audit-finding",
    meaning:message,
    severity,
    type,
    owner,
    path:path.startsWith("/") ? path : `/${path}`,
    affected_entities:affected.length>0 ? affected : [fallback],
    evidence:[{
      artifact_id:fallback,
      path:path.startsWith("/") ? path : `/${path}`,
      detail,
    }],
  };
}

function validationFindings(artifact,schemaId,owner,severity="P0") {
  let result;
  try {
    result=validateDocument(artifact,schemaId);
  } catch (error) {
    return [rawFinding({
      type:"SCHEMA_VALIDATION",
      owner,
      severity,
      path:"/",
      message:error instanceof Error ? error.message : "Contract validation failed",
      artifact_id:artifact?.artifact_id,
    })];
  }
  const findings=result.errors.map(error => {
    const missing=error.keyword==="required" ? error.params?.missingProperty : undefined;
    const errorPath=missing===undefined ? error.instancePath :
      `${error.instancePath}/${escapePointerSegment(missing)}`;
    return rawFinding({
      type:"SCHEMA_VALIDATION",
      owner,
      severity,
      path:errorPath || "/",
      message:error.message ?? `${schemaId} validation failed`,
      artifact_id:artifact?.artifact_id,
    });
  });
  if (result.valid) {
    let actualHash;
    try {
      actualHash=sha256Canonical(artifact.content);
    } catch (error) {
      findings.push(rawFinding({
        type:"CANONICAL_JSON",
        owner,
        severity:"P0",
        path:"/content",
        message:error instanceof Error ? error.message : "Artifact content is not canonical JSON",
        artifact_id:artifact?.artifact_id,
      }));
    }
    if (actualHash!==undefined && artifact.content_sha256!==actualHash) {
      findings.push(rawFinding({
        type:"CONTENT_SHA256_MISMATCH",
        owner,
        severity:"P0",
        path:"/content_sha256",
        message:"Artifact content hash does not match canonical content",
        artifact_id:artifact?.artifact_id,
        detail:`Expected ${actualHash}; received ${String(artifact.content_sha256)}`,
      }));
    }
  }
  return findings;
}

function normalizeMeaning(value) {
  return typeof value==="string" ? value.trim().replace(/\s+/g," ").toLowerCase() : "";
}

function duplicateFindings(collections,artifactId,owner) {
  const findings=[];
  const byId=new Map();
  const byMeaning=new Map();
  for (const {path,entities,artifactIds} of collections) {
    if (!Array.isArray(entities)) continue;
    for (const [index,entity] of entities.entries()) {
      if (!isPlainObject(entity)) continue;
      const entityPath=`${path}/${index}`;
      const findingArtifactId=artifactIds?.[index] ?? artifactId;
      if (typeof entity.id==="string") {
        if (byId.has(entity.id)) {
          findings.push(rawFinding({
            type:"DUPLICATE_ENTITY_ID",
            owner,
            severity:"P1",
            path:`${entityPath}/id`,
            message:`Entity ID ${entity.id} is defined more than once`,
            affected_entities:[entity.id],
            artifact_id:findingArtifactId,
          }));
        } else {
          byId.set(entity.id,entityPath);
        }
      }
      const normalized=normalizeMeaning(entity.meaning);
      if (!normalized) continue;
      const meaningKey=`${String(entity.kind)}\u0000${normalized}`;
      if (byMeaning.has(meaningKey)) {
        const previous=byMeaning.get(meaningKey);
        findings.push(rawFinding({
          type:"DUPLICATE_ENTITY_MEANING",
          owner,
          severity:"P2",
          path:`${entityPath}/meaning`,
          message:`Materially identical ${String(entity.kind)} meanings are duplicated`,
          affected_entities:[previous.id,entity.id].filter(Boolean),
          artifact_id:findingArtifactId,
        }));
      } else {
        byMeaning.set(meaningKey,{id:entity.id,path:entityPath});
      }
    }
  }
  return findings;
}

function exactReferenceSetFindings({
  actual,
  expected,
  artifactId,
  path,
  owner,
  label,
}) {
  const findings=[];
  const actualRefs=Array.isArray(actual) ? actual : [];
  const remaining=[...expected];
  for (const [index,reference] of actualRefs.entries()) {
    const matchIndex=remaining.findIndex(candidate => sameReference(reference,candidate));
    if (matchIndex>=0) {
      remaining.splice(matchIndex,1);
      continue;
    }
    const referenceLabel=reference?.document_type==="adr" ? "ADR" : label;
    findings.push(rawFinding({
      type:`EXTRA_${referenceLabel}_INPUT`,
      owner,
      severity:"P0",
      path:`${path}/${index}`,
      message:`${label} contains an extra, duplicate, or stale input reference`,
      affected_entities:[reference?.artifact_id].filter(Boolean),
      artifact_id:artifactId,
    }));
  }
  for (const reference of remaining) {
    const referenceLabel=reference.document_type==="adr" ? "ADR" : label;
    findings.push(rawFinding({
      type:`MISSING_${referenceLabel}_INPUT`,
      owner,
      severity:"P0",
      path,
      message:`${label} is missing an exact immutable input reference`,
      affected_entities:[reference.artifact_id],
      artifact_id:artifactId,
    }));
  }
  return findings;
}

function exactInputFindings(pmAnalysis,architectureArtifact,adrs,issuePlan) {
  const findings=[];
  const pmReference=artifactReference(pmAnalysis);
  const architectureReference=artifactReference(architectureArtifact);
  const adrReferences=adrs.map(artifactReference);
  findings.push(...exactReferenceSetFindings({
    actual:architectureArtifact.inputs,
    expected:[pmReference],
    artifactId:architectureArtifact.artifact_id,
    path:"/inputs",
    owner:"ARCHITECT",
    label:"ARCHITECTURE",
  }));
  for (const [index,adr] of adrs.entries()) {
    findings.push(...exactReferenceSetFindings({
      actual:adr.inputs,
      expected:[pmReference,architectureReference],
      artifactId:adr.artifact_id,
      path:`/architecture/adrs/${index}/inputs`,
      owner:"ARCHITECT",
      label:"ADR",
    }));
  }
  const issuePlanExpected=[pmReference,architectureReference,...adrReferences];
  findings.push(...exactReferenceSetFindings({
    actual:issuePlan.inputs,
    expected:issuePlanExpected,
    artifactId:issuePlan.artifact_id,
    path:"/inputs",
    owner:"PM_FINALIZATION",
    label:"ISSUE_PLAN",
  }));
  const snapshots=issuePlan.content?.input_snapshots;
  const snapshotReferences=snapshots ? [
    snapshots.pm_analysis,
    snapshots.architecture,
    ...(Array.isArray(snapshots.adrs) ? snapshots.adrs : []),
  ] : [];
  findings.push(...exactReferenceSetFindings({
    actual:snapshotReferences,
    expected:issuePlanExpected,
    artifactId:issuePlan.artifact_id,
    path:"/content/input_snapshots",
    owner:"PM_FINALIZATION",
    label:"IMMUTABLE",
  }));
  return findings;
}

function requirementEntries(pmAnalysis) {
  const content=pmAnalysis.content ?? {};
  return [
    ...(Array.isArray(content.functional_requirements) ?
      content.functional_requirements.map((entity,index) => ({
        entity,
        path:`/content/functional_requirements/${index}`,
        blocking:true,
      })) : []),
    ...(Array.isArray(content.non_functional_requirements) ?
      content.non_functional_requirements.map((entity,index) => ({
        entity,
        path:`/content/non_functional_requirements/${index}`,
        blocking:false,
      })) : []),
    ...(Array.isArray(content.constraints) ?
      content.constraints.map((entity,index) => ({
        entity,
        path:`/content/constraints/${index}`,
        blocking:false,
      })) : []),
  ];
}

function coverageFindings(pmAnalysis,issuePlan) {
  const findings=[];
  const issues=Array.isArray(issuePlan.content?.issues) ? issuePlan.content.issues : [];
  const criteria=Array.isArray(issuePlan.content?.acceptance_criteria) ?
    issuePlan.content.acceptance_criteria : [];
  const issueRequirementIds=new Set(issues.flatMap(issue =>
    Array.isArray(issue?.source_requirements) ?
      issue.source_requirements.map(reference => reference?.id) : [],
  ));
  const acRequirementIds=new Set(criteria.flatMap(criterion =>
    Array.isArray(criterion?.verifies) ?
      criterion.verifies.map(reference => reference?.id) : [],
  ));
  const requirements=requirementEntries(pmAnalysis);
  const requirementById=new Map(requirements.map(entry => [entry.entity.id,entry]));
  for (const {entity,path,blocking} of requirements) {
    if (!isPlainObject(entity) || typeof entity.id!=="string") continue;
    const mentioned=issueRequirementIds.has(entity.id);
    const verified=acRequirementIds.has(entity.id);
    if (!mentioned && !verified) {
      findings.push(rawFinding({
        type:"ORPHAN_REQUIREMENT",
        owner:"PM",
        severity:blocking ? "P1" : "P3",
        path,
        message:`Requirement ${entity.id} is not traced to an issue or acceptance criterion`,
        affected_entities:[entity.id],
        artifact_id:pmAnalysis.artifact_id,
      }));
    } else if (!mentioned && verified) {
      findings.push(rawFinding({
        type:"REQUIREMENT_AC_WITHOUT_ISSUE",
        owner:"PM_FINALIZATION",
        severity:"P2",
        path:"/content/acceptance_criteria",
        message:`Requirement ${entity.id} is verified by an AC but not owned by an issue`,
        affected_entities:[entity.id],
        artifact_id:issuePlan.artifact_id,
      }));
    }
  }
  const criteriaById=new Map(criteria.map(criterion => [criterion?.id,criterion]));
  for (const [issueIndex,issue] of issues.entries()) {
    if (!isPlainObject(issue)) continue;
    const ownedCriteria=(issue.acceptance_criteria ?? []).map(reference =>
      criteriaById.get(reference?.id),
    ).filter(criterion => criterion?.issue?.id===issue.id);
    for (const [referenceIndex,reference] of (issue.source_requirements ?? []).entries()) {
      const requirement=requirementById.get(reference?.id);
      if (!requirement) continue;
      const verifiedByOwnedCriterion=ownedCriteria.some(criterion =>
        (criterion.verifies ?? []).some(target => target?.id===reference.id),
      );
      if (verifiedByOwnedCriterion) continue;
      findings.push(rawFinding({
        type:"AC_COVERAGE",
        owner:"PM_FINALIZATION",
        severity:requirement.blocking ? "P1" : "P2",
        path:`/content/issues/${issueIndex}/source_requirements/${referenceIndex}`,
        message:`Requirement ${reference.id} is not verified by an acceptance criterion owned by issue ${issue.id}`,
        affected_entities:[issue.id,reference.id],
        artifact_id:issuePlan.artifact_id,
      }));
    }
  }
  return findings;
}

function issueAndReferenceFindings(pmAnalysis,adrs,issuePlan) {
  const findings=[];
  const content=issuePlan.content ?? {};
  const epics=Array.isArray(content.epics) ? content.epics : [];
  const issues=Array.isArray(content.issues) ? content.issues : [];
  const criteria=Array.isArray(content.acceptance_criteria) ? content.acceptance_criteria : [];
  const requirementIds=new Set(requirementEntries(pmAnalysis).map(({entity}) => entity.id));
  const epicIds=new Set(epics.map(entity => entity?.id));
  const issueById=new Map();
  const criterionById=new Map();
  const adrById=new Map(adrs.map(adr => [adr.content?.id,adr]));
  for (const issue of issues) {
    if (!issueById.has(issue?.id)) issueById.set(issue?.id,issue);
  }
  for (const criterion of criteria) {
    if (!criterionById.has(criterion?.id)) criterionById.set(criterion?.id,criterion);
  }

  const usedEpicIds=new Set(issues.map(issue => issue?.epic?.id).filter(Boolean));
  for (const [index,epic] of epics.entries()) {
    if (!isPlainObject(epic)) continue;
    const path=`/content/epics/${index}`;
    const incomplete=typeof epic.meaning!=="string" || !epic.meaning.trim() ||
      !Array.isArray(epic.source_requirements) || epic.source_requirements.length===0;
    if (incomplete) {
      findings.push(rawFinding({
        type:"EPIC_INCOMPLETE",
        owner:"PM_FINALIZATION",
        severity:"P1",
        path,
        message:`Epic ${String(epic.id)} lacks material meaning or source requirements`,
        affected_entities:[epic.id].filter(Boolean),
        artifact_id:issuePlan.artifact_id,
      }));
    }
    for (const [referenceIndex,reference] of (epic.source_requirements ?? []).entries()) {
      if (requirementIds.has(reference?.id)) continue;
      findings.push(rawFinding({
        type:"DANGLING_REFERENCE",
        owner:"PM_FINALIZATION",
        severity:"P1",
        path:`${path}/source_requirements/${referenceIndex}`,
        message:`Epic ${String(epic.id)} references missing requirement ${String(reference?.id)}`,
        affected_entities:[epic.id,reference?.id].filter(Boolean),
        artifact_id:issuePlan.artifact_id,
      }));
    }
    if (!usedEpicIds.has(epic.id)) {
      findings.push(rawFinding({
        type:"ORPHAN_EPIC",
        owner:"PM_FINALIZATION",
        severity:"P1",
        path,
        message:`Authoritative epic ${String(epic.id)} is not used by any issue`,
        affected_entities:[epic.id].filter(Boolean),
        artifact_id:issuePlan.artifact_id,
      }));
    }
  }

  for (const [index,issue] of issues.entries()) {
    if (!isPlainObject(issue)) continue;
    const path=`/content/issues/${index}`;
    const incompleteFields=[];
    if (typeof issue.atomic_scope!=="string" || !issue.atomic_scope.trim()) {
      incompleteFields.push("atomic_scope");
    }
    if (!Array.isArray(issue.acceptance_criteria) ||
        issue.acceptance_criteria.length===0) {
      incompleteFields.push("acceptance_criteria");
    }
    if (!Array.isArray(issue.definition_of_done) ||
        issue.definition_of_done.length===0 ||
        issue.definition_of_done.some(item => typeof item!=="string" || !item.trim())) {
      incompleteFields.push("definition_of_done");
    }
    if (issue.requires_adr===true &&
        (!Array.isArray(issue.adr_refs) || issue.adr_refs.length===0)) {
      incompleteFields.push("adr_refs");
    }
    if (incompleteFields.length>0) {
      findings.push(rawFinding({
        type:"ISSUE_INCOMPLETE",
        owner:"PM_FINALIZATION",
        severity:"P1",
        path,
        message:`Issue ${String(issue.id)} is incomplete: ${incompleteFields.join(", ")}`,
        affected_entities:[issue.id].filter(Boolean),
        artifact_id:issuePlan.artifact_id,
      }));
    }
    if (!issue.epic && !issue.standalone) {
      findings.push(rawFinding({
        type:"ORPHAN_ISSUE",
        owner:"PM_FINALIZATION",
        severity:"P1",
        path,
        message:`Issue ${String(issue.id)} is neither assigned to an epic nor explicitly standalone`,
        affected_entities:[issue.id].filter(Boolean),
        artifact_id:issuePlan.artifact_id,
      }));
    } else if (issue.epic && !epicIds.has(issue.epic.id)) {
      findings.push(rawFinding({
        type:"DANGLING_REFERENCE",
        owner:"PM_FINALIZATION",
        severity:"P1",
        path:`${path}/epic`,
        message:`Issue ${String(issue.id)} references missing epic ${String(issue.epic.id)}`,
        affected_entities:[issue.id,issue.epic.id].filter(Boolean),
        artifact_id:issuePlan.artifact_id,
      }));
    }
    if ((!Array.isArray(issue.source_requirements) || issue.source_requirements.length===0) &&
        (typeof issue.governance_rationale!=="string" || !issue.governance_rationale.trim())) {
      findings.push(rawFinding({
        type:"ORPHAN_ISSUE",
        owner:"PM_FINALIZATION",
        severity:"P1",
        path:`${path}/source_requirements`,
        message:`Issue ${String(issue.id)} has neither source requirements nor governance rationale`,
        affected_entities:[issue.id].filter(Boolean),
        artifact_id:issuePlan.artifact_id,
      }));
    }
    for (const [referenceIndex,reference] of (issue.source_requirements ?? []).entries()) {
      if (requirementIds.has(reference?.id)) continue;
      findings.push(rawFinding({
        type:"DANGLING_REFERENCE",
        owner:"PM_FINALIZATION",
        severity:"P1",
        path:`${path}/source_requirements/${referenceIndex}`,
        message:`Issue ${String(issue.id)} references missing requirement ${String(reference?.id)}`,
        affected_entities:[issue.id,reference?.id].filter(Boolean),
        artifact_id:issuePlan.artifact_id,
      }));
    }
    for (const [referenceIndex,reference] of (issue.acceptance_criteria ?? []).entries()) {
      const criterion=criterionById.get(reference?.id);
      if (!criterion) {
        findings.push(rawFinding({
          type:"DANGLING_REFERENCE",
          owner:"PM_FINALIZATION",
          severity:"P1",
          path:`${path}/acceptance_criteria/${referenceIndex}`,
          message:`Issue ${String(issue.id)} references missing acceptance criterion ${String(reference?.id)}`,
          affected_entities:[issue.id,reference?.id].filter(Boolean),
          artifact_id:issuePlan.artifact_id,
        }));
      } else if (criterion.issue?.id!==issue.id) {
        findings.push(rawFinding({
          type:"AC_ISSUE_LINK_MISMATCH",
          owner:"PM_FINALIZATION",
          severity:"P1",
          path:`${path}/acceptance_criteria/${referenceIndex}`,
          message:`Acceptance criterion ${criterion.id} does not link back to issue ${issue.id}`,
          affected_entities:[issue.id,criterion.id],
          artifact_id:issuePlan.artifact_id,
        }));
      }
    }
    for (const [referenceIndex,reference] of (issue.adr_refs ?? []).entries()) {
      if (adrById.has(reference?.id)) continue;
      findings.push(rawFinding({
        type:"DANGLING_REFERENCE",
        owner:"PM_FINALIZATION",
        severity:"P1",
        path:`${path}/adr_refs/${referenceIndex}`,
        message:`Issue ${String(issue.id)} references missing ADR ${String(reference?.id)}`,
        affected_entities:[issue.id,reference?.id].filter(Boolean),
        artifact_id:issuePlan.artifact_id,
      }));
    }
    for (const [referenceIndex,reference] of (issue.dependencies ?? []).entries()) {
      if (issueById.has(reference?.id)) continue;
      findings.push(rawFinding({
        type:"DANGLING_REFERENCE",
        owner:"PM_FINALIZATION",
        severity:"P1",
        path:`${path}/dependencies/${referenceIndex}`,
        message:`Issue ${String(issue.id)} depends on missing issue ${String(reference?.id)}`,
        affected_entities:[issue.id,reference?.id].filter(Boolean),
        artifact_id:issuePlan.artifact_id,
      }));
    }
  }

  for (const [index,criterion] of criteria.entries()) {
    if (!isPlainObject(criterion)) continue;
    const issue=issueById.get(criterion.issue?.id);
    if (!issue || !Array.isArray(issue.acceptance_criteria) ||
        !issue.acceptance_criteria.some(reference => reference?.id===criterion.id)) {
      findings.push(rawFinding({
        type:"AC_ISSUE_LINK_MISMATCH",
        owner:"PM_FINALIZATION",
        severity:"P1",
        path:`/content/acceptance_criteria/${index}/issue`,
        message:`Acceptance criterion ${String(criterion.id)} has no exact owning issue link`,
        affected_entities:[criterion.id,criterion.issue?.id].filter(Boolean),
        artifact_id:issuePlan.artifact_id,
      }));
    }
    for (const [referenceIndex,reference] of (criterion.verifies ?? []).entries()) {
      if (requirementIds.has(reference?.id)) continue;
      findings.push(rawFinding({
        type:"DANGLING_REFERENCE",
        owner:"PM_FINALIZATION",
        severity:"P1",
        path:`/content/acceptance_criteria/${index}/verifies/${referenceIndex}`,
        message:`Acceptance criterion ${String(criterion.id)} verifies missing requirement ${String(reference?.id)}`,
        affected_entities:[criterion.id,reference?.id].filter(Boolean),
        artifact_id:issuePlan.artifact_id,
      }));
    }
  }
  return findings;
}

function dependencyCycleFindings(issuePlan) {
  const issues=Array.isArray(issuePlan.content?.issues) ? issuePlan.content.issues : [];
  const issueById=new Map();
  for (const issue of issues) {
    if (typeof issue?.id==="string" && !issueById.has(issue.id)) issueById.set(issue.id,issue);
  }
  const visiting=[];
  const visited=new Set();
  const cycleKeys=new Set();
  const findings=[];
  function visit(id) {
    const cycleIndex=visiting.indexOf(id);
    if (cycleIndex>=0) {
      const members=[...visiting.slice(cycleIndex),id];
      const key=[...new Set(members)].sort().join("\u0000");
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key);
        findings.push(rawFinding({
          type:"DEPENDENCY_CYCLE",
          owner:"PM_FINALIZATION",
          severity:"P1",
          path:"/content/issues",
          message:`Issue dependency cycle detected: ${members.join(" -> ")}`,
          affected_entities:[...new Set(members)],
          artifact_id:issuePlan.artifact_id,
        }));
      }
      return;
    }
    if (visited.has(id)) return;
    const issue=issueById.get(id);
    if (!issue) return;
    visiting.push(id);
    for (const reference of issue.dependencies ?? []) visit(reference?.id);
    visiting.pop();
    visited.add(id);
  }
  for (const id of [...issueById.keys()].sort()) visit(id);
  return findings;
}

function adrFindings(architectureArtifact,adrs,issuePlan) {
  const findings=[];
  const issues=Array.isArray(issuePlan.content?.issues) ? issuePlan.content.issues : [];
  const referencedAdrIds=new Set(issues.flatMap(issue =>
    Array.isArray(issue?.adr_refs) ? issue.adr_refs.map(reference => reference?.id) : [],
  ));
  const issueRequirementIds=new Set(issues.flatMap(issue =>
    Array.isArray(issue?.source_requirements) ?
      issue.source_requirements.map(reference => reference?.id) : [],
  ));
  const resolvedQuestionIds=new Set();
  for (const [index,adr] of adrs.entries()) {
    const content=adr.content ?? {};
    for (const id of content.resolved_architecture_questions ?? []) {
      resolvedQuestionIds.add(id);
    }
    const relevant=(content.affected_requirements ?? []).some(id =>
      issueRequirementIds.has(id),
    );
    if (typeof content.id==="string" && !referencedAdrIds.has(content.id)) {
      findings.push(rawFinding({
        type:relevant ? "ADR_CONSISTENCY" : "ORPHAN_ADR",
        owner:relevant ? "PM_FINALIZATION" : "ARCHITECT",
        severity:relevant ? "P1" : "P3",
        path:`/architecture/adrs/${index}/content/id`,
        message:relevant ?
          `Relevant ADR ${content.id} is not linked by an affected issue` :
          `ADR ${content.id} is not linked by any issue`,
        affected_entities:[content.id],
        artifact_id:adr.artifact_id,
      }));
    }
  }
  for (const [index,question] of (
    architectureArtifact.content?.architecture_questions ?? []
  ).entries()) {
    if (question?.status!=="resolved" || resolvedQuestionIds.has(question.id)) continue;
    findings.push(rawFinding({
      type:"ADR_CONSISTENCY",
      owner:"ARCHITECT",
      severity:"P1",
      path:`/content/architecture_questions/${index}`,
      message:`Resolved architecture question ${String(question.id)} has no ADR evidence`,
      affected_entities:[question.id].filter(Boolean),
      artifact_id:architectureArtifact.artifact_id,
    }));
  }
  return findings;
}

function upstreamFindings(pmAnalysis,architectureArtifact,adrs,issuePlan) {
  const findings=[];
  try {
    const architectureResult=validateArchitecture({
      pmAnalysis,
      architecture:architectureArtifact,
      adrs,
    });
    for (const finding of architectureResult.findings ?? []) {
      if (architectureResult.valid && !BLOCKING_SEVERITIES.has(finding.severity)) {
        continue;
      }
      findings.push(rawFinding({
        type:`ARCHITECTURE_${finding.type}`,
        owner:finding.owner==="PM" ? "PM" : "ARCHITECT",
        severity:finding.severity ?? "P1",
        path:`/architecture${finding.path==="/" ? "" : finding.path}`,
        message:finding.message,
        affected_entities:finding.affected_entities,
        artifact_id:architectureArtifact.artifact_id,
      }));
    }
    if (architectureResult.valid && !architectureResult.complete) {
      findings.push(rawFinding({
        type:adrs.length===0 ? "ADR_REQUIRED" : "ARCHITECTURE_NOT_READY",
        owner:"ARCHITECT",
        severity:"P1",
        path:"/architecture",
        message:"Architecture and ADR inputs are not ready for specification audit",
        artifact_id:architectureArtifact.artifact_id,
      }));
    }
  } catch (error) {
    findings.push(rawFinding({
      type:"IMMUTABLE_ARCHITECTURE_INPUT",
      owner:"ARCHITECT",
      severity:"P0",
      path:"/architecture",
      message:error instanceof Error ? error.message : "Architecture integrity failed",
      artifact_id:architectureArtifact.artifact_id,
    }));
  }
  try {
    const issuePlanResult=validateIssuePlan({
      pmAnalysis,
      architecture:architectureArtifact,
      adrs,
      issuePlan,
    });
    for (const finding of issuePlanResult.findings ?? []) {
      findings.push(rawFinding({
        type:`ISSUE_PLAN_${finding.type}`,
        owner:finding.owner==="ARCHITECT" ? "ARCHITECT" : "PM_FINALIZATION",
        severity:finding.severity ?? "P1",
        path:finding.path,
        message:finding.message,
        affected_entities:finding.affected_entities,
        artifact_id:issuePlan.artifact_id,
      }));
    }
  } catch (error) {
    const message=error instanceof Error ? error.message : "Issue-plan integrity failed";
    findings.push(rawFinding({
      type:/cycle/i.test(message) ? "DEPENDENCY_CYCLE" :
        /dangling/i.test(message) ? "DANGLING_REFERENCE" :
          "IMMUTABLE_INPUT_MISMATCH",
      owner:"PM_FINALIZATION",
      severity:"P0",
      path:"/issuePlan",
      message,
      artifact_id:issuePlan.artifact_id,
    }));
  }
  return findings;
}

function finalizeFindings(rawFindings) {
  const unique=new Map();
  for (const finding of rawFindings) {
    const key=canonicalJson(finding);
    if (!unique.has(key)) unique.set(key,finding);
  }
  const ordered=[...unique.values()].sort((left,right) =>
    SEVERITY_ORDER.get(left.severity)-SEVERITY_ORDER.get(right.severity) ||
    compareText(left.type,right.type) ||
    compareText(left.owner,right.owner) ||
    compareText(left.path,right.path) ||
    compareText(canonicalJson(left.affected_entities),canonicalJson(right.affected_entities)) ||
    compareText(canonicalJson(left.evidence),canonicalJson(right.evidence)),
  );
  return ordered.map(finding => ({
    id:`Q-AUDIT-${sha256Canonical(finding).slice(0,16).toUpperCase()}`,
    ...finding,
  }));
}

function auditProvenance(issuePlan,runId) {
  const provenance=canonicalCopy(issuePlan.provenance);
  if (isPlainObject(provenance.agent)) {
    provenance.agent.identity="toss-spec-auditor";
    provenance.agent.run_id=runId;
  }
  if (Object.hasOwn(provenance,"timestamp")) {
    provenance.timestamp=issuePlan.created_at;
  }
  return provenance;
}

function assertAggregate(architecture) {
  if (!isPlainObject(architecture) || !isPlainObject(architecture.artifact) ||
      !Array.isArray(architecture.adrs)) {
    throw new SpecAuditInputError(
      "Spec audit architecture must contain a plain artifact and adrs array",
      {path:"/architecture"},
    );
  }
  const keys=Object.keys(architecture).sort();
  if (canonicalJson(keys)!==canonicalJson(["adrs","artifact"])) {
    throw new SpecAuditInputError(
      "Spec audit architecture aggregate requires exactly artifact and adrs",
      {path:"/architecture"},
    );
  }
}

function canonicalOptions(options) {
  let canonical;
  try {
    canonical=canonicalJson(options);
  } catch (error) {
    throw new SpecAuditInputError(
      `Spec audit options must be canonical plain JSON: ${
        error instanceof Error ? error.message : "invalid input"
      }`,
      {cause:error},
    );
  }
  const normalized=JSON.parse(canonical);
  if (!isPlainObject(normalized)) {
    throw new SpecAuditInputError("Spec audit options must be a plain JSON object");
  }
  const keys=Object.keys(normalized).sort();
  if (canonicalJson(keys)!==canonicalJson(OPTION_KEYS)) {
    throw new SpecAuditInputError(
      "Spec audit options require exactly architecture, issuePlan, and pmAnalysis",
    );
  }
  return normalized;
}

function assertReferenceIdentity(artifact,path) {
  if (!isPlainObject(artifact)) {
    throw new SpecAuditInputError("Artifact must be a plain JSON object",{path});
  }
  for (const [field,valid] of [
    ["document_type",typeof artifact.document_type==="string" &&
      DOCUMENT_TYPE_PATTERN.test(artifact.document_type)],
    ["artifact_id",typeof artifact.artifact_id==="string" &&
      ARTIFACT_ID_PATTERN.test(artifact.artifact_id)],
    ["revision",Number.isSafeInteger(artifact.revision) && artifact.revision>=1],
    ["content_sha256",typeof artifact.content_sha256==="string" &&
      SHA256_PATTERN.test(artifact.content_sha256)],
  ]) {
    if (!valid) {
      throw new SpecAuditInputError(
        `Artifact lacks usable immutable envelope field ${field}`,
        {path:`${path}/${field}`},
      );
    }
  }
}

function assertOutputMetadata(issuePlan) {
  const runId=typeof issuePlan.run_id==="string" ? issuePlan.run_id : "";
  const probe={
    schema_version:"acp.v1",
    document_type:"spec-audit",
    artifact_id:"spec-audit:metadata-probe",
    revision:1,
    run_id:runId,
    producer:{role:"spec-auditor",identity:"toss-spec-auditor"},
    runtime_identity:issuePlan.runtime_identity,
    created_at:issuePlan.created_at,
    provenance:issuePlan.provenance,
    parents:[],
    inputs:[],
    content_sha256:"0".repeat(64),
    content:{},
  };
  const validation=validateDocument(probe,"artifact-envelope.v1");
  if (validation.valid) return;
  const first=validation.errors[0];
  const missing=first?.keyword==="required" ? first.params?.missingProperty : undefined;
  const relativePath=missing===undefined ? first?.instancePath :
    `${first?.instancePath}/${escapePointerSegment(missing)}`;
  throw new SpecAuditInputError(
    "Issue-plan envelope lacks metadata required for a valid audit artifact",
    {path:`/issuePlan${relativePath || "/"}`},
  );
}

function assertMinimumEnvelopes(pmAnalysis,architectureArtifact,adrs,issuePlan) {
  assertReferenceIdentity(pmAnalysis,"/pmAnalysis");
  assertReferenceIdentity(architectureArtifact,"/architecture/artifact");
  for (const [index,adr] of adrs.entries()) {
    assertReferenceIdentity(adr,`/architecture/adrs/${index}`);
  }
  assertReferenceIdentity(issuePlan,"/issuePlan");
  assertOutputMetadata(issuePlan);
}

export function auditSpecification(options) {
  const normalized=canonicalOptions(options);
  assertAggregate(normalized.architecture);
  const pm=normalized.pmAnalysis;
  const architectureArtifact=normalized.architecture.artifact;
  const adrs=[...normalized.architecture.adrs];
  const plan=normalized.issuePlan;
  assertMinimumEnvelopes(pm,architectureArtifact,adrs,plan);
  adrs.sort((left,right) =>
    compareText(
      referenceIdentity(artifactReference(left)),
      referenceIdentity(artifactReference(right)),
    ),
  );

  const rawFindings=[
    ...validationFindings(pm,"pm-analysis.v1","PM"),
    ...validationFindings(architectureArtifact,"architecture.v1","ARCHITECT"),
    ...adrs.flatMap(adr => validationFindings(adr,"adr.v1","ARCHITECT")),
    ...validationFindings(plan,"issue-plan.v1","PM_FINALIZATION"),
    ...exactInputFindings(pm,architectureArtifact,adrs,plan),
    ...duplicateFindings([
      {path:"/content/functional_requirements",entities:pm.content?.functional_requirements},
      {path:"/content/non_functional_requirements",entities:pm.content?.non_functional_requirements},
      {path:"/content/constraints",entities:pm.content?.constraints},
      {path:"/content/business_rules",entities:pm.content?.business_rules},
      {path:"/content/architecture_questions",entities:pm.content?.architecture_questions},
    ],pm.artifact_id,"PM"),
    ...duplicateFindings([
      {path:"/content/components",entities:architectureArtifact.content?.components},
      {path:"/content/constraints",entities:architectureArtifact.content?.constraints},
      {
        path:"/architecture/adrs",
        entities:adrs.map(adr => adr.content),
        artifactIds:adrs.map(adr => adr.artifact_id),
      },
    ],architectureArtifact.artifact_id,"ARCHITECT"),
    ...duplicateFindings([
      {path:"/content/epics",entities:plan.content?.epics},
      {path:"/content/issues",entities:plan.content?.issues},
      {path:"/content/acceptance_criteria",entities:plan.content?.acceptance_criteria},
    ],plan.artifact_id,"PM_FINALIZATION"),
    ...coverageFindings(pm,plan),
    ...issueAndReferenceFindings(pm,adrs,plan),
    ...dependencyCycleFindings(plan),
    ...adrFindings(architectureArtifact,adrs,plan),
    ...upstreamFindings(pm,architectureArtifact,adrs,plan),
  ];
  const findings=finalizeFindings(rawFindings);
  const blocking=findings.filter(finding => BLOCKING_SEVERITIES.has(
    finding.severity,
  )).length;
  const warnings=findings.length-blocking;
  const status=blocking>0 ? "FAIL" : warnings>0 ? "WARN" : "PASS";
  const readyForGithub=blocking===0;
  const inputs=[
    artifactReference(pm),
    artifactReference(architectureArtifact),
    ...adrs.map(artifactReference),
    artifactReference(plan),
  ];
  const content={
    status,
    ready_for_github:readyForGithub,
    summary:{total:findings.length,blocking,warnings},
    audited_issue_ids:[...new Set((plan.content?.issues ?? []).map(issue => issue?.id).filter(
      id => typeof id==="string",
    ))].sort(),
    findings,
  };
  const runId=`${plan.run_id}:spec-audit`;
  const artifact={
    schema_version:"acp.v1",
    document_type:"spec-audit",
    artifact_id:`spec-audit:${plan.artifact_id}`,
    revision:plan.revision,
    run_id:runId,
    producer:{role:"spec-auditor",identity:"toss-spec-auditor"},
    runtime_identity:canonicalCopy(plan.runtime_identity),
    created_at:plan.created_at,
    provenance:auditProvenance(plan,runId),
    parents:[],
    inputs,
    content_sha256:sha256Canonical(content),
    content,
  };
  return deepFreeze({
    status,
    ready_for_github:readyForGithub,
    findings,
    artifact,
  });
}
