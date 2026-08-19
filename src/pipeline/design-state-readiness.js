import {createHash,createPublicKey} from "node:crypto";

import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {createDesignOrchestrator} from "./design-orchestrator.js";
import {validateDesignArtifact} from "./design-contracts.js";

const FULL_REGISTRY_KEYS=Object.freeze([
  "schema_version","registry_id","revision","actors","content_sha256",
]);
const FULL_ACTOR_KEYS=Object.freeze([
  "actor_id","actor_role","public_key","public_key_fingerprint",
  "allowed_publications","allowed_routes",
]);
const DESIGN_ACTOR_KEYS=Object.freeze([
  "actor_id","actor_role","public_key","allowed_routes",
]);
const ROUTE=Object.freeze({
  authority:"A3",verification_kind:"A3_VERIFIED_CEO_OR_USER_AUTHORITY",
});
const ROUTES=Object.freeze({
  A2:Object.freeze({
    verification_kind:"A2_ARCHITECT_OR_SPECIALIST_EVIDENCE",
    actor_roles:Object.freeze(["ARCHITECT","SPECIALIST"]),
  }),
  A3:Object.freeze({
    verification_kind:ROUTE.verification_kind,
    actor_roles:Object.freeze(["CEO","USER"]),
  }),
});

function copy(value,label) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON`,{cause:error});
  }
}

function exactKeys(value,keys,label) {
  if (!value || typeof value!=="object" || Array.isArray(value) ||
      !new Set([Object.prototype,null]).has(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a closed object`);
  }
  const actual=Object.keys(value).sort();
  const expected=[...keys].sort();
  if (canonicalJson(actual)!==canonicalJson(expected)) {
    throw new TypeError(`${label} has unexpected or missing properties`);
  }
}

function closedKeys(value,allowed,required,label) {
  if (!value || typeof value!=="object" || Array.isArray(value) ||
      !new Set([Object.prototype,null]).has(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a closed object`);
  }
  if (Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value,key))) {
    throw new TypeError(`${label} has unexpected or missing properties`);
  }
}

function canonicalPublicKey(value,label) {
  if (typeof value!=="string" || value.length===0) {
    throw new TypeError(`${label} must be a public key`);
  }
  const input=value.endsWith("\n") ? value : `${value}\n`;
  let key;
  try {
    key=createPublicKey(input);
  } catch (error) {
    throw new TypeError(`${label} must be a valid public key`,{cause:error});
  }
  if (key.asymmetricKeyType!=="ed25519" ||
      key.export({format:"pem",type:"spki"}).toString()!==input) {
    throw new TypeError(`${label} must be one canonical Ed25519 SPKI key`);
  }
  return {input,key};
}

function exactRoute(value,label,{designOnly=false,actorRole}={}) {
  exactKeys(value,["authority","verification_kind"],label);
  const expected=ROUTES[value.authority];
  if (!expected || value.verification_kind!==expected.verification_kind ||
      (actorRole!==undefined && !expected.actor_roles.includes(actorRole)) ||
      (designOnly && value.authority!=="A3")) {
    throw new TypeError(`${label} contradicts its trusted authority role`);
  }
}

function designViewFromActors(actors,{full}) {
  if (!Array.isArray(actors) || actors.length===0) {
    throw new TypeError("Trusted authority registry requires actors");
  }
  const seen=new Set();
  const selected=[];
  for (const [index,actor] of actors.entries()) {
    const label=`Trusted authority actor ${index}`;
    if (full) {
      closedKeys(actor,FULL_ACTOR_KEYS,FULL_ACTOR_KEYS.filter(key =>
        key!=="allowed_routes"),label);
    } else {
      exactKeys(actor,DESIGN_ACTOR_KEYS,label);
    }
    if (typeof actor.actor_id!=="string" || actor.actor_id.trim().length===0 ||
        seen.has(actor.actor_id) || !Object.values(ROUTES).some(route =>
          route.actor_roles.includes(actor.actor_role))) {
      throw new TypeError(`${label} identity is invalid or duplicated`);
    }
    seen.add(actor.actor_id);
    const {input,key}=canonicalPublicKey(actor.public_key,`${label}.public_key`);
    if (full) {
      const fingerprint=createHash("sha256").update(key.export({
        format:"der",type:"spki",
      })).digest("hex");
      if (actor.public_key_fingerprint!==fingerprint ||
          !Array.isArray(actor.allowed_publications)) {
        throw new TypeError(`${label} publication authority metadata is invalid`);
      }
      const publicationKeys=new Set();
      for (const [publicationIndex,publication] of actor.allowed_publications.entries()) {
        exactKeys(publication,["approval_kind","repository"],
          `${label}.allowed_publications[${publicationIndex}]`);
        if (publication.approval_kind!=="GITHUB_ISSUE_PUBLICATION" ||
            typeof publication.repository!=="string" ||
            !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+$/u.test(
              publication.repository)) {
          throw new TypeError(`${label} publication route is invalid`);
        }
        const publicationKey=canonicalJson(publication);
        if (publicationKeys.has(publicationKey)) {
          throw new TypeError(`${label} duplicates a publication route`);
        }
        publicationKeys.add(publicationKey);
      }
    }
    if (actor.allowed_routes!==undefined) {
      if (!Array.isArray(actor.allowed_routes) || actor.allowed_routes.length===0) {
        throw new TypeError(`${label}.allowed_routes must be a non-empty array`);
      }
      const routeKeys=new Set();
      for (const [routeIndex,route] of actor.allowed_routes.entries()) {
        exactRoute(route,`${label}.allowed_routes[${routeIndex}]`,{
          designOnly:!full,actorRole:actor.actor_role,
        });
        const routeKey=canonicalJson(route);
        if (routeKeys.has(routeKey)) throw new TypeError(`${label} duplicates an authority route`);
        routeKeys.add(routeKey);
      }
    }
    if (new Set(["CEO","USER"]).has(actor.actor_role) &&
        actor.allowed_routes?.some(route => canonicalJson(route)===canonicalJson(ROUTE))) {
      selected.push({
        actor_id:actor.actor_id,actor_role:actor.actor_role,
        public_key:input,allowed_routes:[ROUTE],
      });
    }
  }
  if (selected.length===0) {
    throw new TypeError("Trusted authority registry has no A3 CEO or USER design authority");
  }
  return {actors:selected};
}

export function trustedDesignAuthorityRegistry(value) {
  const registry=copy(value,"Trusted authority registry");
  if (Object.keys(registry).length===1 && Object.hasOwn(registry,"actors")) {
    exactKeys(registry,["actors"],"Trusted design authority registry");
    return designViewFromActors(registry.actors,{full:false});
  }
  exactKeys(registry,FULL_REGISTRY_KEYS,"Trusted publication authority registry");
  if (registry.schema_version!=="github-publication-authority-registry.v1" ||
      typeof registry.registry_id!=="string" || registry.registry_id.trim().length===0 ||
      !Number.isSafeInteger(registry.revision) || registry.revision<1 ||
      typeof registry.content_sha256!=="string" ||
      !/^[a-f0-9]{64}$/u.test(registry.content_sha256)) {
    throw new TypeError("Trusted publication authority registry metadata is invalid");
  }
  const {content_sha256,...unsigned}=registry;
  if (sha256Canonical(unsigned)!==content_sha256) {
    throw new TypeError("Trusted publication authority registry content hash does not match");
  }
  return designViewFromActors(registry.actors,{full:true});
}

function reference(artifact) {
  return {
    document_type:artifact.document_type,artifact_id:artifact.artifact_id,
    revision:artifact.revision,content_sha256:artifact.content_sha256,
  };
}

function sorted(values) {
  return [...values].sort((left,right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)));
}

function exactSet(left,right,label) {
  const leftKeys=left.map(canonicalJson);
  const rightKeys=right.map(canonicalJson);
  if (new Set(leftKeys).size!==leftKeys.length ||
      new Set(rightKeys).size!==rightKeys.length ||
      canonicalJson([...leftKeys].sort())!==canonicalJson([...rightKeys].sort())) {
    throw new TypeError(`${label} is not an exact duplicate-free set`);
  }
}

export function verifyDesignStateGraph({state,designGraph,authorityRegistry}) {
  const envelope=copy(state,"Design state artifact");
  const graph=copy(designGraph,"Design graph");
  const validation=validateDocument(envelope,"design-orchestration-state.v1");
  if (!validation.valid || envelope.content_sha256!==sha256Canonical(envelope.content)) {
    throw new TypeError("Design state artifact is invalid or mutable");
  }
  if (!Array.isArray(graph) || graph.length===0) {
    throw new TypeError("Design state requires a non-empty exact graph");
  }
  const authority=trustedDesignAuthorityRegistry(authorityRegistry);
  const snapshot=createDesignOrchestrator({authorityRegistry:authority})
    .verifyStateSnapshot({content:envelope.content,provenance:envelope.provenance});
  const graphRefs=graph.map(reference);
  exactSet(snapshot.content.artifact_refs,graphRefs,
    "Design state artifact references");
  const expectedInputs=[
    ...snapshot.content.source_artifact_refs,...snapshot.content.artifact_refs,
  ];
  if (new Set(envelope.inputs.map(canonicalJson)).size!==envelope.inputs.length ||
      canonicalJson(envelope.inputs)!==canonicalJson(expectedInputs)) {
    throw new TypeError("Design state envelope inputs are not the exact ordered source and graph references");
  }
  const commitments=snapshot.content.payload_commitments;
  if (commitments.length!==graph.length) {
    throw new TypeError("Design state commitments do not close the exact graph");
  }
  const commitmentKeys=new Set();
  for (const row of commitments) {
    const key=canonicalJson(row.expected_artifact_ref);
    if (commitmentKeys.has(key) || row.status!=="PERSISTED" ||
        !row.artifact_ref || canonicalJson(row.artifact_ref)!==key) {
      throw new TypeError("Design state commitments are duplicate or not persisted");
    }
    commitmentKeys.add(key);
    const matches=graph.filter(artifact => canonicalJson(reference(artifact))===key);
    if (matches.length!==1 || row.payload_sha256!==sha256Canonical(matches[0])) {
      throw new TypeError("Design state payload commitment does not match the full artifact payload");
    }
  }
  for (const artifact of graph) {
    if (artifact.provenance?.source_revision!==envelope.provenance.source_revision ||
        artifact.provenance?.source_sha256!==envelope.provenance.source_sha256) {
      throw new TypeError("Design graph source does not match its signed state");
    }
    const artifactValidation=validateDesignArtifact(artifact,graph);
    if (!artifactValidation.valid) {
      throw new TypeError("Design graph is not schema-valid and dependency-closed");
    }
  }
  return Object.freeze({state:envelope,snapshot,graph:Object.freeze(graph),
    graph_refs:Object.freeze(sorted(graphRefs))});
}

export function stateMatchesIssuePlanTrace(state,issuePlan) {
  if (state.provenance?.source_revision!==issuePlan.provenance?.source_revision ||
      state.provenance?.source_sha256!==issuePlan.provenance?.source_sha256) return false;
  const traces=(issuePlan.content?.issues ?? []).filter(issue =>
    Object.hasOwn(issue,"ui_design_trace")).map(issue => issue.ui_design_trace);
  if (traces.length===0) return state.content?.gate==="NOT_APPLICABLE";
  const required=[];
  for (const trace of traces) {
    required.push(trace.design_system_ref);
    for (const key of [
      "flow_refs","screen_refs","component_refs","state_refs",
      "responsive_refs","accessibility_refs",
    ]) required.push(...trace[key]);
  }
  const stateKeys=new Set((state.content?.artifact_refs ?? []).map(row => canonicalJson(row)));
  return required.every(row => {
    const {entity_id,...artifactRef}=row;
    return stateKeys.has(canonicalJson(artifactRef));
  });
}
