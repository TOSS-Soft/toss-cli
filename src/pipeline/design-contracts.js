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

function sameStringSet(left,right) {
  return Array.isArray(left) && Array.isArray(right) &&
    new Set(left).size===left.length && new Set(right).size===right.length &&
    canonicalJson([...left].sort(compareText))===canonicalJson([...right].sort(compareText));
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
  const add=(id,path,value=id) => {
    if (typeof id==="string") definitions.push({id,path,value,artifact});
  };
  const addArray=(rows,field,path) => {
    if (!Array.isArray(rows)) return;
    for (const [rowIndex,row] of rows.entries()) {
      if (row && typeof row==="object" && !Array.isArray(row)) {
        add(row[field],`${path}/${rowIndex}/${field}`,row);
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

function exactDesignSystemPredecessor(older,newer) {
  return older.document_type==="design-system" &&
    newer.document_type==="design-system" &&
    older.artifact_id===newer.artifact_id && newer.revision===older.revision+1 &&
    artifactSource(older)===artifactSource(newer) &&
    canonicalJson(older.provenance)===canonicalJson(newer.provenance) &&
    newer.parents.length===1 &&
    newer.parents[0].artifact_id===older.artifact_id &&
    newer.parents[0].revision===older.revision &&
    newer.parents[0].content_sha256===older.content_sha256 &&
    newer.parents[0].document_type===older.document_type;
}

function sharedLineageEntity(left,right) {
  const [older,newer]=left.artifact.revision<right.artifact.revision ?
    [left,right] : [right,left];
  return left.artifact.revision!==right.artifact.revision &&
    exactDesignSystemPredecessor(older.artifact,newer.artifact) &&
    canonicalJson(older.value)===canonicalJson(newer.value);
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

function graphIndexes(graph,validIndexes=new Set(graph.keys())) {
  const artifacts=new Map();
  const latestRevision=new Map();
  const entities=new Map();
  const entityGroups=new Map();
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
    if (!validIndexes.has(index)) continue;
    for (const definition of entityDefinitions(artifact,index)) {
      const group=entityGroups.get(definition.id) ?? [];
      group.push(definition);
      entityGroups.set(definition.id,group);
    }
  }
  for (const [entityId,definitions] of entityGroups) {
    definitions.sort((left,right) =>
      compareText(left.artifact.artifact_id,right.artifact.artifact_id) ||
      left.artifact.revision-right.artifact.revision ||
      compareText(left.path,right.path));
    let previous;
    for (const definition of definitions) {
      if (previous && !sharedLineageEntity(previous,definition)) {
        findings.push(finding(
          "DUPLICATE_ENTITY_IDENTITY",definition.path,
          `Duplicate design entity identity ${entityId}`,
        ));
      }
      previous=definition;
    }
    entities.set(entityId,definitions.at(-1));
  }
  return {artifacts,latestRevision,entities,findings};
}

function referenceFindings(graph,indexes,validIndexes) {
  const findings=[];
  for (const [index,artifact] of graph.entries()) {
    if (!validIndexes.has(index)) continue;
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
      const exactPredecessorParent=artifact.document_type==="design-system" &&
        path.startsWith(`/${index}/parents/`) &&
        exactDesignSystemPredecessor(target.artifact,artifact);
      if (!exactPredecessorParent &&
          (indexes.latestRevision.get(reference.artifact_id) ?? 0)>reference.revision) {
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

function sourceFindings(graph,validIndexes) {
  const findings=[];
  const briefs=graph.filter((artifact,index) => validIndexes.has(index) &&
    artifact?.document_type==="design-brief");
  if (briefs.length===0) {
    return [finding(
      "MISSING_DESIGN_BRIEF","/","Design graph requires an authoritative design-brief",
    )];
  }
  const authoritative=briefs.reduce((left,right) =>
    left.revision>=right.revision ? left : right);
  for (const [index,artifact] of graph.entries()) {
    if (!validIndexes.has(index)) continue;
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

function linkedEntityFindings(graph,indexes,validIndexes) {
  const findings=[];
  const exactEntity=(reference,expectedType,path) => {
    if (!reference || typeof reference!=="object" || Array.isArray(reference)) return undefined;
    const target=indexes.artifacts.get(artifactReferenceIdentity(reference));
    if (!target || !validIndexes.has(target.index) ||
        target.artifact.document_type!==expectedType ||
        target.artifact.content_sha256!==reference.content_sha256 ||
        !entityDefinitions(target.artifact,target.index).some(definition =>
          definition.id===reference.entity_id)) {
      findings.push(finding(
        "DANGLING_ENTITY_REFERENCE",path,
        `Reference must select one exact ${expectedType} artifact revision and entity`,
      ));
      return undefined;
    }
    return target;
  };
  const validScreens=graph.filter((artifact,index) => validIndexes.has(index) &&
    artifact.document_type==="screen-spec");
  for (const [artifactIndex,artifact] of graph.entries()) {
    if (!validIndexes.has(artifactIndex)) continue;
    const content=artifact?.content;
    if (!content || typeof content!=="object" || Array.isArray(content)) continue;
    if (artifact.document_type==="user-flow") {
      const stepIds=new Set(content.steps.map(step => step.step_id));
      for (const [stepIndex,step] of asArray(content.steps).entries()) {
        for (const [nextIndex,nextId] of step.next_step_ids.entries()) {
          if (!stepIds.has(nextId)) findings.push(finding(
            "DANGLING_NEXT_STEP_REFERENCE",
            `/${artifactIndex}/content/steps/${stepIndex}/next_step_ids/${nextIndex}`,
            `Flow step references missing local next step ${nextId}`,
          ));
        }
        const screens=validScreens.filter(screen =>
          screen.content.screen_id===step.screen_id &&
          screen.content.flow_refs.some(reference =>
            reference.artifact_id===artifact.artifact_id &&
            reference.revision===artifact.revision &&
            reference.content_sha256===artifact.content_sha256 &&
            reference.document_type===artifact.document_type &&
            reference.entity_id===content.flow_id));
        if (screens.length!==1) findings.push(finding(
          "FLOW_SCREEN_LINK_INVALID",`/${artifactIndex}/content/steps/${stepIndex}/screen_id`,
          `Flow step must be linked by one exact screen revision for ${step.screen_id}`,
        ));
        else if (!screens[0].content.states.some(state => state.state_id===step.state_id)) {
          findings.push(finding(
            "CROSS_SCREEN_STATE_REFERENCE",`/${artifactIndex}/content/steps/${stepIndex}/state_id`,
            `State ${step.state_id} does not belong to the exact linked screen`,
          ));
        }
      }
    }
    if (artifact.document_type==="information-architecture") {
      const nodeIds=new Set(content.nodes.map(node => node.node_id));
      for (const [nodeIndex,node] of asArray(content.nodes).entries()) {
        if (node.parent_id!==null && !nodeIds.has(node.parent_id)) findings.push(finding(
          "DANGLING_IA_PARENT_REFERENCE",
          `/${artifactIndex}/content/nodes/${nodeIndex}/parent_id`,
          `Information architecture references missing local parent ${node.parent_id}`,
        ));
        for (const [screenIndex,screenRef] of node.screen_refs.entries()) {
          exactEntity(screenRef,"screen-spec",
            `/${artifactIndex}/content/nodes/${nodeIndex}/screen_refs/${screenIndex}`);
        }
      }
    }
    if (artifact.document_type==="wireframe-plan") {
      for (const [wireIndex,wireframe] of asArray(content.wireframes).entries()) {
        const screen=exactEntity(wireframe.screen_ref,"screen-spec",
          `/${artifactIndex}/content/wireframes/${wireIndex}/screen_ref`);
        for (const [flowIndex,flowRef] of wireframe.flow_refs.entries()) {
          const flow=exactEntity(flowRef,"user-flow",
            `/${artifactIndex}/content/wireframes/${wireIndex}/flow_refs/${flowIndex}`);
          if (screen && flow) {
            const reverseLinked=screen.artifact.content.flow_refs.some(reference =>
              reference.artifact_id===flow.artifact.artifact_id &&
              reference.revision===flow.artifact.revision &&
              reference.content_sha256===flow.artifact.content_sha256 &&
              reference.document_type===flow.artifact.document_type &&
              reference.entity_id===flowRef.entity_id);
            const traversedStates=new Set(flow.artifact.content.steps.filter(step =>
              step.screen_id===wireframe.screen_ref.entity_id).map(step => step.state_id));
            if (!reverseLinked || !wireframe.state_ids.every(stateId =>
              traversedStates.has(stateId))) findings.push(finding(
              "WIREFRAME_FLOW_SCREEN_MISMATCH",
              `/${artifactIndex}/content/wireframes/${wireIndex}/flow_refs/${flowIndex}`,
              "Wireframe flow must traverse every selected state on the exact reverse-linked screen",
            ));
          }
        }
        for (const [stateIndex,stateId] of wireframe.state_ids.entries()) {
          if (!screen?.artifact.content.states.some(state => state.state_id===stateId)) {
            findings.push(finding(
              "CROSS_SCREEN_STATE_REFERENCE",
              `/${artifactIndex}/content/wireframes/${wireIndex}/state_ids/${stateIndex}`,
              `Wireframe state ${stateId} must belong to its exact screen revision`,
            ));
          }
        }
      }
    }
    if (artifact.document_type==="design-system") {
      const ruleIds=new Set(content.rules.map(rule => rule.rule_id));
      for (const [componentIndex,component] of asArray(content.components).entries()) {
        for (const [ruleIndex,ruleId] of component.rule_ids.entries()) {
          if (!ruleIds.has(ruleId)) findings.push(finding(
            "DANGLING_RULE_REFERENCE",
            `/${artifactIndex}/content/components/${componentIndex}/rule_ids/${ruleIndex}`,
            `Component references missing local design rule ${ruleId}`,
          ));
        }
      }
    }
    if (artifact.document_type==="screen-spec") {
      const componentRefs=new Map(content.component_refs.map(reference =>
        [reference.entity_id,{
          reference,
          target:exactEntity(reference,"design-system",
            `/${artifactIndex}/content/component_refs/${reference.entity_id}`),
        }]));
      const statesById=new Map(content.states.map(state => [state.state_id,state]));
      const responsiveIds=new Set(content.responsive.map(row => row.target_id));
      const accessibilityIds=new Set(content.accessibility.map(row => row.criterion_id));
      for (const [stateIndex,state] of asArray(content.states).entries()) {
        for (const [componentIndex,componentId] of state.component_ids.entries()) {
          if (!componentRefs.get(componentId)?.target) findings.push(finding(
            "SCREEN_COMPONENT_NOT_DECLARED",
            `/${artifactIndex}/content/states/${stateIndex}/component_ids/${componentIndex}`,
            `Screen state component ${componentId} is not one of this screen's exact component references`,
          ));
        }
        for (const [responsiveIndex,targetId] of state.responsive_target_ids.entries()) {
          if (!responsiveIds.has(targetId)) findings.push(finding(
            "DANGLING_RESPONSIVE_REFERENCE",
            `/${artifactIndex}/content/states/${stateIndex}/responsive_target_ids/${responsiveIndex}`,
            `Screen state references missing responsive target ${targetId}`,
          ));
        }
        for (const [criterionIndex,criterionId] of state.accessibility_criterion_ids.entries()) {
          if (!accessibilityIds.has(criterionId)) findings.push(finding(
            "DANGLING_ACCESSIBILITY_REFERENCE",
            `/${artifactIndex}/content/states/${stateIndex}/accessibility_criterion_ids/${criterionIndex}`,
            `Screen state references missing accessibility criterion ${criterionId}`,
          ));
        }
      }
      for (const [ruleIndex,application] of asArray(content.rule_applications).entries()) {
        const path=`/${artifactIndex}/content/rule_applications/${ruleIndex}`;
        const ruleTarget=exactEntity(application.rule_ref,"design-system",`${path}/rule_ref`);
        for (const [componentIndex,componentId] of application.component_ids.entries()) {
          const componentLink=componentRefs.get(componentId);
          const component=componentLink?.target?.artifact.content.components.find(candidate =>
            candidate.component_id===componentId);
          const sameSystem=ruleTarget && componentLink?.target &&
            ruleTarget.artifact.artifact_id===componentLink.target.artifact.artifact_id &&
            ruleTarget.artifact.revision===componentLink.target.artifact.revision &&
            ruleTarget.artifact.content_sha256===componentLink.target.artifact.content_sha256;
          if (!sameSystem || !component?.rule_ids.includes(application.rule_ref.entity_id)) {
            findings.push(finding(
              "RULE_APPLICATION_SCOPE_INVALID",`${path}/component_ids/${componentIndex}`,
              `Rule application component ${componentId} must resolve to the exact rule-bearing design-system revision`,
            ));
          }
        }
        for (const [stateIndex,stateId] of application.state_ids.entries()) {
          const state=statesById.get(stateId);
          if (!state || !application.component_ids.every(componentId =>
            state.component_ids.includes(componentId))) findings.push(finding(
            "RULE_APPLICATION_SCOPE_INVALID",`${path}/state_ids/${stateIndex}`,
            `Rule application state ${stateId} must use every affected component`,
          ));
        }
      }
    }
  }
  return findings;
}

function integrityFindings(graph,validIndexes) {
  const findings=[];
  for (const [index,artifact] of graph.entries()) {
    if (!validIndexes.has(index)) continue;
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

function sortArtifactReferences(references) {
  return [...references].sort((left,right) => compareText(canonicalJson(left),canonicalJson(right)));
}

function designSystemLineageFindings(systems) {
  const findings=[];
  const byArtifactId=new Map();
  for (const system of systems) {
    const group=byArtifactId.get(system.artifact_id) ?? [];
    group.push(system);
    byArtifactId.set(system.artifact_id,group);
  }
  for (const revisions of byArtifactId.values()) {
    revisions.sort((left,right) => left.revision-right.revision);
    const byRevision=new Map();
    for (const system of revisions) {
      const sameRevision=byRevision.get(system.revision) ?? [];
      sameRevision.push(system);
      byRevision.set(system.revision,sameRevision);
    }
    for (const [revision,members] of byRevision) {
      if (members.length>1) findings.push(finding(
        "DESIGN_SYSTEM_LINEAGE_FORK",
        `/design-system/${members[0].artifact_id}@${revision}`,
        `Design-system lineage has ${members.length} artifacts at revision ${revision}`,
      ));
    }
    for (const current of revisions) {
      if (current.revision===1) continue;
      const priorMembers=byRevision.get(current.revision-1) ?? [];
      if (priorMembers.length!==1) {
        const hasEarlier=revisions.some(candidate => candidate.revision<current.revision);
        findings.push(finding(
          hasEarlier ? "DESIGN_SYSTEM_LINEAGE_NONCONTIGUOUS" :
            "DESIGN_SYSTEM_LINEAGE_MISSING",
          `/design-system/${current.artifact_id}@${current.revision}`,
          `Design-system revision ${current.revision} requires exactly one revision ${current.revision-1}`,
        ));
        continue;
      }
      const previous=priorMembers[0];
      if (!exactDesignSystemPredecessor(previous,current)) findings.push(finding(
        "DESIGN_SYSTEM_LINEAGE_PARENT_INVALID",
        `/design-system/${current.artifact_id}@${current.revision}/parents`,
        "Design-system revision must have its exact immediate predecessor as its sole parent",
      ));
      if (previous.content.verified===true && (current.content.verified!==true ||
          current.content.system_id!==previous.content.system_id)) findings.push(finding(
        "VERIFIED_SYSTEM_DOWNGRADE",
        `/design-system/${current.artifact_id}@${current.revision}`,
        "A verified design-system identity cannot be removed or downgraded",
      ));
      const currentRules=new Map(current.content.rules.map(rule => [rule.rule_id,rule]));
      for (const old of previous.content.rules) {
        if (previous.content.verified!==true || old.origin!=="company_system" ||
            old.binding!==true) continue;
        const next=currentRules.get(old.rule_id);
        if (!next) findings.push(finding(
          "VERIFIED_RULE_DELETION",
          `/design-system/${current.artifact_id}@${current.revision}/rules/${old.rule_id}`,
          `Verified company rule ${old.rule_id} was deleted`,
        ));
        else if (canonicalJson(next)!==canonicalJson(old)) findings.push(finding(
          "VERIFIED_RULE_MUTATION",
          `/design-system/${current.artifact_id}@${current.revision}/rules/${old.rule_id}`,
          `Verified company rule ${old.rule_id} or its verification metadata changed`,
        ));
      }
    }
  }
  return findings;
}

function approvalClosure(graph,validIndexes) {
  const latest=[];
  const issues=[];
  for (const documentType of Object.keys(SCHEMA_BY_DOCUMENT_TYPE)) {
    const members=graph.filter((artifact,index) => validIndexes.has(index) &&
      artifact.document_type===documentType);
    if (members.length===0) {
      issues.push({
        type:"APPROVAL_REQUIRED_TYPE_MISSING",
        message:`Approval graph requires exactly one latest ${documentType} artifact`,
      });
      continue;
    }
    if (documentType==="design-system") {
      const artifactIds=new Set(members.map(artifact => artifact.artifact_id));
      const revisions=new Set(members.map(artifact => artifact.revision));
      if (artifactIds.size!==1 || revisions.size!==members.length) {
        issues.push({
          type:"APPROVAL_TYPE_MULTIPLICITY",
          message:"Approval graph permits one unambiguous design-system lineage only",
        });
        continue;
      }
      latest.push(members.reduce((left,right) => left.revision>right.revision ? left : right));
      continue;
    }
    if (members.length!==1) {
      issues.push({
        type:"APPROVAL_TYPE_MULTIPLICITY",
        message:`Approval graph contains ${members.length} ${documentType} artifacts`,
      });
      continue;
    }
    latest.push(members[0]);
  }
  return {issues,latest};
}

function authoritativeApprovalManifest(closure) {
  return sortArtifactReferences(closure.latest.filter(artifact =>
    artifact.document_type!=="design-approval").map(artifact => ({
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  })));
}

function approvalGraphFindings(graph,validIndexes) {
  const findings=[];
  const closure=approvalClosure(graph,validIndexes);
  const expected=authoritativeApprovalManifest(closure);
  const expectedByIdentity=new Map(expected.map(reference =>
    [artifactReferenceIdentity(reference),reference]));
  const briefs=graph.filter((artifact,index) => validIndexes.has(index) &&
    artifact.document_type==="design-brief");
  const brief=briefs.sort((left,right) => right.revision-left.revision)[0];
  const graphTime=Math.max(...graph.filter((artifact,index) => validIndexes.has(index)).map(
    artifact => Date.parse(artifact.created_at)));
  for (const [index,approval] of graph.entries()) {
    if (!validIndexes.has(index) || approval.document_type!=="design-approval") continue;
    const prefix=`/${index}/content`;
    for (const issue of closure.issues) findings.push(finding(
      issue.type,`${prefix}/graph_manifest`,issue.message,
    ));
    if (closure.issues.length>0) findings.push(finding(
      "APPROVAL_GRAPH_INCOMPLETE",`${prefix}/graph_manifest`,
      "Approval graph cannot form the exact required twelve-type closure",
    ));
    const manifest=approval.content.graph_manifest;
    const seen=new Set();
    for (const [manifestIndex,reference] of manifest.entries()) {
      const identity=artifactReferenceIdentity(reference);
      if (seen.has(identity)) findings.push(finding(
        "APPROVAL_GRAPH_DUPLICATE",`${prefix}/graph_manifest/${manifestIndex}`,
        `Approval graph repeats ${reference.artifact_id}@${reference.revision}`,
      ));
      seen.add(identity);
      const exact=expectedByIdentity.get(identity);
      if (!exact) {
        const existsAtAnotherRevision=expected.some(candidate =>
          candidate.artifact_id===reference.artifact_id);
        findings.push(finding(
          existsAtAnotherRevision ? "APPROVAL_GRAPH_STALE" : "APPROVAL_GRAPH_EXTRA",
          `${prefix}/graph_manifest/${manifestIndex}`,
          `Approval graph contains a non-authoritative member ${reference.artifact_id}@${reference.revision}`,
        ));
      } else if (canonicalJson(exact)!==canonicalJson(reference)) findings.push(finding(
        "APPROVAL_GRAPH_STALE",`${prefix}/graph_manifest/${manifestIndex}`,
        `Approval graph member ${reference.artifact_id}@${reference.revision} is stale or corrupt`,
      ));
    }
    for (const reference of expected) {
      if (!manifest.some(candidate => canonicalJson(candidate)===canonicalJson(reference))) {
        findings.push(finding(
          "APPROVAL_GRAPH_INCOMPLETE",`${prefix}/graph_manifest`,
          `Approval graph omits ${reference.artifact_id}@${reference.revision}`,
        ));
      }
    }
    const sorted=sortArtifactReferences(manifest);
    if (canonicalJson(manifest)!==canonicalJson(sorted)) findings.push(finding(
      "APPROVAL_GRAPH_ORDER",`${prefix}/graph_manifest`,
      "Approval graph manifest must use canonical artifact-reference order",
    ));
    if (sha256Canonical(sorted)!==approval.content.graph_root_sha256) findings.push(finding(
      "APPROVAL_GRAPH_ROOT_MISMATCH",`${prefix}/graph_root_sha256`,
      "Approval graph root must hash the canonical graph manifest",
    ));
    if (!brief || canonicalJson(approval.content.authority)!==
        canonicalJson(brief.content.approval_owner)) findings.push(finding(
      "APPROVAL_AUTHORITY_INVALID",`${prefix}/authority`,
      "Approval authority must be the exact human authority selected by the design brief",
    ));
    const approvedAt=Date.parse(approval.content.approved_at);
    const expiresAt=Date.parse(approval.content.expires_at);
    if (approvedAt>Date.parse(approval.created_at) || expiresAt<approvedAt) findings.push(finding(
      "APPROVAL_TIME_INVALID",`${prefix}/approved_at`,
      "Approval time must be provenance-bound and precede its expiry",
    ));
    if (expiresAt<graphTime) findings.push(finding(
      "APPROVAL_EXPIRED",`${prefix}/expires_at`,
      "Approval expired before the latest artifact in its graph",
    ));
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

function graphSchemaState(graph) {
  const findings=[];
  const validIndexes=new Set();
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
    } else validIndexes.add(index);
    findings.push(...artifactAssetFindings(artifact,`/${index}`));
  }
  return {findings,validIndexes};
}

function graphFindings(graph) {
  if (!Array.isArray(graph)) {
    return [finding("MALFORMED_GRAPH","/","Design artifact graph must be an array")];
  }
  const schemaState=graphSchemaState(graph);
  const indexes=graphIndexes(graph,schemaState.validIndexes);
  return [
    ...schemaState.findings,
    ...indexes.findings,
    ...integrityFindings(graph,schemaState.validIndexes),
    ...sourceFindings(graph,schemaState.validIndexes),
    ...referenceFindings(graph,indexes,schemaState.validIndexes),
    ...linkedEntityFindings(graph,indexes,schemaState.validIndexes),
    ...designSystemLineageFindings(graph.filter((artifact,index) =>
      schemaState.validIndexes.has(index) && artifact.document_type==="design-system")),
    ...approvalGraphFindings(graph,schemaState.validIndexes),
  ];
}

function candidateGraphFindings(artifact,graph) {
  if (!Array.isArray(graph)) return [];
  const matches=graph.filter(candidate => candidate && typeof candidate==="object" &&
    !Array.isArray(candidate) && candidate.artifact_id===artifact.artifact_id &&
    candidate.revision===artifact.revision);
  if (matches.length===0) return [finding(
    "ARTIFACT_NOT_IN_GRAPH","/",
    `Artifact ${artifact.artifact_id}@${artifact.revision} is absent from the graph`,
  )];
  if (matches.length!==1 || canonicalJson(matches[0])!==canonicalJson(artifact)) return [finding(
    "ARTIFACT_GRAPH_MISMATCH","/",
    `Artifact ${artifact.artifact_id}@${artifact.revision} is not the graph's exact canonical member`,
  )];
  return [];
}

function bindingFindings(graph) {
  const findings=[];
  const schemaState=graphSchemaState(graph);
  const indexes=graphIndexes(graph,schemaState.validIndexes);
  const systems=graph.filter((artifact,index) => schemaState.validIndexes.has(index) &&
    artifact.document_type==="design-system");
  const screens=graph.filter((artifact,index) => schemaState.validIndexes.has(index) &&
    artifact.document_type==="screen-spec");
  const approvals=graph.filter((artifact,index) => schemaState.validIndexes.has(index) &&
    artifact.document_type==="design-approval");
  const approvalIssues=approvalGraphFindings(graph,schemaState.validIndexes);
  const graphTime=Math.max(...graph.filter((artifact,index) =>
    schemaState.validIndexes.has(index)).map(artifact => Date.parse(artifact.created_at)));
  const exactEntityRef=(reference,artifact,entityId) => reference &&
    reference.artifact_id===artifact.artifact_id &&
    reference.revision===artifact.revision &&
    reference.content_sha256===artifact.content_sha256 &&
    reference.document_type===artifact.document_type &&
    reference.entity_id===entityId;
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
        const targetsSystem=application.rule_ref?.artifact_id===system.artifact_id &&
          application.rule_ref?.revision===system.revision &&
          application.rule_ref?.content_sha256===system.content_sha256 &&
          application.rule_ref?.document_type===system.document_type;
        if (!targetsSystem) continue;
        const rule=rules.get(application.rule_ref.entity_id);
        if (!rule) {
          findings.push(finding(
            "DANGLING_RULE_REFERENCE",`${path}/rule_ref/entity_id`,
            `Screen references missing design rule ${application.rule_ref.entity_id}`,
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
        const grants=[];
        for (const approval of approvals) {
          const approvalIndex=graph.indexOf(approval);
          const approvalBound=!approvalIssues.some(issue =>
            issue.path===`/${approvalIndex}` || issue.path.startsWith(`/${approvalIndex}/`));
          if (approval.content.decision!=="APPROVED" || !approvalBound ||
              approval.content.source!==artifactSource(system) ||
              Date.parse(approval.content.expires_at)<graphTime) continue;
          for (const grant of approval.content.exception_grants) {
            if (grant.exception_id===application.exception_id &&
                exactEntityRef(grant.rule_ref,system,rule.rule_id) &&
                exactEntityRef(grant.screen_ref,screen,screen.content.screen_id)) {
              grants.push({approval,grant});
            }
          }
        }
        const componentRefs=new Map(screen.content.component_refs.map(reference =>
          [reference.entity_id,reference]));
        const states=new Map(screen.content.states.map(state => [state.state_id,state]));
        const authorization=grants.length===1 ? grants[0] : undefined;
        const exactComponents=exception?.scope.component_ids.every(componentId => {
          const reference=componentRefs.get(componentId);
          const component=system.content.components.find(candidate =>
            candidate.component_id===componentId);
          return exactEntityRef(reference,system,componentId) &&
            component?.rule_ids.includes(rule.rule_id);
        });
        const exactStates=exception?.scope.state_ids.every(stateId => {
          const state=states.get(stateId);
          return state && exception.scope.component_ids.every(componentId =>
            state.component_ids.includes(componentId));
        });
        const valid=authorization!==undefined && exception?.exact_rule_id===rule.rule_id &&
          sameStringSet(exception.scope.screen_ids,[screen.content.screen_id]) &&
          sameStringSet(exception.scope.state_ids,application.state_ids) &&
          sameStringSet(exception.scope.component_ids,application.component_ids) &&
          exactComponents && exactStates &&
          sameStringSet(exception.scope.screen_ids,authorization.grant.scope.screen_ids) &&
          sameStringSet(exception.scope.state_ids,authorization.grant.scope.state_ids) &&
          sameStringSet(exception.scope.component_ids,authorization.grant.scope.component_ids) &&
          canonicalJson(exception.provenance)===canonicalJson(system.provenance) &&
          Date.parse(exception.valid_until)>=graphTime &&
          Date.parse(exception.valid_until)>=Date.parse(authorization.approval.content.approved_at);
        if (!valid) findings.push(finding(
          "APPROVED_EXCEPTION_INVALID",`${path}/exception_id`,
          `Exception ${application.exception_id} is not exact, scoped, authority-approved, and provenance-bound`,
        ));
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
  const findings=[];
  if (value.schema_version!=="acp.v1") {
    findings.push(finding(
      "UNKNOWN_SCHEMA_VERSION","/schema_version","Design artifact schema_version must be acp.v1",
    ));
  }
  const schemaId=value.schema_version==="acp.v1" ?
    SCHEMA_BY_DOCUMENT_TYPE[value.document_type] : undefined;
  if (value.schema_version==="acp.v1" && !schemaId) {
    findings.push(finding(
      "UNKNOWN_DOCUMENT_TYPE","/document_type","Unknown design artifact document_type",
    ));
  }
  if (schemaId) {
    try {
      assertKnownDocumentType(value.document_type,value.schema_version);
    } catch (error) {
      findings.push(finding(
        "REGISTRY_CONTRACT","/document_type",
        error instanceof Error ? error.message : "Design artifact is not registered",
      ));
    }
  }
  const validation=schemaId ? validateDocument(value,schemaId) : {valid:false,errors:[]};
  if (schemaId && !validation.valid) findings.push(...schemaFindings(validation.errors));
  const integrityValid=validation.valid &&
    sha256Canonical(value.content)===value.content_sha256;
  if (validation.valid && !integrityValid) {
    findings.push(finding(
      "CONTENT_SHA256_MISMATCH","/content_sha256","content_sha256 must match canonical content",
    ));
  }
  if (validation.valid) findings.push(...artifactAssetFindings(value));
  if (!Array.isArray(graphValue)) {
    findings.push(finding("MALFORMED_GRAPH","/","Design artifact graph must be an array"));
  } else {
    findings.push(...graphFindings(graphValue));
    if (integrityValid) findings.push(...candidateGraphFindings(value,graphValue));
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
      /[\u0000-\u001f\u007f]/.test(candidate) || /%(?:[0-1][0-9a-f]|7f|25|2e|2f|5c)/i.test(candidate) ||
      /[?#]/.test(candidate) || candidate.startsWith("/") ||
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
    const encodedAmbiguity=typeof location.uri==="string" &&
      /%[0-9a-f]{2}/i.test(location.uri);
    const unsafe=canonicalJson(uriKeys)!==canonicalJson(["kind","uri"]) ||
      typeof location.uri!=="string" || /[\u0000-\u0020\u007f]/.test(location.uri) ||
      encodedAmbiguity ||
      !parsed || !new Set(["https:","figma:","pencil:"]).has(parsed.protocol) ||
      parsed.username!=="" || parsed.password!=="" ||
      parsed.search!=="" || parsed.hash!=="" || parsed.href!==location.uri ||
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
