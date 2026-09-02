import {CoreConflictError,CoreValidationError} from "../errors.js";
import {normalizeReviewResult} from "../domain/review.js";

export const REVIEW_MARKERS=Object.freeze({
  start:"<!-- toss-core:review-results:start -->",
  end:"<!-- toss-core:review-results:end -->",
});

const MARKER_LIKE=/<!--\s*toss-core:review-results:[^>]*-->/giu;
const MARKER_SIGNAL=/toss-core\s*:\s*review-results\b/giu;

function bodyText(value) {
  if (typeof value!=="string") throw new CoreValidationError("Pull request body must be text");
  return value;
}

function oneLine(value) {
  const normalized=value.normalize("NFKC")
    .replace(/[\p{C}\s]+/gu," ")
    .trim()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;");
  return normalized.replace(/([\\`*_{}\[\]()#+.!|\-])/gu,"\\$1");
}

function occurrences(body,marker) {
  const indexes=[];
  let offset=0;
  while (offset<=body.length) {
    const index=body.indexOf(marker,offset);
    if (index===-1) break;
    indexes.push(index);
    offset=index+marker.length;
  }
  return indexes;
}

export function parseManagedReviewBlock(bodyInput) {
  const body=bodyText(bodyInput);
  const starts=occurrences(body,REVIEW_MARKERS.start);
  const ends=occurrences(body,REVIEW_MARKERS.end);
  const signals=[...body.matchAll(MARKER_SIGNAL)];
  if (signals.length!==starts.length+ends.length) {
    throw new CoreConflictError("Pull request body contains a partial or marker-like managed review block");
  }
  for (const match of body.matchAll(MARKER_LIKE)) {
    if (match[0]!==REVIEW_MARKERS.start && match[0]!==REVIEW_MARKERS.end) {
      throw new CoreConflictError("Pull request body contains a marker-like managed review block");
    }
  }
  if (starts.length===0 && ends.length===0) return null;
  if (starts.length!==1 || ends.length!==1 || starts[0]>=ends[0]) {
    throw new CoreConflictError("Pull request body has duplicate, nested, reversed, or partial review markers");
  }
  const end=ends[0]+REVIEW_MARKERS.end.length;
  return Object.freeze({
    before:body.slice(0,starts[0]),
    block:body.slice(starts[0],end),
    after:body.slice(end),
  });
}

export function renderManagedReviewBlock(resultInput) {
  const result=normalizeReviewResult(resultInput);
  const counts={Critical:0,Important:0,Minor:0};
  for (const finding of result.findings) counts[finding.severity]+=1;
  const unresolved=new Map(result.findings.map(finding => [finding.finding_id,finding]));
  const unresolvedLines=result.unresolved.length===0
    ? ["- None"]
    : result.unresolved.map(id => `- ${oneLine(id)}: ${oneLine(unresolved.get(id).summary)}`);
  const evidenceLines=[...result.verification_evidence]
    .sort()
    .map(value => `- ${oneLine(value)}`);
  const followUpLines=result.follow_up_issues.length===0
    ? ["- None"]
    : [...result.follow_up_issues].sort().map(value => `- ${oneLine(value)}`);
  return [
    REVIEW_MARKERS.start,
    "## Review results",
    "",
    `- Verdict: ${result.verdict}`,
    `- Reviewed revision: ${result.reviewed_revision}`,
    `- Reviewer: ${oneLine(result.reviewer.identity)} (${result.reviewer.role})`,
    `- Reviewed at: ${result.reviewed_at}`,
    `- Freshness: ${result.freshness}`,
    "",
    "### Findings",
    `- Critical: ${counts.Critical}`,
    `- Important: ${counts.Important}`,
    `- Minor: ${counts.Minor}`,
    "",
    "### Unresolved",
    ...unresolvedLines,
    "",
    "### Verification evidence",
    ...evidenceLines,
    "",
    "### Follow-up issues",
    ...followUpLines,
    REVIEW_MARKERS.end,
  ].join("\n");
}

export function updateManagedReviewBlock(bodyInput,resultInput) {
  const body=bodyText(bodyInput);
  const rendered=renderManagedReviewBlock(resultInput);
  const parsed=parseManagedReviewBlock(body);
  if (parsed!==null) return `${parsed.before}${rendered}${parsed.after}`;
  if (body.length===0) return rendered;
  return `${body}${body.endsWith("\n") ? "" : "\n"}${rendered}`;
}
