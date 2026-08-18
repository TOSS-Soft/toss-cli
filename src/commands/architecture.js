import {createPublicKey,verify as verifyDetached} from "node:crypto";

import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateArchitecture} from "../pipeline/architecture.js";
import {
  acquireGateInput,
  approvalPackageFromTransition,
  commandCatalog,
  deepFreeze,
  exactReference,
  gateCommandServices,
  latestTransition,
  OrchestrationError,
  resolveGateBundle,
  validationError,
} from "./gate-support.js";

const SIGNING_DOMAIN="toss.adr-approval.authority-attestation.v1";
const SIGNATURE_PATTERN=/^[A-Za-z0-9+/]{86}==$/;

export function adrApprovalSigningPayload(value) {
  const copy=JSON.parse(canonicalJson(value));
  return deepFreeze({domain:SIGNING_DOMAIN,...copy});
}

function same(left,right) {
  return canonicalJson(left)===canonicalJson(right);
}

function closedApprovalInput(value) {
  const fields=[
    "schema_version","approval_kind","authority","verification_kind","actor_id",
    "actor_role","source_revision","source_sha256","adr","approval_package",
    "record_id","record_revision","record_sha256","timestamp","signature",
  ];
  if (!value || typeof value!=="object" || Array.isArray(value) ||
      !same(Object.keys(value).sort(),[...fields].sort())) {
    throw new OrchestrationError(
      "ADR_APPROVAL_INVALID","ADR approval input is a closed exact object",3,
    );
  }
  if (value.schema_version!=="adr-approval-input.v1") {
    throw new OrchestrationError(
      "ADR_APPROVAL_INVALID","ADR approval input version is unsupported",3,
    );
  }
  return value;
}

function canonicalPublicKey(value,label) {
  if (typeof value!=="string" || value.length===0 ||
      value.replace(/\r\n/gu,"").includes("\r")) {
    throw new OrchestrationError("ADR_AUTHORITY_INVALID",`${label} is not canonical PEM`,4);
  }
  const canonical=value.replace(/\r\n/gu,"\n");
  const input=canonical.endsWith("\n") ? canonical : `${canonical}\n`;
  let key;
  let exported;
  try {
    key=createPublicKey(input);
    exported=key.export({format:"pem",type:"spki"}).toString();
  } catch (error) {
    throw new OrchestrationError("ADR_AUTHORITY_INVALID",`${label} is not a public key`,4,{
      cause:error,
    });
  }
  if (key.asymmetricKeyType!=="ed25519" || exported!==input) {
    throw new OrchestrationError(
      "ADR_AUTHORITY_INVALID",`${label} must be one canonical Ed25519 SPKI key`,4,
    );
  }
  return key;
}

function trustedActor(registry,approval) {
  if (!registry || typeof registry!=="object" || Array.isArray(registry) ||
      !same(Object.keys(registry),["actors"]) || !Array.isArray(registry.actors) ||
      registry.actors.length===0) {
    throw new OrchestrationError(
      "ADR_AUTHORITY_REQUIRED","ADR approval requires independent trusted authority registry",4,
    );
  }
  const actors=new Map();
  for (const [index,actor] of registry.actors.entries()) {
    const fields=["actor_id","actor_role","public_key","allowed_routes"];
    if (!actor || typeof actor!=="object" || Array.isArray(actor) ||
        !same(Object.keys(actor).sort(),fields.sort()) ||
        typeof actor.actor_id!=="string" || actors.has(actor.actor_id) ||
        !["CEO","USER","ARCHITECT","SPECIALIST"].includes(actor.actor_role) ||
        !Array.isArray(actor.allowed_routes) || actor.allowed_routes.length===0) {
      throw new OrchestrationError(
        "ADR_AUTHORITY_INVALID",`Trusted authority actor ${index} is invalid`,4,
      );
    }
    const routes=new Set();
    for (const route of actor.allowed_routes) {
      if (!route || typeof route!=="object" || Array.isArray(route) ||
          !same(Object.keys(route).sort(),["authority","verification_kind"]) ||
          !["A2","A3"].includes(route.authority)) {
        throw new OrchestrationError(
          "ADR_AUTHORITY_INVALID",`Trusted authority actor ${index} route is invalid`,4,
        );
      }
      routes.add(canonicalJson(route));
    }
    actors.set(actor.actor_id,{
      role:actor.actor_role,
      key:canonicalPublicKey(actor.public_key,`Trusted authority actor ${index} key`),
      routes,
    });
  }
  const actor=actors.get(approval.actor_id);
  if (!actor || actor.role!==approval.actor_role ||
      !actor.routes.has(canonicalJson({
        authority:approval.authority,
        verification_kind:approval.verification_kind,
      }))) {
    throw new OrchestrationError(
      "ADR_AUTHORITY_INVALID","ADR approval actor or route is not trusted",4,
    );
  }
  return actor;
}

function verifyApproval(value,registry,{adr,packageValue}) {
  const input=closedApprovalInput(value);
  if (input.approval_kind!=="ADR_APPROVAL" || input.authority!=="A3" ||
      input.verification_kind!=="A3_VERIFIED_CEO_OR_USER_AUTHORITY" ||
      !["CEO","USER"].includes(input.actor_role) ||
      input.source_revision!==adr.provenance.source_revision ||
      input.source_sha256!==adr.provenance.source_sha256 ||
      !same(input.adr,exactReference(adr)) || !same(input.approval_package,packageValue)) {
    throw new OrchestrationError(
      "ADR_APPROVAL_STALE","ADR approval is stale or does not bind the exact pending package",6,
    );
  }
  if (!Number.isSafeInteger(input.record_revision) || input.record_revision<1 ||
      typeof input.record_id!=="string" || input.record_id.length===0 ||
      typeof input.record_sha256!=="string" || !/^[a-f0-9]{64}$/.test(input.record_sha256) ||
      typeof input.signature!=="string" || !SIGNATURE_PATTERN.test(input.signature) ||
      Buffer.from(input.signature,"base64").length!==64 ||
      Buffer.from(input.signature,"base64").toString("base64")!==input.signature) {
    throw new OrchestrationError("ADR_APPROVAL_INVALID","ADR approval record is invalid",3);
  }
  const actor=trustedActor(registry,input);
  const {schema_version:ignored,signature,...unsigned}=input;
  void ignored;
  let verified=false;
  try {
    verified=verifyDetached(
      null,
      Buffer.from(canonicalJson(adrApprovalSigningPayload(unsigned)),"utf8"),
      actor.key,
      Buffer.from(signature,"base64"),
    );
  } catch {
    verified=false;
  }
  if (!verified) {
    throw new OrchestrationError(
      "ADR_AUTHORITY_INVALID","ADR approval authority signature is invalid",4,
    );
  }
  return input;
}

async function approvalHistory(catalog) {
  const rows=await catalog.list({document_type:"adr-approval"});
  const byAdr=new Map();
  const records=new Map();
  for (const row of rows) {
    validationError(row,"adr-approval.v1","ADR approval");
    const adrKey=canonicalJson(row.content.adr);
    const prior=byAdr.get(adrKey);
    if (prior && !same(prior,row)) {
      throw new OrchestrationError(
        "ADR_APPROVAL_CONFLICT","ADR approval history conflicts",6,
      );
    }
    byAdr.set(adrKey,row);
    const record=row.content.approval_record;
    const recordKey=canonicalJson({
      record_id:record.record_id,record_revision:record.record_revision,
    });
    const claim=records.get(recordKey);
    if (claim && claim!==adrKey) {
      throw new OrchestrationError("ADR_APPROVAL_REPLAY","ADR approval record was replayed",6);
    }
    records.set(recordKey,adrKey);
  }
  return {byAdr,records};
}

async function reviewArchitecture(catalog) {
  const bundle=await resolveGateBundle(catalog,{requireState:true,current:true});
  const result=validateArchitecture({
    pmAnalysis:bundle.pmAnalysis,
    architecture:bundle.architecture.artifact,
    adrs:bundle.architecture.adrs,
  });
  return deepFreeze({
    valid:result.valid,
    complete:result.complete,
    ready_for_pm_finalization:result.ready_for_pm_finalization,
    findings:result.findings,
    architecture:exactReference(bundle.architecture.artifact),
    adrs:bundle.architecture.adrs.map(exactReference),
    pending_adrs:bundle.architecture.adrs.filter(adr =>
      adr.content.status!=="accepted" || adr.content.approval.state!=="approved"
    ).map(adr => ({
      id:adr.content.id,
      meaning:adr.content.meaning,
      artifact:exactReference(adr),
      status:adr.content.status,
      approval_state:adr.content.approval.state,
    })),
  });
}

async function approveArchitecture(command,catalog,services) {
  if (services.authorityRegistry===undefined) {
    throw new OrchestrationError(
      "ADR_AUTHORITY_REQUIRED","ADR approval requires independent authority registry",4,
    );
  }
  const transition=await latestTransition(catalog);
  const packageValue=approvalPackageFromTransition(transition);
  const matching=[];
  for (const reference of packageValue.adr_references) {
    const adr=await catalog.get(reference);
    if (adr.content.id===command.args[0]) matching.push(adr);
  }
  if (matching.length!==1) {
    throw new OrchestrationError(
      "ADR_APPROVAL_REQUIRED",`ADR ${command.args[0]} is not uniquely pending`,4,
    );
  }
  const adr=matching[0];
  const current=await catalog.list({document_type:"adr",artifact_id:adr.artifact_id});
  const latest=[...current].sort((left,right) => left.revision-right.revision).at(-1);
  if (!latest || !same(exactReference(latest),exactReference(adr))) {
    throw new OrchestrationError("ADR_APPROVAL_STALE","ADR approval targets a stale revision",6);
  }
  const input=verifyApproval(await acquireGateInput(command,services,{
    kind:"ADR approval",code:"ADR_APPROVAL_REQUIRED",
  }),services.authorityRegistry,{adr,packageValue});
  const history=await approvalHistory(catalog);
  const adrKey=canonicalJson(exactReference(adr));
  const recordKey=canonicalJson({
    record_id:input.record_id,record_revision:input.record_revision,
  });
  const claim=history.records.get(recordKey);
  if (claim && claim!==adrKey) {
    throw new OrchestrationError("ADR_APPROVAL_REPLAY","ADR approval record was replayed",6);
  }
  const {schema_version:ignored,...approvalRecord}=input;
  void ignored;
  const content={
    adr:exactReference(adr),
    source_transition:exactReference(transition),
    approval_package:packageValue,
    approval_record:approvalRecord,
    authority_registry:{content_sha256:sha256Canonical(services.authorityRegistry)},
  };
  const draft={
    schema_version:"acp.v1",
    document_type:"adr-approval",
    artifact_id:`adr-approval:${adr.content.id}`,
    revision:1,
    run_id:`${transition.run_id}:adr-approval:${adr.content.id}`,
    producer:{role:"human-authority",identity:input.actor_id},
    runtime_identity:"external-human-authority",
    created_at:input.timestamp,
    provenance:{
      source_revision:adr.provenance.source_revision,
      source_sha256:adr.provenance.source_sha256,
      locations:[`adr:${adr.artifact_id}@${adr.revision}#${adr.content_sha256}`],
    },
    parents:[],
    inputs:[exactReference(transition),exactReference(adr)],
    content_sha256:sha256Canonical(content),
    content,
  };
  validationError(draft,"adr-approval.v1","ADR approval");
  const previous=history.byAdr.get(adrKey);
  if (previous && !same(previous,draft)) {
    throw new OrchestrationError("ADR_APPROVAL_CONFLICT","ADR approval conflicts",6);
  }
  const artifact=await catalog.append(draft);
  if (catalog.hasChanges()) await catalog.refresh();
  return deepFreeze({adr_id:adr.content.id,artifact,reused:Boolean(previous)});
}

export async function runArchitectureCommand(command,serviceInput) {
  if (!["architecture.review","architecture.approve"].includes(command.name)) {
    throw new TypeError(`Unsupported architecture command ${String(command.name)}`);
  }
  const allowed=command.name==="architecture.review" ? ["artifactStore"] :
    ["artifactStore","readInput","prompt","authorityRegistry"];
  const services=gateCommandServices(serviceInput,{allowed});
  const catalog=await commandCatalog(services.store);
  return command.name==="architecture.review" ? reviewArchitecture(catalog) :
    approveArchitecture(command,catalog,services);
}
