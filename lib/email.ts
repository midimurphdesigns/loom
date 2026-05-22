/**
 * Mock email provider.
 *
 * Real production would swap for Resend / Postmark / Sendgrid via the
 * same EmailProvider shape. This impl:
 *   - Honors an idempotency key. If you call sendEmail twice with the
 *     same key, the second call returns the original result without
 *     re-sending. Mirrors Stripe's Idempotency-Key behaviour at the
 *     provider — closes the "Workflows narrows the double-send window
 *     but doesn't eliminate it" gap from the architecture doc.
 *   - Logs to stdout + persists an audit row in Upstash so you can
 *     see deliveries during demo runs.
 */

import { Redis } from "@upstash/redis";

const HAS_UPSTASH = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const redis = HAS_UPSTASH ? Redis.fromEnv() : null;

export type EmailRequest = {
  to: string;
  subject: string;
  body: string;
  /** Stable key the caller derives from workflowId + stepName. */
  idempotencyKey: string;
};

export type EmailResult = {
  messageId: string;
  to: string;
  subject: string;
  bodyPreview: string;
  sentAt: string;
  deduplicated: boolean;
};

const memoryDedupe = new Map<string, EmailResult>();
const DEDUPE_KEY = (k: string) => `loom:email:dedupe:${k}`;
const AUDIT_KEY = "loom:email:audit";
const TTL_SECONDS = 60 * 60 * 24 * 30;

export async function sendEmail(req: EmailRequest): Promise<EmailResult> {
  // 1. Check dedupe by idempotency key. Same key, same result.
  if (redis) {
    const prior = await redis.get<string | EmailResult>(DEDUPE_KEY(req.idempotencyKey));
    if (prior) {
      const result = typeof prior === "string" ? (JSON.parse(prior) as EmailResult) : prior;
      console.log(
        `[email] DEDUPED key=${req.idempotencyKey} to=${req.to} (returning cached result)`,
      );
      return { ...result, deduplicated: true };
    }
  } else if (memoryDedupe.has(req.idempotencyKey)) {
    const result = memoryDedupe.get(req.idempotencyKey)!;
    console.log(
      `[email] DEDUPED key=${req.idempotencyKey} to=${req.to} (returning cached result)`,
    );
    return { ...result, deduplicated: true };
  }

  // 2. Mock send. Real impl would POST to Resend/Postmark/etc.
  const messageId = `msg_${Math.random().toString(36).slice(2, 12)}`;
  const sentAt = new Date().toISOString();
  const result: EmailResult = {
    messageId,
    to: req.to,
    subject: req.subject,
    bodyPreview: req.body.slice(0, 120),
    sentAt,
    deduplicated: false,
  };

  console.log(
    `[email] SENT messageId=${messageId} key=${req.idempotencyKey} to=${req.to}`,
  );
  console.log(`[email]   subject: ${req.subject}`);
  console.log(`[email]   body: ${req.body.split("\n").join(" / ")}`);

  // 3. Persist dedupe record + audit log
  if (redis) {
    await redis.set(DEDUPE_KEY(req.idempotencyKey), JSON.stringify(result), {
      ex: TTL_SECONDS,
    });
    await redis.lpush(AUDIT_KEY, JSON.stringify(result));
    await redis.ltrim(AUDIT_KEY, 0, 199);
  } else {
    memoryDedupe.set(req.idempotencyKey, result);
  }

  return result;
}
