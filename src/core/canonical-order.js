import {canonicalJson} from "../contracts/acp.js";

export function compareCanonicalText(left,right) {
  if (left===right) return 0;
  return left<right ? -1 : 1;
}

export function compareCanonicalValue(left,right) {
  return compareCanonicalText(canonicalJson(left),canonicalJson(right));
}
