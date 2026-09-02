import {canonicalJson} from "../contracts/acp.js";
import {compareCanonicalText} from "./canonical-order.js";

const RELEASE_OPERATION_RANK=Object.freeze(new Map([
  ["release-plan-precondition",-100],
  ["release-activation-precondition",-99],
  ["release-patch-precondition",-98.5],
  ["release-patch-completion-precondition",-98.25],
  ["release-repository-precondition",-98],
  ["release-default-branch-precondition",-97],
  ["release-milestone-precondition",-96],
  ["release-branch-precondition",-95],
  ["release-pull-request-precondition",-94],
  ["release-assignment-precondition",-93],
  ["release-epic-branch-precondition",-92],
  ["release-project-item-precondition",-91],
  ["release-milestone",10],
  ["release-branch",20],
  ["release-patch-reconcile",25],
  ["release-program-manifest",30],
  ["release-pull-request",40],
  ["release-assignment",50],
  ["release-epic-branch",60],
  ["release-project-state",70],
  ["release-patch-review-stale",71],
  ["release-check-request",72],
]));

function nullFirst(left,right) {
  if (left===right) return 0;
  if (left===null) return -1;
  if (right===null) return 1;
  return left<right ? -1 : 1;
}

export function compareOperations(left,right) {
  const leftRank=RELEASE_OPERATION_RANK.get(left.payload?.kind);
  const rightRank=RELEASE_OPERATION_RANK.get(right.payload?.kind);
  if (leftRank!==undefined || rightRank!==undefined) {
    if (leftRank===undefined) return -1;
    if (rightRank===undefined) return 1;
    if (leftRank!==rightRank) return leftRank-rightRank;
  }
  for (const [a,b] of [[left.repository,right.repository],[left.resource,right.resource],[left.action,right.action]]) {
    const comparison=nullFirst(a,b);
    if (comparison!==0) return comparison;
  }
  const payload=compareCanonicalText(canonicalJson(left.payload),canonicalJson(right.payload));
  if (payload!==0) return payload;
  const revision=nullFirst(left.expected_revision,right.expected_revision);
  if (revision!==0) return revision;
  return compareCanonicalText(canonicalJson({resource:left.resource,action:left.action,repository:left.repository,expected_revision:left.expected_revision,payload:left.payload,...(Object.hasOwn(left,"compensation") ? {compensation:left.compensation} : {})}),canonicalJson({resource:right.resource,action:right.action,repository:right.repository,expected_revision:right.expected_revision,payload:right.payload,...(Object.hasOwn(right,"compensation") ? {compensation:right.compensation} : {})}));
}
