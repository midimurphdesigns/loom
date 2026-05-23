/**
 * Anthropic client + cost-recording wrappers.
 *
 * Every LLM call should go through one of these helpers. Each one
 * calls assertWithinBudget BEFORE firing the model and recordSpend
 * AFTER the response so the daily USD cap is enforced and the cost
 * dashboard stays accurate.
 *
 * Two helpers exposed today:
 *   - generateTextHaiku  — cheap classifier / generator (Haiku 4.5)
 *   - generateTextOpus   — expensive negotiator (Opus 4.7), for the
 *                          discount-negotiation workflow only
 *
 * Sonnet 4.6 isn't currently routed because loom's existing flows
 * fall on either end of the cost spectrum. Adding a Sonnet helper
 * is one-and-done if a flow needs the middle tier.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { assertWithinBudget, recordSpend, type LlmUsageSample } from "@/lib/cost";
import type { AgentDecision } from "@/lib/agent-authority";

export const HAIKU_MODEL = "claude-haiku-4-5";
export const OPUS_MODEL = "claude-opus-4-7";

export type GenerateOptions = {
  workflowId: string;
  stepName: string;
  system: string;
  prompt: string;
  maxTokens?: number;
};

type RawUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
};

type RawProviderMetadata = {
  anthropic?: {
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
};

function extractUsage(
  raw: { usage?: RawUsage; providerMetadata?: RawProviderMetadata },
  workflowId: string,
  stepName: string,
  model: string,
): LlmUsageSample {
  const usage = raw.usage ?? {};
  const meta = raw.providerMetadata?.anthropic ?? {};
  return {
    workflowId,
    stepName,
    model,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cachedInputTokens ?? meta.cacheReadInputTokens ?? 0,
    cacheCreationTokens:
      usage.cacheCreationInputTokens ?? meta.cacheCreationInputTokens ?? 0,
  };
}

export async function generateTextHaiku(opts: GenerateOptions): Promise<string> {
  await assertWithinBudget();
  const result = await generateText({
    model: anthropic(HAIKU_MODEL),
    system: opts.system,
    prompt: opts.prompt,
    maxOutputTokens: opts.maxTokens ?? 600,
  });
  const sample = extractUsage(result, opts.workflowId, opts.stepName, HAIKU_MODEL);
  const cost = await recordSpend(sample);
  console.log(
    `[anthropic] haiku step=${opts.stepName} in=${sample.inputTokens} out=${sample.outputTokens} usd=${cost.totalUsd.toFixed(5)}`,
  );
  return result.text;
}

export async function generateTextOpus(opts: GenerateOptions): Promise<string> {
  await assertWithinBudget();
  const result = await generateText({
    model: anthropic(OPUS_MODEL),
    system: opts.system,
    prompt: opts.prompt,
    maxOutputTokens: opts.maxTokens ?? 600,
  });
  const sample = extractUsage(result, opts.workflowId, opts.stepName, OPUS_MODEL);
  const cost = await recordSpend(sample);
  console.log(
    `[anthropic] opus step=${opts.stepName} in=${sample.inputTokens} out=${sample.outputTokens} usd=${cost.totalUsd.toFixed(5)}`,
  );
  return result.text;
}

const AgentDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("discount"),
    amountUsd: z.number().nonnegative(),
    reasoning: z.string(),
  }),
  z.object({
    kind: z.literal("refund"),
    amountUsd: z.number().nonnegative(),
    reasoning: z.string(),
  }),
  z.object({
    kind: z.literal("no_action"),
    reasoning: z.string(),
  }),
]);

/**
 * Generate a typed AgentDecision via Opus + structured output.
 * The shape is enforced by Zod so the budget gate downstream knows
 * exactly which fields it's validating. The gate (in agent-authority.ts)
 * still has the final word — this helper just shapes the model output.
 */
export async function generateAgentDecisionOpus(
  opts: GenerateOptions,
): Promise<AgentDecision> {
  await assertWithinBudget();
  const result = await generateObject({
    model: anthropic(OPUS_MODEL),
    schema: AgentDecisionSchema,
    system: opts.system,
    prompt: opts.prompt,
  });
  const sample = extractUsage(result, opts.workflowId, opts.stepName, OPUS_MODEL);
  const cost = await recordSpend(sample);
  console.log(
    `[anthropic] opus(decision) step=${opts.stepName} kind=${result.object.kind} in=${sample.inputTokens} out=${sample.outputTokens} usd=${cost.totalUsd.toFixed(5)}`,
  );
  return result.object as AgentDecision;
}
