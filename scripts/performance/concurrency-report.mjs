import {canonicalJson} from "../../src/contracts/acp.js";
import {median} from "./report.mjs";

export const CONCURRENCY_REPORT_VERSION="toss-test-concurrency-report.v1";
export const CONCURRENCY_CANDIDATES=Object.freeze([1,2,3,4]);

const HASH=/^[a-f0-9]{64}$/u;
const COMMIT=/^[a-f0-9]{40}$/u;
const HEADING=/^\[test\] lane=full entry=([^ ]+) outcome=(passed|failed|signaled|spawn_error) (?:status=(-?\d+)|signal=([^ ]+)|error_code=([^ ]+)) duration_ms=(\d+(?:\.\d+)?)$/u;
const ENTRY_RESULT_FIELDS=Object.freeze([
  "entry","outcome","exit_status","signal","error_code","duration_ms",
]);
const EVIDENCE_FIELDS=Object.freeze([
  "wall_ms","user_cpu_ms","system_cpu_ms","exit_status","fresh_process_count",
  "peak_process_count","duplicates","entry_results","orphan_process_count",
  "isolation_passed",
]);
const MEDIAN_FIELDS=Object.freeze([
  "wall_ms","user_cpu_ms","system_cpu_ms","fresh_process_count","peak_process_count",
]);
const ISOLATION_OWNER="test/command-store-fixture.test.js";

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
    throw new TypeError(`${label} must be an array`);
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

function deepFreeze(value) {
  if (value && typeof value==="object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function nonemptyString(value,label) {
  if (typeof value!=="string" || value.length===0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
  return value;
}

function finiteNonnegative(value,label) {
  if (typeof value!=="number" || !Number.isFinite(value) || value<0) {
    throw new TypeError(`${label} must be finite nonnegative`);
  }
  return value;
}

function nonnegativeInteger(value,label) {
  finiteNonnegative(value,label);
  if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer`);
  return value;
}

function safeEntry(value,label) {
  nonemptyString(value,label);
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") ||
      /^[A-Za-z]:/u.test(value)) {
    throw new TypeError(`${label} is unsafe`);
  }
  const segments=value.split("/");
  if (segments.length!==2 || segments.some(segment => !segment || segment==="." || segment==="..")) {
    throw new TypeError(`${label} is unsafe`);
  }
  const [directory,file]=segments;
  if ((directory!=="test" || !file.endsWith(".test.js")) &&
      (directory!=="scripts" || !file.endsWith("-test.js"))) {
    throw new TypeError(`${label} is unsafe`);
  }
  return value;
}

function normalizeIdentity(value) {
  const identity=closedRecord(value,"concurrency identity",[
    "commit","node_version","platform","arch","lock_sha256","runner_id",
  ]);
  for (const key of Object.keys(identity)) nonemptyString(identity[key],`identity ${key}`);
  if (!COMMIT.test(identity.commit)) throw new TypeError("identity commit must be a Git commit SHA");
  if (!HASH.test(identity.lock_sha256)) {
    throw new TypeError("identity lock_sha256 must be a SHA-256 hex digest");
  }
  return {
    commit:identity.commit,node_version:identity.node_version,platform:identity.platform,
    arch:identity.arch,lock_sha256:identity.lock_sha256,runner_id:identity.runner_id,
  };
}

function normalizeEntries(value) {
  const entries=denseArray(value,"concurrency entries");
  const seen=new Set();
  return entries.map((entry,index) => {
    safeEntry(entry,`concurrency entry ${index+1}`);
    if (seen.has(entry)) throw new TypeError(`duplicate concurrency entry: ${entry}`);
    seen.add(entry);
    return entry;
  });
}

function normalizeEntryResult(value,expectedEntry,label) {
  const result=closedRecord(value,label,ENTRY_RESULT_FIELDS);
  safeEntry(result.entry,`${label} entry`);
  if (result.entry!==expectedEntry) {
    throw new TypeError(`${label} entry order mismatch: expected ${expectedEntry}`);
  }
  finiteNonnegative(result.duration_ms,`${label} duration_ms`);
  if (result.outcome==="passed") {
    if (result.exit_status!==0 || result.signal!==null || result.error_code!==null) {
      throw new TypeError(`${label} passed outcome requires status 0`);
    }
  } else if (result.outcome==="failed") {
    if (!Number.isInteger(result.exit_status) || result.exit_status===0 ||
        result.signal!==null || result.error_code!==null) {
      throw new TypeError(`${label} failed outcome requires a nonzero status`);
    }
  } else if (result.outcome==="signaled") {
    if (result.exit_status!==null || typeof result.signal!=="string" ||
        result.signal.length===0 || result.error_code!==null) {
      throw new TypeError(`${label} signaled outcome requires only a signal`);
    }
  } else if (result.outcome==="spawn_error") {
    if (result.exit_status!==null || result.signal!==null ||
        typeof result.error_code!=="string" || result.error_code.length===0) {
      throw new TypeError(`${label} spawn_error outcome requires only an error code`);
    }
  } else {
    throw new TypeError(`${label} has unknown outcome`);
  }
  return {
    entry:result.entry,outcome:result.outcome,exit_status:result.exit_status,
    signal:result.signal,error_code:result.error_code,duration_ms:result.duration_ms,
  };
}

function normalizeDuplicate(value,label) {
  const duplicate=closedRecord(value,label,["entry_path","count"]);
  nonemptyString(duplicate.entry_path,`${label} entry_path`);
  nonnegativeInteger(duplicate.count,`${label} count`);
  if (duplicate.count<2) throw new TypeError(`${label} count must be at least two`);
  return {entry_path:duplicate.entry_path,count:duplicate.count};
}

function normalizeEvidence(value,entries,label) {
  const evidence=closedRecord(value,label,EVIDENCE_FIELDS);
  const normalized={};
  for (const field of ["wall_ms","user_cpu_ms","system_cpu_ms"]) {
    normalized[field]=finiteNonnegative(evidence[field],`${label} ${field}`);
  }
  normalized.exit_status=nonnegativeInteger(evidence.exit_status,`${label} exit_status`);
  for (const field of ["fresh_process_count","peak_process_count"]) {
    normalized[field]=nonnegativeInteger(evidence[field],`${label} ${field}`);
  }
  if (normalized.peak_process_count>normalized.fresh_process_count) {
    throw new TypeError(`${label} peak_process_count cannot exceed fresh_process_count`);
  }
  normalized.duplicates=denseArray(evidence.duplicates,`${label} duplicates`).map(
    (duplicate,index) => normalizeDuplicate(duplicate,`${label} duplicate ${index+1}`),
  );
  const entryResults=denseArray(evidence.entry_results,`${label} entry results`);
  if (entryResults.length!==entries.length) {
    throw new TypeError(`${label} entry results must match the exact entry inventory`);
  }
  normalized.entry_results=entryResults.map((result,index) =>
    normalizeEntryResult(result,entries[index],`${label} entry result ${index+1}`));
  normalized.orphan_process_count=nonnegativeInteger(
    evidence.orphan_process_count,`${label} orphan_process_count`,
  );
  const allPassed=normalized.entry_results.every(result => result.outcome==="passed");
  if ((normalized.exit_status===0)!==allPassed) {
    throw new TypeError(`${label} aggregate exit_status does not match entry results`);
  }
  if (typeof evidence.isolation_passed!=="boolean") {
    throw new TypeError(`${label} isolation_passed must be boolean`);
  }
  const isolation=normalized.entry_results.find(result => result.entry===ISOLATION_OWNER);
  if (!isolation) throw new TypeError(`${label} requires the isolation owner result`);
  normalized.isolation_passed=isolation.outcome==="passed";
  if (evidence.isolation_passed!==normalized.isolation_passed) {
    throw new TypeError(`${label} isolation_passed must be derived from the isolation owner`);
  }
  return normalized;
}

function normalizeCaptureError(value,label) {
  const error=closedRecord(value,label,["code","message"]);
  nonemptyString(error.code,`${label} code`);
  nonemptyString(error.message,`${label} message`);
  return {code:error.code,message:error.message};
}

function normalizeSample(value,entries,candidateIndex,sampleIndex) {
  const label=`candidate ${candidateIndex} sample ${sampleIndex}`;
  const sample=closedRecord(value,label,["run","capture_error","evidence"]);
  if (sample.run!==sampleIndex) throw new TypeError(`${label} run number must match canonical order`);
  if (sample.capture_error===null) {
    if (sample.evidence===null) throw new TypeError(`${label} requires evidence`);
    return {run:sample.run,capture_error:null,evidence:normalizeEvidence(sample.evidence,entries,label)};
  }
  if (sample.evidence!==null) throw new TypeError(`${label} capture error requires evidence null`);
  return {
    run:sample.run,
    capture_error:normalizeCaptureError(sample.capture_error,`${label} capture error`),
    evidence:null,
  };
}

function stableSamples(samples,entries) {
  const manifestEntries=new Set(entries);
  return samples.every(sample => sample.capture_error===null && sample.evidence!==null &&
    sample.evidence.exit_status===0 && sample.evidence.orphan_process_count===0 &&
    sample.evidence.fresh_process_count>0 && sample.evidence.peak_process_count>0 &&
    !sample.evidence.duplicates.some(duplicate => manifestEntries.has(duplicate.entry_path)) &&
    sample.evidence.isolation_passed &&
    sample.evidence.entry_results.every(result => result.outcome==="passed"));
}

function sampleMedians(samples) {
  return Object.fromEntries(MEDIAN_FIELDS.map(field => [
    field,median(samples.map(sample => sample.evidence[field])),
  ]));
}

function normalizeMedians(value,label) {
  const medians=closedRecord(value,label,MEDIAN_FIELDS);
  return Object.fromEntries(MEDIAN_FIELDS.map(field => [
    field,finiteNonnegative(medians[field],`${label} ${field}`),
  ]));
}

function normalizeCandidate(value,entries,index,{verifyDerived=false}={}) {
  const label=`concurrency candidate ${index+1}`;
  const candidate=closedRecord(value,label,["concurrency","samples"],verifyDerived ? ["stable","medians"] : []);
  if (candidate.concurrency!==CONCURRENCY_CANDIDATES[index]) {
    throw new TypeError("concurrency candidates must appear in canonical order 1 through 4");
  }
  const samples=denseArray(candidate.samples,`${label} samples`);
  if (samples.length!==3) throw new TypeError(`${label} requires exactly three samples`);
  const normalizedSamples=samples.map((sample,sampleIndex) =>
    normalizeSample(sample,entries,index+1,sampleIndex+1));
  const stable=stableSamples(normalizedSamples,entries);
  const medians=stable ? sampleMedians(normalizedSamples) : null;
  if (verifyDerived) {
    if (candidate.stable!==stable) throw new TypeError("invalid concurrency report derived stability");
    if (candidate.medians===null) {
      if (medians!==null) throw new TypeError("invalid concurrency report derived medians");
    } else {
      const supplied=normalizeMedians(candidate.medians,`${label} medians`);
      if (medians===null || canonicalJson(supplied)!==canonicalJson(medians)) {
        throw new TypeError("invalid concurrency report derived medians");
      }
    }
  }
  return {concurrency:candidate.concurrency,samples:normalizedSamples,stable,medians};
}

function normalizedSelection(value) {
  if (value===null) return null;
  const selection=closedRecord(value,"concurrency selection",["concurrency","reason"]);
  if (!CONCURRENCY_CANDIDATES.includes(selection.concurrency)) {
    throw new TypeError("concurrency selection has unknown candidate");
  }
  if (selection.reason!=="LOWEST_STABLE_WALL_MEDIAN") {
    throw new TypeError("concurrency selection has unknown reason");
  }
  return {concurrency:selection.concurrency,reason:selection.reason};
}

function selectNormalizedConcurrency(candidates) {
  const stable=[];
  candidates.forEach(row => {
    if (row.stable) stable.push({concurrency:row.concurrency,wall_ms:row.medians.wall_ms});
  });
  if (stable.length===0) return null;
  stable.sort((left,right) => left.wall_ms-right.wall_ms || left.concurrency-right.concurrency);
  return Object.freeze({
    concurrency:stable[0].concurrency,
    reason:"LOWEST_STABLE_WALL_MEDIAN",
  });
}

function inferSelectionEntries(candidates) {
  for (let candidateIndex=0;candidateIndex<candidates.length;candidateIndex+=1) {
    const candidate=closedRecord(
      candidates[candidateIndex],`selection candidate ${candidateIndex+1}`,
      ["concurrency","samples"],
    );
    if (candidate.concurrency!==CONCURRENCY_CANDIDATES[candidateIndex]) {
      throw new TypeError("selection candidates must appear in canonical order");
    }
    const samples=denseArray(candidate.samples,`selection candidate ${candidateIndex+1} samples`);
    if (samples.length!==3) {
      throw new TypeError(`selection candidate ${candidateIndex+1} requires exactly three samples`);
    }
    for (let sampleIndex=0;sampleIndex<samples.length;sampleIndex+=1) {
      const sample=closedRecord(
        samples[sampleIndex],
        `selection candidate ${candidateIndex+1} sample ${sampleIndex+1}`,
        ["run","capture_error","evidence"],
      );
      if (sample.evidence===null) continue;
      const evidence=closedRecord(
        sample.evidence,
        `selection candidate ${candidateIndex+1} sample ${sampleIndex+1} evidence`,
        EVIDENCE_FIELDS,
      );
      const results=denseArray(
        evidence.entry_results,
        `selection candidate ${candidateIndex+1} sample ${sampleIndex+1} entry results`,
      );
      return normalizeEntries(results.map((result,resultIndex) =>
        closedRecord(
          result,
          `selection candidate ${candidateIndex+1} sample ${sampleIndex+1} entry result ${resultIndex+1}`,
          ENTRY_RESULT_FIELDS,
        ).entry));
    }
  }
  return [];
}

export function selectStableConcurrency(value) {
  const candidates=denseArray(value,"selection candidates");
  if (candidates.length!==CONCURRENCY_CANDIDATES.length) {
    throw new TypeError("selection requires candidates 1 through 4");
  }
  const entries=inferSelectionEntries(candidates);
  const normalized=candidates.map((candidate,index) =>
    normalizeCandidate(candidate,entries,index));
  return selectNormalizedConcurrency(normalized);
}

function normalizeReportInput({identity,entries,candidates},{verifyDerived=false,selection}={}) {
  const normalizedEntries=normalizeEntries(entries);
  if (!normalizedEntries.includes(ISOLATION_OWNER)) {
    throw new TypeError("concurrency entries require the isolation owner");
  }
  const candidateRows=denseArray(candidates,"concurrency candidates");
  if (candidateRows.length!==CONCURRENCY_CANDIDATES.length) {
    throw new TypeError("concurrency report requires exactly four candidates 1 through 4");
  }
  const normalizedCandidates=candidateRows.map((candidate,index) =>
    normalizeCandidate(candidate,normalizedEntries,index,{verifyDerived}));
  const derivedSelection=selectNormalizedConcurrency(normalizedCandidates);
  if (verifyDerived) {
    const supplied=normalizedSelection(selection);
    if (canonicalJson(supplied)!==canonicalJson(derivedSelection)) {
      throw new TypeError("invalid concurrency report derived selection");
    }
  }
  return {
    schema_version:CONCURRENCY_REPORT_VERSION,
    identity:normalizeIdentity(identity),
    entries:normalizedEntries,
    candidates:normalizedCandidates,
    selection:derivedSelection,
  };
}

export function createConcurrencyReport(value) {
  const input=closedRecord(value,"concurrency report input",["identity","entries","candidates"]);
  return deepFreeze(normalizeReportInput(input));
}

export function canonicalConcurrencyJson(value) {
  const report=closedRecord(value,"concurrency report",[
    "schema_version","identity","entries","candidates","selection",
  ]);
  if (report.schema_version!==CONCURRENCY_REPORT_VERSION) {
    throw new TypeError("invalid concurrency report schema_version");
  }
  return canonicalJson(normalizeReportInput(report,{
    verifyDerived:true,selection:report.selection,
  }));
}

export function parseFullLaneHeadings(output,expectedEntries) {
  if (typeof output!=="string") throw new TypeError("full lane output must be a string");
  const entries=normalizeEntries(expectedEntries);
  const parsed=[];
  const seen=new Set();
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith("[test]")) continue;
    const match=HEADING.exec(line);
    if (!match) throw new TypeError("invalid full lane heading");
    const [,entry,outcome,status,signal,errorCode,duration]=match;
    safeEntry(entry,"full lane heading entry");
    const expected=entries[parsed.length];
    if (!entries.includes(entry)) throw new TypeError(`unknown full lane heading entry: ${entry}`);
    if (seen.has(entry)) throw new TypeError(`duplicate full lane heading entry: ${entry}`);
    if (entry!==expected) throw new TypeError(`full lane heading order mismatch: expected ${expected}`);
    seen.add(entry);
    parsed.push(normalizeEntryResult({
      entry,outcome,
      exit_status:status===undefined ? null : Number(status),
      signal:signal ?? null,
      error_code:errorCode ?? null,
      duration_ms:Number(duration),
    },entry,`full lane heading ${parsed.length+1}`));
  }
  if (parsed.length!==entries.length) throw new TypeError("missing full lane heading");
  return deepFreeze(parsed);
}
