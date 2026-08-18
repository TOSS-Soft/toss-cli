import {canonicalJson} from "../contracts/acp.js";

const METHOD_NAMES=Object.freeze(["findByMarker","createIssue","updateIssue"]);
const SHA256_PATTERN=/^[a-f0-9]{64}$/;

function isPlainObject(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function canonicalCopy(value,label) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON`,{cause:error});
  }
}

export function assertOwnDataFunction(value,name,label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const descriptor=Object.getOwnPropertyDescriptor(value,name);
  if (!descriptor?.enumerable || !("value" in descriptor) ||
      typeof descriptor.value!=="function") {
    throw new TypeError(
      `${label}.${name} must be an own enumerable data property containing a function`,
    );
  }
  return descriptor.value;
}

export function validateGitHubAdapter(adapter) {
  const methods={};
  for (const name of METHOD_NAMES) {
    methods[name]=assertOwnDataFunction(adapter,name,"GitHub adapter").bind(adapter);
  }
  return Object.freeze(methods);
}

function requiredText(value,label) {
  if (typeof value!=="string" || value.length===0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeLabels(value,label) {
  if (!Array.isArray(value) || value.some(item => typeof item!=="string" || item.length===0)) {
    throw new TypeError(`${label}.labels must be an array of non-empty strings`);
  }
  if (new Set(value).size!==value.length ||
      canonicalJson(value)!==canonicalJson([...value].sort())) {
    throw new TypeError(`${label}.labels must be unique and canonically ordered`);
  }
  return value;
}

export function normalizeRemoteIssue(value,{repository,marker,label="GitHub issue"}) {
  const issue=canonicalCopy(value,label);
  if (!isPlainObject(issue)) throw new TypeError(`${label} must be a plain object`);
  const fields=[
    "body","labels","marker","milestone","number","repository","title","url",
  ];
  if (canonicalJson(Object.keys(issue).sort())!==canonicalJson(fields)) {
    throw new TypeError(`${label} must be a closed object without unsupported fields`);
  }
  if (!Number.isSafeInteger(issue.number) || issue.number<1) {
    throw new TypeError(`${label}.number must be a positive safe integer`);
  }
  const expectedUrl=`https://github.com/${repository}/issues/${issue.number}`;
  if (issue.url!==expectedUrl) {
    throw new TypeError(`${label}.url must identify issue ${issue.number} in ${repository}`);
  }
  if (issue.repository!==repository) {
    throw new TypeError(`${label}.repository conflicts with ${repository}`);
  }
  if (issue.marker!==marker) throw new TypeError(`${label}.marker conflicts with discovery marker`);
  requiredText(issue.title,`${label}.title`);
  requiredText(issue.body,`${label}.body`);
  normalizeLabels(issue.labels,`${label}`);
  if (issue.milestone!==null &&
      (typeof issue.milestone!=="string" || issue.milestone.length===0)) {
    throw new TypeError(`${label}.milestone must be null or a non-empty string`);
  }
  return Object.freeze({
    number:issue.number,
    url:issue.url,
    repository,
    marker:issue.marker,
    title:issue.title,
    body:issue.body,
    labels:Object.freeze([...issue.labels]),
    milestone:issue.milestone,
  });
}

export function normalizeMarkerMatches(value,options) {
  const matches=canonicalCopy(value,"GitHub marker discovery result");
  if (!Array.isArray(matches)) {
    throw new TypeError("GitHub marker discovery result must be an array");
  }
  return Object.freeze(matches.map((issue,index) => normalizeRemoteIssue(issue,{
    ...options,
    label:`GitHub marker discovery result[${index}]`,
  })));
}

export function exactArtifactReference(value,label="artifact reference") {
  const reference=canonicalCopy(value,label);
  if (!isPlainObject(reference) ||
      canonicalJson(Object.keys(reference).sort())!==canonicalJson([
        "artifact_id","content_sha256","document_type","revision",
      ]) ||
      typeof reference.document_type!=="string" || reference.document_type.length===0 ||
      typeof reference.artifact_id!=="string" || reference.artifact_id.length===0 ||
      !Number.isSafeInteger(reference.revision) || reference.revision<1 ||
      typeof reference.content_sha256!=="string" ||
      !SHA256_PATTERN.test(reference.content_sha256)) {
    throw new TypeError(`${label} must be a closed exact artifact reference`);
  }
  return Object.freeze(reference);
}
