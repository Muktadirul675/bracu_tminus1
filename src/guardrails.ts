import type { AnalyzeTicketRequest, AnalyzeTicketResponse } from "./schemas.js";

const HIGH_VALUE_THRESHOLD = 25_000;

const safeCustomerReply =
  "Thank you for contacting QueueStorm support. We have logged your concern and our team will review it through official channels. Please do not share your PIN, OTP, password, or full card number with anyone. Any eligible amount will be returned through official channels after review.";

const safeRecommendedAction =
  "Escalate this ticket through the official internal workflow, verify the transaction timeline in system logs, and proceed according to authorized dispute/SOP review steps.";

const credentialTermPattern =
  /\b(pin|otp|one[\s-]?time(?:\s+password)?|password|passcode|cvv|full card(?:\s+number)?|card number)\b/i;
const credentialRequestVerbPattern =
  /\b(share|provide|send|give|enter|type|tell|submit|reply with|confirm)\b/i;
const safeCredentialWarningPattern =
  /\b(do not|don't|never|avoid)\b.{0,40}\b(share|provide|send|give|tell|disclose)\b.{0,40}\b(pin|otp|password|card|cvv)\b/i;

const unauthorizedCommitmentPattern =
  /\b(we|i)\s+(will|shall|can|guarantee|ensure|confirm|promise)\b.{0,80}\b(refund|reversal|reverse|recover|recovery|unblock|reactivate)\b/i;

const thirdPartyRedirectPattern =
  /(https?:\/\/|www\.|telegram|whatsapp|facebook|messenger|gmail|outside support|third[- ]party)/i;

const suspiciousCaseTypes = new Set([
  "wrong_transfer",
  "payment_failed",
  "refund_request",
  "duplicate_payment",
  "phishing_or_social_engineering"
] as const);

const collapseWhitespace = (value: string): string => value.trim().replace(/\s+/g, " ");

const containsCredentialRequest = (text: string): boolean => {
  if (!credentialTermPattern.test(text)) return false;
  if (safeCredentialWarningPattern.test(text)) return false;
  return credentialRequestVerbPattern.test(text);
};

const containsUnauthorizedCommitment = (text: string): boolean =>
  unauthorizedCommitmentPattern.test(text);

const containsThirdPartyRedirect = (text: string): boolean => thirdPartyRedirectPattern.test(text);

export const isSemanticallyValidComplaint = (complaint: string): boolean => {
  const normalized = collapseWhitespace(complaint);
  if (normalized.length < 3) return false;
  return /[\p{L}\p{N}]/u.test(normalized);
};

export const mapDepartment = (
  caseType: AnalyzeTicketResponse["case_type"],
  severity: AnalyzeTicketResponse["severity"],
  userType: AnalyzeTicketRequest["user_type"],
  complaint: string
): AnalyzeTicketResponse["department"] => {
  if (caseType === "wrong_transfer") return "dispute_resolution";
  if (caseType === "payment_failed" || caseType === "duplicate_payment") return "payments_ops";
  if (caseType === "merchant_settlement_delay") return "merchant_operations";
  if (caseType === "agent_cash_in_issue") return "agent_operations";
  if (caseType === "phishing_or_social_engineering") return "fraud_risk";
  if (caseType === "refund_request") {
    return severity === "low" ? "customer_support" : "dispute_resolution";
  }

  if (userType === "merchant" || /\bmerchant|settlement|payout\b/i.test(complaint)) {
    return "merchant_operations";
  }
  if (userType === "agent" || /\bagent|cash[\s_-]?in\b/i.test(complaint)) {
    return "agent_operations";
  }
  return "customer_support";
};

export const enforceSafetyAndPolicy = (
  candidate: AnalyzeTicketResponse,
  input: AnalyzeTicketRequest
): AnalyzeTicketResponse => {
  const complaint = collapseWhitespace(input.complaint);
  const nextAction = collapseWhitespace(candidate.recommended_next_action || "");
  const customerReply = collapseWhitespace(candidate.customer_reply || "");
  const summary = collapseWhitespace(candidate.agent_summary || "");
  const confidence =
    typeof candidate.confidence === "number"
      ? Math.max(0, Math.min(1, candidate.confidence))
      : undefined;

  const relevantTransaction = (input.transaction_history ?? []).find(
    (txn) => txn.transaction_id === candidate.relevant_transaction_id
  );

  const disputeOrRisk =
    suspiciousCaseTypes.has(candidate.case_type) ||
    candidate.case_type === "merchant_settlement_delay" ||
    candidate.case_type === "agent_cash_in_issue";
  const ambiguous = candidate.evidence_verdict === "insufficient_data";
  const highValue = (relevantTransaction?.amount ?? 0) >= HIGH_VALUE_THRESHOLD;
  const securityRisk = candidate.case_type === "phishing_or_social_engineering";

  const mustEscalate = disputeOrRisk || ambiguous || highValue || securityRisk;

  const nextActionUnsafe =
    !nextAction ||
    containsUnauthorizedCommitment(nextAction) ||
    containsThirdPartyRedirect(nextAction);
  const replyUnsafe =
    !customerReply ||
    containsCredentialRequest(customerReply) ||
    containsUnauthorizedCommitment(customerReply) ||
    containsThirdPartyRedirect(customerReply);

  const reasonCodes = candidate.reason_codes?.map(collapseWhitespace).filter(Boolean);

  const output: AnalyzeTicketResponse = {
    ticket_id: input.ticket_id,
    relevant_transaction_id: candidate.relevant_transaction_id,
    evidence_verdict: candidate.evidence_verdict,
    case_type: candidate.case_type,
    severity: candidate.severity,
    department: mapDepartment(candidate.case_type, candidate.severity, input.user_type, complaint),
    agent_summary: summary || "Ticket reviewed with available complaint and transaction snippet.",
    recommended_next_action: nextActionUnsafe ? safeRecommendedAction : nextAction,
    customer_reply: replyUnsafe ? safeCustomerReply : customerReply,
    human_review_required: candidate.human_review_required || mustEscalate
  };

  if (typeof confidence === "number") {
    output.confidence = confidence;
  }
  if (reasonCodes && reasonCodes.length > 0) {
    output.reason_codes = Array.from(new Set(reasonCodes));
  }

  return output;
};
