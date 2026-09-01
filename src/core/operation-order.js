import {canonicalJson} from "../contracts/acp.js";
import {compareCanonicalText} from "./canonical-order.js";

function nullFirst(left,right) {
  if (left===right) return 0;
  if (left===null) return -1;
  if (right===null) return 1;
  return left<right ? -1 : 1;
}

export function compareOperations(left,right) {
  for (const [a,b] of [[left.repository,right.repository],[left.resource,right.resource],[left.action,right.action]]) {
    const comparison=nullFirst(a,b);
    if (comparison!==0) return comparison;
  }
  const payload=compareCanonicalText(canonicalJson(left.payload),canonicalJson(right.payload));
  if (payload!==0) return payload;
  const revision=nullFirst(left.expected_revision,right.expected_revision);
  if (revision!==0) return revision;
  return compareCanonicalText(canonicalJson({resource:left.resource,action:left.action,repository:left.repository,expected_revision:left.expected_revision,payload:left.payload}),canonicalJson({resource:right.resource,action:right.action,repository:right.repository,expected_revision:right.expected_revision,payload:right.payload}));
}
