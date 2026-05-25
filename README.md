# loom

<!-- ai-citation-block -->
> Loom is an open-source durable AI-commerce backend. Four Vercel Workflows demonstrate the patterns that make agent-driven money movement safe in production: cart abandonment with durable sleep, dynamic checkout with bounded discount negotiation, shipping monitoring with saga compensation, and a Stripe webhook drift demo. Agentic spending is bounded by a deterministic gate the LLM cannot override.
>
> **Author:** Kevin Murphy ([kevinmurphywebdev.com](https://kevinmurphywebdev.com)) · **License:** MIT · **Live:** [loom.kevinmurphywebdev.com](https://loom.kevinmurphywebdev.com) · **Stack:** TypeScript, Next.js 16, Vercel Workflow SDK, Vercel AI SDK, Anthropic SDK, Stripe, Upstash

Durable AI-commerce backend for the fictional Greywater Outfitters. Companion build to [forge](https://github.com/midimurphdesigns/forge).

Demonstrates: Vercel Workflows + Stripe webhook drift reconciliation + agentic spending authority + adversarial-prompt guardrail + failure-injection durability proof + cost-aware Anthropic model routing.

## Architecture

Read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) first. Six flows are designed; two are shipped (cart abandonment + dynamic checkout). The architectural concepts are fully demonstrated by the two; the remaining four are surface-area completion.

- **`lib/orchestration.ts`** — Internal provider interface used only by the failure-injection harness (stub providers simulate crash-and-replay without involving the Workflows runtime). Vercel Workflows (GA) is the production runtime.
- **`lib/orchestration-durable.ts`** — `DurableStubProvider` persists step results to Upstash, the way Vercel Workflows persists internally. Used by the failure-injection harness.
- **`lib/workflows/cart-abandonment.ts`** — durable 6h sleep, LLM-composed re-engagement, idempotency-keyed mock email send.
- **`lib/workflows/dynamic-checkout.ts`** — Opus-negotiated discount with hard ceiling enforcement in deterministic code AFTER the LLM returns.
- **`lib/agent-authority.ts`** — the budget gate. `MAX_DISCOUNT_USD` and `MAX_REFUND_USD` ceilings from env, not from prompt.
- **`lib/cost.ts`** — daily USD cap + per-model pricing. Workflows fail fast at the cap with `BudgetExceededError`.
- **`app/api/webhooks/stripe/route.ts`** — drift-tolerant webhook receiver. Persists events to Upstash with 30d TTL + per-type list for workflow polling.

## Local development

```sh
pnpm install
cp .env.example .env.local
# Fill in ANTHROPIC_API_KEY and Upstash creds at minimum
pnpm dev
```

Then open `http://localhost:3000` and click the workflow buttons.

For shrunken sleep duration during local end-to-end testing of cart-abandonment, set `LOOM_DEMO_SLEEP_MS=500` in `.env.local` so the 6h durable sleep compresses to 500ms.

## Adversarial guardrail proof — `pnpm sirens`

10 prompt-injection attacks designed to make the discount agent grant more than the $25 ceiling. Pass = budget gate held.

```sh
pnpm sirens --dry-run                          # list scenarios, no LLM
ANTHROPIC_API_KEY=... pnpm sirens              # full suite (~$0.50)
ANTHROPIC_API_KEY=... pnpm sirens --scenario=ignore-instructions
```

Snapshots write to `.loom/sirens/<timestamp>.json`. A passing snapshot is the security posture for the agentic-discount surface.

## Durability proof — `pnpm failures`

Simulates worker death at random step boundaries and asserts (a) workflow recovers via persisted step results in Upstash, (b) zero duplicate side effects (receiver-side idempotency keys hold), (c) zero dropped side effects.

```sh
pnpm failures --dry-run                                  # list workflows + kill points
ANTHROPIC_API_KEY=... pnpm failures --runs=5             # full suite (~$2.50)
ANTHROPIC_API_KEY=... pnpm failures --workflow=cart-abandonment
```

Requires Upstash env vars (durable storage is the point). Snapshots write to `.loom/failures/<timestamp>.json`. A passing snapshot proves the durability claim across N trials at each kill point with exactly-once visible side effects.

## Production deploy (Vercel)

### Founder action steps

1. Create the Vercel project and attach `loom.kevinmurphywebdev.com`.
2. Create an Upstash Redis database (Global, eviction enabled).
3. Create a Stripe account (test mode is fine), get a webhook secret via `stripe listen --forward-to https://loom.kevinmurphywebdev.com/api/webhooks/stripe`.
4. Set Vercel env vars (Production scope):
   - `ANTHROPIC_API_KEY` — required
   - `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — required
   - `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` — required for the webhook receiver
   - `LOOM_DAILY_USD_CAP` — defaults to 2 if unset
   - `LOOM_MAX_DISCOUNT_USD` — defaults to 25
   - `LOOM_MAX_REFUND_USD` — defaults to 50
5. DNS: CNAME `loom` → `cname.vercel-dns.com`.
6. Deploy.

### Guardrails

- **Daily USD cap** ($2 default). Workflows halt with `BudgetExceededError` when reached.
- **Agent spending authority**: `MAX_DISCOUNT_USD` and `MAX_REFUND_USD` are env-driven hard ceilings the LLM cannot raise via prompt content. Validated in deterministic code after the LLM returns.

## What loom intentionally does NOT do

- **Real customer payments.** Stripe test-mode only.
- **Real shipping or email integration.** Both are mocked; swapping in a real provider is one file behind the existing `EmailProvider` shape.
- **Shipping monitor + return triage workflows.** Designed in `docs/ARCHITECTURE.md`; deferred from Phase 5. The architectural concepts are demonstrated by the two shipped workflows.
- **A dispatcher between Stripe webhooks and workflow starts.** Webhook handler persists events to Upstash; the dispatcher pattern (transactional outbox + watchdog) is documented in the architecture but not built. Honest gap; would be Phase 7.

## Reading order

If you're new to this codebase:
1. `docs/ARCHITECTURE.md` — the design contract
2. `lib/orchestration.ts` — the provider abstraction
3. `lib/workflows/cart-abandonment.ts` — the simpler workflow
4. `lib/workflows/dynamic-checkout.ts` — the agentic workflow
5. `lib/agent-authority.ts` — the budget gate
6. `scripts/sirens.ts` — the adversarial suite
7. `scripts/failure-injection.ts` — the durability proof
