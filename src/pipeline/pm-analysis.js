import {canonicalJson, sha256Canonical} from "../contracts/acp.js";
import {validateArtifactGraph} from "../contracts/semantic-validator.js";
import {validateDocument} from "../contracts/validator.js";

const REQUIRED_SECTIONS=Object.freeze([
  "summary",
  "goals",
  "non_goals",
  "actors",
  "functional_requirements",
  "non_functional_requirements",
  "business_rules",
  "domains_modules",
  "user_flows",
  "integrations",
  "constraints",
  "assumptions",
  "open_questions",
  "risks",
  "architecture_questions",
  "epic_candidates",
]);

const PROVENANCE_SECTIONS=Object.freeze([
  "goals",
  "non_goals",
  "actors",
  "functional_requirements",
  "non_functional_requirements",
  "business_rules",
  "domains_modules",
  "user_flows",
  "integrations",
  "constraints",
  "assumptions",
  "open_questions",
  "risks",
  "architecture_questions",
  "epic_candidates",
]);

const GLOBAL_ENTITY_SECTIONS=Object.freeze([
  "functional_requirements",
  "non_functional_requirements",
  "business_rules",
  "user_flows",
  "constraints",
  "assumptions",
  "open_questions",
  "risks",
  "architecture_questions",
  "epic_candidates",
]);

const EXPECTED_INTENT_TYPES=Object.freeze({
  functional_requirements:"business-requirement",
  non_functional_requirements:"business-quality-attribute",
  business_rules:"business-rule",
  constraints:"business-constraint",
});

const FORBIDDEN_PM_DECISION_FIELDS=Object.freeze([
  "adrs",
  "architecture",
  "architecture_decisions",
  "technical_decisions",
]);

const FORBIDDEN_REQUIREMENT_FIELDS=Object.freeze([
  "adr",
  "architecture_decision",
  "decision",
  "implementation",
  "technical_solution",
]);

function isPlainObject(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function escapePointerSegment(value) {
  return String(value).replaceAll("~","~0").replaceAll("/","~1");
}

function finding(type,path,message) {
  return Object.freeze({type,path,message});
}

function canonicalCopy(value) {
  return JSON.parse(canonicalJson(value));
}

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function formatValidationErrors(errors) {
  return errors.map(error => {
    const missing=error.keyword==="required" ? error.params?.missingProperty : undefined;
    const path=missing===undefined ? error.instancePath :
      `${error.instancePath}/${escapePointerSegment(missing)}`;
    const isMissingSection=error.keyword==="required" &&
      error.instancePath==="/content" && REQUIRED_SECTIONS.includes(missing);
    const isEmptySection=error.keyword==="minItems" &&
      REQUIRED_SECTIONS.includes(error.instancePath.slice("/content/".length));
    const isBlankSummary=error.keyword==="pattern" &&
      error.instancePath==="/content/summary";
    return finding(
      isMissingSection ? "MISSING_REQUIRED_SECTION" :
        isEmptySection ? "EMPTY_REQUIRED_SECTION" :
          isBlankSummary ? "BLANK_REQUIRED_TEXT" : "SCHEMA_VALIDATION",
      path || "/",
      error.message ?? "PM analysis does not satisfy its contract",
    );
  });
}

function epicCandidateCircularFindings(content) {
  if (!isPlainObject(content) || !Array.isArray(content.epic_candidates)) return [];
  const findings=[];
  for (const [candidateIndex,candidate] of content.epic_candidates.entries()) {
    if (!isPlainObject(candidate) || typeof candidate.id!=="string" ||
        !Array.isArray(candidate.source_entities)) continue;
    for (const [referenceIndex,reference] of candidate.source_entities.entries()) {
      if (isPlainObject(reference) && reference.reference_type==="internal" &&
          reference.entity_id===candidate.id) {
        findings.push(finding(
          "SEMANTIC_CIRCULAR_REFERENCE",
          `/content/epic_candidates/${candidateIndex}/source_entities/${referenceIndex}/entity_id`,
          `Epic candidate ${candidate.id} cannot use itself as source evidence`,
        ));
      }
    }
  }
  return findings;
}

function roleBoundaryFindings(analysis) {
  if (!isPlainObject(analysis)) return [];
  const findings=[];
  if (analysis.producer?.role!==undefined && analysis.producer.role!=="pm") {
    findings.push(finding(
      "ROLE_BOUNDARY_PRODUCER",
      "/producer/role",
      "pm-analysis must be produced by the PM role",
    ));
  }
  if (!isPlainObject(analysis.content)) return findings;

  for (const field of FORBIDDEN_PM_DECISION_FIELDS) {
    if (Object.hasOwn(analysis.content,field)) {
      findings.push(finding(
        field==="adrs" ? "ROLE_BOUNDARY_ADR" : "ROLE_BOUNDARY_ARCHITECTURE_DECISION",
        `/content/${escapePointerSegment(field)}`,
        "PM analysis records product intent and questions; Architect-owned decisions are forbidden",
      ));
    }
  }

  for (const [section,expectedIntent] of Object.entries(EXPECTED_INTENT_TYPES)) {
    const entities=analysis.content[section];
    if (!Array.isArray(entities)) continue;
    for (const [index,entity] of entities.entries()) {
      if (!isPlainObject(entity)) continue;
      const path=`/content/${section}/${index}`;
      if (entity.intent_type!==undefined && entity.intent_type!==expectedIntent) {
        findings.push(finding(
          "ROLE_BOUNDARY_TECHNICAL_SOLUTION",
          `${path}/intent_type`,
          `${section} must express ${expectedIntent} rather than a technical solution`,
        ));
      }
      for (const field of FORBIDDEN_REQUIREMENT_FIELDS) {
        if (Object.hasOwn(entity,field)) {
          findings.push(finding(
            "ROLE_BOUNDARY_TECHNICAL_SOLUTION",
            `${path}/${escapePointerSegment(field)}`,
            "Technical decisions and implementation choices belong to the Architect",
          ));
        }
      }
    }
  }
  return findings;
}

function integrityFindings(analysis) {
  if (!isPlainObject(analysis) || !Object.hasOwn(analysis,"content")) return [];
  const expected=sha256Canonical(analysis.content);
  if (analysis.content_sha256===expected) return [];
  return [finding(
    "CONTENT_SHA256_MISMATCH",
    "/content_sha256",
    "content_sha256 must equal the SHA-256 digest of canonical content",
  )];
}

function globalEntities(content) {
  return GLOBAL_ENTITY_SECTIONS.flatMap(section =>
    Array.isArray(content[section]) ? content[section] : [],
  );
}

function architectureQuestionLinkFindings(content) {
  if (!isPlainObject(content)) return [];
  const requirementIds=new Set(
    Array.isArray(content.functional_requirements) ?
      content.functional_requirements.map(entity => entity?.id) : [],
  );
  const constraintIds=new Set(
    Array.isArray(content.constraints) ?
      content.constraints.map(entity => entity?.id) : [],
  );
  const findings=[];
  const questions=Array.isArray(content.architecture_questions) ?
    content.architecture_questions : [];
  for (const [questionIndex,question] of questions.entries()) {
    if (!isPlainObject(question)) continue;
    for (const [index,id] of (question.affected_requirements ?? []).entries()) {
      if (!requirementIds.has(id)) {
        findings.push(finding(
          "SEMANTIC_DANGLING_REFERENCE",
          `/content/architecture_questions/${questionIndex}/affected_requirements/${index}`,
          `Architecture question references missing PM requirement ${String(id)}`,
        ));
      }
    }
    for (const [index,id] of (question.affected_constraints ?? []).entries()) {
      if (!constraintIds.has(id)) {
        findings.push(finding(
          "SEMANTIC_DANGLING_REFERENCE",
          `/content/architecture_questions/${questionIndex}/affected_constraints/${index}`,
          `Architecture question references missing PM constraint ${String(id)}`,
        ));
      }
    }
  }
  return findings;
}

function semanticFindings(content) {
  const findings=architectureQuestionLinkFindings(content);
  if (findings.length>0) return findings;
  const graphContent={
    ...content,
    entities:globalEntities(content).map(entity => {
      if (!isPlainObject(entity) || entity.kind!=="architecture-question") return entity;
      return {
        ...entity,
        affected_entities:[
          ...entity.affected_requirements,
          ...entity.affected_constraints,
        ],
      };
    }),
  };
  try {
    validateArtifactGraph([{content:graphContent}]);
  } catch (error) {
    return [finding(
      "SEMANTIC_VALIDATION",
      "/content",
      error instanceof Error ? error.message : "PM analysis semantic validation failed",
    )];
  }
  return [];
}

function decorateContentWithProvenance(source,provenance) {
  if (!isPlainObject(source)) return source;
  const content={...source};
  for (const section of PROVENANCE_SECTIONS) {
    if (!Array.isArray(content[section])) continue;
    content[section]=content[section].map(entity =>
      isPlainObject(entity) && !Object.hasOwn(entity,"provenance") ?
        {...entity,provenance} : entity,
    );
  }
  return content;
}

function buildArtifact({source,provenance,artifactContext}) {
  const context=canonicalCopy(artifactContext);
  const sourceCopy=canonicalCopy(source);
  const provenanceCopy=canonicalCopy(provenance);
  const content=decorateContentWithProvenance(sourceCopy,provenanceCopy);
  return {
    schema_version:"acp.v1",
    document_type:"pm-analysis",
    artifact_id:context.artifact_id,
    revision:context.revision,
    run_id:context.run_id,
    producer:context.producer,
    runtime_identity:context.runtime_identity,
    created_at:context.created_at,
    provenance:provenanceCopy,
    parents:context.parents,
    inputs:context.inputs,
    content_sha256:sha256Canonical(content),
    content,
  };
}

export function buildPmAnalysis({source,provenance,artifactContext}={}) {
  let artifact;
  try {
    artifact=buildArtifact({source,provenance,artifactContext});
  } catch (error) {
    throw new TypeError(
      `Cannot build pm-analysis from non-canonical inputs: ${
        error instanceof Error ? error.message : "invalid input"
      }`,
      {cause:error},
    );
  }
  const result=validatePmAnalysis(artifact);
  if (!result.valid) {
    throw new TypeError(
      `Cannot build invalid pm-analysis: ${result.findings.map(item =>
        `${item.type} at ${item.path}`,
      ).join("; ")}`,
    );
  }
  return deepFreeze(artifact);
}

export function validatePmAnalysis(analysis) {
  let canonical;
  try {
    canonical=canonicalCopy(analysis);
  } catch (error) {
    return {
      valid:false,
      complete:false,
      findings:[finding(
        "CANONICAL_JSON",
        "/",
        error instanceof Error ? error.message : "PM analysis is not canonical JSON",
      )],
    };
  }

  const findings=[
    ...roleBoundaryFindings(canonical),
    ...integrityFindings(canonical),
    ...epicCandidateCircularFindings(canonical.content),
  ];
  const shape=validateDocument(canonical,"pm-analysis.v1");
  if (!shape.valid) findings.push(...formatValidationErrors(shape.errors));
  if (shape.valid && findings.length===0) {
    findings.push(...semanticFindings(canonical.content));
  }
  return {
    valid:findings.length===0,
    complete:findings.length===0,
    findings,
  };
}
