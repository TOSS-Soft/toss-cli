import {canonicalJson} from "../contracts/acp.js";
import {currentAdrApprovalEvidence} from "./architecture.js";
import {currentDecisionAnswerEvidence} from "./decisions.js";
import {deepFreeze,exactReference,OrchestrationError} from "./gate-support.js";

function sortedReferences(values) {
  return values.map(exactReference).sort((left,right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)));
}

function registeredReferences(transition,documentType) {
  return transition.inputs.filter(reference => reference.document_type===documentType).sort(
    (left,right) => canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function requireRegistered(transition,documentType,artifacts) {
  if (canonicalJson(registeredReferences(transition,documentType))!==
      canonicalJson(sortedReferences(artifacts))) {
    throw new OrchestrationError(
      "GATE_EVIDENCE_STALE",
      `Current transition does not register the exact verified ${documentType} evidence`,6,
    );
  }
}

export async function verifiedGateEvidence(catalog,bundle,registry) {
  const [decisions,architecture]=await Promise.all([
    currentDecisionAnswerEvidence(catalog,bundle.pmAnalysis,registry),
    currentAdrApprovalEvidence(catalog,bundle.architecture.adrs,registry),
  ]);
  if (!bundle.analysisState) {
    if (decisions.answers.length>0 || architecture.approvals.length>0) {
      throw new OrchestrationError(
        "GATE_EVIDENCE_STALE",
        "Gate evidence exists without an exact registered transition",6,
      );
    }
    return deepFreeze({decisionAnswers:[],adrApprovals:[]});
  }
  requireRegistered(bundle.analysisState,"decision-answer",decisions.answers);
  requireRegistered(bundle.analysisState,"adr-approval",architecture.approvals);
  const decisionPackage=decisions.package ?? bundle.decisionPackage;
  return deepFreeze({
    decisionAnswers:decisions.answers,
    ...(decisionPackage===undefined ? {} : {decisionPackage}),
    adrApprovals:architecture.approvals,
  });
}
