import {types} from "node:util";

import {sha256Canonical} from "../../contracts/acp.js";
import {parseWorkItemId} from "../domain/identity.js";
import {normalizeReviewResult} from "../domain/review.js";
import {CoreBlockedError,CoreValidationError} from "../errors.js";
import {recordReview,reviewStatus} from "../review/recorder.js";
import {closedData,exact,ownDataFunction,ownDataValue} from "./common.js";

const PULL_REQUEST_KEYS=Object.freeze([
  "repository","number","native_revision","revision","head_repository","base_repository",
  "head","base","head_sha","body","formal_review","recorded_result","checks","work",
]);
const IMPLEMENTATION_IDENTITY_KEYS=Object.freeze([
  "base_revision","revision","pull_request_author","commit_count","commits_sha256","commits",
]);
const PROJECT_KEYS=Object.freeze([
  "project_id","item_id","revision","follow_up_mappings","reservations",
]);

function confirmation(command,services) {
  if (!command.options.apply || !command.interactive) return undefined;
  if (!services || typeof services!=="object" || types.isProxy(services) ||
      !Object.hasOwn(services,"confirm")) {
    throw new CoreBlockedError("Interactive apply requires CLI confirmation");
  }
  return ownDataFunction(services,"confirm","services");
}

function assertUngated(command) {
  if (command.options.authority!==null) {
    throw new CoreValidationError("Review commands do not accept an authority record");
  }
}

function queryFor(reference,reservationRequest=null) {
  const identity=parseWorkItemId(reference);
  return Object.freeze({
    kind:"review",repository:identity.repository,number:identity.issueNumber,
    ...(reservationRequest===null ? {} : reservationRequest),
  });
}

function normalizeSnapshot(input,query) {
  const snapshot=closedData(input,"review command snapshot");
  exact(snapshot,["kind","source","pullRequest","implementationIdentity","project"],"review command snapshot");
  exact(snapshot.source,["repository","revision","sha256"],"review snapshot source");
  exact(snapshot.pullRequest,PULL_REQUEST_KEYS,"review snapshot pull request");
  exact(snapshot.implementationIdentity,IMPLEMENTATION_IDENTITY_KEYS,"review snapshot implementation identity");
  exact(snapshot.project,PROJECT_KEYS,"review snapshot Project evidence");
  exact(snapshot.pullRequest.formal_review,[
    "state","review_id","reviewed_revision",
  ],"review snapshot formal review");
  exact(snapshot.pullRequest.checks,["state","revision"],"review snapshot checks");
  if (!Array.isArray(snapshot.implementationIdentity.commits) ||
      !Array.isArray(snapshot.project.follow_up_mappings) ||
      !Array.isArray(snapshot.project.reservations)) {
    throw new CoreValidationError("Review snapshot evidence collections must be arrays");
  }
  for (const commit of snapshot.implementationIdentity.commits) {
    exact(commit,["revision","author","committer"],"review snapshot implementation commit");
  }
  const semantic=Object.freeze({
    kind:snapshot.kind,pullRequest:snapshot.pullRequest,
    implementationIdentity:snapshot.implementationIdentity,project:snapshot.project,
  });
  const semanticHash=sha256Canonical(semantic);
  if (snapshot.kind!=="review" || snapshot.pullRequest.repository!==query.repository ||
      snapshot.pullRequest.number!==query.number || snapshot.source.repository!==query.repository ||
      snapshot.source.revision!==snapshot.pullRequest.revision ||
      typeof snapshot.source.sha256!=="string" || !/^[a-f0-9]{64}$/u.test(snapshot.source.sha256) ||
      snapshot.source.sha256!==semanticHash) {
    throw new CoreValidationError("Review snapshot does not bind the requested pull request");
  }
  return snapshot;
}

function statusInput(snapshot) {
  return Object.freeze({
    pullRequest:snapshot.pullRequest,
    implementationIdentity:snapshot.implementationIdentity,
    project:snapshot.project,
  });
}

async function snapshot(command,services,reservationRequest=null) {
  const query=queryFor(command.args[0],reservationRequest);
  const github=ownDataValue(services,"github","services");
  return normalizeSnapshot(
    await ownDataFunction(github,"snapshot","github")(query),query,
  );
}

async function record(command,services) {
  assertUngated(command);
  if (command.options.from===null) {
    throw new CoreValidationError("review record requires --from <FILE>");
  }
  const result=normalizeReviewResult(
    await ownDataFunction(services,"readInput","services")(command.options.from),
  );
  const unresolvedMinorFindingIds=result.findings
    .filter(finding => !finding.resolved && finding.severity==="Minor")
    .map(finding => finding.finding_id)
    .sort();
  const observed=await snapshot(command,services,Object.freeze({
    review_id:result.review_id,
    unresolved_minor_finding_ids:Object.freeze(unresolvedMinorFindingIds),
  }));
  const operations=recordReview({...statusInput(observed),result});
  if (operations.length===0) {
    return closedData({
      status:"already-reconciled",
      review:reviewStatus(statusInput(observed)),
    },"review replay result");
  }
  const confirm=confirmation(command,services);
  const runner=ownDataValue(services,"operations","services");
  return ownDataFunction(runner,"execute","operations")({
    command,source:observed.source,operations,authority:null,
    ...(confirm===undefined ? {} : {confirm}),
  });
}

async function status(command,services) {
  if (command.options.from!==null || command.options.authority!==null) {
    throw new CoreValidationError("review status does not consume input or authority files");
  }
  return reviewStatus(statusInput(await snapshot(command,services)));
}

export async function runReviewCommand(command,services) {
  if (command.name==="review.record") return record(command,services);
  if (command.name==="review.status") return status(command,services);
  throw new CoreValidationError("Unsupported review command");
}
