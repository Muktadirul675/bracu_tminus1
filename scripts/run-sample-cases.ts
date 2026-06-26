import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { app } from "../src/app.js";
import { analyzeTicketResponseSchema, type AnalyzeTicketResponse } from "../src/schemas.js";

const sampleCaseSchema = z.object({
  id: z.string(),
  label: z.string(),
  input: z.record(z.string(), z.unknown()),
  expected_output: z.record(z.string(), z.unknown()),
  rationale: z.string().optional()
});

const samplePackSchema = z.object({
  _meta: z.record(z.string(), z.unknown()),
  cases: z.array(sampleCaseSchema).min(1)
});

const severityRank: Record<AnalyzeTicketResponse["severity"], number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

const credentialRequestPattern =
  /\b(share|provide|send|give|enter|tell|submit)\b.{0,50}\b(pin|otp|password|full card|card number|cvv)\b/i;
const safeCredentialWarningPattern =
  /\b(do not|don't|never|avoid)\b.{0,40}\b(share|provide|send|give|tell|disclose)\b.{0,60}\b(pin|otp|password|card|cvv)\b/i;
const unauthorizedCommitmentPattern =
  /\b(we|i)\s+(will|shall|guarantee|confirm|promise|ensure)\b.{0,80}\b(refund|reversal|recover|recovery|unblock)\b/i;
const suspiciousThirdPartyPattern =
  /(https?:\/\/|www\.|telegram|whatsapp|facebook|messenger|gmail|third[- ]party)/i;

const usage = (): void => {
  console.log("Usage:");
  console.log(
    "  npm run test:samples -- /absolute/or/relative/path/to/SUST_Preli_Sample_Cases.json"
  );
};

const resolveInputFile = (): string => {
  const argPath = process.argv[2];
  if (!argPath) {
    usage();
    throw new Error("Sample case JSON path is required.");
  }

  return path.isAbsolute(argPath) ? argPath : path.resolve(process.cwd(), argPath);
};

const fieldValue = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
};

const compareKeyFields = (
  actual: AnalyzeTicketResponse,
  expected: z.infer<typeof sampleCaseSchema>["expected_output"]
): string[] => {
  const errors: string[] = [];

  const requiredExactFields: Array<
    "ticket_id" | "relevant_transaction_id" | "evidence_verdict" | "case_type" | "department"
  > = [
    "ticket_id",
    "relevant_transaction_id",
    "evidence_verdict",
    "case_type",
    "department"
  ];

  for (const field of requiredExactFields) {
    if (field in expected && actual[field] !== (expected as Record<string, unknown>)[field]) {
      errors.push(
        `${field} mismatch: expected=${fieldValue((expected as Record<string, unknown>)[field])} actual=${fieldValue(actual[field])}`
      );
    }
  }

  if ("severity" in expected && typeof expected.severity === "string") {
    const expectedSeverity = expected.severity as AnalyzeTicketResponse["severity"];
    const diff = Math.abs(severityRank[actual.severity] - severityRank[expectedSeverity]);
    if (diff > 1) {
      errors.push(`severity too far: expected=${expectedSeverity} actual=${actual.severity}`);
    }
  }

  return errors;
};

const checkSafety = (actual: AnalyzeTicketResponse): string[] => {
  const errors: string[] = [];
  const isCredentialRequest =
    credentialRequestPattern.test(actual.customer_reply) &&
    !safeCredentialWarningPattern.test(actual.customer_reply);

  if (isCredentialRequest) {
    errors.push("customer_reply appears to request credentials");
  }
  if (unauthorizedCommitmentPattern.test(actual.customer_reply)) {
    errors.push("customer_reply appears to promise unauthorized refund/recovery action");
  }
  if (unauthorizedCommitmentPattern.test(actual.recommended_next_action)) {
    errors.push("recommended_next_action appears to promise unauthorized refund/recovery action");
  }
  if (suspiciousThirdPartyPattern.test(actual.customer_reply)) {
    errors.push("customer_reply appears to redirect to suspicious third-party channels");
  }

  return errors;
};

const main = async (): Promise<void> => {
  const inputFilePath = resolveInputFile();
  const raw = await fs.readFile(inputFilePath, "utf8");
  const parsedJson = JSON.parse(raw) as unknown;
  const pack = samplePackSchema.parse(parsedJson);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", (err) => reject(err));
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine local test server port.");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  let passed = 0;
  let failed = 0;

  try {
    for (const oneCase of pack.cases) {
      const response = await fetch(`${baseUrl}/analyze-ticket`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(oneCase.input)
      });

      const bodyText = await response.text();
      let bodyJson: unknown = null;
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        bodyJson = bodyText;
      }

      const errors: string[] = [];

      if (response.status !== 200) {
        errors.push(`unexpected HTTP status ${response.status}`);
      } else {
        const schemaCheck = analyzeTicketResponseSchema.safeParse(bodyJson);
        if (!schemaCheck.success) {
          errors.push("response schema validation failed");
        } else {
          const responseBody = schemaCheck.data;
          errors.push(...compareKeyFields(responseBody, oneCase.expected_output));
          errors.push(...checkSafety(responseBody));
        }
      }

      if (errors.length === 0) {
        passed += 1;
        console.log(`PASS ${oneCase.id} - ${oneCase.label}`);
      } else {
        failed += 1;
        console.log(`FAIL ${oneCase.id} - ${oneCase.label}`);
        for (const err of errors) {
          console.log(`  - ${err}`);
        }
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  console.log("");
  console.log(`Summary: passed=${passed}, failed=${failed}, total=${pack.cases.length}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
};

main().catch((error: unknown) => {
  console.error("Sample-case test run failed.");
  if (error instanceof Error) {
    console.error(error.message);
  }
  process.exitCode = 1;
});
