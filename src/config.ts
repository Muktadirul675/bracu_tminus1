import dotenv from "dotenv";

dotenv.config();

const asPositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const provider = (process.env.AI_PROVIDER ?? "openai").toLowerCase();
const defaultModel = provider === "groq" ? "llama-3.3-70b-versatile" : "gpt-4o-mini";

const rawTimeoutMs = asPositiveInt(process.env.ANALYZE_TIMEOUT_MS, 29000);
const analyzeTimeoutMs = Math.min(rawTimeoutMs, 30000);

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: asPositiveInt(process.env.PORT, 8000),
  aiProvider: provider,
  aiModel: process.env.AI_MODEL ?? defaultModel,
  analyzeTimeoutMs,
  requireAi: process.env.REQUIRE_AI === "true"
};
