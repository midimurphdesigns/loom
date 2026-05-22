/**
 * Stripe webhook receiver — drift-tolerant.
 *
 * Stripe webhooks arrive at unpredictable times relative to the
 * workflows that depend on them. Three drift cases (from
 * docs/ARCHITECTURE.md):
 *   1) BEFORE the workflow exists. We persist the event in Upstash
 *      under `loom:stripe:event:<id>` with a 30d TTL so the workflow
 *      can read it on its first step.
 *   2) DURING the workflow. Workflow's polling step reads the same
 *      Upstash key.
 *   3) AFTER the workflow finished. Event persists in case a
 *      downstream workflow needs it; TTL cleans up.
 *
 * This handler ONLY persists + acknowledges. It does NOT trigger
 * workflow starts directly; the trigger lives in a separate dispatch
 * layer so the webhook handler stays simple, fast, and idempotent.
 *
 * Signature verification is mandatory. Stripe's CLI sets the secret
 * via `stripe listen --forward-to ...` output; copy it into
 * STRIPE_WEBHOOK_SECRET.
 */

import { Redis } from "@upstash/redis";
import Stripe from "stripe";

export const runtime = "nodejs";

const HAS_UPSTASH = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const redis = HAS_UPSTASH ? Redis.fromEnv() : null;

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

const EVENT_TTL_SECONDS = 60 * 60 * 24 * 30;

export async function POST(req: Request): Promise<Response> {
  if (!stripe) {
    return new Response("stripe not configured", { status: 500 });
  }
  if (!WEBHOOK_SECRET) {
    return new Response("webhook secret not configured", { status: 500 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("missing signature", { status: 400 });
  }

  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      WEBHOOK_SECRET,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "verification failed";
    return new Response(`signature verification failed: ${message}`, {
      status: 400,
    });
  }

  if (redis) {
    await redis.set(`loom:stripe:event:${event.id}`, JSON.stringify(event), {
      ex: EVENT_TTL_SECONDS,
    });
    await redis.lpush(`loom:stripe:type:${event.type}`, event.id);
    await redis.ltrim(`loom:stripe:type:${event.type}`, 0, 999);
  }

  return Response.json({ received: true, eventId: event.id });
}
