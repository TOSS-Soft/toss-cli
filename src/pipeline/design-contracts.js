import {
  assertKnownDocumentType,
  canonicalJson,
  sha256Canonical,
} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";

const SCHEMA_BY_DOCUMENT_TYPE=Object.freeze({
  "design-brief":"design-brief.v1",
  "ux-analysis":"ux-analysis.v1",
  "user-flow":"user-flow.v1",
  "information-architecture":"information-architecture.v1",
  "wireframe-plan":"wireframe-plan.v1",
  "visual-direction":"visual-direction.v1",
  "design-system":"design-system.v1",
  "screen-spec":"screen-spec.v1",
  "prototype-manifest":"prototype-manifest.v1",
  "usability-evidence":"usability-evidence.v1",
  "design-audit":"design-audit.v1",
  "design-approval":"design-approval.v1",
});

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalCopy(value) {
  return JSON.parse(canonicalJson(value));
}

function finding(type,path,message) {
  return {type,path,message};
}

function compareText(left,right) {
  return left<right ? -1 : left>right ? 1 : 0;
}

function sortedResult(findings,extra={}) {
  findings.sort((left,right) =>
    compareText(left.type,right.type) ||
    compareText(left.path,right.path) ||
    compareText(left.message,right.message));
  return deepFreeze({valid:findings.length===0,...extra,findings});
}

function canonicalFailure(type,error) {
  return sortedResult([finding(
    type,
    "/",
    error instanceof Error ? error.message : "Input is not canonical JSON",
  )]);
}

function schemaFindings(errors) {
  return errors.map(error => {
    const missing=error.keyword==="required" ? error.params?.missingProperty : undefined;
    return finding(
      "SCHEMA_VALIDATION",
      `${error.instancePath || ""}${missing===undefined ? "" : `/${missing}`}` || "/",
      error.message ?? "Design artifact does not satisfy its contract",
    );
  });
}

function artifactIdentity(artifactId,revision) {
  return `${artifactId}\u0000${revision}`;
}

function artifactReferenceIdentity(reference) {
  return artifactIdentity(reference.artifact_id,reference.revision);
}

function artifactSource(artifact) {
  return artifact?.content?.source;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function entityDefinitions(artifact,index) {
  const content=artifact.content;
  if (!content || typeof content!=="object" || Array.isArray(content)) return [];
  const definitions=[];
  const add=(id,path) => {
    if (typeof id==="string") definitions.push({id,path,artifact});
  };
  const addArray=(rows,field,path) => {
    if (!Array.isArray(rows)) return;
    for (const [rowIndex,row] of rows.entries()) {
      if (row && typeof row==="object" && !Array.isArray(row)) {
        add(row[field],`${path}/${rowIndex}/${field}`);
      }
    }
  };
  const root=`/${index}/content`;
  switch (artifact.document_type) {
    case "design-brief": add(content.design_id,`${root}/design_id`); break;
    case "ux-analysis":
      add(content.analysis_id,`${root}/analysis_id`);
      addArray(content.users,"user_id",`${root}/users`);
      break;
    case "user-flow":
      add(content.flow_id,`${root}/flow_id`);
      addArray(content.steps,"step_id",`${root}/steps`);
      break;
    case "information-architecture":
      add(content.architecture_id,`${root}/architecture_id`);
      addArray(content.nodes,"node_id",`${root}/nodes`);
      break;
    case "wireframe-plan":
      add(content.plan_id,`${root}/plan_id`);
      addArray(content.wireframes,"wireframe_id",`${root}/wireframes`);
      break;
    case "visual-direction": add(content.direction_id,`${root}/direction_id`); break;
    case "design-system":
      add(content.system_id,`${root}/system_id`);
      addArray(content.rules,"rule_id",`${root}/rules`);
      addArray(content.components,"component_id",`${root}/components`);
      addArray(content.exceptions,"exception_id",`${root}/exceptions`);
      break;
    case "screen-spec":
      add(content.screen_id,`${root}/screen_id`);
      addArray(content.states,"state_id",`${root}/states`);
      addArray(content.responsive,"target_id",`${root}/responsive`);
      addArray(content.accessibility,"criterion_id",`${root}/accessibility`);
      break;
    case "prototype-manifest":
      add(content.prototype_id,`${root}/prototype_id`);
      addArray(content.assets,"asset_id",`${root}/assets`);
      break;
    case "usability-evidence":
      add(content.evidence_id,`${root}/evidence_id`);
      addArray(content.sessions,"session_id",`${root}/sessions`);
      for (const [sessionIndex,session] of asArray(content.sessions).entries()) {
        addArray(session?.tasks,"task_id",`${root}/sessions/${sessionIndex}/tasks`);
      }
      break;
    case "design-audit":
      add(content.audit_id,`${root}/audit_id`);
      addArray(content.findings,"finding_id",`${root}/findings`);
      break;
    case "design-approval": add(content.approval_id,`${root}/approval_id`); break;
    default: break;
  }
  return definitions;
}

function collectArtifactReferences(value,path,references) {
  if (!value || typeof value!=="object") return;
  if (Array.isArray(value)) {
    for (const [index,item] of value.entries()) {
      collectArtifactReferences(item,`${path}/${index}`,references);
    }
    return;
  }
  if (typeof value.artifact_id==="string" &&
      Number.isSafeInteger(value.revision) &&
      typeof value.content_sha256==="string") {
    references.push({reference:value,path});
    return;
  }
  for (const [key,item] of Object.entries(value)) {
    collectArtifactReferences(item,`${path}/${key}`,references);
  }
}

function graphIndexes(graph) {
  const artifacts=new Map();
  const latestRevision=new Map();
  const entities=new Map();
  const findings=[];
  for (const [index,artifact] of graph.entries()) {
    if (!artifact || typeof artifact!=="object" || Array.isArray(artifact)) {
      findings.push(finding(
        "MALFORMED_GRAPH_MEMBER",`/${index}`,"Design graph members must be objects",
      ));
      continue;
    }
    if (typeof artifact.artifact_id!=="string" ||
        !Number.isSafeInteger(artifact.revision) || artifact.revision<1) {
      findings.push(finding(
        "MALFORMED_ARTIFACT_IDENTITY",`/${index}`,"Graph artifact identity is invalid",
      ));
      continue;
    }
    const identity=artifactIdentity(artifact.artifact_id,artifact.revision);
    if (artifacts.has(identity)) {
      findings.push(finding(
        "DUPLICATE_ARTIFACT_IDENTITY",`/${index}`,
        `Duplicate artifact identity ${artifact.artifact_id}@${artifact.revision}`,
      ));
    } else {
      artifacts.set(identity,{artifact,index});
    }
    latestRevision.set(
      artifact.artifact_id,
      Math.max(latestRevision.get(artifact.artifact_id) ?? 0,artifact.revision),
    );
    for (const definition of entityDefinitions(artifact,index)) {
      if (entities.has(definition.id)) {
        findings.push(finding(
          "DUPLICATE_ENTITY_IDENTITY",definition.path,
          `Duplicate design entity identity ${definition.id}`,
        ));
      } else {
        entities.set(definition.id,definition);
      }
    }
  }
  return {artifacts,latestRevision,entities,findings};
}

function referenceFindings(graph,indexes) {
  const findings=[];
  for (const [index,artifact] of graph.entries()) {
    if (!artifact || typeof artifact!=="object" || Array.isArray(artifact)) continue;
    const references=[];
    collectArtifactReferences(artifact.parents,`/${index}/parents`,references);
    collectArtifactReferences(artifact.inputs,`/${index}/inputs`,references);
    collectArtifactReferences(artifact.content,`/${index}/content`,references);
    for (const {reference,path} of references) {
      const target=indexes.artifacts.get(artifactReferenceIdentity(reference));
      if (!target) {
        findings.push(finding(
          "DANGLING_ARTIFACT_REFERENCE",path,
          `Reference target ${reference.artifact_id}@${reference.revision} is absent`,
        ));
        continue;
      }
      if (target.artifact.content_sha256!==reference.content_sha256) {
        findings.push(finding(
          "REFERENCE_HASH_MISMATCH",`${path}/content_sha256`,
          "Reference content_sha256 does not match the target artifact",
        ));
      }
      if (reference.document_type!==undefined &&
          target.artifact.document_type!==reference.document_type) {
        findings.push(finding(
          "REFERENCE_TYPE_MISMATCH",`${path}/document_type`,
          "Reference document_type does not match the target artifact",
        ));
      }
      if ((indexes.latestRevision.get(reference.artifact_id) ?? 0)>reference.revision) {
        findings.push(finding(
          "STALE_ARTIFACT_REFERENCE",`${path}/revision`,
          `Reference does not select the latest ${reference.artifact_id} revision`,
        ));
      }
      if (artifactSource(artifact)!==undefined && artifactSource(target.artifact)!==undefined &&
          artifactSource(artifact)!==artifactSource(target.artifact)) {
        findings.push(finding(
          "CROSS_SOURCE_REFERENCE",path,
          "Design references cannot cross source-of-truth selections",
        ));
      }
      if (typeof reference.entity_id==="string") {
        const targetDefinition=entityDefinitions(target.artifact,target.index).some(
          definition => definition.id===reference.entity_id,
        );
        if (!targetDefinition) {
          findings.push(finding(
            "DANGLING_ENTITY_REFERENCE",`${path}/entity_id`,
            `Referenced entity ${reference.entity_id} is absent from the target artifact`,
          ));
        }
      }
    }
  }
  return findings;
}

function sourceFindings(graph) {
  const findings=[];
  const briefs=graph.filter(artifact => artifact?.document_type==="design-brief" &&
    artifact.content && typeof artifact.content==="object" && !Array.isArray(artifact.content) &&
    Number.isSafeInteger(artifact.revision));
  if (briefs.length===0) {
    return [finding(
      "MISSING_DESIGN_BRIEF","/","Design graph requires an authoritative design-brief",
    )];
  }
  const authoritative=briefs.reduce((left,right) =>
    left.revision>=right.revision ? left : right);
  for (const [index,artifact] of graph.entries()) {
    if (!artifact || typeof artifact!=="object" || Array.isArray(artifact)) continue;
    if (artifactSource(artifact)!==authoritative.content.source) {
      findings.push(finding(
        "SOURCE_MISMATCH",`/${index}/content/source`,
        "Artifact source must match the authoritative design-brief source",
      ));
    }
    if (artifact.provenance?.source_revision!==authoritative.provenance?.source_revision ||
        artifact.provenance?.source_sha256!==authoritative.provenance?.source_sha256) {
      findings.push(finding(
        "STALE_SOURCE_REVISION",`/${index}/provenance`,
        "Artifact provenance must match the authoritative design-brief source revision and hash",
      ));
    }
  }
  return findings;
}

function linkedEntityFindings(graph,indexes) {
  const findings=[];
  const requireEntity=(id,expectedType,path,message) => {
    const definition=indexes.entities.get(id);
    if (!definition || definition.artifact.document_type!==expectedType) {
      findings.push(finding("DANGLING_ENTITY_REFERENCE",path,message));
    }
    return definition;
  };
  for (const [artifactIndex,artifact] of graph.entries()) {
    const content=artifact?.content;
    if (!content || typeof content!=="object" || Array.isArray(content)) continue;
    if (artifact.document_type==="user-flow") {
      for (const [stepIndex,step] of asArray(content.steps).entries()) {
        if (!step || typeof step!=="object" || Array.isArray(step)) continue;
        const screen=requireEntity(
          step.screen_id,"screen-spec",`/${artifactIndex}/content/steps/${stepIndex}/screen_id`,
          `Flow step references missing screen ${step.screen_id}`,
        );
        const state=requireEntity(
          step.state_id,"screen-spec",`/${artifactIndex}/content/steps/${stepIndex}/state_id`,
          `Flow step references missing screen state ${step.state_id}`,
        );
        if (screen && state && screen.artifact!==state.artifact) findings.push(finding(
          "CROSS_SCREEN_STATE_REFERENCE",`/${artifactIndex}/content/steps/${stepIndex}/state_id`,
          `State ${step.state_id} does not belong to screen ${step.screen_id}`,
        ));
      }
    }
    if (artifact.document_type==="information-architecture") {
      for (const [nodeIndex,node] of asArray(content.nodes).entries()) {
        if (!node || typeof node!=="object" || Array.isArray(node)) continue;
        for (const [screenIndex,screenId] of asArray(node.screen_ids).entries()) {
          requireEntity(screenId,"screen-spec",
            `/${artifactIndex}/content/nodes/${nodeIndex}/screen_ids/${screenIndex}`,
            `Information architecture references missing screen ${screenId}`);
        }
      }
    }
    if (artifact.document_type==="wireframe-plan") {
      for (const [wireIndex,wireframe] of asArray(content.wireframes).entries()) {
        if (!wireframe || typeof wireframe!=="object" || Array.isArray(wireframe)) continue;
        requireEntity(wireframe.screen_id,"screen-spec",
          `/${artifactIndex}/content/wireframes/${wireIndex}/screen_id`,
          `Wireframe references missing screen ${wireframe.screen_id}`);
        for (const [flowIndex,flowId] of asArray(wireframe.flow_ids).entries()) {
          requireEntity(flowId,"user-flow",
            `/${artifactIndex}/content/wireframes/${wireIndex}/flow_ids/${flowIndex}`,
            `Wireframe references missing flow ${flowId}`);
        }
        for (const [stateIndex,stateId] of asArray(wireframe.state_ids).entries()) {
          requireEntity(stateId,"screen-spec",
            `/${artifactIndex}/content/wireframes/${wireIndex}/state_ids/${stateIndex}`,
            `Wireframe references missing screen state ${stateId}`);
        }
      }
    }
    if (artifact.document_type==="design-system") {
      for (const [componentIndex,component] of asArray(content.components).entries()) {
        if (!component || typeof component!=="object" || Array.isArray(component)) continue;
        for (const [ruleIndex,ruleId] of asArray(component.rule_ids).entries()) {
          requireEntity(ruleId,"design-system",
            `/${artifactIndex}/content/components/${componentIndex}/rule_ids/${ruleIndex}`,
            `Component references missing design rule ${ruleId}`);
        }
      }
    }
    if (artifact.document_type==="screen-spec") {
      for (const [stateIndex,state] of asArray(content.states).entries()) {
        if (!state || typeof state!=="object" || Array.isArray(state)) continue;
        for (const [componentIndex,componentId] of asArray(state.component_ids).entries()) {
          requireEntity(componentId,"design-system",
            `/${artifactIndex}/content/states/${stateIndex}/component_ids/${componentIndex}`,
            `Screen state references missing component ${componentId}`);
        }
      }
      for (const [ruleIndex,application] of asArray(content.rule_applications).entries()) {
        if (!application || typeof application!=="object" || Array.isArray(application)) continue;
        requireEntity(application.rule_id,"design-system",
          `/${artifactIndex}/content/rule_applications/${ruleIndex}/rule_id`,
          `Screen references missing design rule ${application.rule_id}`);
      }
    }
  }
  return findings;
}

function integrityFindings(graph) {
  const findings=[];
  for (const [index,artifact] of graph.entries()) {
    if (!artifact || typeof artifact!=="object" || Array.isArray(artifact) ||
        !("content" in artifact)) continue;
    if (sha256Canonical(artifact.content)!==artifact.content_sha256) {
      findings.push(finding(
        "CONTENT_SHA256_MISMATCH",`/${index}/content_sha256`,
        "Graph artifact content_sha256 must match canonical content",
      ));
    }
  }
  return findings;
}

function artifactAssetFindings(artifact,pathPrefix="") {
  const collections=[];
  if (artifact?.document_type==="visual-direction") {
    collections.push([artifact.content?.reference_assets,`${pathPrefix}/content/reference_assets`]);
  }
  if (artifact?.document_type==="prototype-manifest") {
    collections.push([artifact.content?.assets,`${pathPrefix}/content/assets`]);
  }
  const findings=[];
  for (const [assets,path] of collections) {
    if (!Array.isArray(assets)) continue;
    for (const [index,asset] of assets.entries()) {
      const result=resolveDesignAsset(asset);
      for (const item of result.findings) findings.push(finding(
        item.type,`${path}/${index}${item.path==="/" ? "" : item.path}`,item.message,
      ));
    }
  }
  return findings;
}

function graphSchemaFindings(graph) {
  const findings=[];
  for (const [index,artifact] of graph.entries()) {
    if (!artifact || typeof artifact!=="object" || Array.isArray(artifact)) continue;
    if (artifact.schema_version!=="acp.v1") {
      findings.push(finding(
        "UNKNOWN_SCHEMA_VERSION",`/${index}/schema_version`,
        "Design graph artifact schema_version must be acp.v1",
      ));
      continue;
    }
    const schemaId=SCHEMA_BY_DOCUMENT_TYPE[artifact.document_type];
    if (!schemaId) {
      findings.push(finding(
        "UNKNOWN_DOCUMENT_TYPE",`/${index}/document_type`,
        "Design graph contains an unknown artifact document_type",
      ));
      continue;
    }
    const validation=validateDocument(artifact,schemaId);
    if (!validation.valid) {
      for (const item of schemaFindings(validation.errors)) findings.push(finding(
        "GRAPH_SCHEMA_VALIDATION",`/${index}${item.path==="/" ? "" : item.path}`,
        item.message,
      ));
    }
    findings.push(...artifactAssetFindings(artifact,`/${index}`));
  }
  return findings;
}

function graphFindings(graph) {
  if (!Array.isArray(graph)) {
    return [finding("MALFORMED_GRAPH","/","Design artifact graph must be an array")];
  }
  const indexes=graphIndexes(graph);
  return [
    ...graphSchemaFindings(graph),
    ...indexes.findings,
    ...integrityFindings(graph),
    ...sourceFindings(graph),
    ...referenceFindings(graph,indexes),
    ...linkedEntityFindings(graph,indexes),
  ];
}

function bindingFindings(graph) {
  const findings=[];
  const indexes=graphIndexes(graph);
  const systems=graph.filter(artifact => artifact?.document_type==="design-system");
  const screens=graph.filter(artifact => artifact?.document_type==="screen-spec");
  for (const system of systems) {
    const rules=new Map(asArray(system.content?.rules).filter(rule =>
      rule && typeof rule==="object" && !Array.isArray(rule)).map(rule => [rule.rule_id,rule]));
    const exceptions=new Map(
      asArray(system.content?.exceptions).filter(exception =>
        exception && typeof exception==="object" && !Array.isArray(exception)).map(
        exception => [exception.exception_id,exception]),
    );
    for (const component of asArray(system.content?.components)) {
      if (!component || typeof component!=="object" || Array.isArray(component)) continue;
      for (const [index,ruleId] of asArray(component.rule_ids).entries()) {
        if (!rules.has(ruleId)) findings.push(finding(
          "DANGLING_RULE_REFERENCE",
          `/design-system/${system.artifact_id}/components/${component.component_id}/rule_ids/${index}`,
          `Component references missing design rule ${ruleId}`,
        ));
      }
    }
    for (const screen of screens.filter(candidate =>
      artifactSource(candidate)===artifactSource(system))) {
      for (const [index,application] of asArray(screen.content?.rule_applications).entries()) {
        if (!application || typeof application!=="object" || Array.isArray(application)) continue;
        const path=`/screen-spec/${screen.artifact_id}/rule_applications/${index}`;
        const rule=rules.get(application.rule_id);
        if (!rule) {
          findings.push(finding(
            "DANGLING_RULE_REFERENCE",`${path}/rule_id`,
            `Screen references missing design rule ${application.rule_id}`,
          ));
          continue;
        }
        const changed=canonicalJson(application.value)!==canonicalJson(rule.value);
        const protectedRule=system.content.verified===true &&
          rule.origin==="company_system" && rule.binding===true;
        if (!changed || !protectedRule) {
          if (!changed && application.exception_id!==null) findings.push(finding(
            "APPROVED_EXCEPTION_MISUSE",`${path}/exception_id`,
            "An exception cannot be attached when the binding rule is unchanged",
          ));
          continue;
        }
        if (application.exception_id===null) {
          findings.push(finding(
            "BINDING_RULE_VIOLATION",path,
            `Screen overrides binding company rule ${rule.rule_id} without an approved exception`,
          ));
          continue;
        }
        const exception=exceptions.get(application.exception_id);
        const approvalTarget=exception?.approval?.artifact===undefined ? undefined :
          indexes.artifacts.get(artifactReferenceIdentity(exception.approval.artifact));
        const valid=exception?.exact_rule_id===rule.rule_id &&
          exception.scope?.screen_ids?.includes(screen.content.screen_id) &&
          exception.authority?.role===exception.approval?.authority?.role &&
          exception.authority?.identity===exception.approval?.authority?.identity &&
          approvalTarget?.artifact?.document_type==="design-approval" &&
          approvalTarget.artifact.content_sha256===exception.approval.artifact.content_sha256;
        if (!valid) findings.push(finding(
          "APPROVED_EXCEPTION_INVALID",`${path}/exception_id`,
          `Exception ${application.exception_id} is not exact, scoped, authority-approved, and provenance-bound`,
        ));
      }
    }
  }
  const byArtifactId=new Map();
  for (const system of systems) {
    const group=byArtifactId.get(system.artifact_id) ?? [];
    group.push(system);
    byArtifactId.set(system.artifact_id,group);
  }
  for (const revisions of byArtifactId.values()) {
    revisions.sort((left,right) => left.revision-right.revision);
    for (let index=1;index<revisions.length;index+=1) {
      const previous=new Map(asArray(revisions[index-1].content?.rules).filter(rule =>
        rule && typeof rule==="object" && !Array.isArray(rule)).map(rule => [rule.rule_id,rule]));
      for (const rule of asArray(revisions[index].content?.rules)) {
        if (!rule || typeof rule!=="object" || Array.isArray(rule)) continue;
        const old=previous.get(rule.rule_id);
        if (old?.origin==="company_system" && old.binding===true &&
            canonicalJson(old.value)!==canonicalJson(rule.value)) {
          findings.push(finding(
            "VERIFIED_RULE_MUTATION",`/design-system/${revisions[index].artifact_id}@${revisions[index].revision}/rules/${rule.rule_id}`,
            `Verified company rule ${rule.rule_id} changed across revisions`,
          ));
        }
      }
    }
  }
  return findings;
}

export function validateDesignArtifact(artifact,graph=[]) {
  let value;
  let graphValue;
  try {
    value=canonicalCopy(artifact);
    graphValue=canonicalCopy(graph);
  } catch (error) {
    return canonicalFailure("CANONICAL_JSON",error);
  }
  if (value.schema_version!=="acp.v1") {
    return sortedResult([finding(
      "UNKNOWN_SCHEMA_VERSION","/schema_version","Design artifact schema_version must be acp.v1",
    )]);
  }
  const schemaId=SCHEMA_BY_DOCUMENT_TYPE[value.document_type];
  if (!schemaId) {
    return sortedResult([finding(
      "UNKNOWN_DOCUMENT_TYPE","/document_type","Unknown design artifact document_type",
    )]);
  }
  try {
    assertKnownDocumentType(value.document_type,value.schema_version);
  } catch (error) {
    return sortedResult([finding(
      "REGISTRY_CONTRACT","/document_type",
      error instanceof Error ? error.message : "Design artifact is not registered",
    )]);
  }
  const validation=validateDocument(value,schemaId);
  const findings=validation.valid ? [] : schemaFindings(validation.errors);
  if (validation.valid && sha256Canonical(value.content)!==value.content_sha256) {
    findings.push(finding(
      "CONTENT_SHA256_MISMATCH","/content_sha256","content_sha256 must match canonical content",
    ));
  }
  if (validation.valid) findings.push(...artifactAssetFindings(value));
  if (!Array.isArray(graphValue)) {
    findings.push(finding("MALFORMED_GRAPH","/","Design artifact graph must be an array"));
  } else if (validation.valid && graphValue.length>0) {
    findings.push(...graphFindings(graphValue));
  }
  return sortedResult(findings);
}

export function validateDesignSystemRules(graph) {
  let graphValue;
  try {
    graphValue=canonicalCopy(graph);
  } catch (error) {
    return canonicalFailure("CANONICAL_JSON",error);
  }
  if (!Array.isArray(graphValue)) return sortedResult(graphFindings(graphValue));
  return sortedResult([
    ...graphFindings(graphValue),
    ...bindingFindings(graphValue),
  ]);
}

export function resolveDesignAsset(entry) {
  let asset;
  try {
    asset=canonicalCopy(entry);
  } catch (error) {
    return canonicalFailure("CANONICAL_JSON",error);
  }
  const findings=[];
  const keys=asset && typeof asset==="object" && !Array.isArray(asset) ?
    Object.keys(asset).sort() : [];
  const expectedKeys=["asset_id","integrity","location","tool","version"];
  if (canonicalJson(keys)!==canonicalJson(expectedKeys)) findings.push(finding(
    "ASSET_SHAPE_INVALID","/","Asset requires exactly identity, tool, version, integrity, and location",
  ));
  if (typeof asset?.asset_id!=="string" ||
      !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/.test(asset.asset_id)) {
    findings.push(finding(
      "ASSET_IDENTITY_INVALID","/asset_id","Asset identity must be a stable uppercase design ID",
    ));
  }
  if (!new Set(["figma","pencil","code_native"]).has(asset?.tool)) findings.push(finding(
    "ASSET_TOOL_INVALID","/tool","Asset tool must be figma, pencil, or code_native",
  ));
  if (typeof asset?.version!=="string" || asset.version.trim().length===0) findings.push(finding(
    "ASSET_VERSION_INVALID","/version","Asset version must be a non-blank immutable version",
  ));
  const integrityKeys=asset?.integrity && typeof asset.integrity==="object" &&
    !Array.isArray(asset.integrity) ? Object.keys(asset.integrity).sort() : [];
  if (canonicalJson(integrityKeys)!==canonicalJson(["algorithm","value"]) ||
      asset?.integrity?.algorithm!=="sha256" ||
      typeof asset?.integrity?.value!=="string" ||
      !/^[a-f0-9]{64}$/.test(asset.integrity.value)) {
    findings.push(finding(
      "ASSET_INTEGRITY_INVALID","/integrity","Asset integrity must contain an exact SHA-256 digest",
    ));
  }
  const location=asset?.location;
  if (!location || typeof location!=="object" || Array.isArray(location)) {
    findings.push(finding(
      "ASSET_LOCATION_INVALID","/location","Asset location must be a path or URI object",
    ));
  } else if (location.kind==="path") {
    const pathKeys=Object.keys(location).sort();
    const candidate=location.path;
    const segments=typeof candidate==="string" ? candidate.split("/") : [];
    const unsafe=canonicalJson(pathKeys)!==canonicalJson(["kind","path"]) ||
      typeof candidate!=="string" || candidate.length===0 || candidate.includes("\\") ||
      candidate.includes("\u0000") || candidate.startsWith("/") ||
      /^[A-Za-z]:/.test(candidate) || candidate.startsWith("//") ||
      segments.some(segment => segment==="" || segment==="." || segment==="..");
    if (unsafe) findings.push(finding(
      "ASSET_PATH_UNSAFE","/location/path",
      "Asset paths must be contained normalized repository-relative POSIX paths",
    ));
  } else if (location.kind==="uri") {
    const uriKeys=Object.keys(location).sort();
    let parsed;
    try {
      parsed=new URL(location.uri);
    } catch {
      parsed=undefined;
    }
    const unsafe=canonicalJson(uriKeys)!==canonicalJson(["kind","uri"]) ||
      typeof location.uri!=="string" || /[\u0000-\u0020]/.test(location.uri) ||
      !parsed || !new Set(["https:","figma:","pencil:"]).has(parsed.protocol) ||
      parsed.username!=="" || parsed.password!=="" ||
      (parsed.protocol==="https:" && parsed.hostname.length===0);
    if (unsafe) findings.push(finding(
      "ASSET_URI_UNSAFE","/location/uri",
      "Asset URIs must use an approved non-credentialed URI scheme",
    ));
  } else {
    findings.push(finding(
      "ASSET_LOCATION_INVALID","/location/kind","Asset location kind must be path or uri",
    ));
  }
  return sortedResult(findings,{asset});
}
