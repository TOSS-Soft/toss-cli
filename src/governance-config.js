const ALLOWED_GOVERNANCE_KEYS = new Set(["delivery"]);

export function resolveGovernanceProfiles(brief={}) {
  const governance=brief.governance ?? {};
  if (typeof governance !== "object" || governance === null || Array.isArray(governance)) {
    throw new TypeError("Project Brief governance must be an object.");
  }
  if (governance.assurance === true) {
    throw new TypeError(
      "Project Brief governance.assurance is not supported in TOSS CLI 2.0.",
    );
  }
  for (const key of Object.keys(governance)) {
    if (!ALLOWED_GOVERNANCE_KEYS.has(key)) {
      throw new TypeError(`Project Brief contains unknown governance key: ${key}`);
    }
  }
  const delivery=governance.delivery ?? false;
  if (typeof delivery !== "boolean") {
    throw new TypeError("Project Brief governance.delivery must be true or false.");
  }
  return Object.freeze({core:true,delivery});
}
