import type {
  AnalyzeTicketRequest,
  AnalyzeTicketResponse,
  TransactionHistoryEntry
} from "./schemas.js";
import { mapDepartment } from "./guardrails.js";

const isInText = (text: string, pattern: RegExp): boolean => pattern.test(text);

const timestampWeight = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const latestOf = (entries: TransactionHistoryEntry[]): TransactionHistoryEntry | null => {
  if (entries.length === 0) return null;
  return [...entries].sort((a, b) => timestampWeight(b.timestamp) - timestampWeight(a.timestamp))[0] ?? null;
};

const extractMentionedAmount = (text: string): number | null => {
  const normalized = text.replace(/[,]/g, "");
  const match = normalized.match(/(?:^|\D)(\d{2,7}(?:\.\d{1,2})?)(?:\D|$)/);
  if (!match?.[1]) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
};

const hasCounterpartyIdentifier = (text: string): boolean => /\+?\d{10,14}/.test(text);

const detectCaseType = (input: AnalyzeTicketRequest): AnalyzeTicketResponse["case_type"] => {
  const text = input.complaint.toLowerCase();
  const settlementSignal = /(settlement|payout|sales.*not.*settled|not been settled|batch status|next[- ]day window)/i;

  if (
    isInText(
      text,
      /(phish|social engineering|scam|fraud|otp|pin|password|hack|hacked|suspicious call|suspicious sms|প্রতারণা|ফিশিং|স্ক্যাম)/i
    )
  ) {
    return "phishing_or_social_engineering";
  }
  if (
    isInText(text, /(wrong transfer|wrong number|wrong person|sent to wrong|ভুল নম্বর|ভুলে পাঠ|ভুল ট্রান্সফার)/i) ||
    (isInText(text, /(sent|send|transfer|পাঠিয়েছি|পাঠিয়েছি|পাঠিয়েছি)/i) &&
      isInText(text, /(didn't get|did not get|not receive|not received|পায়নি|পায়নি|পাইনি)/i))
  ) {
    return "wrong_transfer";
  }
  if (
    isInText(text, /(duplicate|double charged|charged twice|deducted twice|deducted two times|two times|দুইবার|ডুপ্লিকেট)/i)
  ) {
    return "duplicate_payment";
  }
  if (
    isInText(
      text,
      /(failed|payment failed|not completed|declined|pending but charged|balance deducted|কাটা গেছে|পেমেন্ট হয়নি|অসফল|ফেইল)/i
    )
  ) {
    return "payment_failed";
  }
  if (input.user_type === "agent" || isInText(text, /(agent|cash[\s_-]?in|ক্যাশ ইন|এজেন্ট)/i)) {
    return "agent_cash_in_issue";
  }
  if (isInText(text, /(refund|return money|reversal|chargeback|ফেরত|রিফান্ড)/i)) {
    return "refund_request";
  }
  if (
    isInText(text, /merchant|merchant portal|ব্যবসায়ী|মার্চেন্ট/i) &&
    (input.user_type === "merchant" || settlementSignal.test(text))
  ) {
    return "merchant_settlement_delay";
  }
  if (settlementSignal.test(text)) {
    return "merchant_settlement_delay";
  }
  return "other";
};

const findExactTxnFromComplaint = (
  complaint: string,
  history: TransactionHistoryEntry[]
): TransactionHistoryEntry | null => {
  const lowered = complaint.toLowerCase();
  for (const txn of history) {
    if (lowered.includes(txn.transaction_id.toLowerCase())) {
      return txn;
    }
  }
  return null;
};

const pickRelevantTransaction = (
  input: AnalyzeTicketRequest,
  caseType: AnalyzeTicketResponse["case_type"]
): TransactionHistoryEntry | null => {
  const history = input.transaction_history ?? [];
  if (history.length === 0) return null;

  const exact = findExactTxnFromComplaint(input.complaint, history);
  if (exact) return exact;

  if (caseType === "wrong_transfer") {
    const transfers = history.filter((txn) => txn.type === "transfer");
    if (transfers.length === 0) return null;

    const mentionedAmount = extractMentionedAmount(input.complaint);
    if (mentionedAmount !== null) {
      const amountMatches = transfers.filter((txn) => Math.abs(txn.amount - mentionedAmount) < 0.01);
      if (amountMatches.length === 1) {
        return amountMatches[0] ?? null;
      }
      if (amountMatches.length > 1) {
        if (!hasCounterpartyIdentifier(input.complaint)) {
          return null;
        }
        return latestOf(amountMatches);
      }
    }
    return latestOf(transfers);
  }
  if (caseType === "payment_failed") {
    return latestOf(history.filter((txn) => txn.status === "failed" || txn.status === "pending" || txn.type === "payment"));
  }
  if (caseType === "refund_request") {
    return latestOf(history.filter((txn) => txn.type === "refund" || txn.type === "payment" || txn.type === "transfer"));
  }
  if (caseType === "merchant_settlement_delay") {
    return latestOf(history.filter((txn) => txn.type === "settlement"));
  }
  if (caseType === "agent_cash_in_issue") {
    return latestOf(history.filter((txn) => txn.type === "cash_in"));
  }
  if (caseType === "duplicate_payment") {
    const grouped = new Map<string, TransactionHistoryEntry[]>();
    for (const txn of history) {
      const key = `${txn.type}|${txn.amount}|${txn.counterparty}`;
      grouped.set(key, [...(grouped.get(key) ?? []), txn]);
    }
    const duplicates = [...grouped.values()].filter((group) => group.length >= 2).flat();
    return latestOf(duplicates);
  }

  if (caseType === "other") return null;

  return latestOf(history);
};

const evidenceFor = (
  caseType: AnalyzeTicketResponse["case_type"],
  relevant: TransactionHistoryEntry | null,
  history: TransactionHistoryEntry[]
): AnalyzeTicketResponse["evidence_verdict"] => {
  if (!relevant) return "insufficient_data";

  if (caseType === "wrong_transfer") {
    if (relevant.type !== "transfer") return "inconsistent";
    if (relevant.status !== "completed") return "inconsistent";

    const priorTransfersToSameRecipient = history.filter((txn) => {
      if (txn.type !== "transfer") return false;
      if (txn.counterparty !== relevant.counterparty) return false;
      return timestampWeight(txn.timestamp) < timestampWeight(relevant.timestamp);
    }).length;

    if (priorTransfersToSameRecipient >= 2) return "inconsistent";
    return "consistent";
  }
  if (caseType === "payment_failed") {
    if (relevant.status === "failed" || relevant.status === "pending") return "consistent";
    if (relevant.status === "completed") return "inconsistent";
    return "insufficient_data";
  }
  if (caseType === "refund_request") {
    if (relevant.status === "reversed") return "inconsistent";
    if (relevant.type === "refund" && relevant.status === "completed") return "consistent";
    if (
      (relevant.type === "payment" || relevant.type === "transfer") &&
      relevant.status === "completed"
    ) {
      return "consistent";
    }
    return "insufficient_data";
  }
  if (caseType === "duplicate_payment") {
    const duplicateCount = history.filter(
      (txn) =>
        txn.type === relevant.type &&
        txn.amount === relevant.amount &&
        txn.counterparty === relevant.counterparty
    ).length;
    if (duplicateCount >= 2) return "consistent";
    return "insufficient_data";
  }
  if (caseType === "merchant_settlement_delay") {
    if (relevant.type !== "settlement") return "inconsistent";
    if (relevant.status === "pending") return "consistent";
    if (relevant.status === "completed") return "inconsistent";
    return "insufficient_data";
  }
  if (caseType === "agent_cash_in_issue") {
    if (relevant.type !== "cash_in") return "inconsistent";
    if (relevant.status === "failed" || relevant.status === "pending") return "consistent";
    if (relevant.status === "completed") return "inconsistent";
    return "insufficient_data";
  }
  if (caseType === "phishing_or_social_engineering") {
    return "insufficient_data";
  }
  return "insufficient_data";
};

const severityFor = (
  caseType: AnalyzeTicketResponse["case_type"],
  relevant: TransactionHistoryEntry | null,
  evidenceVerdict: AnalyzeTicketResponse["evidence_verdict"]
): AnalyzeTicketResponse["severity"] => {
  const amount = relevant?.amount ?? 0;

  if (caseType === "phishing_or_social_engineering") return "critical";
  if (amount >= 100_000) return "critical";

  if (caseType === "wrong_transfer") {
    return amount >= 5_000 ? "high" : "medium";
  }

  if (caseType === "duplicate_payment") {
    return "high";
  }

  if (caseType === "payment_failed") {
    return "high";
  }

  if (caseType === "refund_request") {
    if (amount >= 10_000) return "high";
    return evidenceVerdict === "insufficient_data" ? "medium" : "low";
  }

  if (caseType === "merchant_settlement_delay") {
    return amount >= 20_000 ? "high" : "medium";
  }

  if (caseType === "agent_cash_in_issue") {
    if (relevant?.status === "pending" || relevant?.status === "failed") return "high";
    return amount >= 20_000 ? "high" : "medium";
  }

  return "low";
};

export const runFallbackAnalysis = (
  input: AnalyzeTicketRequest,
  reason: string
): AnalyzeTicketResponse => {
  const caseType = detectCaseType(input);
  const history = input.transaction_history ?? [];
  const relevant = pickRelevantTransaction(input, caseType);
  const evidenceVerdict = evidenceFor(caseType, relevant, history);
  const severity = severityFor(caseType, relevant, evidenceVerdict);
  const department = mapDepartment(caseType, severity, input.user_type, input.complaint);

  const highValue = (relevant?.amount ?? 0) >= 25_000;
  const disputedCase = caseType === "wrong_transfer" || caseType === "duplicate_payment";
  const contestedRefund =
    caseType === "refund_request" && (severity !== "low" || evidenceVerdict !== "consistent");
  const agentPendingIssue =
    caseType === "agent_cash_in_issue" && (relevant?.status === "pending" || relevant?.status === "failed");

  const humanReviewRequired =
    caseType === "phishing_or_social_engineering" ||
    disputedCase ||
    contestedRefund ||
    agentPendingIssue ||
    evidenceVerdict === "insufficient_data" ||
    highValue ||
    severity === "critical";

  const summaryTransactionPart = relevant
    ? `using transaction ${relevant.transaction_id} (${relevant.status}, ${relevant.amount} BDT).`
    : "without a directly matching transaction in the provided history.";

  const confidence = evidenceVerdict === "insufficient_data" ? 0.55 : 0.7;

  return {
    ticket_id: input.ticket_id,
    relevant_transaction_id: relevant?.transaction_id ?? null,
    evidence_verdict: evidenceVerdict,
    case_type: caseType,
    severity,
    department,
    agent_summary: `Fallback investigator processed the complaint ${summaryTransactionPart}`,
    recommended_next_action:
      "Verify timeline and transaction metadata in official internal tools, then continue according to approved SOP. Any eligible financial adjustment must follow authorized review.",
    customer_reply:
      "Thank you for reporting this issue. Our team has logged your case and will review it through official support channels. Please do not share PIN, OTP, password, or full card number with anyone. Any eligible amount will be returned through official channels after review.",
    human_review_required: humanReviewRequired,
    confidence,
    reason_codes: [`fallback_mode:${reason}`, `case_type:${caseType}`, `evidence:${evidenceVerdict}`]
  };
};
