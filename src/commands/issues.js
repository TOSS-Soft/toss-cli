import {canonicalJson} from "../contracts/acp.js";
import {
  acquireGateInput,
  commandCatalog,
  deepFreeze,
  gateCommandServices,
  OrchestrationError,
  resolveGateBundle,
} from "./gate-support.js";

function publicationContext(repository,bundle) {
  return deepFreeze({repository,artifacts:bundle});
}

function previewResult(value,mode) {
  let preview;
  try {
    preview=JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new OrchestrationError(
      "PUBLICATION_PREVIEW_INVALID","GitHub writer preview is not canonical JSON",5,
      {cause:error},
    );
  }
  if (!preview || typeof preview!=="object" || Array.isArray(preview) ||
      !Array.isArray(preview.operations)) {
    throw new OrchestrationError(
      "PUBLICATION_PREVIEW_INVALID","GitHub writer preview operations are missing",5,
    );
  }
  const summary={create:0,update:0,skip:0};
  for (const operation of preview.operations) {
    if (!operation || typeof operation!=="object" ||
        !Object.hasOwn(summary,operation.action)) {
      throw new OrchestrationError(
        "PUBLICATION_PREVIEW_INVALID","GitHub writer preview action is invalid",5,
      );
    }
    summary[operation.action]+=1;
  }
  return deepFreeze({...preview,mode,operation_summary:summary});
}

function publicationError(error) {
  if (!error || typeof error!=="object") return error;
  const exit=Object.getOwnPropertyDescriptor(error,"exitCode");
  if (exit && "value" in exit && [4,5,6].includes(exit.value)) return error;
  const messageDescriptor=Object.getOwnPropertyDescriptor(error,"message");
  const codeDescriptor=Object.getOwnPropertyDescriptor(error,"code");
  const message=messageDescriptor && "value" in messageDescriptor &&
    typeof messageDescriptor.value==="string" ? messageDescriptor.value :
    "GitHub publication failed";
  const code=codeDescriptor && "value" in codeDescriptor &&
    typeof codeDescriptor.value==="string" ? codeDescriptor.value :
    "GITHUB_PUBLICATION_FAILED";
  const conflict=/duplicate|conflict|replay|artifact store|mapping|marker/i.test(message) ||
    code==="ARTIFACT_STORE_FAILED";
  const blocked=/readiness|audit|state|approval|authority|plan|gate|stale/i.test(message) ||
    error instanceof TypeError;
  if (!conflict && !blocked) return error;
  return new OrchestrationError(code,message,conflict ? 6 : 4);
}

export async function runIssuesCommand(command,serviceInput) {
  if (!["issues.preview","issues.publish"].includes(command.name)) {
    throw new TypeError(`Unsupported issues command ${String(command.name)}`);
  }
  const services=gateCommandServices(serviceInput,{
    allowed:["artifactStore","repository","writer","readInput","prompt"],
    required:["artifactStore","repository","writer"],
  });
  let authority;
  if (command.name==="issues.publish" && command.options.apply) {
    authority=await acquireGateInput(command,services,{
      kind:"GitHub publication approval",code:"PUBLICATION_APPROVAL_REQUIRED",
    });
  }
  const catalog=await commandCatalog(services.store);
  const bundle=await resolveGateBundle(catalog,{
    requirePlan:true,requireAudit:true,requireState:true,current:true,
  });
  const context=publicationContext(services.repository,bundle);
  try {
    if (command.name==="issues.publish" && command.options.apply) {
      return deepFreeze(JSON.parse(canonicalJson(await services.writer.publish(
        context,{apply:true,authority},
      ))));
    }
    const preview=await services.writer.preview(context);
    return previewResult(preview,command.name==="issues.preview" ? "preview" : "dry-run");
  } catch (error) {
    throw publicationError(error);
  }
}
