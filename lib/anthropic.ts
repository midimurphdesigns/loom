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
import { generateText } from "ai";
import { assertWithinBudget, recordSpend, type LlmUsageSample } from "@/lib/cost";

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
