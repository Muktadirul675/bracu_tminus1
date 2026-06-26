# QueueStorm Investigator API

Internal AI Copilot backend for digital-finance support operations (SUST CSE Carnival 2026 preliminary challenge).

## Stack

- Node.js + Express.js
- TypeScript (ES Modules)
- Vercel AI SDK (`ai`) with provider support:
  - `@ai-sdk/openai`
  - `@ai-sdk/groq`
- Zod for strict request/response validation

## Required Endpoints

- `GET /health` → returns:

```json
{"status":"ok"}
```

- `POST /analyze-ticket` → validates input, investigates complaint vs transaction history, and returns structured JSON.

## Project Layout

```text
src/
  app.ts                # Express app, routes, and error handling
  index.ts              # Server bootstrap
  config.ts             # process.env loading and runtime config
  schemas.ts            # Zod schemas and enum contracts
  guardrails.ts         # Safety checks, department mapping, policy enforcement
  ai-investigator.ts    # Vercel AI SDK integration + strict system prompt
  fallback-analyzer.ts  # Deterministic fallback when AI is unavailable/timeout
```

## Environment Variables (`process.env`)

Create a `.env` file locally (never commit real secrets). Use `.env.example` as template.

| Variable | Required | Default | Description |
|---|---:|---|---|
| `PORT` | No | `8000` | API listen port |
| `AI_PROVIDER` | No | `openai` | `openai` or `groq` |
| `AI_MODEL` | No | provider-specific default | Model name used by selected provider |
| `OPENAI_API_KEY` | If `AI_PROVIDER=openai` | - | OpenAI key |
| `GROQ_API_KEY` | If `AI_PROVIDER=groq` | - | Groq key |
| `ANALYZE_TIMEOUT_MS` | No | `29000` | Per-ticket processing budget (clamped to 30s) |
| `REQUIRE_AI` | No | `false` | If `true`, fail when AI key/provider unavailable instead of fallback |

### Provider defaults

- `openai` → `gpt-4o-mini`
- `groq` → `llama-3.3-70b-versatile`

## Local Setup

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
npm start
```

## API Contract

### POST `/analyze-ticket` request

Required:
- `ticket_id` (string)
- `complaint` (string)

Optional:
- `language` (`en | bn | mixed`)
- `channel` (`in_app_chat | call_center | email | merchant_portal | field_agent`)
- `user_type` (`customer | merchant | agent | unknown`)
- `campaign_context` (string)
- `transaction_history` (array of transaction objects)
- `metadata` (object)

`transaction_history` entry:
- `transaction_id` (string)
- `timestamp` (ISO 8601 string)
- `type` (`transfer | payment | cash_in | cash_out | settlement | refund`)
- `amount` (number)
- `counterparty` (string)
- `status` (`completed | failed | pending | reversed`)

### POST `/analyze-ticket` response schema

```json
{
  "ticket_id": "TKT-001",
  "relevant_transaction_id": "TXN-9101",
  "evidence_verdict": "consistent",
  "case_type": "wrong_transfer",
  "severity": "high",
  "department": "dispute_resolution",
  "agent_summary": "Customer reports sending funds to an unintended recipient and TXN-9101 aligns with the claim.",
  "recommended_next_action": "Escalate to dispute workflow and verify transaction timeline in internal systems.",
  "customer_reply": "We have logged your concern and our team will review this through official channels. Any eligible amount will be returned through official channels.",
  "human_review_required": true,
  "confidence": 0.9,
  "reason_codes": ["wrong_transfer", "transaction_match"]
}
```

## Error Handling

- `400` for malformed JSON or missing/invalid required fields
- `422` for semantically invalid complaint (empty/non-meaningful text)
- `500` for internal failures with a generic non-sensitive message

The service never returns stack traces, tokens, or secrets in API responses.

## Safety Guardrails Implemented

Both prompt-level and code-level enforcement is applied:

1. **No credential harvesting**
   - Output is blocked/sanitized if customer reply asks for PIN/OTP/password/full card number.
2. **No unauthorized commitments**
   - Reply/action cannot promise refund/reversal/account recovery.
3. **No third-party redirection**
   - Reply cannot direct users to suspicious external channels/links.
4. **Anti-prompt injection**
   - Complaint text is treated as untrusted; embedded override instructions are ignored.

If AI output violates policy, the service automatically replaces unsafe text with safe official phrasing.

## Reliability Strategy

- Strict Zod validation for request and response schemas
- Route-level timeout guard for `/analyze-ticket`
- AI-level timeout guard
- Deterministic fallback analyzer when provider is unavailable or times out
- Defensive global error handling to prevent process crashes from malformed input

## Testing Guide (What to do next)

### 1) Basic local checks

```bash
npm run typecheck
npm run build
```

### 2) Start API locally

```bash
npm run dev
```

Then test manually:

```bash
curl -s http://localhost:8000/health
```

### 3) Run official sample-case pack automatically

Use the provided sample JSON from organizers and run:

```bash
npm run test:samples -- /path/to/SUST_Preli_Sample_Cases.json
```

The runner will:
- call `POST /analyze-ticket` for all sample cases
- validate response schema
- compare key functional fields with expected outputs
- check core safety constraints in generated text
- print PASS/FAIL summary

> Note: sample cases are reference cases only. Hidden tests may differ.

## cURL examples

Health:

```bash
curl -s http://localhost:8000/health
```

Analyze ticket:

```bash
curl -s -X POST http://localhost:8000/analyze-ticket \
  -H "Content-Type: application/json" \
  -d '{
    "ticket_id": "TKT-001",
    "complaint": "I sent 5000 BDT to a wrong number around 2pm.",
    "language": "en",
    "channel": "in_app_chat",
    "user_type": "customer",
    "campaign_context": "boishakh_bonanza_day_1",
    "transaction_history": [
      {
        "transaction_id": "TXN-9101",
        "timestamp": "2026-04-14T14:08:22Z",
        "type": "transfer",
        "amount": 5000,
        "counterparty": "+8801719876543",
        "status": "completed"
      }
    ]
  }'
```
