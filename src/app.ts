import express, { type NextFunction, type Request, type Response } from "express";
import { analyzeTicket } from "./ai-investigator.js";
import { config } from "./config.js";
import { runFallbackAnalysis } from "./fallback-analyzer.js";
import { enforceSafetyAndPolicy, isSemanticallyValidComplaint } from "./guardrails.js";
import {
  analyzeTicketRequestSchema,
  analyzeTicketResponseSchema,
  type AnalyzeTicketResponse
} from "./schemas.js";

const withRouteTimeout = async <T>(promise: Promise<T>, fallback: () => T, timeoutMs: number): Promise<T> => {
  let timeoutId: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve(fallback());
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

export const app = express();

app.disable("x-powered-by");
app.use(
  express.json({
    limit: "1mb"
  })
);

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.post("/analyze-ticket", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsedInput = analyzeTicketRequestSchema.safeParse(req.body);
    if (!parsedInput.success) {
      return res.status(400).json({
        error: "Invalid request payload. Ensure ticket_id and complaint are present with valid types."
      });
    }

    const input = parsedInput.data;
    if (!isSemanticallyValidComplaint(input.complaint)) {
      return res.status(422).json({
        error: "Complaint is empty or semantically invalid."
      });
    }

    const result = await withRouteTimeout<AnalyzeTicketResponse>(
      analyzeTicket(input),
      () => enforceSafetyAndPolicy(runFallbackAnalysis(input, "route_timeout"), input),
      Math.max(1000, config.analyzeTimeoutMs - 100)
    );

    const validated = analyzeTicketResponseSchema.parse(result);
    return res.status(200).json(validated);
  } catch (error) {
    return next(error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const parseError =
    err instanceof SyntaxError &&
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: number }).status === 400 &&
    "body" in err;

  if (parseError) {
    return res.status(400).json({ error: "Invalid JSON payload." });
  }

  return res.status(500).json({ error: "Internal server error. Please retry later." });
});
