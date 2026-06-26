import { z } from "zod";

export const evidenceVerdictValues = [
  "consistent",
  "inconsistent",
  "insufficient_data"
] as const;

export const caseTypeValues = [
  "wrong_transfer",
  "payment_failed",
  "refund_request",
  "duplicate_payment",
  "merchant_settlement_delay",
  "agent_cash_in_issue",
  "phishing_or_social_engineering",
  "other"
] as const;

export const severityValues = ["low", "medium", "high", "critical"] as const;

export const departmentValues = [
  "customer_support",
  "dispute_resolution",
  "payments_ops",
  "merchant_operations",
  "agent_operations",
  "fraud_risk"
] as const;

export const languageValues = ["en", "bn", "mixed"] as const;
export const channelValues = [
  "in_app_chat",
  "call_center",
  "email",
  "merchant_portal",
  "field_agent"
] as const;
export const userTypeValues = ["customer", "merchant", "agent", "unknown"] as const;

export const transactionTypeValues = [
  "transfer",
  "payment",
  "cash_in",
  "cash_out",
  "settlement",
  "refund"
] as const;

export const transactionStatusValues = [
  "completed",
  "failed",
  "pending",
  "reversed"
] as const;

export const transactionHistoryEntrySchema = z.object({
  transaction_id: z.string().min(1, "transaction_id is required"),
  timestamp: z
    .string()
    .min(1, "timestamp is required")
    .refine((value) => !Number.isNaN(Date.parse(value)), "timestamp must be ISO 8601"),
  type: z.enum(transactionTypeValues),
  amount: z.number().finite().nonnegative(),
  counterparty: z.string().min(1, "counterparty is required"),
  status: z.enum(transactionStatusValues)
});

export const analyzeTicketRequestSchema = z
  .object({
    ticket_id: z.string().min(1, "ticket_id is required"),
    complaint: z.string(),
    language: z.enum(languageValues).optional(),
    channel: z.enum(channelValues).optional(),
    user_type: z.enum(userTypeValues).optional(),
    campaign_context: z.string().optional(),
    transaction_history: z.array(transactionHistoryEntrySchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough();

export const analyzeTicketResponseSchema = z
  .object({
    ticket_id: z.string().min(1),
    relevant_transaction_id: z.string().nullable(),
    evidence_verdict: z.enum(evidenceVerdictValues),
    case_type: z.enum(caseTypeValues),
    severity: z.enum(severityValues),
    department: z.enum(departmentValues),
    agent_summary: z.string().min(1),
    recommended_next_action: z.string().min(1),
    customer_reply: z.string().min(1),
    human_review_required: z.boolean(),
    confidence: z.number().min(0).max(1).optional(),
    reason_codes: z.array(z.string().min(1)).optional()
  })
  .strict();

export const aiGeneratedResponseSchema = analyzeTicketResponseSchema
  .omit({ ticket_id: true })
  .strict();

export type AnalyzeTicketRequest = z.infer<typeof analyzeTicketRequestSchema>;
export type AnalyzeTicketResponse = z.infer<typeof analyzeTicketResponseSchema>;
export type TransactionHistoryEntry = z.infer<typeof transactionHistoryEntrySchema>;
