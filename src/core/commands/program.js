import {sha256Canonical} from "../../contracts/acp.js";
import {CoreConflictError,CoreValidationError} from "../errors.js";
import {normalizeReleasePlanningState,programStatusResult} from "../release/operations.js";
import {closedData,ownDataFunction,ownDataValue} from "./common.js";

function compareProgramIds(left,right) {
  const leftNumber=BigInt(left.program_id.slice("TOSS-OS-R".length));
  const rightNumber=BigInt(right.program_id.slice("TOSS-OS-R".length));
  return leftNumber<rightNumber ? -1 : leftNumber>rightNumber ? 1 :
    left.program_id<right.program_id ? -1 : left.program_id>right.program_id ? 1 : 0;
}

function selectedPrograms(state,programId) {
  if (programId!==null) {
    const program=state.programs.find(value => value.program_id===programId);
    if (!program) throw new CoreConflictError(`Unknown release program: ${programId}`);
    return [program];
  }
  const open=state.programs.filter(value => value.phase!=="RELEASED").sort(compareProgramIds);
  if (open.length>0) return open;
  return state.programs.length===0 ? [] : [[...state.programs].sort(compareProgramIds).at(-1)];
}

export async function runProgramCommand(command,services) {
  if (command.name==="program.status") {
    if (command.options.from!==null || command.options.authority!==null) {
      throw new CoreValidationError("Program status does not accept authority or input files");
    }
    const control=ownDataValue(services,"control","services");
    const state=normalizeReleasePlanningState(
      await ownDataFunction(control,"loadReleasePlanningState","control")(),
    );
    const programId=command.args[0] ?? null;
    const programs=selectedPrograms(state,programId);
    const repositories=new Set(programs.flatMap(program =>
      program.repository_releases.map(release => release.repository)));
    const github=closedData(await ownDataFunction(
      ownDataValue(services,"github","services"),"snapshot","github",
    )({kind:"program-status",control_revision:state.revision,programs:state.programs,
      selected_programs:programs,
      repository_configurations:state.repositories.filter(value => repositories.has(value.repository)),
      project:state.organization.project}),"program status GitHub snapshot");
    if (!github || typeof github!=="object" || Array.isArray(github) || Object.hasOwn(github,"source")) {
      throw new CoreValidationError("program status GitHub snapshot must contain only independent GitHub evidence");
    }
    const snapshot=closedData({...github,source:{
      repository:state.organization.control_repository,revision:state.revision,
      sha256:sha256Canonical({control:state,github}),
    }},"program status aggregate snapshot");
    return programStatusResult({planningState:state,programId,snapshot});
  }
  throw new CoreValidationError("Unsupported program command");
}
