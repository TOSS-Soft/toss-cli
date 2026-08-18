import {types as utilTypes} from "node:util";

import {canonicalJson} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {
  canonicalCopy,
  createVerifiedArtifactCatalog,
  deepFreeze,
  exactReference,
  OrchestrationError,
  parseCommandInput,
} from "../pipeline/project-input.js";
import {buildTraceGraph} from "../pipeline/traceability.js";

const REQUIRED_STORE_METHODS=Object.freeze(["append","get","list","verify"]);
const STORE_METHODS=Object.freeze([...REQUIRED_STORE_METHODS,"recover"]);
const REFERENCE_TYPES=new Set([
  "pm-analysis","architecture","adr","issue-plan","spec-audit","transition-event",
  "decision-answer","adr-approval",
]);

function ownCallable(value,label) {
  if (typeof value!=="function" || utilTypes.isProxy(value)) {
    throw new OrchestrationError(
      "COMMAND_CONTEXT_INVALID",`${label} must be a non-proxy own data-function`,3,
    );
  }
  return value;
}

function bindCallable(value,receiver) {
  return Reflect.apply(Function.prototype.bind,value,[receiver]);
}

function plainDataRecord(value,label,allowed,{required=[]}={}) {
  if (!value || typeof value!=="object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new OrchestrationError(
      "COMMAND_CONTEXT_INVALID",`${label} must be a plain own-data object`,3,
    );
  }
  const prototype=Object.getPrototypeOf(value);
  if (prototype!==Object.prototype && prototype!==null) {
    throw new OrchestrationError(
      "COMMAND_CONTEXT_INVALID",`${label} must use a plain object prototype`,3,
    );
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const keys=Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key==="symbol")) {
    throw new OrchestrationError(
      "COMMAND_CONTEXT_INVALID",`${label} symbol properties are unsupported`,3,
    );
  }
  const result=Object.create(null);
  for (const key of keys) {
    const descriptor=descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new OrchestrationError(
        "COMMAND_CONTEXT_INVALID",`${label} accessor or hidden property is unsupported: ${key}`,3,
      );
    }
    if (!allowed.has(key)) {
      throw new OrchestrationError(
        "COMMAND_CONTEXT_INVALID",`${label} is closed; unsupported property ${key}`,3,
      );
    }
    result[key]=descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(descriptors,key)) {
      throw new OrchestrationError(
        "COMMAND_CONTEXT_INVALID",`${label} requires ${key}`,3,
      );
    }
  }
  return result;
}

function safeStore(value) {
  const record=plainDataRecord(
    value,"artifactStore",new Set(STORE_METHODS),{required:REQUIRED_STORE_METHODS},
  );
  const store=Object.create(null);
  for (const method of STORE_METHODS) {
    if (!Object.hasOwn(record,method)) continue;
    store[method]=bindCallable(
      ownCallable(record[method],`artifactStore.${method}`),value,
    );
  }
  return Object.freeze(store);
}

function safeWriter(value) {
  const record=plainDataRecord(
    value,"GitHub writer",new Set(["preview","publish"]),
    {required:["preview","publish"]},
  );
  for (const method of ["preview","publish"]) {
    ownCallable(record[method],`GitHub writer.${method}`);
  }
  return Object.freeze({
    preview:bindCallable(record.preview,value),
    publish:bindCallable(record.publish,value),
  });
}

export function gateCommandServices(value,{allowed,required=["artifactStore"]}) {
  const keys=new Set(allowed);
  const record=plainDataRecord(value,"gate command services",keys,{required});
  const normalized=Object.create(null);
  normalized.store=safeStore(record.artifactStore);
  for (const key of keys) {
    if (key==="artifactStore" || !Object.hasOwn(record,key)) continue;
    if (["readInput","prompt"].includes(key)) {
      normalized[key]=record[key]===undefined ? undefined : ownCallable(record[key],key);
    } else if (key==="writer") {
      normalized.writer=safeWriter(record.writer);
    } else if (key==="repository") {
      if (typeof record.repository!=="string" ||
          !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+$/.test(record.repository)) {
        throw new OrchestrationError(
          "COMMAND_CONTEXT_INVALID","repository must be an exact owner/name identity",3,
        );
      }
      normalized.repository=record.repository;
    } else if (key==="authorityRegistry") {
      normalized.authorityRegistry=canonicalCopy(record.authorityRegistry,"authority registry");
    }
  }
  return Object.freeze(normalized);
}

export async function commandCatalog(store) {
  const catalog=createVerifiedArtifactCatalog(store);
  await catalog.refresh();
  return catalog;
}

export async function acquireGateInput(command,services,{kind,code}) {
  let value;
  if (command.options.from!==null) {
    if (typeof services.readInput!=="function") {
      throw new OrchestrationError(code,`${kind} input reader is unavailable`,3);
    }
    value=parseCommandInput(await services.readInput(command.options.from),kind);
  } else if (command.interactive) {
    if (typeof services.prompt!=="function") {
      throw new OrchestrationError(code,`${kind} prompt is unavailable`,3);
    }
    value=await services.prompt(Object.freeze({kind,command:command.name}));
  } else {
    throw new OrchestrationError(code,`${kind} input is required`,4);
  }
  return deepFreeze(canonicalCopy(value,kind));
}

function identityKey(value) {
  return canonicalJson({
    document_type:value.document_type,
    artifact_id:value.artifact_id,
    revision:value.revision,
  });
}

function latestRows(rows,label) {
  const identities=new Map();
  for (const row of rows) {
    const current=identities.get(row.artifact_id);
    if (!current || current.revision<row.revision) identities.set(row.artifact_id,row);
  }
  if (identities.size===0) return [];
  if (identities.size!==1 && label!=="adr") {
    throw new OrchestrationError(
      "AMBIGUOUS_ARTIFACT_HISTORY",`More than one ${label} identity is current`,5,
    );
  }
  return [...identities.values()].sort((left,right) =>
    left.artifact_id.localeCompare(right.artifact_id));
}

export async function latestOfType(catalog,documentType,{required=true}={}) {
  const latest=latestRows(await catalog.list({document_type:documentType}),documentType);
  if (latest.length===0 && required) {
    throw new OrchestrationError(
      "ARTIFACT_REQUIRED",`A verified ${documentType} artifact is required`,4,
    );
  }
  return documentType==="adr" ? latest : latest[0] ?? null;
}

export async function latestTransition(catalog,{required=true}={}) {
  return latestOfType(catalog,"transition-event",{required});
}

async function exactInputs(catalog,transition) {
  const seen=new Set();
  const result=[];
  for (const reference of transition.inputs) {
    if (!REFERENCE_TYPES.has(reference.document_type)) {
      throw new OrchestrationError(
        "UNEXPECTED_TRANSITION_INPUT",
        `Transition references unsupported artifact type ${String(reference.document_type)}`,5,
      );
    }
    const artifact=await catalog.get(reference);
    const key=identityKey(artifact);
    if (seen.has(key)) {
      throw new OrchestrationError(
        "DUPLICATE_REVISION_IDENTITY","Transition duplicates an artifact input identity",5,
      );
    }
    seen.add(key);
    result.push(artifact);
  }
  return result;
}

async function assertCurrent(catalog,artifacts) {
  for (const artifact of artifacts) {
    const rows=await catalog.list({
      document_type:artifact.document_type,
      artifact_id:artifact.artifact_id,
    });
    const latest=[...rows].sort((left,right) => left.revision-right.revision).at(-1);
    if (!latest || canonicalJson(exactReference(latest))!==canonicalJson(exactReference(artifact))) {
      throw new OrchestrationError(
        "STALE_GATE_ARTIFACT",
        `${artifact.document_type} ${artifact.artifact_id}@${artifact.revision} is stale`,6,
      );
    }
  }
}

function one(artifacts,type,{required=true}={}) {
  const matches=artifacts.filter(artifact => artifact.document_type===type);
  if (matches.length>1 || (required && matches.length!==1)) {
    throw new OrchestrationError(
      "AMBIGUOUS_GATE_INPUT",`Gate requires exactly one ${type} artifact`,5,
    );
  }
  return matches[0] ?? null;
}

export async function resolveGateBundle(catalog,{
  requirePlan=false,
  requireAudit=false,
  requireState=false,
  requireTrace=true,
  current=true,
}={}) {
  const transition=await latestTransition(catalog,{required:requireState});
  let artifacts=transition ? await exactInputs(catalog,transition) : [];
  const addLatest=async type => {
    if (artifacts.some(artifact => artifact.document_type===type)) return;
    const latest=await latestOfType(catalog,type,{required:false});
    if (Array.isArray(latest)) artifacts.push(...latest);
    else if (latest) artifacts.push(latest);
  };
  for (const type of ["pm-analysis","architecture","adr","issue-plan","spec-audit"]) {
    await addLatest(type);
  }
  const pmAnalysis=one(artifacts,"pm-analysis");
  const architectureArtifact=one(artifacts,"architecture");
  const adrs=artifacts.filter(artifact => artifact.document_type==="adr").sort(
    (left,right) => left.artifact_id.localeCompare(right.artifact_id),
  );
  if (adrs.length===0) {
    throw new OrchestrationError("ARTIFACT_REQUIRED","At least one verified ADR is required",4);
  }
  const issuePlan=one(artifacts,"issue-plan",{required:requirePlan});
  const boundAudit=one(artifacts,"spec-audit",{required:requireAudit});
  if (current) await assertCurrent(catalog,[
    pmAnalysis,architectureArtifact,...adrs,
    ...(issuePlan ? [issuePlan] : []),
    ...(boundAudit ? [boundAudit] : []),
    ...(transition ? [transition] : []),
  ]);
  let specAudits=[];
  if (boundAudit) specAudits=[boundAudit];
  else {
    const latest=await latestOfType(catalog,"spec-audit",{required:false});
    if (latest) specAudits=[latest];
  }
  const bundle={
    pmAnalysis,
    architecture:{artifact:architectureArtifact,adrs},
    issuePlan,
    specAudits,
    analysisState:transition,
  };
  if (issuePlan && requireTrace) bundle.traceGraph=buildTraceGraph({
    pmAnalysis,
    architecture:bundle.architecture,
    issuePlan,
  });
  const packageValue=transition?.content?.decision_package ??
    transition?.content?.next_action?.decision_package;
  if (packageValue?.document_type==="decision-package") {
    bundle.decisionPackage=packageValue;
  }
  return deepFreeze(bundle);
}

export function decisionPackageFromTransition(transition) {
  const packageValue=transition?.content?.decision_package ??
    transition?.content?.next_action?.decision_package;
  if (packageValue?.document_type!=="decision-package") {
    throw new OrchestrationError(
      "DECISION_PACKAGE_REQUIRED","Current verified state has no decision package",4,
    );
  }
  const validation=validateDocument(packageValue,"decision-package.v1");
  if (!validation.valid) {
    throw new OrchestrationError(
      "DECISION_PACKAGE_INVALID","Current decision package is invalid",5,
    );
  }
  return deepFreeze(canonicalCopy(packageValue,"decision package"));
}

export function approvalPackageFromTransition(transition) {
  const packageValue=transition?.content?.decision_package ??
    transition?.content?.next_action?.decision_package;
  if (packageValue?.document_type!=="adr-approval-package") {
    throw new OrchestrationError(
      "ADR_APPROVAL_REQUIRED","Current verified state has no ADR approval package",4,
    );
  }
  return deepFreeze(canonicalCopy(packageValue,"ADR approval package"));
}

export function validationError(value,schemaId,label) {
  const validation=validateDocument(value,schemaId);
  if (validation.valid) return;
  throw new OrchestrationError(
    "GATE_VALIDATION_FAILED",
    `${label} is invalid${validation.errors[0]?.instancePath ?? ""}: ${
      validation.errors[0]?.message ?? "schema validation failed"
    }`,5,
  );
}

export {deepFreeze,exactReference,OrchestrationError};
