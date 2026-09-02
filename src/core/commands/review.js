import {types} from "node:util";

import {parseWorkItemId} from "../domain/identity.js";
import {normalizeReviewResult} from "../domain/review.js";
import {CoreBlockedError,CoreValidationError} from "../errors.js";
import {recordReview,reviewStatus} from "../review/recorder.js";
import {closedData,exact,ownDataFunction,ownDataValue} from "./common.js";

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

function queryFor(reference) {
  const identity=parseWorkItemId(reference);
  return Object.freeze({kind:"review",repository:identity.repository,number:identity.issueNumber});
}

function normalizeSnapshot(input,query) {
  const snapshot=closedData(input,"review command snapshot");
  exact(snapshot,["kind","source","pullRequest","implementationIdentity","project"],"review command snapshot");
  exact(snapshot.source,["repository","revision","sha256"],"review snapshot source");
  if (snapshot.kind!=="review" || snapshot.pullRequest.repository!==query.repository ||
      snapshot.pullRequest.number!==query.number || snapshot.source.repository!==query.repository ||
      snapshot.source.revision!==snapshot.pullRequest.revision ||
      typeof snapshot.source.sha256!=="string" || !/^[a-f0-9]{64}$/u.test(snapshot.source.sha256)) {
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

async function snapshot(command,services) {
  const query=queryFor(command.args[0]);
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
  const observed=await snapshot(command,services);
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
