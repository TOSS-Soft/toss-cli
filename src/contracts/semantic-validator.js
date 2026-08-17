import {ENTITY_ID_PATTERN, canonicalJson} from "./acp.js";

export const SEMANTIC_VALIDATION_BOUNDARY=Object.freeze({
  schema:[
    "closed object shape",
    "required fields and primitive constraints",
    "ACP identifier syntax",
    "internal versus external reference discrimination",
  ],
  semantic:[
    "duplicate artifact and entity identities",
    "entity prefix-to-kind meaning",
    "dangling internal entity references",
    "exact ACP artifact reference resolution",
  ],
});

const KIND_BY_PREFIX=Object.freeze({
  REQ:new Set(["requirement", "functional-requirement"]),
  NFR:new Set(["non-functional-requirement", "nonfunctional-requirement"]),
  BR:new Set(["business-rule"]),
  FLOW:new Set(["flow"]),
  ARCHQ:new Set(["architecture-question", "question"]),
  ADR:new Set(["architecture-decision", "architecture-decision-record", "decision"]),
  EPIC:new Set(["epic"]),
  ISSUE:new Set(["issue"]),
  AC:new Set(["acceptance-criterion"]),
  RISK:new Set(["risk"]),
  ASM:new Set(["assumption"]),
  Q:new Set(["question", "audit-finding"]),
});

function isPlainObject(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function graphContent(document,index) {
  if (!isPlainObject(document)) {
    throw new TypeError(`Artifact graph document at index ${index} must be an object`);
  }
  if (Object.hasOwn(document,"content")) {
    if (!isPlainObject(document.content)) {
      throw new TypeError(`Artifact graph document ${index} content must be an object`);
    }
    return document.content;
  }
  return document;
}

function artifactIdentity(artifactId,revision) {
  return `${artifactId}\u0000${revision}`;
}

function assertArtifactIdentity(document,index,artifacts) {
  if (!Object.hasOwn(document,"artifact_id") && !Object.hasOwn(document,"revision")) {
    return;
  }
  if (typeof document.artifact_id!=="string" || document.artifact_id.length===0 ||
      !Number.isSafeInteger(document.revision) || document.revision<1) {
    throw new Error(`Invalid artifact identity at graph document ${index}`);
  }
  const identity=artifactIdentity(document.artifact_id,document.revision);
  if (artifacts.has(identity)) {
    throw new Error(`Duplicate artifact identity ${document.artifact_id}@${document.revision}`);
  }
  artifacts.set(identity,{
    content_sha256:document.content_sha256,
    document_type:document.document_type,
  });
}

function collectArtifactReferences(document,index,references) {
  for (const kind of ["parents","inputs"]) {
    if (document[kind]===undefined) continue;
    if (!Array.isArray(document[kind])) {
      throw new TypeError(`Artifact graph document ${index} ${kind} must be an array`);
    }
    for (const [referenceIndex,reference] of document[kind].entries()) {
      if (!isPlainObject(reference) ||
          typeof reference.artifact_id!=="string" || reference.artifact_id.length===0 ||
          !Number.isSafeInteger(reference.revision) || reference.revision<1 ||
          typeof reference.content_sha256!=="string" ||
          !/^[a-f0-9]{64}$/.test(reference.content_sha256) ||
          (reference.document_type!==undefined &&
            (typeof reference.document_type!=="string" ||
              reference.document_type.length===0))) {
        throw new Error(`Invalid ${kind} reference at ${index}:${referenceIndex}`);
      }
      references.push({...reference,kind});
    }
  }
}

function assertEntity(entity,documentIndex,entityIndex,entities) {
  if (!isPlainObject(entity)) {
    throw new TypeError(
      `Entity ${documentIndex}:${entityIndex} must be an object`,
    );
  }
  if (typeof entity.id!=="string" || !ENTITY_ID_PATTERN.test(entity.id)) {
    throw new Error(`Invalid entity ID at ${documentIndex}:${entityIndex}`);
  }
  if (typeof entity.kind!=="string" || entity.kind.length===0 ||
      typeof entity.meaning!=="string" || entity.meaning.length===0) {
    throw new Error(`Entity ${entity.id} must declare a kind and meaning`);
  }
  const prefix=entity.id.split("-",1)[0];
  if (!KIND_BY_PREFIX[prefix]?.has(entity.kind)) {
    throw new Error(`Entity prefix ${prefix} conflicts with kind ${entity.kind}`);
  }
  const meaning=canonicalJson({kind:entity.kind,meaning:entity.meaning});
  if (entities.has(entity.id)) {
    if (entities.get(entity.id)!==meaning) {
      throw new Error(`Duplicate entity ID ${entity.id} has conflicting meaning`);
    }
    throw new Error(`Duplicate entity ID ${entity.id}`);
  }
  entities.set(entity.id,meaning);
}

function collectInternalReferences(value,references,ancestors=new Set()) {
  if (value===null || typeof value!=="object") return;
  if (ancestors.has(value)) {
    throw new TypeError("Artifact graph contains a cyclic reference");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) collectInternalReferences(item,references,ancestors);
      return;
    }
    if (!isPlainObject(value)) {
      throw new TypeError("Artifact graph must contain JSON objects only");
    }
    if (value.reference_type==="internal") {
      if (typeof value.entity_id!=="string" || !ENTITY_ID_PATTERN.test(value.entity_id)) {
        throw new Error("Invalid internal entity reference");
      }
      references.push(value.entity_id);
    }
    for (const property of Object.values(value)) {
      collectInternalReferences(property,references,ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function validateArtifactGraph(documents) {
  if (!Array.isArray(documents)) {
    throw new TypeError("Artifact graph documents must be an array");
  }
  canonicalJson(documents);

  const artifacts=new Map();
  const entities=new Map();
  const internalReferences=[];
  const artifactReferences=[];
  for (const [documentIndex,document] of documents.entries()) {
    assertArtifactIdentity(document,documentIndex,artifacts);
    collectArtifactReferences(document,documentIndex,artifactReferences);
    const content=graphContent(document,documentIndex);
    if (content.entities!==undefined) {
      if (!Array.isArray(content.entities)) {
        throw new TypeError(`Artifact graph document ${documentIndex} entities must be an array`);
      }
      for (const [entityIndex,entity] of content.entities.entries()) {
        assertEntity(entity,documentIndex,entityIndex,entities);
      }
    }
    collectInternalReferences(content,internalReferences);
  }
  for (const targetId of internalReferences) {
    if (!entities.has(targetId)) {
      throw new Error(`Dangling reference to entity ${targetId}`);
    }
  }
  for (const reference of artifactReferences) {
    const key=artifactIdentity(reference.artifact_id,reference.revision);
    if (!artifacts.has(key)) {
      throw new Error(
        `Dangling reference to artifact ${reference.artifact_id}@${reference.revision}`,
      );
    }
    const target=artifacts.get(key);
    if (target.content_sha256!==reference.content_sha256) {
      throw new Error(
        `Mismatched reference hash for artifact ${reference.artifact_id}@${reference.revision}`,
      );
    }
    if (reference.document_type!==undefined &&
        target.document_type!==reference.document_type) {
      throw new Error(
        `Mismatched reference document type for artifact ${reference.artifact_id}@${reference.revision}`,
      );
    }
  }
  return {
    valid:true,
    entity_count:entities.size,
    internal_reference_count:internalReferences.length,
  };
}
