import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {validateCoreDocument} from "../contracts.js";
import {CoreBlockedError,CoreValidationError} from "../errors.js";
import {parseWorkItemId} from "./identity.js";

const SHA=/^[a-f0-9]{40}$/u;
const SHA256=/^[a-f0-9]{64}$/u;
const VISIBLE_IDENTITY=/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,253}$/u;

function invalid(message,options={}) {
  throw new CoreValidationError(message,options);
}

function copyClosed(value,label,ancestors=new Set()) {
  if (value===null || ["string","boolean"].includes(typeof value)) return value;
  if (typeof value==="number") {
    if (!Number.isFinite(value)) invalid(`${label} must contain only finite JSON values`);
    return value;
  }
  if (typeof value!=="object" || types.isProxy(value)) {
    invalid(`${label} must contain only plain non-proxy JSON data`);
  }
  if (ancestors.has(value)) invalid(`${label} must not be cyclic`);
  ancestors.add(value);
  try {
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const keys=Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value)!==Array.prototype) invalid(`${label} arrays must be plain`);
      const length=descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length<0 || keys.length!==length+1) {
        invalid(`${label} arrays must be dense own data`);
      }
      const result=[];
      for (let index=0;index<length;index+=1) {
        const descriptor=descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          invalid(`${label} arrays must be dense own data`);
        }
        result.push(copyClosed(descriptor.value,`${label}[${index}]`,ancestors));
      }
      return Object.freeze(result);
    }
    if (![Object.prototype,null].includes(Object.getPrototypeOf(value))) {
      invalid(`${label} objects must be plain`);
    }
    const result={};
    for (const key of keys) {
      const descriptor=descriptors[key];
      if (typeof key!=="string" || !descriptor.enumerable || !("value" in descriptor)) {
        invalid(`${label} objects must contain only own enumerable data`);
      }
      result[key]=copyClosed(descriptor.value,`${label}.${key}`,ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function exact(value,keys,label) {
  if (value===null || typeof value!=="object" || Array.isArray(value) ||
      canonicalJson(Object.keys(value).sort())!==canonicalJson([...keys].sort())) {
    invalid(`${label} must use the exact closed shape`);
  }
}

function compare(left,right) {
  return left===right ? 0 : left<right ? -1 : 1;
}

function sha(value,label) {
  if (typeof value!=="string" || !SHA.test(value)) {
    invalid(`${label} must be a lowercase 40-character commit SHA`);
  }
  return value;
}

function identityKey(value,label) {
  if (typeof value!=="string" || !VISIBLE_IDENTITY.test(value)) {
    invalid(`${label} must be a visible bounded ASCII GitHub-style identity`);
  }
  return value.toLowerCase();
}

function summaryKey(value) {
  return value.normalize("NFKC").trim().replace(/\s+/gu," ").toLowerCase();
}

export function normalizeReviewResult(input) {
  const value=copyClosed(input,"Review result");
  validateCoreDocument(value,"review-result.v1");

  const findings=[...value.findings].sort((left,right) => compare(left.finding_id,right.finding_id));
  const summaries=new Set();
  for (const finding of findings) {
    const key=summaryKey(finding.summary);
    if (summaries.has(key)) invalid(`Review result has duplicate finding summary ${finding.summary}`);
    summaries.add(key);
  }

  const unresolvedExpected=findings
    .filter(finding => !finding.resolved)
    .map(finding => finding.finding_id)
    .sort(compare);
  const unresolved=[...value.unresolved].sort(compare);
  if (canonicalJson(unresolved)!==canonicalJson(unresolvedExpected)) {
    invalid("Review unresolved projection must exactly identify every unresolved finding");
  }

  const blockers=findings.filter(finding =>
    !finding.resolved && ["Critical","Important"].includes(finding.severity));
  if (value.verdict==="APPROVED" && blockers.length>0) {
    invalid("An APPROVED review cannot contain unresolved Critical or Important findings");
  }
  if (value.verdict!=="APPROVED" && unresolved.length===0) {
    invalid("A non-approved review must identify at least one unresolved finding");
  }

  const minorCount=findings.filter(finding =>
    !finding.resolved && finding.severity==="Minor").length;
  const followUpIssues=[...value.follow_up_issues].sort(compare);
  if (followUpIssues.length>minorCount) {
    invalid("Review follow-up issues may refer only to unresolved Minor findings");
  }
  for (const issueId of followUpIssues) {
    let parsed;
    try { parsed=parseWorkItemId(issueId); }
    catch (error) { invalid("Review follow-up issue must be a canonical work-item ID",{cause:error}); }
    if (parsed.repository!==value.repository) {
      invalid("Review follow-up issues must belong to the reviewed repository");
    }
  }

  if (Date.parse(value.reviewed_at)>Date.parse(value.recorded_at)) {
    invalid("Review recorded_at cannot precede reviewed_at");
  }
  identityKey(value.reviewer.identity,"Review reviewer identity");

  return Object.freeze({
    ...value,
    findings:Object.freeze(findings),
    unresolved:Object.freeze(unresolved),
    verification_evidence:Object.freeze([...value.verification_evidence].sort(compare)),
    follow_up_issues:Object.freeze(followUpIssues),
  });
}

export function validateImplementationIdentity(input) {
  const value=copyClosed(input,"Implementation identity evidence");
  exact(value,[
    "base_revision","revision","pull_request_author","commit_count","commits_sha256","commits",
  ],"Implementation identity evidence");
  sha(value.base_revision,"Implementation identity base revision");
  sha(value.revision,"Implementation identity revision");
  if (value.base_revision===value.revision) {
    invalid("Implementation identity base and head revisions must differ");
  }
  identityKey(value.pull_request_author,"Pull request author identity");
  if (!Array.isArray(value.commits) || value.commits.length===0) {
    invalid("Implementation identity evidence must contain every implementation commit identity");
  }
  if (!Number.isSafeInteger(value.commit_count) || value.commit_count<1 ||
      value.commit_count!==value.commits.length) {
    invalid("Implementation identity commit count must equal the complete commit evidence length");
  }
  if (typeof value.commits_sha256!=="string" || !SHA256.test(value.commits_sha256)) {
    invalid("Implementation identity commit digest must be a lowercase SHA-256 digest");
  }
  const revisions=new Set();
  const commits=value.commits.map(commit => {
    exact(commit,["revision","author","committer"],"Implementation commit identity");
    sha(commit.revision,"Implementation commit revision");
    identityKey(commit.author,"Implementation commit author identity");
    identityKey(commit.committer,"Implementation commit committer identity");
    if (revisions.has(commit.revision)) invalid(`Implementation commit revision is duplicated: ${commit.revision}`);
    revisions.add(commit.revision);
    return commit;
  }).sort((left,right) => compare(left.revision,right.revision));
  if (!revisions.has(value.revision)) {
    invalid("Implementation identity evidence must include the exact current revision");
  }
  if (value.commits_sha256!==sha256Canonical(commits)) {
    invalid("Implementation identity commit digest must bind the canonical complete commit evidence");
  }
  return Object.freeze({...value,commits:Object.freeze(commits)});
}

export function assertIndependentReviewer(reviewerIdentity,implementationIdentity) {
  const reviewer=identityKey(reviewerIdentity,"Review reviewer identity");
  const evidence=validateImplementationIdentity(implementationIdentity);
  const implementers=new Set([
    identityKey(evidence.pull_request_author,"Pull request author identity"),
    ...evidence.commits.flatMap(commit => [
      identityKey(commit.author,"Implementation commit author identity"),
      identityKey(commit.committer,"Implementation commit committer identity"),
    ]),
  ]);
  if (implementers.has(reviewer)) {
    throw new CoreBlockedError("The review must be produced by an independent reviewer");
  }
  return true;
}

export function reviewFreshness(resultInput,currentHeadSha) {
  const result=normalizeReviewResult(resultInput);
  const current=sha(currentHeadSha,"Current pull request head");
  sha(result.reviewed_revision,"Reviewed revision");
  return result.freshness==="STALE" || result.reviewed_revision!==current ? "STALE" : "CURRENT";
}
