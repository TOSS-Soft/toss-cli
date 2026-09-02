const ROW_KEYS=["schemaId","uri","relativePath"];
const SCHEMA_ID=/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.v[1-9][0-9]*)?$/;
const URI=/^https:\/\/toss\.software\/schemas\/(agents|common|core|design|pipeline)\/([a-z0-9]+(?:-[a-z0-9]+)*(?:\.v[1-9][0-9]*)?)\.schema\.json$/;
const RELATIVE_PATH=/^\.\.\/\.\.\/contracts\/(agents|common|core|design|pipeline)\/([a-z0-9]+(?:-[a-z0-9]+)*(?:\.v[1-9][0-9]*)?\.schema\.json)$/;

function catalogError(message) {
  throw new Error(`Invalid contract schema catalog: ${message}`);
}

function hasOwnEnumerableDataProperties(value,label) {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      catalogError(`${label} must use own enumerable data properties`);
    }
  }
}

function validateDensePlainArray(catalog) {
  if (!Array.isArray(catalog) || Object.getPrototypeOf(catalog)!==Array.prototype) {
    catalogError("must be a dense plain array");
  }
  const keys=Reflect.ownKeys(catalog);
  if (keys.length!==catalog.length+1 || !keys.includes("length")) {
    catalogError("must be a dense plain array");
  }
  for (let index=0;index<catalog.length;index+=1) {
    const descriptor=Object.getOwnPropertyDescriptor(catalog,String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      catalogError("must be a dense plain array");
    }
  }
}

function validateRow(row,index) {
  const label=`row ${index}`;
  if (row===null || typeof row!=="object" || Object.getPrototypeOf(row)!==Object.prototype) {
    catalogError(`${label} must be a plain JSON record`);
  }
  hasOwnEnumerableDataProperties(row,label);
  const keys=Reflect.ownKeys(row);
  if (keys.length!==ROW_KEYS.length || !ROW_KEYS.every(key => keys.includes(key))) {
    catalogError(`${label} must have exactly schemaId, uri, relativePath`);
  }
  for (const key of ROW_KEYS) {
    if (typeof row[key]!=="string") {
      catalogError(`${label} ${key} must be a string`);
    }
  }
  if (!SCHEMA_ID.test(row.schemaId)) {
    catalogError(`${label} schemaId must be canonical ASCII`);
  }
  const uriMatch=URI.exec(row.uri);
  if (!uriMatch) {
    catalogError(`${label} uri must be a canonical HTTPS toss.software URI`);
  }
  const pathMatch=RELATIVE_PATH.exec(row.relativePath);
  if (!pathMatch) {
    catalogError(`${label} relativePath must be a safe repository-relative path`);
  }
  return {
    schemaId:row.schemaId,
    uri:row.uri,
    relativePath:row.relativePath,
  };
}

export function validateContractSchemaCatalog(catalog) {
  validateDensePlainArray(catalog);
  const normalized=[];
  const schemaIds=new Set();
  const uris=new Set();
  const relativePaths=new Set();
  let previousSchemaId;

  for (let index=0;index<catalog.length;index+=1) {
    const row=validateRow(catalog[index],index);
    if (schemaIds.has(row.schemaId)) {
      catalogError(`duplicate schemaId: ${row.schemaId}`);
    }
    if (uris.has(row.uri)) {
      catalogError(`duplicate uri: ${row.uri}`);
    }
    if (relativePaths.has(row.relativePath)) {
      catalogError(`duplicate relativePath: ${row.relativePath}`);
    }
    if (previousSchemaId!==undefined && previousSchemaId>=row.schemaId) {
      catalogError("rows must use stable ASCII order by schemaId");
    }
    previousSchemaId=row.schemaId;
    schemaIds.add(row.schemaId);
    uris.add(row.uri);
    relativePaths.add(row.relativePath);
    normalized.push(Object.freeze(row));
  }

  return Object.freeze(normalized);
}

const definitions=[
  ["adr-approval.v1","pipeline","adr-approval.v1.schema.json"],
  ["adr.v1","agents","adr.v1.schema.json"],
  ["architecture-constraint.v1","agents","architecture-constraint.v1.schema.json"],
  ["architecture.v1","agents","architecture.v1.schema.json"],
  ["artifact-envelope.v1","common","artifact-envelope.schema.json"],
  ["authority-record.v1","core","authority-record.v1.schema.json"],
  ["command-result.v1","pipeline","command-result.v1.schema.json"],
  ["decision-answer.v1","pipeline","decision-answer.v1.schema.json"],
  ["decision-package.v1","pipeline","decision-package.v1.schema.json"],
  ["dependency-edge.v1","core","dependency-edge.v1.schema.json"],
  ["design-approval.v1","design","design-approval.v1.schema.json"],
  ["design-audit.v1","design","design-audit.v1.schema.json"],
  ["design-brief.v1","design","design-brief.v1.schema.json"],
  ["design-orchestration-state.v1","pipeline","design-orchestration-state.v1.schema.json"],
  ["design-system.v1","design","design-system.v1.schema.json"],
  ["entity.v1","common","entity.schema.json"],
  ["epic-plan.v1","core","epic-plan.v1.schema.json"],
  ["feature-delta.v1","pipeline","feature-delta.v1.schema.json"],
  ["finding.v1","agents","finding.v1.schema.json"],
  ["github-publication-result.v1","pipeline","github-publication-result.v1.schema.json"],
  ["information-architecture.v1","design","information-architecture.v1.schema.json"],
  ["issue-plan.v1","agents","issue-plan.v1.schema.json"],
  ["operation-intent.v1","core","operation-intent.v1.schema.json"],
  ["operation-receipt.v1","core","operation-receipt.v1.schema.json"],
  ["organization-config.v1","core","organization-config.v1.schema.json"],
  ["pdor-result.v1","pipeline","pdor-result.v1.schema.json"],
  ["pm-analysis.v1","agents","pm-analysis.v1.schema.json"],
  ["project-input.v1","pipeline","project-input.v1.schema.json"],
  ["prototype-manifest.v1","design","prototype-manifest.v1.schema.json"],
  ["provenance.v1","common","provenance.schema.json"],
  ["question.v1","common","question.schema.json"],
  ["reference.v1","common","reference.schema.json"],
  ["repository-config.v1","core","repository-config.v1.schema.json"],
  ["review-result.v1","core","review-result.v1.schema.json"],
  ["screen-spec.v1","design","screen-spec.v1.schema.json"],
  ["spec-audit.v1","agents","spec-audit.v1.schema.json"],
  ["trace-graph.v1","pipeline","trace-graph.v1.schema.json"],
  ["trace-result.v1","pipeline","trace-result.v1.schema.json"],
  ["transition-event.v1","pipeline","transition-event.v1.schema.json"],
  ["ui-design-dor-result.v1","design","ui-design-dor-result.v1.schema.json"],
  ["usability-evidence.v1","design","usability-evidence.v1.schema.json"],
  ["user-flow.v1","design","user-flow.v1.schema.json"],
  ["ux-analysis.v1","design","ux-analysis.v1.schema.json"],
  ["visual-direction.v1","design","visual-direction.v1.schema.json"],
  ["wireframe-plan.v1","design","wireframe-plan.v1.schema.json"],
  ["work-item.v1","core","work-item.v1.schema.json"],
];

export const CONTRACT_SCHEMA_CATALOG=validateContractSchemaCatalog(
  definitions.map(([schemaId,family,file]) => ({
    schemaId,
    uri:`https://toss.software/schemas/${family}/${schemaId}.schema.json`,
    relativePath:`../../contracts/${family}/${file}`,
  })),
);
