/**
 * Cost tracking + daily USD cap.
 *
 * Every Anthropic call goes through this module. We record token usage,
 * map to USD via per-model pricing, and enforce a hard daily cap so a
 * runaway workflow loop can't drain the budget overnight.
 *
 * The cap defaults to $2/UTC-day. Override via LOOM_DAILY_USD_CAP env.
 * When the day's total exceeds the cap, `assertWithinBudget` throws —
 * workflows catch and halt instead of grinding through more LLM calls.
 */

import { Redis } from "@upstash/redis";

const HAS_UPSTASH = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const redis = HAS_UPSTASH ? Redis.fromEnv() : null;

const DAILY_CAP_USD = Number(process.env.LOOM_DAILY_USD_CAP ?? "2");

export type LlmUsageSample = {
  workflowId: string;
  stepName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

export type LlmCost = {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheCreationUsd: number;
  totalUsd: number;
};

/* Per-million-token pricing in USD. Cache reads are ~10% of input;
 * cache writes are ~125%. Anthropic publishes these on its pricing
 * page. Update when prices change. */
const PRICING: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheCreation: number }
> = {
  "claude-haiku-4-5": {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheCreation: 1.25,
  },
  "claude-sonnet-4-6": {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheCreation: 3.75,
  },
  "claude-opus-4-7": {
    input: 15.0,
    output: 75.0,
    cacheRead: 1.5,
    cacheCreation: 18.75,
  },
};

function priceFor(model: string) {
  return PRICING[model] ?? PRICING["claude-sonnet-4-6"];
}

export function sampleToCost(sample: LlmUsageSample): LlmCost {
  const p = priceFor(sample.model);
  const inputUsd = (sample.inputTokens * p.input) / 1_000_000;
  const outputUsd = (sample.outputTokens * p.output) / 1_000_000;
  const cacheReadUsd = ((sample.cacheReadTokens ?? 0) * p.cacheRead) / 1_000_000;
  const cacheCreationUsd =
    ((sample.cacheCreationTokens ?? 0) * p.cacheCreation) / 1_000_000;
  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheCreationUsd,
    totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheCreationUsd,
  };
}

function todayKey(): string {
  return `loom:cost:${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Record a usage sample to Upstash. Idempotent at the daily total
 * level — repeated calls add to the running total even if you
 * accidentally record the same sample twice (an acceptable risk
 * given the daily cap is a soft guardrail, not an exact ledger).
 */
export async function recordSpend(sample: LlmUsageSample): Promise<LlmCost> {
  const cost = sampleToCost(sample);
  if (redis) {
    await redis.incrbyfloat(todayKey(), cost.totalUsd);
    await redis.expire(todayKey(), 86400 * 7);
  }
  return cost;
}

/**
 * Throw `BudgetExceededError` if today's spend has already passed the
 * cap. Call this at the top of every step that makes an LLM call;
 * workflows catch and halt rather than burning through more requests.
 */
export class BudgetExceededError extends Error {
  constructor(
    public spent: number,
    public cap: number,
  ) {
    super(`Daily LLM budget exceeded: $${spent.toFixed(4)} / $${cap.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

export async function assertWithinBudget(): Promise<void> {
  if (!redis) return;
  const raw = await redis.get<string | number>(todayKey());
  const spent = Number(raw ?? 0);
  if (spent >= DAILY_CAP_USD) {
    throw new BudgetExceededError(spent, DAILY_CAP_USD);
  }
}

export async function getTodaySpend(): Promise<number> {
  if (!redis) return 0;
  const raw = await redis.get<string | number>(todayKey());
  return Number(raw ?? 0);
}

export const BUDGET_CAP_USD = DAILY_CAP_USD;
