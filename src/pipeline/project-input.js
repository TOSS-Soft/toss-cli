import {types as utilTypes} from "node:util";

import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {fromYamlProjection} from "../contracts/yaml-projection.js";

const SERVICE_KEYS=new Set(["artifactStore","readInput","prompt"]);
const STORE_KEYS=new Set(["append","get","list","verify","recover"]);
const ARTIFACT_REFERENCE_KEYS=new Set([
  "document_type","artifact_id","revision","content_sha256",
]);
const PROJECT_INPUT_KEYS=new Set([
  "schema_version","project_id","analysis_id","created_at","run_id",
  "runtime_identity","provenance","artifacts",
]);
const PROJECT_ARTIFACT_KEYS=new Set([
  "pm_analysis","decision_enrichments","architecture","adrs","issue_plan",
]);
const SCHEMA_BY_TYPE=Object.freeze({
  "pm-analysis":"pm-analysis.v1",
  architecture:"architecture.v1",
  adr:"adr.v1",
  "issue-plan":"issue-plan.v1",
  "spec-audit":"spec-audit.v1",
  "transition-event":"transition-event.v1",
  "project-input":"project-input.v1",
  "feature-delta":"feature-delta.v1",
});

export class OrchestrationError extends Error {
  constructor(code,message,exitCode) {
    super(message);
    this.name="OrchestrationError";
    this.code=code;
    this.exitCode=exitCode;
  }
}

export function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function canonicalCopy(value,label="value") {
  try {
    if (utilTypes.isProxy(value)) throw new TypeError("proxies are unsupported");
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON`,{cause:error});
  }
}

function isNativeTypeError(value) {
  try {
    return utilTypes.isNativeError(value) && Object.getPrototypeOf(value)===TypeError.prototype;
  } catch {
    return false;
  }
}

function plainRecord(value,label,allowed,{required=allowed}={}) {
  if (!value || typeof value!=="object" || Array.isArray(value) ||
      utilTypes.isProxy(value)) {
    throw new TypeError(`${label} must be a plain canonical object`);
  }
  const prototype=Object.getPrototypeOf(value);
  if (prototype!==Object.prototype && prototype!==null) {
    throw new TypeError(`${label} must use a plain object prototype`);
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const keys=Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key==="symbol")) {
    throw new TypeError(`${label} symbol properties are unsupported`);
  }
  for (const key of keys) {
    const descriptor=descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} accessor or hidden property is unsupported: ${key}`);
    }
    if (allowed && !allowed.has(key)) {
      throw new TypeError(`${label} is closed; unexpected property ${key}`);
    }
  }
  for (const key of required ?? []) {
    if (!Object.hasOwn(descriptors,key)) throw new TypeError(`${label} requires ${key}`);
  }
  const result=Object.create(null);
  for (const key of keys) result[key]=descriptors[key].value;
  return result;
}

export function commandServices(value) {
  let services;
  let storeRecord;
  try {
    services=plainRecord(value,"command services",SERVICE_KEYS,{
      required:new Set(["artifactStore"]),
    });
    storeRecord=plainRecord(
      services.artifactStore,"artifactStore",STORE_KEYS,
      {required:new Set(["append","get","list","verify"])},
    );
  } catch (error) {
    throw new OrchestrationError(
      "COMMAND_CONTEXT_INVALID",
      error instanceof Error ? error.message : "Command services are invalid",
      3,
    );
  }
  const store=Object.create(null);
  for (const key of ["append","get","list","verify"]) {
    if (typeof storeRecord[key]!=="function") {
      throw new TypeError(`artifactStore.${key} must be an own enumerable data-function`);
    }
    store[key]=storeRecord[key];
  }
  for (const key of ["readInput","prompt"]) {
    if (services[key]!==undefined && typeof services[key]!=="function") {
      throw new TypeError(`${key} must be an own enumerable data-function`);
    }
  }
  return Object.freeze({
    store:Object.freeze(store),
    readInput:services.readInput,
    prompt:services.prompt,
  });
}

function assertText(value,label) {
  if (typeof value!=="string" || value.trim().length===0) {
    throw new TypeError(`${label} must be a non-blank string`);
  }
}

function validationError(value,schemaId,label) {
  const result=validateDocument(value,schemaId);
  if (result.valid) return;
  const first=result.errors[0];
  throw new OrchestrationError(
    "ORCHESTRATION_VALIDATION_FAILED",
    `${label} is invalid${first?.instancePath ?? ""}: ${first?.message ?? "schema validation failed"}`,
    5,
  );
}

function sameSource(artifact,provenance) {
  return artifact.provenance?.source_revision===provenance.source_revision &&
    artifact.provenance?.source_sha256===provenance.source_sha256;
}

export function normalizeProjectInput(value) {
  const record=plainRecord(value,"project input",PROJECT_INPUT_KEYS);
  if (record.schema_version!=="project-command-input.v1") {
    throw new TypeError("project input schema_version must be project-command-input.v1");
  }
  for (const key of ["project_id","analysis_id","created_at","run_id"]) {
    assertText(record[key],`project input ${key}`);
  }
  const artifacts=plainRecord(record.artifacts,"project input artifacts",PROJECT_ARTIFACT_KEYS);
  if (!Array.isArray(artifacts.decision_enrichments) || !Array.isArray(artifacts.adrs)) {
    throw new TypeError("project input decision_enrichments and adrs must be arrays");
  }
  const copied=canonicalCopy({
    schema_version:record.schema_version,
    project_id:record.project_id,
    analysis_id:record.analysis_id,
    created_at:record.created_at,
    run_id:record.run_id,
    runtime_identity:record.runtime_identity,
    provenance:record.provenance,
    artifacts:{
      pm_analysis:artifacts.pm_analysis,
      decision_enrichments:artifacts.decision_enrichments,
      architecture:artifacts.architecture,
      adrs:artifacts.adrs,
      issue_plan:artifacts.issue_plan,
    },
  },"project input");
  const typed=[
    [copied.artifacts.pm_analysis,"pm-analysis.v1"],
    [copied.artifacts.architecture,"architecture.v1"],
    ...copied.artifacts.adrs.map(adr => [adr,"adr.v1"]),
    [copied.artifacts.issue_plan,"issue-plan.v1"],
  ];
  for (const [artifact,schemaId] of typed) {
    validationError(artifact,schemaId,artifact?.document_type ?? schemaId);
    if (!sameSource(artifact,copied.provenance)) {
      throw new OrchestrationError(
        "STALE_PROJECT_SOURCE",
        "Every supplied project artifact must match the exact project source provenance",
        6,
      );
    }
  }
  return deepFreeze(copied);
}

export function parseCommandInput(text,label) {
  if (typeof text!=="string") throw new TypeError(`${label} reader must return text`);
  try {
    return JSON.parse(text);
  } catch {
    return fromYamlProjection(text);
  }
}

export async function acquireInput(command,services,{kind,normalize,missingCode}) {
  let raw;
  if (command.options.from!==null) {
    if (typeof services.readInput!=="function") {
      throw new OrchestrationError(missingCode,`${kind} input reader is unavailable`,3);
    }
    raw=parseCommandInput(await services.readInput(command.options.from),`${kind} input`);
  } else if (command.interactive) {
    if (typeof services.prompt!=="function") {
      throw new OrchestrationError(missingCode,`${kind} interactive prompt is unavailable`,3);
    }
    raw=await services.prompt(Object.freeze({kind,command:command.name}));
  } else {
    throw new OrchestrationError(missingCode,`${kind} input is required`,3);
  }
  return normalize(raw);
}

export function exactReference(artifact) {
  return deepFreeze({
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  });
}

function sameReference(left,right) {
  return canonicalJson(left)===canonicalJson(right);
}

function canonicalReference(value,label) {
  const reference=canonicalCopy(plainRecord(
    value,label,ARTIFACT_REFERENCE_KEYS,
  ),label);
  if (typeof reference.document_type!=="string" || reference.document_type.length===0 ||
      typeof reference.artifact_id!=="string" || reference.artifact_id.length===0 ||
      !Number.isInteger(reference.revision) || reference.revision<1 ||
      typeof reference.content_sha256!=="string" ||
      !/^[a-f0-9]{64}$/.test(reference.content_sha256)) {
    throw new TypeError(`${label} is not an exact artifact reference`);
  }
  return reference;
}

function canonicalListFilter(value) {
  const filter=canonicalCopy(plainRecord(
    value,"artifactStore.list filter",ARTIFACT_REFERENCE_KEYS,{required:new Set()},
  ),"artifactStore.list filter");
  if (filter.document_type!==undefined &&
      (typeof filter.document_type!=="string" || filter.document_type.length===0)) {
    throw new TypeError("artifactStore.list document_type filter must be a non-empty string");
  }
  if (filter.artifact_id!==undefined &&
      (typeof filter.artifact_id!=="string" || filter.artifact_id.length===0)) {
    throw new TypeError("artifactStore.list artifact_id filter must be a non-empty string");
  }
  if (filter.revision!==undefined &&
      (!Number.isInteger(filter.revision) || filter.revision<1)) {
    throw new TypeError("artifactStore.list revision filter must be a positive integer");
  }
  if (filter.content_sha256!==undefined &&
      (typeof filter.content_sha256!=="string" ||
       !/^[a-f0-9]{64}$/.test(filter.content_sha256))) {
    throw new TypeError("artifactStore.list content_sha256 filter must be a SHA-256 hash");
  }
  return filter;
}

export async function verifiedExact(store,reference) {
  const requested=deepFreeze(canonicalReference(reference,"artifact reference"));
  let gotCopy;
  let verifiedCopy;
  try {
    const got=await store.get(deepFreeze(canonicalCopy(requested)));
    gotCopy=canonicalCopy(got,"artifactStore.get result");
    const verified=await store.verify(deepFreeze(canonicalCopy(requested)));
    verifiedCopy=canonicalCopy(verified,"artifactStore.verify result");
  } catch (error) {
    if (isNativeTypeError(error)) {
      throw new OrchestrationError(
        "REFERENCE_RETARGET","Artifact store attempted to mutate or retarget an exact reference",5,
      );
    }
    throw error;
  }
  const gotRef=exactReference(gotCopy);
  const verifiedRef=exactReference(verifiedCopy);
  if (!sameReference(gotRef,requested) || !sameReference(verifiedRef,requested) ||
      canonicalJson(gotCopy)!==canonicalJson(verifiedCopy)) {
    throw new OrchestrationError(
      "REFERENCE_RETARGET",
      "Artifact store get and verify returned contradictory exact revisions",
      5,
    );
  }
  validationError(verifiedCopy,"artifact-envelope.v1","artifact envelope");
  const schemaId=SCHEMA_BY_TYPE[verifiedCopy.document_type];
  if (schemaId) validationError(verifiedCopy,schemaId,verifiedCopy.document_type);
  return deepFreeze(verifiedCopy);
}

export async function listedArtifacts(store,filter={}) {
  const requestedFilter=deepFreeze(canonicalListFilter(filter));
  let listed;
  try {
    listed=await store.list(deepFreeze(canonicalCopy(requestedFilter)));
  } catch (error) {
    if (isNativeTypeError(error)) {
      throw new OrchestrationError(
        "FILTER_VIOLATION","Artifact store attempted to mutate the list filter",5,
      );
    }
    throw error;
  }
  const rows=canonicalCopy(listed,"artifactStore.list result");
  if (!Array.isArray(rows)) throw new TypeError("artifactStore.list must return an array");
  const seen=new Set();
  const verified=[];
  for (const row of rows) {
    if (Object.entries(requestedFilter).some(([key,value]) => row[key]!==value)) {
      throw new OrchestrationError(
        "FILTER_VIOLATION","Artifact store list returned a row outside the exact filter",5,
      );
    }
    const reference=exactReference(row);
    const key=canonicalJson({
      document_type:reference.document_type,
      artifact_id:reference.artifact_id,
      revision:reference.revision,
    });
    if (seen.has(key)) {
      throw new OrchestrationError(
        "DUPLICATE_REVISION_IDENTITY",
        "Artifact store list returned conflicting rows for one revision identity",5,
      );
    }
    seen.add(key);
    const exact=await verifiedExact(store,reference);
    if (canonicalJson(row)!==canonicalJson(exact)) {
      throw new OrchestrationError(
        "AMBIGUOUS_ARTIFACT_HISTORY",
        "Artifact store list contradicted get and verify for an exact revision",5,
      );
    }
    verified.push(exact);
  }
  if (requestedFilter.revision===undefined && requestedFilter.content_sha256===undefined) {
    const histories=new Map();
    for (const row of verified) {
      const identity=canonicalJson({
        document_type:row.document_type,
        artifact_id:row.artifact_id,
      });
      const revisions=histories.get(identity) ?? [];
      revisions.push(row.revision);
      histories.set(identity,revisions);
    }
    for (const revisions of histories.values()) {
      revisions.sort((left,right) => left-right);
      if (revisions.some((revision,index) => revision!==index+1)) {
        throw new OrchestrationError(
          "AMBIGUOUS_ARTIFACT_HISTORY","Artifact revision history is not contiguous",5,
        );
      }
    }
  }
  return verified;
}

export async function latestArtifact(store,documentType,artifactId) {
  const rows=await listedArtifacts(store,{document_type:documentType,artifact_id:artifactId});
  rows.sort((left,right) => left.revision-right.revision);
  for (const [index,row] of rows.entries()) {
    if (row.revision!==index+1) {
      throw new OrchestrationError(
        "AMBIGUOUS_ARTIFACT_HISTORY","Artifact revision history is not contiguous",5,
      );
    }
  }
  return rows.at(-1) ?? null;
}

export async function appendVerified(store,draft,schemaId) {
  const expected=deepFreeze(canonicalCopy(draft,"artifact draft"));
  validationError(expected,schemaId,expected.document_type);
  let appendedRaw;
  try {
    appendedRaw=await store.append(deepFreeze(canonicalCopy(expected)));
  } catch (error) {
    if (isNativeTypeError(error)) {
      throw new OrchestrationError(
        "APPEND_MUTATION","Artifact store attempted to mutate the immutable append draft",5,
      );
    }
    throw error;
  }
  let appended;
  try {
    appended=canonicalCopy(appendedRaw,"artifactStore.append result");
  } catch {
    throw new OrchestrationError(
      "APPEND_MUTATION","Artifact store returned a malformed appended artifact",5,
    );
  }
  const reference=exactReference(appended);
  if (canonicalJson(expected)!==canonicalJson(appended)) {
    throw new OrchestrationError(
      "APPEND_MUTATION","Artifact store appended an artifact different from the immutable draft",5,
    );
  }
  let verified;
  try {
    verified=await verifiedExact(store,reference);
  } catch {
    throw new OrchestrationError(
      "APPEND_MUTATION","Appended artifact verification was retargeted or contradicted",5,
    );
  }
  if (canonicalJson(expected)!==canonicalJson(verified)) {
    throw new OrchestrationError(
      "APPEND_MUTATION","Appended artifact verification contradicted the immutable draft",5,
    );
  }
  return verified;
}

export function verifiedOrchestrationStore(store) {
  return Object.freeze({
    list:async (filter={}) => listedArtifacts(store,filter),
    verify:async reference => verifiedExact(store,reference),
    append:async draft => {
      const canonical=canonicalCopy(draft,"orchestration artifact draft");
      const schemaId=SCHEMA_BY_TYPE[canonical.document_type];
      if (!schemaId) {
        throw new OrchestrationError(
          "ORCHESTRATION_VALIDATION_FAILED",
          `Unsupported orchestration artifact type ${String(canonical.document_type)}`,
          5,
        );
      }
      return appendVerified(store,canonical,schemaId);
    },
  });
}

export async function persistProjectInput(store,input) {
  const artifactId=`project-input:${input.project_id}`;
  const previous=await latestArtifact(store,"project-input",artifactId);
  const content={
    schema_version:input.schema_version,
    project_id:input.project_id,
    analysis_id:input.analysis_id,
    artifacts:input.artifacts,
  };
  const contentSha256=sha256Canonical(content);
  if (previous?.content_sha256===contentSha256) return {artifact:previous,reused:true};
  const draft={
    schema_version:"acp.v1",
    document_type:"project-input",
    artifact_id:artifactId,
    revision:(previous?.revision ?? 0)+1,
    run_id:input.run_id,
    producer:{role:"orchestrator",identity:"toss-project-orchestrator"},
    runtime_identity:input.runtime_identity,
    created_at:input.created_at,
    provenance:input.provenance,
    parents:previous ? [exactReference(previous)] : [],
    inputs:[],
    content_sha256:contentSha256,
    content,
  };
  return {artifact:await appendVerified(store,draft,"project-input.v1"),reused:false};
}

export function projectInputFromArtifact(artifact) {
  validationError(artifact,"project-input.v1","project-input");
  return normalizeProjectInput({
    ...artifact.content,
    created_at:artifact.created_at,
    run_id:artifact.run_id,
    runtime_identity:artifact.runtime_identity,
    provenance:artifact.provenance,
  });
}
