import {canonicalJson} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {buildTraceGraph,traceEntity} from "../pipeline/traceability.js";

const TRACE_ENTITY_PATTERN=/^(?:REQ|NFR|BR|ARCHQ|ADR|EPIC|ISSUE|AC)-[A-Z0-9]+(?:[._-][A-Z0-9]+)*$/;
const CONTENT_SHA256_PATTERN=/^[a-f0-9]{64}$/;
const CONTEXT_KEYS=new Set(["artifactStore","artifacts"]);
const STORE_METHOD_NAMES=Object.freeze(["list","get","verify"]);

export class TraceCommandError extends Error {
  constructor(message,{code="TRACE_COMMAND_INVALID",cause}={}) {
    super(message,{cause});
    this.name="TraceCommandError";
    this.code=code;
  }
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

function isPlainObject(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function assertContext(context) {
  if (!isPlainObject(context)) {
    throw new TraceCommandError("Trace command context must be a plain object");
  }
  if (Object.getOwnPropertySymbols(context).length>0) {
    throw new TraceCommandError("Trace command context symbol keys are unsupported");
  }
  for (const key of Object.getOwnPropertyNames(context)) {
    const descriptor=Object.getOwnPropertyDescriptor(context,key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TraceCommandError(
        `Trace command context accessor or non-enumerable property is unsupported: ${key}`,
      );
    }
    if (!CONTEXT_KEYS.has(key)) {
      throw new TraceCommandError(`Unknown trace command context property: ${key}`);
    }
  }
  if ((context.artifacts===undefined)===(context.artifactStore===undefined)) {
    throw new TraceCommandError(
      "Trace command context requires exactly one of artifacts or artifactStore",
    );
  }
}

function parseArgs(args) {
  let normalized;
  try {
    normalized=JSON.parse(canonicalJson(args));
  } catch (error) {
    throw new TraceCommandError(
      `Trace command arguments must be canonical JSON: ${error.message}`,
      {code:"TRACE_ARGUMENT_INVALID",cause:error},
    );
  }
  if (!Array.isArray(normalized) || normalized.length===0) {
    throw new TraceCommandError(
      "Usage: toss trace <ENTITY-ID> [--json]",
      {code:"TRACE_ARGUMENT_INVALID"},
    );
  }
  const [entityId,...options]=normalized;
  if (typeof entityId!=="string" || !TRACE_ENTITY_PATTERN.test(entityId)) {
    throw new TraceCommandError(
      `Invalid trace entity ID: ${String(entityId)}`,
      {code:"TRACE_ARGUMENT_INVALID"},
    );
  }
  let json=false;
  for (const option of options) {
    if (option==="--json" && !json) json=true;
    else {
      throw new TraceCommandError(
        `Unknown option: ${String(option)}`,
        {code:"TRACE_ARGUMENT_INVALID"},
      );
    }
  }
  return {entityId,format:json ? "json" : "human"};
}

function artifactReference(snapshot) {
  return {
    document_type:snapshot.document_type,
    artifact_id:snapshot.artifact_id,
    revision:snapshot.revision,
    content_sha256:snapshot.content_sha256,
  };
}

function assertStore(store) {
  if (!store || typeof store!=="object") {
    throw new TraceCommandError(
      "Trace artifactStore must expose public list, get, and verify methods",
      {code:"TRACE_STORE_INVALID"},
    );
  }
  const methods={};
  for (const name of STORE_METHOD_NAMES) {
    const descriptor=Object.getOwnPropertyDescriptor(store,name);
    if (!descriptor?.enumerable || !("value" in descriptor) ||
        typeof descriptor.value!=="function") {
      throw new TraceCommandError(
        `Trace artifactStore ${name} must be an own enumerable data-function method`,
        {code:"TRACE_STORE_INVALID"},
      );
    }
    methods[name]=descriptor.value;
  }
  return Object.freeze(methods);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "unknown store failure";
}

function canonicalStoreValue(value,label,code) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TraceCommandError(
      `${label} must be canonical JSON: ${errorMessage(error)}`,
      {code,cause:error},
    );
  }
}

function assertArtifactReference(reference,label,{documentType}={}) {
  if (!isPlainObject(reference) ||
      Object.keys(reference).sort(compareText).join(",")!==
        "artifact_id,content_sha256,document_type,revision" ||
      typeof reference.document_type!=="string" ||
      typeof reference.artifact_id!=="string" || !reference.artifact_id ||
      !Number.isInteger(reference.revision) || reference.revision<1 ||
      typeof reference.content_sha256!=="string" ||
      !CONTENT_SHA256_PATTERN.test(reference.content_sha256) ||
      (documentType!==undefined && reference.document_type!==documentType)) {
    throw new TraceCommandError(
      `${label} must be an exact ${documentType ?? "artifact"} reference`,
      {code:"TRACE_INPUT_INVALID"},
    );
  }
  return reference;
}

function assertArtifactEnvelope(value,label,code) {
  if (!isPlainObject(value)) {
    throw new TraceCommandError(`${label} must be an artifact object`,{code});
  }
  const validation=validateDocument(value,"artifact-envelope.v1");
  if (!validation.valid) {
    throw new TraceCommandError(`${label} is not a valid artifact envelope`,{code});
  }
  return value;
}

function assertExactArtifact(artifact,reference,label) {
  const actual=artifactReference(artifact);
  if (canonicalJson(actual)!==canonicalJson(reference)) {
    throw new TraceCommandError(
      `${label} does not match its exact requested artifact reference`,
      {code:"TRACE_INPUT_INVALID"},
    );
  }
}

async function callStore(store,method,name,args,code) {
  try {
    return await Reflect.apply(method,store,args);
  } catch (error) {
    throw new TraceCommandError(
      `Trace artifactStore ${name} failed: ${errorMessage(error)}`,
      {code,cause:error},
    );
  }
}

async function readVerifiedArtifact(store,methods,reference,label) {
  const verifiedRaw=await callStore(
    store,methods.verify,"verify",[reference],"TRACE_INPUT_INVALID",
  );
  const verified=assertArtifactEnvelope(canonicalStoreValue(
    verifiedRaw,`${label} verified artifact`,"TRACE_INPUT_INVALID",
  ),`${label} verified artifact`,"TRACE_INPUT_INVALID");
  assertExactArtifact(verified,reference,`${label} verified artifact`);

  const fetchedRaw=await callStore(
    store,methods.get,"get",[reference],"TRACE_INPUT_INVALID",
  );
  const fetched=assertArtifactEnvelope(canonicalStoreValue(
    fetchedRaw,`${label} fetched artifact`,"TRACE_INPUT_INVALID",
  ),`${label} fetched artifact`,"TRACE_INPUT_INVALID");
  assertExactArtifact(fetched,reference,`${label} fetched artifact`);
  if (canonicalJson(verified)!==canonicalJson(fetched)) {
    throw new TraceCommandError(
      `${label} get and verify results do not canonically match`,
      {code:"TRACE_INPUT_INVALID"},
    );
  }
  return verified;
}

async function loadFromStore(store) {
  const methods=assertStore(store);
  const listed=await callStore(
    store,methods.list,"list",[{document_type:"issue-plan"}],"TRACE_STORE_INVALID",
  );
  const plans=canonicalStoreValue(
    listed,"Trace artifactStore list result","TRACE_STORE_INVALID",
  );
  if (!Array.isArray(plans)) {
    throw new TraceCommandError(
      "Trace artifactStore list result must be an array",
      {code:"TRACE_STORE_INVALID"},
    );
  }
  for (const plan of plans) {
    assertArtifactEnvelope(plan,"Trace artifactStore list entry","TRACE_STORE_INVALID");
    if (plan.document_type!=="issue-plan") {
      throw new TraceCommandError(
        "Trace artifactStore list returned a non-issue-plan artifact",
        {code:"TRACE_STORE_INVALID"},
      );
    }
  }
  if (plans.length===0) {
    throw new TraceCommandError(
      "No issue-plan artifact is available for tracing",
      {code:"TRACE_INPUT_MISSING"},
    );
  }
  const artifactIds=[...new Set(plans.map(plan => plan.artifact_id))].sort(compareText);
  if (artifactIds.length!==1) {
    throw new TraceCommandError(
      `Trace input is ambiguous across issue-plan artifacts: ${artifactIds.join(", ")}`,
      {code:"TRACE_INPUT_AMBIGUOUS"},
    );
  }
  const candidates=plans.filter(plan => plan.artifact_id===artifactIds[0]).sort(
    (left,right) => left.revision-right.revision,
  );
  const selected=candidates.at(-1);
  const issuePlanReference=assertArtifactReference(
    artifactReference(selected),"Selected issue-plan",{documentType:"issue-plan"},
  );
  const issuePlan=await readVerifiedArtifact(
    store,methods,issuePlanReference,"Selected issue-plan",
  );
  const snapshots=issuePlan.content?.input_snapshots;
  if (!isPlainObject(snapshots) || !Array.isArray(snapshots.adrs)) {
    throw new TraceCommandError(
      "Latest issue-plan is missing exact input snapshots",
      {code:"TRACE_INPUT_INVALID"},
    );
  }
  const pmReference=assertArtifactReference(
    snapshots.pm_analysis,"PM analysis snapshot",{documentType:"pm-analysis"},
  );
  const architectureReference=assertArtifactReference(
    snapshots.architecture,"Architecture snapshot",{documentType:"architecture"},
  );
  const adrReferences=snapshots.adrs.map((snapshot,index) =>
    assertArtifactReference(snapshot,`ADR snapshot ${index}`,{documentType:"adr"}),
  );
  const pmAnalysis=await readVerifiedArtifact(
    store,methods,pmReference,"PM analysis snapshot",
  );
  const architecture=await readVerifiedArtifact(
    store,methods,architectureReference,"Architecture snapshot",
  );
  const adrs=[];
  for (const [index,reference] of adrReferences.entries()) {
    adrs.push(await readVerifiedArtifact(
      store,methods,reference,`ADR snapshot ${index}`,
    ));
  }
  return {pmAnalysis,architecture:{artifact:architecture,adrs},issuePlan};
}

export async function runTraceCommand(args,context={}) {
  const parsed=parseArgs(args);
  assertContext(context);
  const artifacts=context.artifacts ?? await loadFromStore(context.artifactStore);
  const graph=buildTraceGraph(artifacts);
  const result=traceEntity(graph,parsed.entityId);
  return deepFreeze({format:parsed.format,result});
}
