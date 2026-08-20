import {canonicalJson} from "../../src/contracts/acp.js";

export const VALIDATOR_REPORT_VERSION="toss-validator-cold-start-report.v1";

export const VALIDATOR_STRATEGIES=Object.freeze([
  "demand-driven",
  "eager-reference",
  "standalone-experiment",
]);

export const VALIDATOR_PHASES=Object.freeze([
  "process_ms",
  "module_ms",
  "schema_io_ms",
  "dependency_discovery_ms",
  "ajv_creation_ms",
  "schema_registration_ms",
  "compilation_ms",
  "first_validation_ms",
  "command_ms",
  "total_ms",
]);

const PROBE_NAMES=Object.freeze([
  "empty_process",
  "cli_module",
  "representative_command",
]);

const SELECTION_REASON_CODES=Object.freeze([
  "STANDALONE_FOCUSED_GAIN_UNPROVEN",
  "STANDALONE_FOCUSED_GAIN_BELOW_TEN_PERCENT",
  "STANDALONE_NONDETERMINISTIC",
  "STANDALONE_DRIFT_UNVERIFIED",
  "STANDALONE_RESULT_MISMATCH",
]);

const FOCUSED_BASE_COMMIT="2caf811f521ee1c1664104a68ea35512fc87fdc8";
const FOCUSED_BEFORE_SAMPLES=Object.freeze([
  32581.98975,
  32685.560625,
  32656.405041,
]);

function plainRecord(value,label) {
  if (!value || typeof value!=="object" || Array.isArray(value) ||
      Object.getPrototypeOf(value)!==Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function closedRecord(value,label,required,optional=[]) {
  const record=plainRecord(value,label);
  const allowed=new Set([...required,...optional]);
  if (Object.getOwnPropertySymbols(record).length>0) {
    throw new TypeError(`${label} has symbol property`);
  }
  for (const key of Object.getOwnPropertyNames(record)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unknown property ${key}`);
    const descriptor=Object.getOwnPropertyDescriptor(record,key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} property ${key} must be enumerable data`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record,key)) throw new TypeError(`${label} requires ${key}`);
  }
  return record;
}

function denseArray(value,label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype) {
    throw new TypeError(`${label} must be a plain array`);
  }
  if (Object.getOwnPropertySymbols(value).length>0) {
    throw new TypeError(`${label} has symbol property`);
  }
  const names=Object.getOwnPropertyNames(value);
  const keys=names.filter(key => key!=="length");
  if (names.length!==value.length+1 || keys.length!==value.length ||
      keys.some((key,index) => key!==String(index))) {
    throw new TypeError(`${label} must be dense`);
  }
  for (const key of keys) {
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} items must be enumerable data`);
    }
  }
  return value;
}

function finiteNumber(value,label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function finiteNonnegative(value,label) {
  if (!Number.isFinite(value) || value<0) {
    throw new TypeError(`${label} must be finite nonnegative`);
  }
  return value;
}

function nonemptyString(value,label) {
  if (typeof value!=="string" || value.length===0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
  return value;
}

function booleanValue(value,label) {
  if (typeof value!=="boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function threeNumbers(value,label) {
  const samples=denseArray(value,label);
  if (samples.length!==3) throw new TypeError(`${label} requires exactly three samples`);
  return samples.map((sample,index) =>
    finiteNonnegative(sample,`${label} sample ${index+1}`));
}

function medianOfThree(value,label) {
  return [...threeNumbers(value,label)].sort((left,right) => left-right)[1];
}

function normalizeIdentity(value) {
  const identity=closedRecord(value,"validator report identity",[
    "commit","node_version","platform","arch","lock_sha256","runner_id",
  ]);
  for (const key of ["commit","node_version","platform","arch","lock_sha256","runner_id"]) {
    nonemptyString(identity[key],`validator report identity ${key}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(identity.lock_sha256)) {
    throw new TypeError("validator report identity lock_sha256 must be a SHA-256 hex digest");
  }
  return {
    commit:identity.commit,
    node_version:identity.node_version,
    platform:identity.platform,
    arch:identity.arch,
    lock_sha256:identity.lock_sha256,
    runner_id:identity.runner_id,
  };
}

function normalizeSample(value,label) {
  const sample=closedRecord(value,label,["exit_status",...VALIDATOR_PHASES]);
  if (!Number.isInteger(sample.exit_status) || sample.exit_status!==0) {
    throw new TypeError(`${label} must have successful exit_status 0`);
  }
  const normalized={exit_status:0};
  for (const phase of VALIDATOR_PHASES) {
    normalized[phase]=finiteNonnegative(sample[phase],`${label} ${phase}`);
  }
  for (const phase of VALIDATOR_PHASES) {
    if (phase!=="total_ms" && normalized.total_ms<normalized[phase]) {
      throw new TypeError(`${label} total_ms must be at least ${phase}`);
    }
  }
  return normalized;
}

function normalizeSamples(value,label) {
  const samples=denseArray(value,label);
  if (samples.length!==3) throw new TypeError(`${label} requires exactly three samples`);
  return samples.map((sample,index) => normalizeSample(sample,`${label} sample ${index+1}`));
}

function normalizePhaseMedians(value,label) {
  const medians=closedRecord(value,label,VALIDATOR_PHASES);
  const normalized={};
  for (const phase of VALIDATOR_PHASES) {
    normalized[phase]=finiteNonnegative(medians[phase],`${label} ${phase}`);
  }
  return normalized;
}

function phaseMedians(samples) {
  const medians={};
  for (const phase of VALIDATOR_PHASES) {
    medians[phase]=medianOfThree(samples.map(sample => sample[phase]),`${phase} samples`);
  }
  return medians;
}

function normalizeMeasurement(value,label,{verifyMedians=false}={}) {
  const measurement=closedRecord(
    value,label,verifyMedians ? ["samples","medians"] : ["samples"],
    verifyMedians ? [] : ["medians"],
  );
  const samples=normalizeSamples(measurement.samples,`${label} samples`);
  const medians=phaseMedians(samples);
  if (measurement.medians!==undefined) {
    const supplied=normalizePhaseMedians(measurement.medians,`${label} medians`);
    if (verifyMedians && canonicalJson(supplied)!==canonicalJson(medians)) {
      throw new TypeError(`${label} medians do not match samples`);
    }
  }
  return {samples,medians};
}

function normalizeProbes(value,{verifyMedians=false}={}) {
  const probes=closedRecord(value,"validator report probes",PROBE_NAMES);
  return {
    empty_process:normalizeMeasurement(probes.empty_process,"empty_process probe",{verifyMedians}),
    cli_module:normalizeMeasurement(probes.cli_module,"cli_module probe",{verifyMedians}),
    representative_command:normalizeMeasurement(
      probes.representative_command,"representative_command probe",{verifyMedians},
    ),
  };
}

function normalizeStrategies(value,{verifyMedians=false}={}) {
  const strategies=denseArray(value,"validator report strategies");
  if (strategies.length!==VALIDATOR_STRATEGIES.length) {
    throw new TypeError("validator report requires exactly three strategies in canonical order");
  }
  return strategies.map((valueAtIndex,index) => {
    const label=`validator strategy ${index+1}`;
    const strategy=closedRecord(
      valueAtIndex,label,verifyMedians ? ["name","samples","medians"] : ["name","samples"],
      verifyMedians ? [] : ["medians"],
    );
    if (strategy.name!==VALIDATOR_STRATEGIES[index]) {
      throw new TypeError("validator strategy names must appear in canonical order");
    }
    return {
      name:strategy.name,
      ...normalizeMeasurement({
        samples:strategy.samples,
        ...(strategy.medians===undefined ? {} : {medians:strategy.medians}),
      },label,{verifyMedians}),
    };
  });
}

function normalizedFocusedSamples(value,label) {
  return threeNumbers(value,label);
}

function sameNumbers(left,right) {
  return left.length===right.length && left.every((value,index) => value===right[index]);
}

function normalizeFocusedGate(value,{verifyDerived=false}={}) {
  const focused=closedRecord(
    value,"validator focused gate",
    verifyDerived ? [
      "base_commit","before_samples_ms","before_median_ms",
      "after_samples_ms","after_median_ms","improvement_percent",
    ] : ["base_commit","before_samples_ms","after_samples_ms"],
    verifyDerived ? [] : ["before_median_ms","after_median_ms","improvement_percent"],
  );
  nonemptyString(focused.base_commit,"validator focused gate base_commit");
  if (focused.base_commit!==FOCUSED_BASE_COMMIT) {
    throw new TypeError("validator focused gate must use the locked base commit");
  }
  const beforeSamples=normalizedFocusedSamples(
    focused.before_samples_ms,"validator focused gate before samples",
  );
  if (!sameNumbers(beforeSamples,FOCUSED_BEFORE_SAMPLES)) {
    throw new TypeError("validator focused gate must use the locked before samples");
  }
  const afterSamples=normalizedFocusedSamples(
    focused.after_samples_ms,"validator focused gate after samples",
  );
  const beforeMedian=medianOfThree(beforeSamples,"validator focused gate before samples");
  if (beforeMedian===0) {
    throw new TypeError("validator focused gate before median must be positive");
  }
  const afterMedian=medianOfThree(afterSamples,"validator focused gate after samples");
  const improvementPercent=Number(
    (((beforeMedian-afterMedian)/beforeMedian)*100).toFixed(3),
  );
  if (focused.before_median_ms!==undefined) {
    finiteNonnegative(focused.before_median_ms,"validator focused gate before_median_ms");
  }
  if (focused.after_median_ms!==undefined) {
    finiteNonnegative(focused.after_median_ms,"validator focused gate after_median_ms");
  }
  if (focused.improvement_percent!==undefined) {
    finiteNumber(focused.improvement_percent,"validator focused gate improvement_percent");
  }
  if (verifyDerived && (focused.before_median_ms!==beforeMedian ||
      focused.after_median_ms!==afterMedian ||
      focused.improvement_percent!==improvementPercent)) {
    throw new TypeError("validator focused gate derived values do not match samples");
  }
  return {
    base_commit:focused.base_commit,
    before_samples_ms:beforeSamples,
    before_median_ms:beforeMedian,
    after_samples_ms:afterSamples,
    after_median_ms:afterMedian,
    improvement_percent:improvementPercent,
  };
}

function normalizeSelectionEvidence(value,{includeDemand=true}={}) {
  const required=[
    ...(includeDemand ? ["demand_focused_median_ms"] : []),
    "standalone_deterministic","standalone_drift_verified",
    "standalone_equivalent","standalone_focused_samples_ms",
  ];
  const evidence=closedRecord(value,"validator selection evidence",required);
  const normalized={};
  if (includeDemand) {
    normalized.demand_focused_median_ms=finiteNonnegative(
      evidence.demand_focused_median_ms,"validator selection evidence demand_focused_median_ms",
    );
  }
  normalized.standalone_deterministic=booleanValue(
    evidence.standalone_deterministic,
    "validator selection evidence standalone_deterministic",
  );
  normalized.standalone_drift_verified=booleanValue(
    evidence.standalone_drift_verified,
    "validator selection evidence standalone_drift_verified",
  );
  normalized.standalone_equivalent=booleanValue(
    evidence.standalone_equivalent,
    "validator selection evidence standalone_equivalent",
  );
  if (evidence.standalone_focused_samples_ms!==null) {
    normalized.standalone_focused_median_ms=medianOfThree(
      evidence.standalone_focused_samples_ms,
      "validator selection evidence standalone focused samples",
    );
  } else {
    normalized.standalone_focused_median_ms=null;
  }
  return normalized;
}

function selectNormalizedStrategy(evidence) {
  let reasonCode=null;
  if (evidence.standalone_focused_median_ms===null) {
    reasonCode=SELECTION_REASON_CODES[0];
  } else if (evidence.standalone_focused_median_ms>
      evidence.demand_focused_median_ms*0.90) {
    reasonCode=SELECTION_REASON_CODES[1];
  } else if (!evidence.standalone_deterministic) {
    reasonCode=SELECTION_REASON_CODES[2];
  } else if (!evidence.standalone_drift_verified) {
    reasonCode=SELECTION_REASON_CODES[3];
  } else if (!evidence.standalone_equivalent) {
    reasonCode=SELECTION_REASON_CODES[4];
  }
  const selected=reasonCode===null ? "standalone-experiment" : "demand-driven";
  return {
    selected,
    rejected:VALIDATOR_STRATEGIES.filter(strategy => strategy!==selected),
    standalone_deterministic:evidence.standalone_deterministic,
    standalone_drift_verified:evidence.standalone_drift_verified,
    standalone_equivalent:evidence.standalone_equivalent,
    standalone_focused_median_ms:evidence.standalone_focused_median_ms,
    reason_code:reasonCode,
  };
}

export function selectValidatorStrategy(value) {
  return selectNormalizedStrategy(normalizeSelectionEvidence(value));
}

function normalizeDecision(value) {
  const decision=closedRecord(value,"validator report decision",[
    "selected","rejected","standalone_deterministic","standalone_drift_verified",
    "standalone_equivalent","standalone_focused_median_ms","reason_code",
  ]);
  if (!VALIDATOR_STRATEGIES.includes(decision.selected)) {
    throw new TypeError("validator report decision selected is unknown");
  }
  const rejected=denseArray(decision.rejected,"validator report decision rejected");
  if (rejected.some(valueAtIndex => !VALIDATOR_STRATEGIES.includes(valueAtIndex))) {
    throw new TypeError("validator report decision rejected contains an unknown strategy");
  }
  booleanValue(decision.standalone_deterministic,
    "validator report decision standalone_deterministic");
  booleanValue(decision.standalone_drift_verified,
    "validator report decision standalone_drift_verified");
  booleanValue(decision.standalone_equivalent,
    "validator report decision standalone_equivalent");
  if (decision.standalone_focused_median_ms!==null) {
    finiteNonnegative(decision.standalone_focused_median_ms,
      "validator report decision standalone_focused_median_ms");
  }
  if (decision.reason_code!==null && !SELECTION_REASON_CODES.includes(decision.reason_code)) {
    throw new TypeError("validator report decision reason_code is unknown");
  }
  return {
    selected:decision.selected,
    rejected:[...rejected],
    standalone_deterministic:decision.standalone_deterministic,
    standalone_drift_verified:decision.standalone_drift_verified,
    standalone_equivalent:decision.standalone_equivalent,
    standalone_focused_median_ms:decision.standalone_focused_median_ms,
    reason_code:decision.reason_code,
  };
}

function matchingDecision(supplied,derived) {
  const normalized=normalizeDecision(supplied);
  if (canonicalJson(normalized)!==canonicalJson(derived)) {
    throw new TypeError("validator report decision does not match evidence");
  }
  return normalized;
}

export function createValidatorColdStartReport(value) {
  const input=closedRecord(value,"validator report input",[
    "identity","probes","strategies","focused_gate_cli","evidence",
  ],["decision"]);
  const identity=normalizeIdentity(input.identity);
  const probes=normalizeProbes(input.probes);
  const strategies=normalizeStrategies(input.strategies);
  const focusedGate=normalizeFocusedGate(input.focused_gate_cli);
  const evidence=normalizeSelectionEvidence(input.evidence,{includeDemand:false});
  const decision=selectNormalizedStrategy({
    demand_focused_median_ms:focusedGate.after_median_ms,
    ...evidence,
  });
  if (input.decision!==undefined) matchingDecision(input.decision,decision);
  return {
    schema_version:VALIDATOR_REPORT_VERSION,
    identity,
    probes,
    strategies,
    focused_gate_cli:focusedGate,
    decision,
  };
}

export function validateValidatorColdStartReport(value) {
  const report=closedRecord(value,"validator cold-start report",[
    "schema_version","identity","probes","strategies","focused_gate_cli","decision",
  ]);
  if (report.schema_version!==VALIDATOR_REPORT_VERSION) {
    throw new TypeError("validator cold-start report has unexpected schema_version");
  }
  const identity=normalizeIdentity(report.identity);
  const probes=normalizeProbes(report.probes,{verifyMedians:true});
  const strategies=normalizeStrategies(report.strategies,{verifyMedians:true});
  const focusedGate=normalizeFocusedGate(report.focused_gate_cli,{verifyDerived:true});
  const suppliedDecision=normalizeDecision(report.decision);
  const derivedDecision=selectNormalizedStrategy({
    demand_focused_median_ms:focusedGate.after_median_ms,
    standalone_deterministic:suppliedDecision.standalone_deterministic,
    standalone_drift_verified:suppliedDecision.standalone_drift_verified,
    standalone_equivalent:suppliedDecision.standalone_equivalent,
    standalone_focused_median_ms:suppliedDecision.standalone_focused_median_ms,
  });
  matchingDecision(suppliedDecision,derivedDecision);
  return {
    schema_version:VALIDATOR_REPORT_VERSION,
    identity,
    probes,
    strategies,
    focused_gate_cli:focusedGate,
    decision:derivedDecision,
  };
}

export function canonicalValidatorColdStartJson(value) {
  return canonicalJson(validateValidatorColdStartReport(value));
}
