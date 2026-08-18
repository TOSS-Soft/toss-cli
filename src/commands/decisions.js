import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {buildDecisionPackage,evaluateDecisionGate} from "../pipeline/decisions.js";
import {runNextStage} from "../pipeline/orchestrator.js";
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
  const singular=canonicalJson(keys)===canonicalJson([
    "answer","authority_resolution","schema_version",
  ]);
  const perSource=canonicalJson(keys)===canonicalJson([
    "answer","authority_resolutions","schema_version",
  ]);
  if (singular===perSource) {
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
  if (perSource && (!Array.isArray(value.authority_resolutions) ||
      value.authority_resolutions.length===0)) {
    throw new OrchestrationError(
      "DECISION_ANSWER_INVALID","Per-source authority resolutions must be non-empty",3,
    );
  }
  return {...value,mode:perSource ? "per-source" : "singular"};
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

function normalizedResolutions(question,input) {
  const resolutions=input.mode==="singular" ? [{
    source_id:question.source_ids[0],authority_resolution:input.authority_resolution,
  }] : input.authority_resolutions;
  if (!Array.isArray(resolutions) || resolutions.some(entry =>
    !entry || typeof entry!=="object" || Array.isArray(entry) ||
    canonicalJson(Object.keys(entry).sort())!==canonicalJson([
      "authority_resolution","source_id",
    ]) || typeof entry.source_id!=="string")) {
    throw new OrchestrationError(
      "DECISION_ANSWER_INVALID","Authority resolutions must be exact per-source records",3,
    );
  }
  const sorted=[...resolutions].sort((left,right) => left.source_id.localeCompare(right.source_id));
  if (canonicalJson(sorted.map(entry => entry.source_id))!==canonicalJson(question.source_ids)) {
    throw new OrchestrationError(
      "DECISION_ANSWER_INVALID",
      "Authority resolutions must cover every retained source question exactly once",3,
    );
  }
  return sorted;
}

function resolvedPackage(packageValue,question,input,registry) {
  const resolutions=normalizedResolutions(question,input);
  const selected=input.answer.kind==="selected-option" ?
    question.options.find(option => option.id===input.answer.option_id) : null;
  if (input.answer.kind==="selected-option" && !selected) {
    throw new OrchestrationError(
      "DECISION_ANSWER_INVALID",`Question ${question.id} has no option ${input.answer.option_id}`,3,
    );
  }
  const answerText=selected?.label ?? input.answer.value;
  if (resolutions.some(entry => entry.authority_resolution?.decision!==answerText)) {
    throw new OrchestrationError(
      "DECISION_ANSWER_INVALID",
      "Authority resolution decision must equal the exact selected or custom answer",3,
    );
  }
  const bySource=new Map(resolutions.map(entry => [entry.source_id,entry.authority_resolution]));
  const sourceQuestions=packageValue.questions.flatMap(candidate =>
    candidate.evidence.map(evidence => {
      const {source_id,...source}=evidence;
      return {
        id:source_id,
        ...source,
        ...(candidate.id===question.id ? {
          status:"resolved",
          authority_resolution:bySource.get(source_id),
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
  return {package:rebuilt,resolutions};
}

function answerIdentity(questionId) {
  return `decision-answer:${questionId}`;
}

function authorityRecordKey(resolution) {
  const attestation=resolution.authority_resolution.authority_attestation;
  return canonicalJson({
    record_id:attestation.record_id,
    record_revision:attestation.record_revision,
  });
}

function resolutionRows(answer) {
  if (Array.isArray(answer.content.authority_resolutions)) {
    return answer.content.authority_resolutions;
  }
  return [{
    source_id:answer.content.source_question.source_ids[0],
    authority_resolution:answer.content.authority_resolution,
  }];
}

async function verifiedAnswerSource(catalog,row) {
  const transition=await catalog.get(row.content.source_transition);
  if (transition.document_type!=="transition-event") {
    throw new OrchestrationError(
      "DECISION_ANSWER_STALE","Decision answer source is not a transition event",6,
    );
  }
  if (canonicalJson(row.inputs)!==canonicalJson([exactReference(transition)])) {
    throw new OrchestrationError(
      "DECISION_ANSWER_STALE","Decision answer inputs do not bind its exact transition",6,
    );
  }
  const packageValue=decisionPackageFromTransition(transition);
  if (canonicalJson(row.content.source_decision_package)!==canonicalJson(packageValue)) {
    throw new OrchestrationError(
      "DECISION_ANSWER_STALE",
      "Decision answer package does not match its verified source transition",6,
    );
  }
  const provenance={
    source_revision:transition.provenance.source_revision,
    source_sha256:transition.provenance.source_sha256,
    locations:[
      `decision-package:${transition.artifact_id}@${transition.revision}:${
        row.content.question_id
      }`,
    ],
  };
  if (canonicalJson(row.provenance)!==canonicalJson(provenance)) {
    throw new OrchestrationError(
      "DECISION_ANSWER_STALE",
      "Decision answer provenance does not match its verified source transition",6,
    );
  }
  return transition;
}

async function answerHistory(catalog,registry) {
  const rows=await catalog.list({document_type:"decision-answer"});
  if (rows.length>0 && registry===undefined) {
    throw new OrchestrationError(
      "DECISION_AUTHORITY_REQUIRED","Decision history requires independent authority registry",4,
    );
  }
  const byQuestion=new Map();
  const byIdentity=new Map();
  const records=new Map();
  const ordered=[...rows].sort((left,right) =>
    left.artifact_id.localeCompare(right.artifact_id) || left.revision-right.revision);
  for (const row of ordered) {
    validationError(row,"decision-answer.v1","decision answer");
    await verifiedAnswerSource(catalog,row);
    if (row.content.authority_registry.content_sha256!==sha256Canonical(registry)) {
      throw new OrchestrationError(
        "DECISION_AUTHORITY_STALE","Decision answer registry binding is stale",6,
      );
    }
    const question=packageQuestion(
      row.content.source_decision_package,row.content.question_id,
    );
    if (canonicalJson(question)!==canonicalJson(row.content.source_question) ||
        row.content.source_decision_package_hash!==
          sha256Canonical(row.content.source_decision_package)) {
      throw new OrchestrationError(
        "DECISION_ANSWER_STALE","Decision answer source snapshot is invalid",6,
      );
    }
    const rebuilt=resolvedPackage(row.content.source_decision_package,question,{
      answer:row.content.answer,
      authority_resolutions:resolutionRows(row),
      mode:"per-source",
    },registry);
    if (canonicalJson(rebuilt.package)!==canonicalJson(row.content.resolved_decision_package)) {
      throw new OrchestrationError(
        "DECISION_ANSWER_CONFLICT","Decision answer resolved snapshot is invalid",6,
      );
    }
    const identity=byIdentity.get(row.artifact_id) ?? [];
    const previous=identity.at(-1);
    if (row.revision!==identity.length+1 || canonicalJson(row.parents)!==canonicalJson(
      previous ? [exactReference(previous)] : [],
    )) {
      throw new OrchestrationError(
        "DECISION_ANSWER_CONFLICT","Decision answer revision lineage is invalid",6,
      );
    }
    identity.push(row);
    byIdentity.set(row.artifact_id,identity);
    const questionRows=byQuestion.get(row.content.question_id) ?? [];
    questionRows.push(row);
    byQuestion.set(row.content.question_id,questionRows);
    for (const resolution of resolutionRows(row)) {
      const key=authorityRecordKey(resolution);
      const claim=canonicalJson({
        artifact_id:row.artifact_id,revision:row.revision,source_id:resolution.source_id,
      });
      const claimed=records.get(key);
      if (claimed && claimed!==claim) {
        throw new OrchestrationError(
          "DECISION_AUTHORITY_REPLAY","Decision authority record was replayed",6,
        );
      }
      records.set(key,claim);
    }
  }
  return {byQuestion,byIdentity,records,rows:ordered};
}

function applyDecisionHistory(packageValue,history,registry) {
  const sourceQuestions=packageValue.questions.flatMap(question =>
    question.evidence.map(evidence => {
      const {source_id,...source}=evidence;
      return {id:source_id,...source};
    }));
  const applied=new Map();
  for (const question of packageValue.questions) {
    const candidates=(history.byQuestion.get(question.id) ?? []).filter(row =>
      row.content.source_decision_package_hash===sha256Canonical(packageValue) &&
      canonicalJson(row.content.source_question)===canonicalJson(question));
    if (candidates.length>1) {
      throw new OrchestrationError(
        "DECISION_ANSWER_CONFLICT","Current decision package has conflicting answers",6,
      );
    }
    if (candidates.length===1) applied.set(question.id,candidates[0]);
  }
  for (const source of sourceQuestions) {
    const question=packageValue.questions.find(candidate =>
      candidate.source_ids.includes(source.id));
    const answer=applied.get(question.id);
    const resolution=answer && resolutionRows(answer).find(entry => entry.source_id===source.id);
    if (resolution) {
      source.status="resolved";
      source.authority_resolution=resolution.authority_resolution;
    }
  }
  const effective=buildDecisionPackage(sourceQuestions,registry);
  evaluateDecisionGate(effective,registry);
  return {package:effective,answers:[...applied.values()]};
}

export async function reduceDecisionAnswers(catalog,packageValue,registry) {
  const history=await answerHistory(catalog,registry);
  let applied=applyDecisionHistory(packageValue,history,registry);
  if (packageValue.gate.can_continue===true && applied.answers.length===0) {
    const bases=new Map(history.rows.map(row => [
      row.content.source_decision_package_hash,row.content.source_decision_package,
    ]));
    const matches=[];
    for (const base of bases.values()) {
      const candidate=applyDecisionHistory(base,history,registry);
      if (canonicalJson(candidate.package)===canonicalJson(packageValue)) matches.push(candidate);
    }
    if (matches.length>1) {
      throw new OrchestrationError(
        "DECISION_ANSWER_CONFLICT","Resolved decision state has ambiguous source history",6,
      );
    }
    if (matches.length===1) applied=matches[0];
  }
  return deepFreeze({...applied,history});
}

function packageMatchesPmQuestions(packageValue,pmAnalysis) {
  const pmQuestions=pmAnalysis.content.open_questions;
  const evidence=packageValue.questions.flatMap(question => question.evidence);
  if (evidence.length!==pmQuestions.length) return false;
  const byId=new Map(evidence.map(source => [source.source_id,source]));
  if (byId.size!==evidence.length) return false;
  const retainedFields=[
    "meaning","question","severity","owner","options","recommendation","rationale",
    "affected_entities","provenance",
  ];
  return pmQuestions.every(question => {
    const source=byId.get(question.id);
    return source && retainedFields.every(field =>
      canonicalJson(source[field])===canonicalJson(question[field]));
  });
}

export async function currentDecisionAnswerEvidence(catalog,pmAnalysis,registry) {
  const history=await answerHistory(catalog,registry);
  const bases=new Map(history.rows.map(row => [
    row.content.source_decision_package_hash,row.content.source_decision_package,
  ]));
  const candidates=[];
  for (const packageValue of bases.values()) {
    if (!packageMatchesPmQuestions(packageValue,pmAnalysis)) continue;
    const reduced=applyDecisionHistory(packageValue,history,registry);
    if (reduced.answers.length>0) candidates.push(reduced);
  }
  if (candidates.length>1) {
    throw new OrchestrationError(
      "DECISION_ANSWER_CONFLICT","Current PM questions have ambiguous decision histories",6,
    );
  }
  const current=candidates[0];
  return deepFreeze(current ?? {answers:[],package:undefined});
}

async function listDecisions(catalog,registry) {
  const transition=await latestTransition(catalog);
  const packageValue=decisionPackageFromTransition(transition);
  evaluateDecisionGate(packageValue,registry);
  const reduced=await reduceDecisionAnswers(catalog,packageValue,registry);
  return deepFreeze({
    package:reduced.package,
    source_transition:exactReference(transition),
    questions:reduced.package.questions.map(question => {
      const answer=reduced.answers.find(row => row.content.question_id===question.id);
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
  evaluateDecisionGate(packageValue,services.authorityRegistry);
  const question=packageQuestion(packageValue,command.args[0]);
  const input=closedAnswerInput(await acquireGateInput(command,services,{
    kind:"decision answer",code:"DECISION_ANSWER_REQUIRED",
  }));
  const resolutions=normalizedResolutions(question,input);
  const history=await answerHistory(catalog,services.authorityRegistry);
  const claims=resolutions.map(resolution => history.records.get(
    authorityRecordKey(resolution),
  )).filter(Boolean);
  if (claims.length>0) {
    const claimedRows=new Map(history.rows.map(row => [canonicalJson({
      artifact_id:row.artifact_id,revision:row.revision,
    }),row]));
    const artifacts=[...new Set(claims.map(claim => {
      const parsed=JSON.parse(claim);
      return canonicalJson({artifact_id:parsed.artifact_id,revision:parsed.revision});
    }))].map(key => claimedRows.get(key));
    const reused=artifacts.length===1 ? artifacts[0] : null;
    if (reused && reused.content.question_id===question.id &&
        canonicalJson(reused.content.answer)===canonicalJson(input.answer) &&
        canonicalJson(resolutionRows(reused))===canonicalJson(resolutions)) {
      const effective=await reduceDecisionAnswers(
        catalog,reused.content.source_decision_package,services.authorityRegistry,
      );
      return deepFreeze({
        question_id:question.id,
        answer:input.answer,
        resolved_gate:effective.package.gate,
        artifact:reused,
        reused:true,
      });
    }
    throw new OrchestrationError(
      "DECISION_AUTHORITY_REPLAY","Decision authority record was replayed",6,
    );
  }
  const rebuilt=resolvedPackage(packageValue,question,input,services.authorityRegistry);
  const content={
    question_id:question.id,
    source_transition:exactReference(transition),
    source_decision_package_hash:sha256Canonical(packageValue),
    source_decision_package:packageValue,
    source_question:question,
    answer:input.answer,
    ...(resolutions.length===1 ? {
      authority_resolution:resolutions[0].authority_resolution,
    } : {}),
    authority_resolutions:resolutions,
    authority_registry:{content_sha256:sha256Canonical(services.authorityRegistry)},
    resolved_decision_package:rebuilt.package,
  };
  const attestations=resolutions.map(resolution =>
    resolution.authority_resolution.authority_attestation);
  const identity=[...new Set(attestations.map(attestation => attestation.actor_id))].sort().join(",");
  const createdAt=[...attestations.map(attestation => attestation.timestamp)].sort().at(-1);
  const identityRows=history.byIdentity.get(answerIdentity(question.id)) ?? [];
  const previous=identityRows.at(-1);
  const sameSource=identityRows.find(row =>
    row.content.source_decision_package_hash===content.source_decision_package_hash &&
    canonicalJson(row.content.source_question)===canonicalJson(question));
  if (sameSource) {
    throw new OrchestrationError(
      "DECISION_ANSWER_CONFLICT","Decision answer conflicts with immutable source history",6,
    );
  }
  const draft={
    schema_version:"acp.v1",
    document_type:"decision-answer",
    artifact_id:answerIdentity(question.id),
    revision:(previous?.revision ?? 0)+1,
    run_id:`${transition.run_id}:decision-answer:${question.id}`,
    producer:{role:"human-authority",identity},
    runtime_identity:"external-human-authority",
    created_at:createdAt,
    provenance:{
      source_revision:transition.provenance.source_revision,
      source_sha256:transition.provenance.source_sha256,
      locations:[`decision-package:${transition.artifact_id}@${transition.revision}:${question.id}`],
    },
    parents:previous ? [exactReference(previous)] : [],
    inputs:[exactReference(transition)],
    content_sha256:sha256Canonical(content),
    content,
  };
  validationError(draft,"decision-answer.v1","decision answer");
  const artifact=await catalog.append(draft);
  const reduced=await reduceDecisionAnswers(catalog,packageValue,services.authorityRegistry);
  const pmReferences=transition.inputs.filter(reference =>
    reference.document_type==="pm-analysis");
  if (pmReferences.length!==1) {
    throw new OrchestrationError(
      "AMBIGUOUS_GATE_INPUT","Decision transition requires exactly one PM analysis",5,
    );
  }
  const pmAnalysis=await catalog.get(pmReferences[0]);
  const transitionContext=(state,event,decisionPackage) => ({
    store:catalog,
    analysis_id:transition.artifact_id,
    state,
    event,
    source_revision:transition.provenance.source_revision,
    source_sha256:transition.provenance.source_sha256,
    artifacts:{
      pm_analysis:pmAnalysis,
      decision_package:decisionPackage,
      decision_answers:reduced.answers,
    },
    provenance:transition.provenance,
    run_id:`${transition.run_id}:decision-state`,
    producer:{role:"orchestrator",identity:"toss-project-orchestrator"},
    runtime_identity:transition.runtime_identity,
    created_at:artifact.created_at,
  });
  let state=transition.content.state;
  if (state==="QUESTIONS_PENDING") {
    await runNextStage(transitionContext(state,"DECISION_STARTED",packageValue));
    state="USER_DECISION";
  }
  if (state==="USER_DECISION" && reduced.package.gate.can_continue===true) {
    await runNextStage(transitionContext(state,"DECISIONS_RESOLVED",reduced.package));
  }
  if (catalog.hasChanges()) await catalog.refresh();
  return deepFreeze({
    question_id:question.id,
    answer:input.answer,
    resolved_gate:reduced.package.gate,
    artifact,
    reused:false,
  });
}

export async function runDecisionsCommand(command,serviceInput) {
  if (!COMMANDS.has(command.name)) {
    throw new TypeError(`Unsupported decisions command ${String(command.name)}`);
  }
  const allowed=command.name==="decisions.list" ?
    ["artifactStore","authorityRegistry"] :
    ["artifactStore","readInput","prompt","authorityRegistry"];
  const services=gateCommandServices(serviceInput,{allowed});
  const catalog=await commandCatalog(services.store);
  return command.name==="decisions.list" ? listDecisions(catalog,services.authorityRegistry) :
    answerDecision(command,catalog,services);
}
