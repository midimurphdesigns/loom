/**
 * Self-targeted Stripe test webhook trigger.
 *
 * Builds a Stripe-shaped payment_intent.succeeded event server-side,
 * signs it with STRIPE_WEBHOOK_SECRET, POSTs it to our own
 * /api/webhooks/stripe receiver. The webhook handler writes to the
 * global event store (real Stripe doesn't know about visitor cookies)
 * AND we additionally write to a per-visitor list so this visitor's
 * "list events" view only shows their own clicks.
 *
 * The signing happens server-side so the secret never leaves Node.
 */

import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import { Redis } from "@upstash/redis";
import {
  getOrCreateVisitor,
  visitorEventListKey,
} from "@/lib/visitor";

export const runtime = "nodejs";

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

const HAS_UPSTASH = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const redis = HAS_UPSTASH ? Redis.fromEnv() : null;

function signPayload(rawBody: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${rawBody}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

export async function POST(req: Request): Promise<Response> {
  if (!WEBHOOK_SECRET) {
    return Response.json(
      { error: "STRIPE_WEBHOOK_SECRET not configured" },
      { status: 500 },
    );
  }

  const { visitorId, setCookieHeader } = getOrCreateVisitor(req);

  const eventId = `evt_test_${randomUUID().slice(0, 12)}`;
  const event = {
    id: eventId,
    object: "event",
    type: "payment_intent.succeeded",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: `pi_test_${randomUUID().slice(0, 12)}`,
        object: "payment_intent",
        amount: 47800,
        currency: "usd",
        status: "succeeded",
        metadata: { source: "loom-demo-test-webhook", visitorId },
      },
    },
  };

  const rawBody = JSON.stringify(event);
  const signature = signPayload(rawBody, WEBHOOK_SECRET);

  const origin = new URL(req.url).origin;
  const receiver = await fetch(`${origin}/api/webhooks/stripe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signature,
    },
    body: rawBody,
  });
  const receiverBody = await receiver.text();

  // Also write to the per-visitor list so this visitor's "list events"
  // call only sees their own events. Caps at 100 entries per visitor.
  if (redis && receiver.ok) {
    await redis.lpush(visitorEventListKey(visitorId, event.type), event.id);
    await redis.ltrim(visitorEventListKey(visitorId, event.type), 0, 99);
    await redis.expire(
      visitorEventListKey(visitorId, event.type),
      60 * 60 * 24 * 7,
    );
  }

  const res = Response.json({
    sent: true,
    eventId,
    eventType: event.type,
    receiverStatus: receiver.status,
    receiverBody,
    visitorId,
  });
  if (setCookieHeader) {
    res.headers.set("Set-Cookie", setCookieHeader);
  }
  return res;
}
