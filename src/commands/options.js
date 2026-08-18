export const EXIT_CODES=Object.freeze({
  SUCCESS:0,
  USAGE:2,
  INVALID_INPUT:3,
  BLOCKED:4,
  VALIDATION_FAILED:5,
  CONFLICT:6,
  NOT_IMPLEMENTED:69,
  INTERNAL:70,
});

export const OPTION_SPECS=Object.freeze({
  "--from":Object.freeze({property:"from",takesValue:true,usage:"--from <FILE>"}),
  "--non-interactive":Object.freeze({
    property:"nonInteractive",
    takesValue:false,
    usage:"--non-interactive",
  }),
  "--json":Object.freeze({property:"json",takesValue:false,usage:"--json"}),
  "--continue":Object.freeze({property:"continue",takesValue:false,usage:"--continue"}),
  "--project":Object.freeze({
    property:"project",
    takesValue:true,
    usage:"--project <PATH>",
  }),
  "--apply":Object.freeze({property:"apply",takesValue:false,usage:"--apply"}),
});

const JSON_PROJECT=["--json","--project"];
const INPUT=["--from","--non-interactive","--json","--project"];
const CONTINUABLE=[
  "--from","--non-interactive","--json","--continue","--project",
];

function definition(
  name,
  tokens,
  {args=0,usage="",options=JSON_PROJECT,mutation="never",interactive=false}={},
) {
  const [minimumArgs,maximumArgs]=Array.isArray(args) ? args : [args,args];
  return Object.freeze({
    name,
    tokens:Object.freeze([...tokens]),
    minimumArgs,
    maximumArgs,
    usage,
    options:Object.freeze([...options]),
    mutation,
    interactive,
  });
}

export const COMMAND_DEFINITIONS=Object.freeze([
  definition("project.create",["project","create"],{
    options:INPUT,mutation:"always",interactive:true,
  }),
  definition("project.analyze",["project","analyze"],{
    options:CONTINUABLE,mutation:"always",interactive:true,
  }),
  definition("project.prepare",["project","prepare"],{
    options:CONTINUABLE,mutation:"always",interactive:true,
  }),
  definition("project.status",["project","status"]),
  definition("project.resume",["project","resume"],{
    options:["--non-interactive","--json","--continue","--project"],
    mutation:"always",
    interactive:true,
  }),
  definition("feature.add",["feature","add"],{
    options:INPUT,mutation:"always",interactive:true,
  }),
  definition("feature.analyze",["feature","analyze"],{
    options:CONTINUABLE,mutation:"always",interactive:true,
  }),
  definition("feature.prepare",["feature","prepare"],{
    options:CONTINUABLE,mutation:"always",interactive:true,
  }),
  definition("feature.status",["feature","status"]),
  definition("decisions.list",["decisions","list"]),
  definition("decisions.answer",["decisions","answer"],{
    args:1,
    usage:"<QUESTION-ID>",
    options:INPUT,
    mutation:"always",
    interactive:true,
  }),
  definition("architecture.review",["architecture","review"],{
    options:["--non-interactive","--json","--continue","--project"],
    mutation:"always",
    interactive:true,
  }),
  definition("architecture.approve",["architecture","approve"],{
    args:1,
    usage:"<ADR-ID>",
    options:INPUT,
    mutation:"always",
    interactive:true,
  }),
  definition("plan.show",["plan","show"]),
  definition("audit.run",["audit","run"],{
    options:["--json","--continue","--project"],mutation:"always",
  }),
  definition("readiness.check",["readiness","check"]),
  definition("issues.preview",["issues","preview"]),
  definition("issues.publish",["issues","publish"],{
    options:["--from","--non-interactive","--json","--project","--apply"],
    mutation:"apply",
    interactive:true,
  }),
  definition("trace",["trace"],{
    args:1,usage:"<ENTITY-ID>",options:JSON_PROJECT,
  }),
  definition("artifacts.list",["artifacts","list"]),
  definition("artifacts.inspect",["artifacts","inspect"],{
    args:1,usage:"<ARTIFACT-ID>",
  }),
  definition("validate",["validate"],{
    args:1,usage:"<FILE>",
  }),
]);

export const HELP_TREE=Object.freeze([
  "project <create|analyze|prepare|status|resume>",
  "feature <add|analyze|prepare|status>",
  "decisions <list|answer>",
  "architecture <review|approve>",
  "plan show",
  "audit run",
  "readiness check",
  "issues <preview|publish>",
  "trace <ENTITY-ID>",
  "artifacts <list|inspect>",
  "validate <FILE>",
]);

const completionWords=new Set([
  ...COMMAND_DEFINITIONS.flatMap(command => command.tokens),
  ...Object.keys(OPTION_SPECS),
  "init","create","--help","-h","--version","-v",
]);
export const SHELL_COMPLETION_WORDS=Object.freeze([...completionWords].sort());

export function renderHelp(version) {
  return [
    `TOSS CLI v${version}`,
    "",
    "Lifecycle commands:",
    ...HELP_TREE.map(line => `  toss ${line}`),
    "",
    "Shared options:",
    "  --from <FILE>       Read JSON or YAML input where declared.",
    "  --non-interactive   Fail closed instead of prompting where declared.",
    "  --json              Emit command-result.v1 for lifecycle commands.",
    "  --continue          Continue from the last verified revision.",
    "  --project <PATH>    Use an explicit project root.",
    "  --apply             Mutate only for `issues publish`.",
    "",
    "Compatibility commands:",
    "  toss init [project-brief.yaml]",
    "  toss create <project-brief.yaml>",
    "  toss trace <ENTITY-ID> [--json]   # raw trace-result.v1 compatibility",
    "  toss \"Project Name\" [legacy scaffold options]",
    "",
    "Recommended:",
    "  toss init",
    "  # fill project-brief.yaml",
    "  toss create project-brief.yaml",
    "",
    "Global package:",
    "  npm install -g @toss-software/cli",
    "",
  ].join("\n");
}
