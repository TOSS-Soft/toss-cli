import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {buildDecisionPackage,evaluateDecisionGate} from "../pipeline/decisions.js";
import {
  acquireGateInput,
  commandCatalog,
  decisionPackageFromTransition,
  deepFreeze,
  exactReference,
  gateCommandServices,
  latestTransition,
  OrchestrationError,
  validationError,
} from "./gate-support.js";

const COMMANDS=new Set(["decisions.list","decisions.answer"]);

function closedAnswerInput(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) {
    throw new OrchestrationError("DECISION_ANSWER_INVALID","Decision answer must be an object",3);
  }
  const keys=Object.keys(value).sort();
  if (canonicalJson(keys)!==canonicalJson([
    "answer","authority_resolution","schema_version",
  ])) {
    throw new OrchestrationError(
      "DECISION_ANSWER_INVALID","Decision answer input is closed and requires exact fields",3,
    );
  }
  if (value.schema_version!=="decision-answer-input.v1") {
    throw new OrchestrationError(
      "DECISION_ANSWER_INVALID","Decision answer input version is unsupported",3,
    );
  }
  const answerKeys=value.answer && typeof value.answer==="object" ?
    Object.keys(value.answer).sort() : [];
  const selected=canonicalJson(answerKeys)===canonicalJson(["kind","option_id"]) &&
    value.answer.kind==="selected-option" && typeof value.answer.option_id==="string" &&
    value.answer.option_id.length>0;
  const custom=canonicalJson(answerKeys)===canonicalJson(["kind","value"]) &&
    value.answer.kind==="custom-answer" && typeof value.answer.value==="string" &&
    value.answer.value.trim().length>0;
  if (selected===custom) {
    throw new OrchestrationError(
      "DECISION_ANSWER_INVALID",
      "Decision answer must contain exactly one selected option or custom answer",3,
    );
  }
  return value;
}

function packageQuestion(packageValue,questionId) {
  const matches=packageValue.questions.filter(question => question.id===questionId);
  if (matches.length!==1) {
    throw new OrchestrationError(
      "DECISION_QUESTION_NOT_FOUND",`Question ${questionId} is not uniquely pending`,4,
    );
  }
  return matches[0];
}

function resolvedPackage(packageValue,question,input,registry) {
  if (question.source_ids.length!==1 || question.evidence.length!==1) {
    throw new OrchestrationError(
      "DECISION_ANSWER_INVALID",
      "A deduplicated question requires one independently signed resolution per source question",3,
    );
  }
  const selected=input.answer.kind==="selected-option" ?
    question.options.find(option => option.id===input.answer.option_id) : null;
  if (input.answer.kind==="selected-option" && !selected) {
    throw new OrchestrationError(
      "DECISION_ANSWER_INVALID",`Question ${question.id} has no option ${input.answer.option_id}`,3,
    );
  }
  const answerText=selected?.label ?? input.answer.value;
  if (input.authority_resolution?.decision!==answerText) {
    throw new OrchestrationError(
      "DECISION_ANSWER_INVALID",
      "Authority resolution decision must equal the exact selected or custom answer",3,
    );
  }
  const sourceQuestions=packageValue.questions.flatMap(candidate =>
    candidate.evidence.map(evidence => {
      const {source_id,...source}=evidence;
      return {
        id:source_id,
        ...source,
        ...(candidate.id===question.id ? {
          status:"resolved",
          authority_resolution:input.authority_resolution,
        } : {}),
      };
    }));
  const rebuilt=buildDecisionPackage(sourceQuestions,registry);
  evaluateDecisionGate(rebuilt,registry);
  const rebuiltQuestion=packageQuestion(rebuilt,question.id);
  if (rebuiltQuestion.status!=="resolved") {
    throw new OrchestrationError(
      "DECISION_ANSWER_INVALID",`Question ${question.id} did not resolve`,3,
    );
  }
  return rebuilt;
}

function answerIdentity(questionId) {
  return `decision-answer:${questionId}`;
}

function authorityRecordKey(answer) {
  const attestation=answer.content.authority_resolution.authority_attestation;
  return canonicalJson({
    record_id:attestation.record_id,
    record_revision:attestation.record_revision,
  });
}

async function answerHistory(catalog) {
  const rows=await catalog.list({document_type:"decision-answer"});
  const byQuestion=new Map();
  const records=new Map();
  for (const row of rows) {
    validationError(row,"decision-answer.v1","decision answer");
    const existing=byQuestion.get(row.content.question_id);
    if (existing && canonicalJson(existing)!==canonicalJson(row)) {
      throw new OrchestrationError(
        "DECISION_ANSWER_CONFLICT","Decision answer history conflicts for one question",6,
      );
    }
    byQuestion.set(row.content.question_id,row);
    const key=authorityRecordKey(row);
    const claimed=records.get(key);
    if (claimed && claimed!==row.content.question_id) {
      throw new OrchestrationError(
        "DECISION_AUTHORITY_REPLAY","Decision authority record was replayed",6,
      );
    }
    records.set(key,row.content.question_id);
  }
  return {byQuestion,records};
}

async function listDecisions(catalog) {
  const transition=await latestTransition(catalog);
  const packageValue=decisionPackageFromTransition(transition);
  evaluateDecisionGate(packageValue);
  const history=await answerHistory(catalog);
  return deepFreeze({
    package:packageValue,
    source_transition:exactReference(transition),
    questions:packageValue.questions.map(question => {
      const answer=history.byQuestion.get(question.id);
      return {
        ...question,
        answered:Boolean(answer),
        answer_artifact:answer ? exactReference(answer) : null,
      };
    }),
  });
}

async function answerDecision(command,catalog,services) {
  if (services.authorityRegistry===undefined) {
    throw new OrchestrationError(
      "DECISION_AUTHORITY_REQUIRED","Decision answer requires independent authority registry",4,
    );
  }
  const transition=await latestTransition(catalog);
  const packageValue=decisionPackageFromTransition(transition);
  evaluateDecisionGate(packageValue);
  const question=packageQuestion(packageValue,command.args[0]);
  const input=closedAnswerInput(await acquireGateInput(command,services,{
    kind:"decision answer",code:"DECISION_ANSWER_REQUIRED",
  }));
  const rebuilt=resolvedPackage(packageValue,question,input,services.authorityRegistry);
  const history=await answerHistory(catalog);
  const record={content:{authority_resolution:input.authority_resolution}};
  const recordKey=authorityRecordKey(record);
  const claimed=history.records.get(recordKey);
  if (claimed && claimed!==question.id) {
    throw new OrchestrationError(
      "DECISION_AUTHORITY_REPLAY","Decision authority record was replayed",6,
    );
  }
  const content={
    question_id:question.id,
    source_transition:exactReference(transition),
    source_decision_package_hash:sha256Canonical(packageValue),
    source_decision_package:packageValue,
    source_question:question,
    answer:input.answer,
    authority_resolution:input.authority_resolution,
    authority_registry:{content_sha256:sha256Canonical(services.authorityRegistry)},
    resolved_decision_package:rebuilt,
  };
  const attestation=input.authority_resolution.authority_attestation;
  const draft={
    schema_version:"acp.v1",
    document_type:"decision-answer",
    artifact_id:answerIdentity(question.id),
    revision:1,
    run_id:`${transition.run_id}:decision-answer:${question.id}`,
    producer:{role:"human-authority",identity:attestation.actor_id},
    runtime_identity:"external-human-authority",
    created_at:attestation.timestamp,
    provenance:{
      source_revision:transition.provenance.source_revision,
      source_sha256:transition.provenance.source_sha256,
      locations:[`decision-package:${transition.artifact_id}@${transition.revision}:${question.id}`],
    },
    parents:[],
    inputs:[exactReference(transition)],
    content_sha256:sha256Canonical(content),
    content,
  };
  validationError(draft,"decision-answer.v1","decision answer");
  const previous=history.byQuestion.get(question.id);
  if (previous && canonicalJson(previous)!==canonicalJson(draft)) {
    throw new OrchestrationError(
      "DECISION_ANSWER_CONFLICT","Decision answer conflicts with immutable history",6,
    );
  }
  const artifact=await catalog.append(draft);
  if (catalog.hasChanges()) await catalog.refresh();
  return deepFreeze({
    question_id:question.id,
    answer:input.answer,
    resolved_gate:rebuilt.gate,
    artifact,
    reused:Boolean(previous),
  });
}

export async function runDecisionsCommand(command,serviceInput) {
  if (!COMMANDS.has(command.name)) {
    throw new TypeError(`Unsupported decisions command ${String(command.name)}`);
  }
  const allowed=command.name==="decisions.list" ?
    ["artifactStore"] : ["artifactStore","readInput","prompt","authorityRegistry"];
  const services=gateCommandServices(serviceInput,{allowed});
  const catalog=await commandCatalog(services.store);
  return command.name==="decisions.list" ? listDecisions(catalog) :
    answerDecision(command,catalog,services);
}
