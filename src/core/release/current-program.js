import {canonicalJson} from "../../contracts/acp.js";
import {CoreConflictError,CoreValidationError} from "../errors.js";
import {planReleaseProgram} from "./planner.js";
import {nextReleaseProgramId} from "./program-id.js";
import {compareSemVer} from "./semver.js";
import {assertRepositoryConcurrency} from "./state.js";

const CURRENT_PHASES=Object.freeze(new Set(["DRAFT","WAITING_FOR_EPIC"]));

function incrementRevision(value) {
  const match=/^REV-([0-9]{4,})$/u.exec(value);
  if (!match) throw new CoreValidationError("Release program revision must be canonical");
  const number=Number(match[1]);
  if (!Number.isSafeInteger(number) || number<1 || number===Number.MAX_SAFE_INTEGER) {
    throw new CoreValidationError("Release program revision cannot be incremented safely");
  }
  const next=String(number+1);
  return `REV-${next.padStart(Math.max(4,match[1].length),"0")}`;
}

function comparable(program) {
  const {revision:_revision,created_at:_createdAt,updated_at:_updatedAt,...content}=program;
  return content;
}

function versionsForRepository(program,repository) {
  const rationale=program.rationale
    .filter(value => value.repository===repository)
    .map(value => value.version);
  const releases=program.repository_releases
    .filter(value => value.repository===repository && value.version!==null)
    .map(value => value.version);
  return [...rationale,...releases];
}

function assertMonotonicVersions(programs,current,proposed,repositories) {
  const observed=new Map(repositories.map(value => [
    value.repository,value.latest_published_version,
  ]));
  for (const repository of repositories) {
    const releasedVersions=programs.flatMap(program => program.repository_releases
      .filter(release => release.repository===repository.repository && release.phase==="RELEASED")
      .map(release => release.version));
    if (releasedVersions.some(version =>
      compareSemVer(repository.latest_published_version,version)<0)) {
      throw new CoreConflictError(
        `Observed published history for ${repository.repository} regresses persisted Released state`,
      );
    }
  }
  const retained=programs.filter(program => program.program_id!==current?.program_id);
  for (const rationale of proposed.rationale) {
    const published=observed.get(rationale.repository);
    if (published===undefined || compareSemVer(rationale.version,published)<=0 ||
        retained.flatMap(program => versionsForRepository(program,rationale.repository))
          .some(version => compareSemVer(rationale.version,version)<=0)) {
      throw new CoreConflictError(
        `Planned version ${rationale.version} for ${rationale.repository} is not monotonic and unused`,
      );
    }
  }
}

export function planCurrentReleaseProgram({programs,candidates,completed,repositories,clock}) {
  const currentRecords=programs.filter(program => CURRENT_PHASES.has(program.phase));
  if (currentRecords.length>1) {
    throw new CoreConflictError("Release planning has more than one current Draft or Waiting program");
  }
  const current=currentRecords[0] ?? null;
  const activePrograms=programs.filter(program => program.program_id!==current?.program_id);
  const proposed=planReleaseProgram({
    programId:current?.program_id ?? nextReleaseProgramId(programs),
    candidates,completed,repositories,activePrograms,clock,
  });
  assertMonotonicVersions(programs,current,proposed,repositories);
  if (current!==null && canonicalJson(comparable(current))===canonicalJson(comparable(proposed))) {
    return Object.freeze({current,program:current,changed:false});
  }
  const program=current===null ? proposed : Object.freeze({...proposed,
    revision:incrementRevision(current.revision),created_at:current.created_at});
  assertRepositoryConcurrency(current===null
    ? [...programs,program]
    : [...activePrograms,program]);
  return Object.freeze({current,program,changed:true});
}
