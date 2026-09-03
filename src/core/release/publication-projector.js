import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {compareCanonicalText} from "../canonical-order.js";
import {closedData,exact} from "../commands/common.js";
import {validateCoreDocument} from "../contracts.js";
import {CoreConflictError,CoreValidationError} from "../errors.js";
import {releaseApprovalLedgerEvidence} from "./approval-ledger.js";
import {planCurrentReleaseProgram} from "./current-program.js";
import {assertRepositoryConcurrency,transitionRepositoryRelease} from "./state.js";

const EVIDENCE_KEYS=Object.freeze([
  "schema_version","evidence_id","release_id","repository","version",
  "expected_revision","tag","package","github_release","evidence_sha256",
  "source_receipt","verified_at",
]);
const PLANNING_BUNDLE_KEYS=Object.freeze([
  "candidates","completed","repositories","activePrograms",
]);
const PUBLICATION_QUERY_KEYS=Object.freeze([
  "kind","control_revision","control_repository","organization","programs",
  "program","release","repository_configuration","project","approval_evidence",
]);
const PUBLICATION_DESCRIPTOR_KEYS=Object.freeze([
  "repository_revision","publication","planning","receipt_id","verified_at",
]);
const PUBLICATION_OBSERVATION_KEYS=Object.freeze([
  "kind","control_revision","repository_revision","publication","planning",
]);
const COMMIT=/^[a-f0-9]{40}$/u;
const RECEIPT=/^RECEIPT-[0-9]{8}-[0-9]{4,}$/u;
const EVIDENCE_ID=/^PUB-[0-9]{8}-[0-9]{4,}$/u;
const SHA512_INTEGRITY=/^sha512-([A-Za-z0-9+/]{85}[AQgw]==)$/u;
const RFC3339_DATE_TIME=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u;

function failure(code,message) {
  return Object.freeze({code,message});
}

export function publicationComplete(failures) {
  const values=closedData(failures,"Publication failures");
  if (!Array.isArray(values)) {
    throw new CoreValidationError("Publication failures must be an array");
  }
  const codes=new Set();
  for (const value of values) {
    exact(value,["code","message"],"Publication failure");
    if (typeof value.code!=="string" || !/^[A-Z][A-Z0-9_]*$/u.test(value.code) ||
        typeof value.message!=="string" || !/\S/u.test(value.message) || codes.has(value.code)) {
      throw new CoreValidationError(
        "Publication failures must use unique canonical code and message records",
      );
    }
    codes.add(value.code);
  }
  return Object.freeze({
    verified:values.length===0,
    failures:Object.freeze([...values].sort((left,right) =>
      compareCanonicalText(left.code,right.code))),
  });
}

function optionalRecord(value,keys,label) {
  if (value===null) return null;
  exact(value,keys,label);
  return value;
}

function evidenceHash(value) {
  const {evidence_sha256,...unsigned}=value;
  void evidence_sha256;
  return sha256Canonical(unsigned);
}

function validSha512Integrity(value) {
  const match=typeof value==="string" ? SHA512_INTEGRITY.exec(value) : null;
  if (!match) return false;
  const decoded=Buffer.from(match[1],"base64");
  return decoded.length===64 && decoded.toString("base64")===match[1];
}

function validTimestamp(value) {
  const match=typeof value==="string" ? RFC3339_DATE_TIME.exec(value) : null;
  if (!match) return false;
  const [,yearText,monthText,dayText,hourText,minuteText,secondText,
    offsetHourText,offsetMinuteText]=match;
  const year=Number(yearText);
  const month=Number(monthText);
  const day=Number(dayText);
  const leap=year%4===0 && (year%100!==0 || year%400===0);
  const days=month===2 ? (leap ? 29 : 28) : [4,6,9,11].includes(month) ? 30 : 31;
  return month>=1 && month<=12 && day>=1 && day<=days &&
    Number(hourText)<=23 && Number(minuteText)<=59 && Number(secondText)<=59 &&
    (offsetHourText===undefined ||
      (Number(offsetHourText)<=23 && Number(offsetMinuteText)<=59));
}

export function verifyPublication(releaseInput,evidenceInput) {
  const release=validateCoreDocument(
    closedData(releaseInput,"Publication release"),"repository-release.v1",
  );
  if (!["PUBLISHING","RELEASED"].includes(release.phase) || release.approval===null) {
    throw new CoreConflictError(
      "Publication verification requires an approved Publishing or Released release",
    );
  }
  const evidence=closedData(evidenceInput,"Publication evidence");
  exact(evidence,EVIDENCE_KEYS,"Publication evidence");
  const failures=[];
  if (evidence.schema_version!=="publication-evidence.v1") {
    failures.push(failure(
      "EVIDENCE_SCHEMA_MISMATCH","Evidence schema is not publication-evidence.v1.",
    ));
  }
  if (typeof evidence.evidence_id!=="string" || !EVIDENCE_ID.test(evidence.evidence_id)) {
    failures.push(failure(
      "EVIDENCE_ID_INVALID","Evidence identity is missing or noncanonical.",
    ));
  }
  if (!validTimestamp(evidence.verified_at)) {
    failures.push(failure(
      "VERIFIED_AT_INVALID","Evidence verification time is missing or noncanonical.",
    ));
  }
  if (typeof evidence.evidence_sha256!=="string" ||
      evidence.evidence_sha256!==evidenceHash(evidence)) {
    failures.push(failure(
      "EVIDENCE_HASH_MISMATCH","Evidence hash does not bind its immutable content.",
    ));
  }
  if (evidence.release_id!==release.release_id || evidence.repository!==release.repository ||
      evidence.version!==release.version) {
    failures.push(failure(
      "RELEASE_IDENTITY_MISMATCH",
      "Evidence does not identify the selected repository release.",
    ));
  }
  const expectedRevision=release.approval.merge_result_revision;
  if (evidence.expected_revision!==expectedRevision || !COMMIT.test(evidence.expected_revision)) {
    failures.push(failure(
      "EXPECTED_REVISION_MISMATCH",
      "Evidence expected revision is not the approved merge result.",
    ));
  }

  const tag=optionalRecord(evidence.tag,["name","target_revision"],"Publication tag evidence");
  if (tag===null) {
    failures.push(failure("TAG_MISSING","The exact release tag is missing."));
  } else {
    if (tag.name!==`v${release.version}`) {
      failures.push(failure("TAG_NAME_MISMATCH","The release tag does not match the release version."));
    }
    if (tag.target_revision!==expectedRevision) {
      failures.push(failure(
        "TAG_TARGET_MISMATCH","The release tag does not target the approved merge result.",
      ));
    }
  }

  const packageEvidence=optionalRecord(
    evidence.package,["name","version","integrity"],"Publication package evidence",
  );
  if (packageEvidence===null) {
    failures.push(failure("PACKAGE_MISSING","The configured package is missing."));
  } else {
    if (packageEvidence.name!==release.approval.publication.package_name) {
      failures.push(failure(
        "PACKAGE_IDENTITY_MISMATCH","Published package identity differs from approved policy.",
      ));
    }
    if (packageEvidence.version!==release.version) {
      failures.push(failure(
        "PACKAGE_VERSION_MISMATCH","Published package version differs from the release.",
      ));
    }
    if (!validSha512Integrity(packageEvidence.integrity)) {
      failures.push(failure(
        "PACKAGE_INTEGRITY_INVALID","Published package integrity is missing or invalid.",
      ));
    }
  }

  const githubRelease=optionalRecord(evidence.github_release,
    ["release_id","tag_name","target_revision","draft","prerelease","assets"],
    "GitHub Release evidence");
  if (githubRelease===null) {
    failures.push(failure("GITHUB_RELEASE_MISSING","The GitHub Release is missing."));
  } else {
    if (typeof githubRelease.release_id!=="string" || !/\S/u.test(githubRelease.release_id) ||
        githubRelease.release_id.trim()!==githubRelease.release_id) {
      failures.push(failure(
        "GITHUB_RELEASE_ID_INVALID","The GitHub Release identity is missing or noncanonical.",
      ));
    }
    if (githubRelease.draft!==false || githubRelease.prerelease!==false) {
      failures.push(failure(
        "GITHUB_RELEASE_NOT_FINAL","The GitHub Release is draft or prerelease.",
      ));
    }
    if (githubRelease.tag_name!==`v${release.version}`) {
      failures.push(failure(
        "GITHUB_RELEASE_TAG_MISMATCH","The GitHub Release tag differs from the release version.",
      ));
    }
    if (githubRelease.target_revision!==expectedRevision) {
      failures.push(failure(
        "GITHUB_RELEASE_TARGET_MISMATCH",
        "The GitHub Release does not target the approved merge result.",
      ));
    }
    if (!Array.isArray(githubRelease.assets)) {
      throw new CoreValidationError("GitHub Release assets must be a dense array");
    }
    const names=[];
    for (const asset of githubRelease.assets) {
      exact(asset,["name","sha256"],"GitHub Release asset");
      if (typeof asset.name!=="string" || !/\S/u.test(asset.name) ||
          typeof asset.sha256!=="string" || !/^[a-f0-9]{64}$/u.test(asset.sha256)) {
        throw new CoreValidationError("GitHub Release asset is malformed");
      }
      names.push(asset.name);
    }
    const ordered=[...names].sort(compareCanonicalText);
    if (new Set(names).size!==names.length || canonicalJson(names)!==canonicalJson(ordered)) {
      failures.push(failure(
        "RELEASE_ASSET_IDENTITY_AMBIGUOUS",
        "GitHub Release assets are duplicate or noncanonical.",
      ));
    } else if (canonicalJson(names)!==
        canonicalJson(release.approval.publication.required_assets)) {
      failures.push(failure(
        "REQUIRED_ASSET_MISMATCH","GitHub Release assets differ from approved policy.",
      ));
    }
  }
  if (typeof evidence.source_receipt!=="string" || !RECEIPT.test(evidence.source_receipt)) {
    failures.push(failure(
      "SOURCE_RECEIPT_INVALID",
      "Publication evidence does not cite a canonical verification receipt.",
    ));
  } else if (typeof evidence.evidence_id==="string" &&
      EVIDENCE_ID.test(evidence.evidence_id) &&
      evidence.evidence_id!==evidenceIdentity(evidence.source_receipt)) {
    failures.push(failure(
      "EVIDENCE_RECEIPT_MISMATCH",
      "Publication evidence identity does not derive from its source receipt.",
    ));
  }
  return publicationComplete(failures);
}

function evidenceIdentity(receiptId) {
  return `PUB-${receiptId.slice("RECEIPT-".length)}`;
}

function incrementRevision(value) {
  const match=/^REV-([0-9]{4,})$/u.exec(value);
  if (!match) throw new CoreValidationError("Program revision must be canonical");
  const number=Number(match[1]);
  if (!Number.isSafeInteger(number) || number<1 || number===Number.MAX_SAFE_INTEGER) {
    throw new CoreValidationError("Program revision cannot be incremented safely");
  }
  const next=String(number+1);
  return `REV-${next.padStart(Math.max(4,match[1].length),"0")}`;
}

function deepFreeze(value) {
  if (value===null || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function publicationObservation(query,descriptor) {
  return closedData({kind:"release-publication",control_revision:query.control_revision,
    repository_revision:descriptor.repository_revision,publication:descriptor.publication,
    planning:descriptor.planning},"Release publication normalized observation");
}

export function publicationSource(queryInput,observationInput) {
  const query=closedData(queryInput,"Release publication source query");
  const observation=closedData(observationInput,"Release publication source observation");
  exact(query,PUBLICATION_QUERY_KEYS,"Release publication source query");
  exact(observation,PUBLICATION_OBSERVATION_KEYS,"Release publication source observation");
  if (query.kind!=="release-publication" || observation.kind!==query.kind ||
      observation.control_revision!==query.control_revision ||
      typeof query.control_repository!=="string" || !/\S/u.test(query.control_repository) ||
      typeof query.control_revision!=="string" || !/\S/u.test(query.control_revision)) {
    throw new CoreConflictError("Publication source does not bind its exact query and observation");
  }
  return deepFreeze({repository:query.control_repository,revision:query.control_revision,
    sha256:sha256Canonical({control:query,github:observation})});
}

export function projectPublicationTransaction(queryInput,descriptorInput) {
  const query=closedData(queryInput,"Release publication query projection");
  const descriptor=closedData(descriptorInput,"Release publication observation descriptor");
  exact(query,PUBLICATION_QUERY_KEYS,"Release publication query projection");
  exact(descriptor,PUBLICATION_DESCRIPTOR_KEYS,"Release publication observation descriptor");
  exact(descriptor.publication,["tag","package","github_release"],
    "Release publication observation");
  if (descriptor.planning!==null) {
    exact(descriptor.planning,["candidates","completed","repositories"],
      "Release publication fresh planning descriptor");
  }
  if (query.kind!=="release-publication" || query.release.phase!=="PUBLISHING" ||
      query.release.approval===null ||
      query.control_repository!==query.organization.control_repository ||
      canonicalJson(query.programs.find(value => value.program_id===query.program.program_id))!==
        canonicalJson(query.program) ||
      canonicalJson(query.program.repository_releases.find(value =>
        value.release_id===query.release.release_id))!==canonicalJson(query.release) ||
      query.release.repository!==query.repository_configuration.repository ||
      query.release.approval.policy_revision!==query.organization.policy_revision ||
      canonicalJson(query.release.approval.publication)!==
        canonicalJson(query.repository_configuration.publication) ||
      typeof descriptor.repository_revision!=="string" || !descriptor.repository_revision ||
      typeof descriptor.receipt_id!=="string" || !RECEIPT.test(descriptor.receipt_id) ||
      !validTimestamp(descriptor.verified_at)) {
    throw new CoreConflictError(
      "Publication projection does not bind an exact approved Publishing release",
    );
  }
  releaseApprovalLedgerEvidence({organization:query.organization,
    intents:[query.approval_evidence.intent],receipts:[query.approval_evidence.receipt]},
  query.release);
  const unsignedEvidence={schema_version:"publication-evidence.v1",
    evidence_id:evidenceIdentity(descriptor.receipt_id),release_id:query.release.release_id,
    repository:query.release.repository,version:query.release.version,
    expected_revision:query.release.approval.merge_result_revision,
    tag:descriptor.publication.tag,package:descriptor.publication.package,
    github_release:descriptor.publication.github_release,
    source_receipt:descriptor.receipt_id,verified_at:descriptor.verified_at};
  const evidence=closedData({...unsignedEvidence,evidence_sha256:sha256Canonical(unsignedEvidence)},
    "Verified publication evidence");
  const verification=verifyPublication(query.release,evidence);
  if (!verification.verified) {
    throw new CoreConflictError(`Publication verification failed: ${verification.failures
      .map(value => value.code).join(", ")}`);
  }
  const released=transitionRepositoryRelease({...query.release,publication_evidence:evidence},{
    event:"VERIFY_PUBLICATION",expected_revision:query.release.revision,
    timestamp:descriptor.verified_at,source_receipt:descriptor.receipt_id,activation:null,
  });
  const releases=query.program.repository_releases.map(value =>
    value.release_id===query.release.release_id ? released : value);
  const last=releases.every(value => value.phase==="RELEASED");
  let program;
  let nextProgram=null;
  if (last) {
    if (descriptor.planning===null) {
      throw new CoreConflictError(
        "Last-track publication requires a fresh complete planning snapshot",
      );
    }
    const completion=completeProgram(query.program,releases,{...descriptor.planning,
      activePrograms:query.programs},() => descriptor.verified_at);
    program=completion.program;
    nextProgram=completion.nextProgram;
  } else {
    if (descriptor.planning!==null) {
      throw new CoreConflictError(
        "Non-final publication must not carry a next-program planning snapshot",
      );
    }
    const phase=releases.some(value => value.phase==="PUBLISHING") ? "PUBLISHING" :
      releases.some(value => value.phase==="PAUSED") ? "PAUSED" : "ACTIVE";
    program=closedData({...query.program,phase,
      revision:incrementRevision(query.program.revision),repository_releases:releases,
      updated_at:descriptor.verified_at},"Publication-updated release program");
    assertRepositoryConcurrency(query.programs.map(value =>
      value.program_id===query.program.program_id ? program : value));
  }
  const observation=publicationObservation(query,descriptor);
  const source=publicationSource(query,observation);
  const operations=[{resource:"repository",action:"verify",repository:query.release.repository,
    expected_revision:descriptor.repository_revision,payload:{kind:"release-publication-precondition",
      query,descriptor,snapshot_sha256:sha256Canonical(observation)}}];
  if (last) {
    const resulting=query.programs.map(value => value.program_id===query.program.program_id
      ? program
      : value.program_id===nextProgram.program_id ? nextProgram : value);
    if (!query.programs.some(value => value.program_id===nextProgram.program_id)) {
      resulting.push(nextProgram);
    }
    resulting.sort((left,right) => compareCanonicalText(left.program_id,right.program_id));
    operations.push({resource:"repository",action:"commit",repository:query.control_repository,
      expected_revision:sha256Canonical(query.programs),payload:{kind:"release-program-manifest-set",
        expected_set_sha256:sha256Canonical(query.programs),
        resulting_set_sha256:sha256Canonical(resulting),entries:resulting.map(value => ({
          program_id:value.program_id,expected_program_revision:query.programs.find(current =>
            current.program_id===value.program_id)?.revision ?? null,program:value,
        }))}});
  } else {
    operations.push({resource:"repository",action:"commit",repository:query.control_repository,
      expected_revision:query.program.revision,payload:{kind:"release-program-manifest",
        expected_program_revision:query.program.revision,
        expected_program_sha256:sha256Canonical(query.program),program}});
  }
  return deepFreeze({source,program,nextProgram,evidence,operations});
}

export function completeProgram(programInput,releasesInput,candidatesInput,clock) {
  if (typeof clock!=="function" || types.isProxy(clock)) {
    throw new CoreValidationError("Program completion clock is required");
  }
  const program=closedData(programInput,"Program completion manifest");
  validateCoreDocument(program,"release-program.v1");
  const releases=closedData(releasesInput,"Program completion releases");
  const bundle=closedData(candidatesInput,"Program completion planning bundle");
  exact(bundle,PLANNING_BUNDLE_KEYS,"Program completion planning bundle");
  if (!Array.isArray(releases) || releases.length!==program.repository_releases?.length) {
    throw new CoreConflictError(
      "Program completion requires every repository release exactly once",
    );
  }
  const expectedIds=program.repository_releases.map(value => value.release_id)
    .sort(compareCanonicalText);
  const suppliedIds=releases.map(value => value?.release_id).sort(compareCanonicalText);
  if (new Set(suppliedIds).size!==suppliedIds.length ||
      canonicalJson(expectedIds)!==canonicalJson(suppliedIds) ||
      canonicalJson(program.repository_releases.map(value => value.release_id))!==
        canonicalJson(releases.map(value => value.release_id))) {
    throw new CoreConflictError(
      "Program completion release inventory is incomplete or ambiguous",
    );
  }
  for (const release of releases) {
    validateCoreDocument(release,"repository-release.v1");
    if (release.program_id!==program.program_id || release.phase!=="RELEASED" ||
        release.publication_evidence===null ||
        !verifyPublication(release,release.publication_evidence).verified) {
      throw new CoreConflictError(
        "Program completion requires verified Released tracks from the selected program",
      );
    }
  }
  if (!Array.isArray(bundle.candidates) || !Array.isArray(bundle.completed) ||
      !Array.isArray(bundle.repositories)) {
    throw new CoreValidationError("Program completion planning inventory must use arrays");
  }
  const releasedScope=new Set(releases.flatMap(release => release.scope));
  if ([...releasedScope].some(id => !bundle.completed.includes(id)) ||
      bundle.candidates.some(candidate => releasedScope.has(candidate?.id))) {
    throw new CoreConflictError(
      "Fresh planning bundle must retire every just-released scope identity",
    );
  }
  for (const release of releases) {
    const history=bundle.repositories.filter(value => value?.repository===release.repository);
    if (history.length!==1 || history[0].latest_published_version!==release.version) {
      throw new CoreConflictError(
        "Fresh planning bundle repository history is stale or ambiguous",
      );
    }
  }
  const timestamp=clock();
  const completed=closedData({...program,phase:"RELEASED",
    revision:incrementRevision(program.revision),repository_releases:releases,
    updated_at:timestamp},"Completed release program");
  if (!Array.isArray(bundle.activePrograms)) {
    throw new CoreValidationError("Program completion activePrograms must be an array");
  }
  const matching=bundle.activePrograms.filter(value => value?.program_id===program.program_id);
  if (matching.length!==1 || canonicalJson(matching[0])!==canonicalJson(program)) {
    throw new CoreConflictError(
      "Fresh planning bundle must contain the exact completing program",
    );
  }
  assertRepositoryConcurrency(bundle.activePrograms);
  const activePrograms=bundle.activePrograms.map(value =>
    value.program_id===program.program_id ? completed : value);
  assertRepositoryConcurrency(activePrograms);
  const nextProgram=planCurrentReleaseProgram({programs:activePrograms,
    candidates:bundle.candidates,completed:bundle.completed,
    repositories:bundle.repositories,clock}).program;
  return deepFreeze({program:completed,nextProgram});
}
