import {canonicalJson} from "../contracts/acp.js";
import {buildTraceGraph,traceEntity} from "../pipeline/traceability.js";

const TRACE_ENTITY_PATTERN=/^(?:REQ|NFR|BR|ARCHQ|ADR|EPIC|ISSUE|AC)-[A-Z0-9]+(?:[._-][A-Z0-9]+)*$/;
const CONTEXT_KEYS=new Set(["artifactStore","artifacts"]);

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
  if (!store || typeof store!=="object" ||
      typeof store.list!=="function" || typeof store.get!=="function" ||
      typeof store.verify!=="function") {
    throw new TraceCommandError(
      "Trace artifactStore must expose public list, get, and verify methods",
      {code:"TRACE_STORE_INVALID"},
    );
  }
}

async function loadFromStore(store) {
  assertStore(store);
  let plans;
  try {
    plans=await store.list({document_type:"issue-plan"});
  } catch (error) {
    throw new TraceCommandError(
      `Could not discover trace issue-plan artifacts: ${error.message}`,
      {code:"TRACE_STORE_INVALID",cause:error},
    );
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
  const issuePlan=candidates.at(-1);
  const snapshots=issuePlan.content?.input_snapshots;
  if (!snapshots || typeof snapshots!=="object") {
    throw new TraceCommandError(
      "Latest issue-plan is missing exact input snapshots",
      {code:"TRACE_INPUT_INVALID"},
    );
  }
  try {
    const pmAnalysis=await store.get(artifactReference(snapshots.pm_analysis));
    const architecture=await store.get(artifactReference(snapshots.architecture));
    const adrs=[];
    for (const snapshot of snapshots.adrs ?? []) {
      adrs.push(await store.get(artifactReference(snapshot)));
    }
    return {pmAnalysis,architecture:{artifact:architecture,adrs},issuePlan};
  } catch (error) {
    throw new TraceCommandError(
      `Could not resolve exact trace input snapshot: ${error.message}`,
      {code:"TRACE_INPUT_INVALID",cause:error},
    );
  }
}

export async function runTraceCommand(args,context={}) {
  const parsed=parseArgs(args);
  assertContext(context);
  const artifacts=context.artifacts ?? await loadFromStore(context.artifactStore);
  const graph=buildTraceGraph(artifacts);
  const result=traceEntity(graph,parsed.entityId);
  return deepFreeze({format:parsed.format,result});
}
