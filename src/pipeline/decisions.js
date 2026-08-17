import {createPublicKey, verify as verifyDetached} from "node:crypto";

import {canonicalJson} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {validatePmAnalysis} from "./pm-analysis.js";

const QUESTION_ID_PATTERN=/^Q-[A-Z0-9]+(?:[._-][A-Z0-9]+)*$/;
const ENTITY_ID_PATTERN=/^(?:REQ|NFR|BR|FLOW|ARCHQ|ADR|EPIC|ISSUE|AC|RISK|ASM|Q)-[A-Z0-9]+(?:[._-][A-Z0-9]+)*$/;
const SEVERITY_RANK=Object.freeze({P0:0,P1:1,P2:2,P3:3,P4:4});
const BLOCKING_SEVERITIES=new Set(["P0","P1","P2"]);
const ASSUMPTION_SEVERITIES=new Set(["P3","P4"]);
const REVERSIBILITY_RANK=Object.freeze({
  reversible:0,
  "partially-reversible":1,
  irreversible:2,
});
const SHA256_PATTERN=/^[a-f0-9]{64}$/;
const ED25519_SIGNATURE_PATTERN=/^[A-Za-z0-9+/]{86}==$/;
const RFC3339_DATE_TIME=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const AUTHORITY_ATTESTATION_SIGNING_DOMAIN=
  "toss.decision-package.authority-attestation.v1";
const AUTHORITY_ATTESTATION_ROUTES=Object.freeze({
  A2:Object.freeze({
    verification_kind:"A2_ARCHITECT_OR_SPECIALIST_EVIDENCE",
    actor_roles:Object.freeze(["ARCHITECT","SPECIALIST"]),
  }),
  A3:Object.freeze({
    verification_kind:"A3_VERIFIED_CEO_OR_USER_AUTHORITY",
    actor_roles:Object.freeze(["CEO","USER"]),
  }),
});
const AUTHORITY_ACTOR_ROLES=new Set(["ARCHITECT","SPECIALIST","CEO","USER"]);
const INPUT_FIELDS=new Set([
  "id",
  "kind",
  "meaning",
  "question",
  "severity",
  "owner",
  "authority",
  "decision_owner",
  "technical_preference",
  "business_input_missing",
  "context",
  "impact",
  "options",
  "recommendation",
  "rationale",
  "affected_entities",
  "provenance",
  "dependencies",
  "status",
  "resolved",
  "authority_resolution",
  "reversibility",
]);
const ENRICHMENT_FIELDS=new Set([
  "id",
  "context",
  "impact",
  "status",
  "resolved",
  "authority_resolution",
  "business_input_missing",
  "technical_preference",
  "reversibility",
  "dependencies",
]);

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

function requiredText(value,label) {
  if (typeof value!=="string" || value.trim().length===0) {
    throw new TypeError(`${label} must be a non-blank string`);
  }
  return value.trim();
}

function compareCanonical(left,right) {
  const leftJson=canonicalJson(left);
  const rightJson=canonicalJson(right);
  if (leftJson===rightJson) return 0;
  return leftJson<rightJson ? -1 : 1;
}

function canonicalIds(ids,label,pattern,{allowEmpty=false}={}) {
  if (!Array.isArray(ids) || (!allowEmpty && ids.length===0)) {
    throw new TypeError(`${label} must be a ${allowEmpty ? "" : "non-empty "}array`);
  }
  const seen=new Set();
  for (const id of ids) {
    if (typeof id!=="string" || !pattern.test(id)) {
      throw new TypeError(`${label} contains an invalid identifier: ${String(id)}`);
    }
    if (seen.has(id)) throw new TypeError(`${label} must not contain duplicate identifier ${id}`);
    seen.add(id);
  }
  return [...seen].sort();
}

function questionStatus(question) {
  const hasStatus=Object.hasOwn(question,"status");
  const hasResolved=Object.hasOwn(question,"resolved");
  if (hasStatus && question.status!=="unresolved" && question.status!=="resolved") {
    throw new TypeError("Question status must be unresolved or resolved");
  }
  if (hasResolved && typeof question.resolved!=="boolean") {
    throw new TypeError("Question resolved must be a boolean when supplied");
  }
  const status=hasStatus ? question.status : question.resolved ? "resolved" : "unresolved";
  if (hasStatus && hasResolved && (question.resolved!==(status==="resolved"))) {
    throw new TypeError("Question status and resolved flag contradict each other");
  }
  return status;
}

function normalizeMeaning(value) {
  return requiredText(value,"Question meaning")
    .normalize("NFKC")
    .replace(/\s+/gu," ")
    .toLowerCase();
}

function normalizeDisplayText(value,label) {
  return requiredText(value,label).replace(/\s+/gu," ");
}

function normalizedKey(question) {
  return canonicalJson({
    affected_entities:question.affected_entities,
    meaning:question.normalized_meaning,
  });
}

function parseOptions(value) {
  if (!Array.isArray(value) || value.length===0) {
    throw new TypeError("Question options must be a non-empty array");
  }
  const byId=new Set();
  const options=value.map((option,index) => {
    if (!isPlainObject(option)) {
      throw new TypeError(`Question option ${index} must be an object`);
    }
    const id=requiredText(option.id,`Question option ${index} id`);
    if (byId.has(id)) throw new TypeError(`Question options duplicate id ${id}`);
    byId.add(id);
    return {id,label:normalizeDisplayText(option.label,`Question option ${index} label`)};
  });
  return options.sort(compareCanonical);
}

function parseProvenance(value) {
  const result=validateDocument(value,"provenance.v1");
  if (!result.valid) {
    const first=result.errors[0];
    throw new TypeError(
      `Question provenance is invalid${first?.instancePath ?? ""}: ${
        first?.message ?? "schema validation failed"
      }`,
    );
  }
  return canonicalCopy(value);
}

function requiredSha256(value,label) {
  const digest=requiredText(value,label);
  if (!SHA256_PATTERN.test(digest)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function isRfc3339DateTime(value) {
  if (typeof value!=="string") return false;
  const match=RFC3339_DATE_TIME.exec(value);
  if (!match) return false;
  const [
    ,yearText,monthText,dayText,hourText,minuteText,secondText,
    offsetHourText,offsetMinuteText,
  ]=match;
  const year=Number(yearText);
  const month=Number(monthText);
  const day=Number(dayText);
  const hour=Number(hourText);
  const minute=Number(minuteText);
  const second=Number(secondText);
  const leapYear=year%4===0 && (year%100!==0 || year%400===0);
  const daysInMonth=month===2 ? (leapYear ? 29 : 28) :
    [4,6,9,11].includes(month) ? 30 : 31;
  if (month<1 || month>12 || day<1 || day>daysInMonth ||
      hour>23 || minute>59 || second>59) {
    return false;
  }
  return offsetHourText===undefined ||
    (Number(offsetHourText)<=23 && Number(offsetMinuteText)<=59);
}

function requiredRfc3339DateTime(value,label) {
  const timestamp=requiredText(value,label);
  if (!isRfc3339DateTime(timestamp)) {
    throw new TypeError(`${label} must be an RFC3339 timestamp`);
  }
  return timestamp;
}

function authorityRouteKey(authority,verificationKind) {
  return canonicalJson({authority,verification_kind:verificationKind});
}

function rejectUnknownFields(value,allowedFields,label) {
  for (const field of Object.keys(value)) {
    if (!allowedFields.includes(field)) {
      throw new TypeError(`${label} contains unsupported field ${field}`);
    }
  }
}

function canonicalAuthorityRegistry(value) {
  if (value===undefined) return undefined;
  let registry;
  try {
    registry=canonicalCopy(value);
  } catch (error) {
    throw new TypeError(
      `Trusted authority registry must be canonical JSON: ${
        error instanceof Error ? error.message : "invalid value"
      }`,
      {cause:error},
    );
  }
  if (!isPlainObject(registry)) {
    throw new TypeError("Trusted authority registry must be a closed plain object");
  }
  const registryFields=["actors"];
  rejectUnknownFields(registry,registryFields,"Trusted authority registry");
  if (!Object.hasOwn(registry,"actors") || !Array.isArray(registry.actors) ||
      registry.actors.length===0) {
    throw new TypeError("Trusted authority registry requires a non-empty actors array");
  }

  const actors=new Map();
  for (const [index,rawActor] of registry.actors.entries()) {
    const label=`Trusted authority registry actor ${index}`;
    if (!isPlainObject(rawActor)) {
      throw new TypeError(`${label} must be a closed plain object`);
    }
    const actorFields=["actor_id","actor_role","public_key","allowed_routes"];
    rejectUnknownFields(rawActor,actorFields,label);
    for (const field of actorFields) {
      if (!Object.hasOwn(rawActor,field)) {
        throw new TypeError(`${label} requires ${field}`);
      }
    }
    const actorId=normalizeDisplayText(rawActor.actor_id,`${label} actor_id`);
    const actorRole=requiredText(rawActor.actor_role,`${label} actor_role`);
    if (!AUTHORITY_ACTOR_ROLES.has(actorRole)) {
      throw new TypeError(`${label} actor_role is invalid`);
    }
    if (actors.has(actorId)) {
      throw new TypeError(`Trusted authority registry duplicates actor_id ${actorId}`);
    }
    const publicKeyText=requiredText(rawActor.public_key,`${label} public_key`);
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----$/u.test(
      publicKeyText,
    )) {
      throw new TypeError(`${label} public_key must be an Ed25519 public PEM key`);
    }
    let publicKey;
    try {
      publicKey=createPublicKey(publicKeyText);
      // Re-export to force parse/normalization before this key becomes trusted.
      publicKey.export({format:"pem",type:"spki"});
    } catch (error) {
      throw new TypeError(`${label} public_key is not a valid public PEM key`,{
        cause:error,
      });
    }
    if (publicKey.asymmetricKeyType!=="ed25519") {
      throw new TypeError(`${label} public_key must be an Ed25519 public key`);
    }
    if (!Array.isArray(rawActor.allowed_routes) || rawActor.allowed_routes.length===0) {
      throw new TypeError(`${label} requires a non-empty allowed_routes array`);
    }
    const allowedRoutes=new Set();
    for (const [routeIndex,rawRoute] of rawActor.allowed_routes.entries()) {
      const routeLabel=`${label} allowed_routes ${routeIndex}`;
      if (!isPlainObject(rawRoute)) {
        throw new TypeError(`${routeLabel} must be a closed plain object`);
      }
      const routeFields=["authority","verification_kind"];
      rejectUnknownFields(rawRoute,routeFields,routeLabel);
      for (const field of routeFields) {
        if (!Object.hasOwn(rawRoute,field)) {
          throw new TypeError(`${routeLabel} requires ${field}`);
        }
      }
      const authority=requiredText(rawRoute.authority,`${routeLabel} authority`);
      const verificationKind=requiredText(
        rawRoute.verification_kind,
        `${routeLabel} verification_kind`,
      );
      const route=AUTHORITY_ATTESTATION_ROUTES[authority];
      if (route===undefined || verificationKind!==route.verification_kind ||
          !route.actor_roles.includes(actorRole)) {
        throw new TypeError(`${routeLabel} contradicts the actor role or authority route`);
      }
      const routeKey=authorityRouteKey(authority,verificationKind);
      if (allowedRoutes.has(routeKey)) {
        throw new TypeError(`${label} duplicates allowed route ${authority}`);
      }
      allowedRoutes.add(routeKey);
    }
    actors.set(actorId,Object.freeze({actor_role:actorRole,public_key:publicKey,allowed_routes:allowedRoutes}));
  }
  return actors;
}

/**
 * Return the exact, domain-separated canonical payload that an external
 * authority signs. This helper never signs and never accepts a public key.
 */
export function authorityAttestationSigningPayload({
  source_id,
  decision,
  rationale,
  authority,
  owner,
  verification_kind,
  actor_id,
  actor_role,
  record_id,
  record_revision,
  record_sha256,
  timestamp,
}) {
  return deepFreeze({
    domain:AUTHORITY_ATTESTATION_SIGNING_DOMAIN,
    source_id,
    decision,
    rationale,
    authority,
    owner,
    verification_kind,
    actor_id,
    actor_role,
    record_id,
    record_revision,
    record_sha256,
    timestamp,
  });
}

function parseAuthorityAttestation(value,classification,{
  source_id,
  decision,
  rationale,
},trustedAuthorityRegistry) {
  if (trustedAuthorityRegistry===undefined) {
    throw new TypeError(`Question ${source_id} requires a trusted authority registry`);
  }
  if (!isPlainObject(value)) {
    throw new TypeError(
      `Question ${source_id} requires a closed authority attestation`,
    );
  }
  const requiredFields=[
    "verification_kind",
    "actor_id",
    "actor_role",
    "record_id",
    "record_revision",
    "record_sha256",
    "timestamp",
    "signature",
  ];
  for (const field of requiredFields) {
    if (!Object.hasOwn(value,field)) {
      throw new TypeError(`Question ${source_id} authority attestation requires ${field}`);
    }
  }
  rejectUnknownFields(
    value,
    requiredFields,
    `Question ${source_id} authority attestation`,
  );
  const route=AUTHORITY_ATTESTATION_ROUTES[classification.authority];
  if (route===undefined) {
    throw new TypeError(
      `Question ${source_id} authority attestation is only defined for A2 or A3 routes`,
    );
  }
  const verificationKind=requiredText(
    value.verification_kind,
    `Question ${source_id} authority attestation verification_kind`,
  );
  if (verificationKind!==route.verification_kind) {
    throw new TypeError(
      `Question ${source_id} authority attestation verification kind does not match ${classification.authority} route`,
    );
  }
  const actorRole=requiredText(
    value.actor_role,
    `Question ${source_id} authority attestation actor_role`,
  );
  if (!route.actor_roles.includes(actorRole)) {
    throw new TypeError(
      `Question ${source_id} authority attestation actor role does not match ${classification.authority} route`,
    );
  }
  if (!Number.isInteger(value.record_revision) || value.record_revision<1) {
    throw new TypeError(
      `Question ${source_id} authority attestation record_revision must be a positive integer`,
    );
  }
  const signature=requiredText(
    value.signature,
    `Question ${source_id} authority attestation signature`,
  );
  if (!ED25519_SIGNATURE_PATTERN.test(signature) ||
      Buffer.from(signature,"base64").length!==64 ||
      Buffer.from(signature,"base64").toString("base64")!==signature) {
    throw new TypeError(
      `Question ${source_id} authority attestation signature must be canonical Ed25519 base64`,
    );
  }
  const attestation={
    verification_kind:verificationKind,
    actor_id:normalizeDisplayText(
      value.actor_id,
      `Question ${source_id} authority attestation actor_id`,
    ),
    actor_role:actorRole,
    record_id:normalizeDisplayText(
      value.record_id,
      `Question ${source_id} authority attestation record_id`,
    ),
    record_revision:value.record_revision,
    record_sha256:requiredSha256(
      value.record_sha256,
      `Question ${source_id} authority attestation record_sha256`,
    ),
    timestamp:requiredRfc3339DateTime(
      value.timestamp,
      `Question ${source_id} authority attestation timestamp`,
    ),
    signature,
  };
  const actor=trustedAuthorityRegistry.get(attestation.actor_id);
  if (actor===undefined) {
    throw new TypeError(`Question ${source_id} authority actor is not trusted`);
  }
  if (actor.actor_role!==attestation.actor_role) {
    throw new TypeError(`Question ${source_id} authority actor role does not match registry`);
  }
  if (!actor.allowed_routes.has(authorityRouteKey(
    classification.authority,
    attestation.verification_kind,
  ))) {
    throw new TypeError(`Question ${source_id} authority route is not trusted for actor`);
  }
  const payload=authorityAttestationSigningPayload({
    source_id,
    decision,
    rationale,
    authority:classification.authority,
    owner:classification.owner,
    ...attestation,
  });
  let verified=false;
  try {
    verified=verifyDetached(
      null,
      Buffer.from(canonicalJson(payload),"utf8"),
      actor.public_key,
      Buffer.from(attestation.signature,"base64"),
    );
  } catch {
    verified=false;
  }
  if (!verified) {
    throw new TypeError(`Question ${source_id} has an invalid authority signature`);
  }
  return attestation;
}

function immutableAuthorityRecordKey(attestation) {
  return canonicalJson({
    record_id:attestation.record_id,
    record_revision:attestation.record_revision,
  });
}

function assertUniqueAuthorityAttestations(questions) {
  const sourceByRecord=new Map();
  for (const question of questions) {
    const attestation=question.authority_resolution?.authority_attestation;
    if (attestation===undefined) continue;
    const key=immutableAuthorityRecordKey(attestation);
    const existing=sourceByRecord.get(key);
    if (existing!==undefined && existing.source_id!==question.id) {
      if (existing.record_sha256!==attestation.record_sha256) {
        throw new TypeError(
          `Authority attestation record hash conflicts for ${existing.source_id} and ${question.id}`,
        );
      }
      throw new TypeError(
        `Authority attestation immutable record is duplicated for ${existing.source_id} and ${question.id}`,
      );
    }
    sourceByRecord.set(key,{
      source_id:question.id,
      record_sha256:attestation.record_sha256,
    });
  }
}

function parseAuthorityResolution(value,classification,required,id,trustedAuthorityRegistry) {
  if (value===undefined) {
    if (required) {
      throw new TypeError(
        `Question ${id} requires an authority resolution for a resolved ${classification.severity}`,
      );
    }
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`Question ${id} authority resolution must be a plain object`);
  }
  const requiredFields=["decision","rationale","authority","owner","provenance"];
  const allowedFields=[...requiredFields,"authority_attestation"];
  for (const field of requiredFields) {
    if (!Object.hasOwn(value,field)) {
      throw new TypeError(`Question ${id} authority resolution requires ${field}`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!allowedFields.includes(field)) {
      throw new TypeError(`Question ${id} authority resolution contains unsupported field ${field}`);
    }
  }
  const authority=requiredText(value.authority,`Question ${id} authority resolution authority`);
  const owner=requiredText(value.owner,`Question ${id} authority resolution owner`);
  if (authority!==classification.authority || owner!==classification.owner) {
    throw new TypeError(
      `Question ${id} authority resolution contradicts ${classification.severity} mapping`,
    );
  }
  const decision=normalizeDisplayText(
    value.decision,
    `Question ${id} authority resolution decision`,
  );
  const rationale=normalizeDisplayText(
    value.rationale,
    `Question ${id} authority resolution rationale`,
  );
  const resolution={
    decision,
    rationale,
    authority,
    owner,
    provenance:parseProvenance(value.provenance),
  };
  if (BLOCKING_SEVERITIES.has(classification.severity)) {
    resolution.authority_attestation=parseAuthorityAttestation(
      value.authority_attestation,
      classification,
      {
        source_id:id,
        decision,
        rationale,
      },
      trustedAuthorityRegistry,
    );
  } else if (value.authority_attestation!==undefined) {
    throw new TypeError(
      `Question ${id} authority attestation is only valid for P0, P1, or P2`,
    );
  }
  return resolution;
}

function parseReversibility(question,severity) {
  const hasReversibility=Object.hasOwn(question,"reversibility");
  if (ASSUMPTION_SEVERITIES.has(severity) && !hasReversibility) {
    throw new TypeError(`${severity} assumptions require reversibility`);
  }
  if (!hasReversibility) return undefined;
  if (!Object.hasOwn(REVERSIBILITY_RANK,question.reversibility)) {
    throw new TypeError("Question reversibility is invalid");
  }
  return question.reversibility;
}

function classifyCanonicalQuestion(question) {
  if (!isPlainObject(question)) {
    throw new TypeError("Question classification input must be a plain object");
  }
  if (!Object.hasOwn(SEVERITY_RANK,question.severity)) {
    throw new TypeError("Question severity must be one of P0, P1, P2, P3, or P4");
  }
  if (question.business_input_missing!==undefined &&
      typeof question.business_input_missing!=="boolean") {
    throw new TypeError("business_input_missing must be a boolean");
  }
  if (question.technical_preference!==undefined &&
      typeof question.technical_preference!=="boolean") {
    throw new TypeError("technical_preference must be a boolean");
  }
  if (question.business_input_missing!==undefined && question.severity!=="P1") {
    throw new TypeError("business_input_missing is only valid for P1 questions");
  }
  if (question.technical_preference===true &&
      (question.severity==="P0" || question.severity==="P2")) {
    throw new TypeError(
      "A technical preference cannot route directly to USER without P1 business input",
    );
  }

  let authority;
  let owner;
  let hardStop=false;
  let requiresAssumptionEvidence=false;
  let businessInputMissing=false;
  switch (question.severity) {
    case "P0":
      authority="A3";
      owner="USER";
      hardStop=true;
      break;
    case "P1":
      businessInputMissing=question.business_input_missing===true;
      authority=businessInputMissing ? "A3" : "A2";
      owner=businessInputMissing ? "USER" : "ARCHITECT";
      break;
    case "P2":
      authority="A3";
      owner="USER";
      break;
    case "P3":
    case "P4":
      authority="A1";
      owner="PM";
      requiresAssumptionEvidence=true;
      break;
    default:
      throw new TypeError(`Unsupported question severity ${String(question.severity)}`);
  }

  if (question.authority!==undefined && question.authority!==authority) {
    throw new TypeError(
      `Question authority ${String(question.authority)} contradicts ${question.severity} mapping`,
    );
  }
  if (question.decision_owner!==undefined && question.decision_owner!==owner) {
    throw new TypeError(
      `Question decision owner ${String(question.decision_owner)} contradicts ${question.severity} mapping`,
    );
  }
  return deepFreeze({
    severity:question.severity,
    authority,
    owner,
    hard_stop:hardStop,
    blocks_when_unresolved:BLOCKING_SEVERITIES.has(question.severity),
    requires_assumption_evidence:requiresAssumptionEvidence,
    business_input_missing:businessInputMissing,
  });
}

export function classifyQuestion(question) {
  let canonical;
  try {
    canonical=canonicalCopy(question);
  } catch (error) {
    throw new TypeError(
      `Cannot classify a non-canonical question: ${
        error instanceof Error ? error.message : "invalid value"
      }`,
      {cause:error},
    );
  }
  return classifyCanonicalQuestion(canonical);
}

function rejectUnknownInputFields(question) {
  for (const key of Object.keys(question)) {
    if (!INPUT_FIELDS.has(key)) {
      throw new TypeError(`Question contains unsupported field ${key}`);
    }
  }
}

function analyzeQuestion(question,index,trustedAuthorityRegistry) {
  if (!isPlainObject(question)) {
    throw new TypeError(`Question at index ${index} must be a plain object`);
  }
  rejectUnknownInputFields(question);
  if (question.kind!==undefined && question.kind!=="question") {
    throw new TypeError(`Question ${index} kind must be question when supplied`);
  }
  const id=requiredText(question.id,`Question ${index} id`);
  if (!QUESTION_ID_PATTERN.test(id)) {
    throw new TypeError(`Question ${index} id must be a Q identifier`);
  }
  const classification=classifyCanonicalQuestion(question);
  const severity=classification.severity;
  const status=questionStatus(question);
  const reportedOwner=question.owner===undefined ? undefined :
    requiredText(question.owner,`Question ${id} owner`);
  const authorityResolution=parseAuthorityResolution(
    question.authority_resolution,
    classification,
    BLOCKING_SEVERITIES.has(severity) && status==="resolved",
    id,
    trustedAuthorityRegistry,
  );
  const result={
    id,
    meaning:normalizeDisplayText(question.meaning,`Question ${id} meaning`),
    normalized_meaning:normalizeMeaning(question.meaning),
    question:normalizeDisplayText(question.question,`Question ${id} text`),
    severity,
    status,
    context:normalizeDisplayText(question.context,`Question ${id} context`),
    impact:normalizeDisplayText(question.impact,`Question ${id} impact`),
    options:parseOptions(question.options),
    recommendation:normalizeDisplayText(question.recommendation,`Question ${id} recommendation`),
    rationale:normalizeDisplayText(question.rationale,`Question ${id} rationale`),
    affected_entities:canonicalIds(
      question.affected_entities,
      `Question ${id} affected_entities`,
      ENTITY_ID_PATTERN,
    ),
    provenance:parseProvenance(question.provenance),
    dependencies:canonicalIds(
      question.dependencies ?? [],
      `Question ${id} dependencies`,
      QUESTION_ID_PATTERN,
      {allowEmpty:true},
    ),
    classification,
  };
  if (reportedOwner!==undefined) result.owner=reportedOwner;
  if (authorityResolution!==undefined) result.authority_resolution=authorityResolution;
  const reversibility=parseReversibility(question,severity);
  if (reversibility!==undefined) result.reversibility=reversibility;
  if (question.business_input_missing===true) result.business_input_missing=true;
  if (question.technical_preference===true) result.technical_preference=true;
  return result;
}

function evidenceFor(question) {
  const evidence={
    source_id:question.id,
    meaning:question.meaning,
    question:question.question,
    severity:question.severity,
    status:question.status,
    context:question.context,
    impact:question.impact,
    options:question.options,
    recommendation:question.recommendation,
    rationale:question.rationale,
    affected_entities:question.affected_entities,
    provenance:question.provenance,
    dependencies:question.dependencies,
  };
  for (const field of [
    "owner",
    "reversibility",
    "business_input_missing",
    "technical_preference",
    "authority_resolution",
  ]) {
    if (question[field]!==undefined) evidence[field]=question[field];
  }
  return evidence;
}

function selectMostBlockingSeverity(members) {
  return members.reduce((selected,member) =>
    SEVERITY_RANK[member.severity]<SEVERITY_RANK[selected] ? member.severity : selected,
  members[0].severity);
}

function selectReversibility(members) {
  return members.reduce((selected,member) =>
    REVERSIBILITY_RANK[member.reversibility]>REVERSIBILITY_RANK[selected] ?
      member.reversibility : selected,
  members[0].reversibility);
}

function mergeOptions(members) {
  const labelsById=new Map();
  const optionsByCanonical=new Map();
  for (const member of members) {
    for (const option of member.options) {
      if (labelsById.has(option.id) && labelsById.get(option.id)!==option.label) {
        throw new TypeError(`Question options conflict for id ${option.id}`);
      }
      labelsById.set(option.id,option.label);
      optionsByCanonical.set(canonicalJson(option),option);
    }
  }
  return [...optionsByCanonical.values()].sort(compareCanonical);
}

function assertSourceIdentityConsistency(questions) {
  const bySourceId=new Map();
  for (const question of questions) {
    if (!isPlainObject(question) || typeof question.id!=="string") continue;
    const serialized=canonicalJson(question);
    const existing=bySourceId.get(question.id);
    if (existing!==undefined && existing!==serialized) {
      throw new TypeError(
        `Duplicate source question id ${question.id} has conflicting content (duplicate question id conflict)`,
      );
    }
    bySourceId.set(question.id,serialized);
  }
}

function buildGroups(questions) {
  const bySourceId=new Map();
  const groups=new Map();
  for (const question of questions) {
    const key=normalizedKey(question);
    const existing=bySourceId.get(question.id);
    if (existing!==undefined && existing!==key) {
      throw new TypeError(
        `Duplicate source question id ${question.id} has conflicting normalized meaning or affected entities`,
      );
    }
    bySourceId.set(question.id,key);
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(question);
  }
  return groups;
}

function mergeGroup(members,idBySource) {
  const orderedMembers=[...members].sort((left,right) =>
    compareCanonical(evidenceFor(left),evidenceFor(right)),
  );
  const id=[...new Set(members.map(member => member.id))].sort()[0];
  const severity=selectMostBlockingSeverity(members);
  const p1Members=members.filter(member => member.severity==="P1");
  const businessInputMissing=severity==="P1" && p1Members.some(member =>
    member.business_input_missing===true,
  );
  const technicalPreference=severity==="P1" && p1Members.some(member =>
    member.technical_preference===true,
  );
  const classification=classifyCanonicalQuestion({
    severity,
    ...(businessInputMissing ? {business_input_missing:true} : {}),
    ...(technicalPreference ? {technical_preference:true} : {}),
  });
  const primary=orderedMembers[0];
  const dependencies=new Set();
  for (const member of members) {
    for (const dependency of member.dependencies) {
      const canonicalId=idBySource.get(dependency);
      if (!canonicalId) {
        throw new TypeError(`Dangling decision dependency ${dependency} for ${id}`);
      }
      if (canonicalId===id) {
        throw new TypeError(`Decision ${id} has a self dependency after deduplication`);
      }
      dependencies.add(canonicalId);
    }
  }
  const evidenceByCanonical=new Map();
  for (const member of members) {
    const evidence=evidenceFor(member);
    evidenceByCanonical.set(canonicalJson(evidence),evidence);
  }
  const status=members.every(member => member.status==="resolved") ? "resolved" : "unresolved";
  if (BLOCKING_SEVERITIES.has(severity) && status==="resolved") {
    for (const member of members) {
      if (member.authority_resolution===undefined) {
        throw new TypeError(
          `Resolved blocking decision ${id} requires authority resolution evidence for ${member.id}`,
        );
      }
    }
  }
  const authorityResolutionsByCanonical=new Map();
  for (const member of members) {
    if (member.authority_resolution===undefined) continue;
    const authorityResolution={
      source_id:member.id,
      ...member.authority_resolution,
    };
    authorityResolutionsByCanonical.set(
      canonicalJson(authorityResolution),
      authorityResolution,
    );
  }
  const merged={
    id,
    meaning:primary.meaning,
    question:primary.question,
    severity,
    authority:classification.authority,
    owner:classification.owner,
    status,
    context:primary.context,
    impact:primary.impact,
    options:mergeOptions(members),
    recommendation:primary.recommendation,
    rationale:primary.rationale,
    affected_entities:primary.affected_entities,
    provenance:primary.provenance,
    dependencies:[...dependencies].sort(),
    source_ids:[...new Set(members.map(member => member.id))].sort(),
    evidence:[...evidenceByCanonical.values()].sort(compareCanonical),
  };
  if (authorityResolutionsByCanonical.size>0) {
    merged.authority_resolutions=[...authorityResolutionsByCanonical.values()].sort(compareCanonical);
  }
  if (ASSUMPTION_SEVERITIES.has(severity)) {
    merged.reversibility=selectReversibility(members.filter(member =>
      ASSUMPTION_SEVERITIES.has(member.severity),
    ));
  }
  if (businessInputMissing) merged.business_input_missing=true;
  if (technicalPreference) merged.technical_preference=true;
  return merged;
}

function stableTopologicalOrder(questions) {
  const byId=new Map();
  const indegree=new Map();
  const dependents=new Map();
  for (const question of questions) {
    if (byId.has(question.id)) {
      throw new TypeError(`Duplicate canonical decision id ${question.id}`);
    }
    byId.set(question.id,question);
    indegree.set(question.id,0);
    dependents.set(question.id,[]);
  }
  for (const question of questions) {
    for (const dependency of question.dependencies) {
      if (!byId.has(dependency)) {
        throw new TypeError(`Dangling decision dependency ${dependency} for ${question.id}`);
      }
      if (dependency===question.id) {
        throw new TypeError(`Decision ${question.id} has a self dependency`);
      }
      indegree.set(question.id,indegree.get(question.id)+1);
      dependents.get(dependency).push(question.id);
    }
  }
  const ready=[...byId.keys()].filter(id => indegree.get(id)===0).sort();
  const ordered=[];
  while (ready.length>0) {
    const id=ready.shift();
    ordered.push(byId.get(id));
    for (const dependent of dependents.get(id).sort()) {
      const next=indegree.get(dependent)-1;
      indegree.set(dependent,next);
      if (next===0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (ordered.length!==questions.length) {
    throw new TypeError("Decision dependency graph contains a cycle");
  }
  return ordered;
}

function recomputeGate(questions) {
  const unresolvedBlockingQuestionIds=[];
  const unresolvedAssumptionQuestionIds=[];
  for (const question of questions) {
    if (question.status!=="unresolved") continue;
    if (BLOCKING_SEVERITIES.has(question.severity)) {
      unresolvedBlockingQuestionIds.push(question.id);
    } else if (ASSUMPTION_SEVERITIES.has(question.severity)) {
      unresolvedAssumptionQuestionIds.push(question.id);
    }
  }
  return {
    can_continue:unresolvedBlockingQuestionIds.length===0,
    status:unresolvedBlockingQuestionIds.length===0 ? "CLEAR" : "BLOCKED",
    unresolved_blocking_question_ids:unresolvedBlockingQuestionIds,
    unresolved_assumption_question_ids:unresolvedAssumptionQuestionIds,
  };
}

function schemaError(result,label) {
  const error=result.errors[0];
  return new TypeError(
    `${label} is invalid${error?.instancePath ?? ""}: ${
      error?.message ?? "schema validation failed"
    }`,
  );
}

function analyzedEvidence(evidence,questionIndex,evidenceIndex,trustedAuthorityRegistry) {
  const {source_id:sourceId,...sourceQuestion}=evidence;
  return analyzeQuestion(
    {id:sourceId,...sourceQuestion},
    `evidence ${questionIndex}:${evidenceIndex}`,
    trustedAuthorityRegistry,
  );
}

function sortedSourceIds(value,label) {
  const sorted=canonicalIds(value,label,QUESTION_ID_PATTERN);
  if (canonicalJson(value)!==canonicalJson(sorted)) {
    throw new TypeError(`${label} must be in canonical sorted order`);
  }
  return sorted;
}

function recomputeQuestionsFromEvidence(questions,trustedAuthorityRegistry) {
  const groups=[];
  const canonicalSourceIds=new Map();
  const normalizedKeys=new Set();
  const evidenceQuestions=[];

  for (const [questionIndex,question] of questions.entries()) {
    const sourceIds=sortedSourceIds(
      question.source_ids,
      `Decision ${question.id} source_ids`,
    );
    const sourceIdSet=new Set(sourceIds);
    const seenEvidenceIds=new Set();
    const members=question.evidence.map((evidence,evidenceIndex) => {
      const sourceId=evidence.source_id;
      if (seenEvidenceIds.has(sourceId)) {
        throw new TypeError(`Decision ${question.id} evidence source IDs must be unique`);
      }
      seenEvidenceIds.add(sourceId);
      if (!sourceIdSet.has(sourceId)) {
        throw new TypeError(
          `Decision ${question.id} evidence source ID ${sourceId} is absent from source_ids`,
        );
      }
      if (canonicalSourceIds.has(sourceId)) {
        throw new TypeError(`Decision package evidence source ID ${sourceId} occurs more than once`);
      }
      canonicalSourceIds.set(sourceId,question.id);
      const member=analyzedEvidence(
        evidence,
        questionIndex,
        evidenceIndex,
        trustedAuthorityRegistry,
      );
      evidenceQuestions.push(member);
      return member;
    });
    if (members.length!==sourceIds.length ||
        members.some(member => !sourceIdSet.has(member.id))) {
      throw new TypeError(`Decision ${question.id} evidence source IDs must equal source_ids`);
    }
    const key=normalizedKey(members[0]);
    if (members.some(member => normalizedKey(member)!==key)) {
      throw new TypeError(`Decision ${question.id} evidence spans conflicting normalized meanings`);
    }
    if (normalizedKeys.has(key)) {
      throw new TypeError(`Decision package contains duplicate normalized decision ${question.id}`);
    }
    normalizedKeys.add(key);
    groups.push(members);
  }

  assertUniqueAuthorityAttestations(evidenceQuestions);

  const canonicalIdBySource=new Map();
  for (const members of groups) {
    const canonicalId=[...new Set(members.map(member => member.id))].sort()[0];
    for (const member of members) canonicalIdBySource.set(member.id,canonicalId);
  }
  return stableTopologicalOrder(
    groups.map(members => mergeGroup(members,canonicalIdBySource)),
  );
}

function assertPackageQuestions(packageValue,trustedAuthorityRegistry) {
  const recomputedQuestions=recomputeQuestionsFromEvidence(
    packageValue.questions,
    trustedAuthorityRegistry,
  );
  if (canonicalJson(packageValue.questions)!==canonicalJson(recomputedQuestions)) {
    throw new TypeError(
      "Decision package canonical questions differ from recomputed evidence",
    );
  }
  return recomputedQuestions;
}

function canonicalPackage(value,trustedAuthorityRegistry) {
  let packageValue;
  try {
    packageValue=canonicalCopy(value);
  } catch (error) {
    throw new TypeError(
      `Decision package must be canonical JSON: ${
        error instanceof Error ? error.message : "invalid value"
      }`,
      {cause:error},
    );
  }
  const shape=validateDocument(packageValue,"decision-package.v1");
  if (!shape.valid) throw schemaError(shape,"Decision package");
  const recomputedQuestions=assertPackageQuestions(packageValue,trustedAuthorityRegistry);
  const recomputedGate=recomputeGate(recomputedQuestions);
  if (canonicalJson(packageValue.gate)!==canonicalJson(recomputedGate)) {
    throw new TypeError("Decision package gate differs from recomputed evidence gate");
  }
  return packageValue;
}

export function buildDecisionPackage(questions,authorityRegistry) {
  const trustedAuthorityRegistry=canonicalAuthorityRegistry(authorityRegistry);
  let canonicalQuestions;
  try {
    canonicalQuestions=canonicalCopy(questions);
  } catch (error) {
    throw new TypeError(
      `Decision questions must be canonical JSON: ${
        error instanceof Error ? error.message : "invalid value"
      }`,
      {cause:error},
    );
  }
  if (!Array.isArray(canonicalQuestions)) {
    throw new TypeError("Decision questions must be an array");
  }
  assertSourceIdentityConsistency(canonicalQuestions);
  const analyzed=canonicalQuestions.map((question,index) =>
    analyzeQuestion(question,index,trustedAuthorityRegistry),
  );
  assertUniqueAuthorityAttestations(analyzed);
  const groups=buildGroups(analyzed);
  const idBySource=new Map();
  for (const members of groups.values()) {
    const canonicalId=[...new Set(members.map(member => member.id))].sort()[0];
    for (const member of members) idBySource.set(member.id,canonicalId);
  }
  const merged=[...groups.values()].map(members => mergeGroup(members,idBySource));
  const ordered=stableTopologicalOrder(merged);
  const packageValue={
    schema_version:"decision-package.v1",
    document_type:"decision-package",
    questions:ordered,
    gate:recomputeGate(ordered),
  };
  canonicalPackage(packageValue,trustedAuthorityRegistry);
  return deepFreeze(packageValue);
}

function canonicalPmAnalysis(value) {
  let analysis;
  try {
    analysis=canonicalCopy(value);
  } catch (error) {
    throw new TypeError(
      `PM analysis must be canonical JSON: ${
        error instanceof Error ? error.message : "invalid value"
      }`,
      {cause:error},
    );
  }
  const validation=validatePmAnalysis(analysis);
  if (!validation.valid) {
    throw new TypeError(
      `PM analysis is invalid: ${validation.findings.map(finding =>
        `${finding.type} at ${finding.path}`,
      ).join("; ")}`,
    );
  }
  return analysis;
}

function canonicalEnrichments(value) {
  let enrichments;
  try {
    enrichments=canonicalCopy(value);
  } catch (error) {
    throw new TypeError(
      `Decision enrichments must be canonical JSON: ${
        error instanceof Error ? error.message : "invalid value"
      }`,
      {cause:error},
    );
  }
  if (!Array.isArray(enrichments)) {
    throw new TypeError("Decision enrichments must be an array");
  }
  const byId=new Map();
  for (const [index,enrichment] of enrichments.entries()) {
    if (!isPlainObject(enrichment)) {
      throw new TypeError(`Decision enrichment at index ${index} must be a plain object`);
    }
    for (const field of Object.keys(enrichment)) {
      if (!ENRICHMENT_FIELDS.has(field)) {
        throw new TypeError(`Decision enrichment contains unsupported field ${field}`);
      }
    }
    const id=requiredText(enrichment.id,`Decision enrichment ${index} id`);
    if (!QUESTION_ID_PATTERN.test(id)) {
      throw new TypeError(`Decision enrichment ${id} must use a Q identifier`);
    }
    if (byId.has(id)) {
      throw new TypeError(`Duplicate enrichment for PM question ${id}`);
    }
    requiredText(enrichment.context,`Decision enrichment ${id} context`);
    requiredText(enrichment.impact,`Decision enrichment ${id} impact`);
    byId.set(id,enrichment);
  }
  return byId;
}

/**
 * Convert validated PM-owned open questions into a decision package.  The PM
 * artifact remains unchanged: only caller-supplied material enrichments fill
 * fields that pm-analysis.v1 intentionally does not own.
 */
export function buildDecisionPackageFromPmAnalysis(
  pmAnalysis,
  enrichments,
  authorityRegistry,
) {
  const analysis=canonicalPmAnalysis(pmAnalysis);
  const enrichmentById=canonicalEnrichments(enrichments);
  const pmQuestionIds=new Set();
  const questions=analysis.content.open_questions;

  for (const question of questions) {
    if (pmQuestionIds.has(question.id)) {
      throw new TypeError(`PM analysis contains duplicate open question id ${question.id}`);
    }
    pmQuestionIds.add(question.id);
  }
  for (const id of enrichmentById.keys()) {
    if (!pmQuestionIds.has(id)) {
      throw new TypeError(`Unknown enrichment for PM question ${id}`);
    }
  }
  for (const id of pmQuestionIds) {
    if (!enrichmentById.has(id)) {
      throw new TypeError(`Missing enrichment for PM question ${id}`);
    }
  }

  return buildDecisionPackage(
    questions.map(question => ({
      ...question,
      ...enrichmentById.get(question.id),
    })),
    authorityRegistry,
  );
}

export function evaluateDecisionGate(packageValue,authorityRegistry) {
  const trustedAuthorityRegistry=canonicalAuthorityRegistry(authorityRegistry);
  const canonical=canonicalPackage(packageValue,trustedAuthorityRegistry);
  return deepFreeze(recomputeGate(canonical.questions));
}
