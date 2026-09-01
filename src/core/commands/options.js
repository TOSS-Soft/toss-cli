import {canonicalJson} from "../../contracts/acp.js";

export const CORE_COMMAND_TOKENS=Object.freeze([
  ["init"],
  ["repo","add"], ["repo","list"],
  ["feature","add"], ["feature","status"],
  ["epic","prepare"], ["epic","status"], ["epic","approve"],
  ["epic","submit"], ["epic","accept"],
  ["issue","add"], ["issue","start"], ["issue","submit"], ["issue","status"],
  ["dependency","add"], ["dependency","remove"],
  ["dependency","graph"], ["dependency","check"],
  ["review","record"], ["review","status"],
  ["release","plan"], ["release","activate"],
  ["release","status"], ["release","approve"],
  ["program","status"],
  ["sync"], ["audit"], ["doctor"],
  ["migrate","rebaseline"],
].map(tokens => Object.freeze(tokens)));

export const CORE_COMMAND_ARGUMENTS=Object.freeze({
  init:Object.freeze([0,0]),
  "repo.add":Object.freeze([1,1]), "repo.list":Object.freeze([0,0]),
  "feature.add":Object.freeze([1,1]), "feature.status":Object.freeze([1,1]),
  "epic.prepare":Object.freeze([1,1]), "epic.status":Object.freeze([1,1]),
  "epic.approve":Object.freeze([1,1]), "epic.submit":Object.freeze([1,1]),
  "epic.accept":Object.freeze([1,1]),
  "issue.add":Object.freeze([1,1]), "issue.start":Object.freeze([1,1]),
  "issue.submit":Object.freeze([1,1]), "issue.status":Object.freeze([1,1]),
  "dependency.add":Object.freeze([2,2]), "dependency.remove":Object.freeze([2,2]),
  "dependency.graph":Object.freeze([0,1]), "dependency.check":Object.freeze([0,1]),
  "review.record":Object.freeze([1,1]), "review.status":Object.freeze([1,1]),
  "release.plan":Object.freeze([0,0]), "release.activate":Object.freeze([1,2]),
  "release.status":Object.freeze([1,1]), "release.approve":Object.freeze([1,1]),
  "program.status":Object.freeze([0,1]), sync:Object.freeze([0,1]),
  audit:Object.freeze([0,1]), doctor:Object.freeze([0,0]),
  "migrate.rebaseline":Object.freeze([0,0]),
});

export const CORE_OPTION_DEFAULTS=Object.freeze({
  apply:false,
  authority:null,
  control:null,
  cutover:null,
  dryRun:false,
  from:null,
  json:false,
  nonInteractive:false,
});

export const CORE_EXIT_CODES=Object.freeze({
  SUCCESS:0, USAGE:2, INVALID_INPUT:3, BLOCKED:4,
  VALIDATION_FAILED:5, CONFLICT:6, NOT_IMPLEMENTED:69, INTERNAL:70,
});

const OPTION_SPECS=Object.freeze({
  "--apply":Object.freeze({property:"apply",takesValue:false}),
  "--authority":Object.freeze({property:"authority",takesValue:true}),
  "--control":Object.freeze({property:"control",takesValue:true}),
  "--cutover":Object.freeze({property:"cutover",takesValue:true}),
  "--dry-run":Object.freeze({property:"dryRun",takesValue:false}),
  "--from":Object.freeze({property:"from",takesValue:true}),
  "--json":Object.freeze({property:"json",takesValue:false}),
  "--non-interactive":Object.freeze({property:"nonInteractive",takesValue:false}),
});

const READ_ONLY_COMMANDS=new Set([
  "repo.list","feature.status","epic.status","issue.status",
  "dependency.graph","dependency.check","review.status","release.status",
  "program.status","audit","doctor",
]);
const definitionsByName=new Map(CORE_COMMAND_TOKENS.map(tokens => {
  const name=tokens.join(".");
  return [name,Object.freeze({tokens,name,args:CORE_COMMAND_ARGUMENTS[name]})];
}));
const knownFamilies=new Set(CORE_COMMAND_TOKENS.map(tokens => tokens[0]));

export class CoreCommandUsageError extends Error {
  constructor(message) {
    super(message);
    this.name="CoreCommandUsageError";
    this.code="COMMAND_USAGE";
    this.exitCode=CORE_EXIT_CODES.USAGE;
  }
}

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function canonicalArgv(argv) {
  let normalized;
  try {
    normalized=JSON.parse(canonicalJson(argv));
  } catch (error) {
    const detail=error instanceof Error ? error.message : "invalid value";
    throw new CoreCommandUsageError("Core command arguments must be canonical JSON: "+detail);
  }
  if (!Array.isArray(normalized) || normalized.some(token => typeof token!=="string")) {
    throw new CoreCommandUsageError("Core command arguments must be an array of strings");
  }
  return normalized;
}

function findDefinition(argv) {
  const definition=[...definitionsByName.values()].find(candidate =>
    candidate.tokens.every((token,index) => argv[index]===token));
  if (definition) return definition;
  if (argv.length===0) throw new CoreCommandUsageError("Usage: toss-core <command> [options]");
  if (knownFamilies.has(argv[0])) {
    throw new CoreCommandUsageError("Unknown core command: "+argv.slice(0,2).join(" "));
  }
  throw new CoreCommandUsageError("Unknown core command: "+argv[0]);
}

function isReadOnlyCommand(name) {
  return READ_ONLY_COMMANDS.has(name);
}

function acceptsOption(name,option) {
  if (option==="--json" || option==="--control") return true;
  if (option==="--cutover") return name==="migrate.rebaseline";
  return !isReadOnlyCommand(name);
}

function parseRemainder(definition,remainder) {
  const options={...CORE_OPTION_DEFAULTS};
  const args=[];
  const seen=new Set();
  for (let index=0;index<remainder.length;index+=1) {
    const token=remainder[index];
    if (!token.startsWith("-")) {
      args.push(token);
      continue;
    }
    const spec=OPTION_SPECS[token];
    if (!spec || !acceptsOption(definition.name,token)) {
      throw new CoreCommandUsageError("Invalid option for toss-core "+definition.name+": "+token);
    }
    if (seen.has(token)) {
      throw new CoreCommandUsageError("Duplicate option for toss-core "+definition.name+": "+token);
    }
    seen.add(token);
    if (spec.takesValue) {
      const value=remainder[index+1];
      if (typeof value!=="string" || value.length===0 || value.startsWith("--")) {
        throw new CoreCommandUsageError("Option "+token+" requires a value");
      }
      options[spec.property]=value;
      index+=1;
    } else {
      options[spec.property]=true;
    }
  }
  const [minimumArgs,maximumArgs]=definition.args;
  if (args.length<minimumArgs || args.length>maximumArgs) {
    const range=minimumArgs===maximumArgs ? String(minimumArgs) : minimumArgs+"-"+maximumArgs;
    throw new CoreCommandUsageError("Invalid argument count for toss-core "+definition.name+": expected "+range);
  }
  if (options.apply && options.dryRun) {
    throw new CoreCommandUsageError("Options --apply and --dry-run cannot be combined");
  }
  if (definition.name==="migrate.rebaseline" &&
      (options.cutover===null || options.cutover.trim().length===0)) {
    throw new CoreCommandUsageError(
      "Option --cutover requires a nonblank version for toss-core migrate rebaseline",
    );
  }
  return Object.freeze({args:Object.freeze(args),options:deepFreeze(options)});
}

export function parseCoreCommand(argv) {
  const normalized=canonicalArgv(argv);
  const definition=findDefinition(normalized);
  const parsed=parseRemainder(definition,normalized.slice(definition.tokens.length));
  const mutation=!isReadOnlyCommand(definition.name);
  return Object.freeze({
    name:definition.name,
    args:parsed.args,
    options:parsed.options,
    readOnly:isReadOnlyCommand(definition.name) || parsed.options.apply!==true,
    interactive:mutation && !parsed.options.nonInteractive,
  });
}
