/**
 * Self-targeted Stripe test webhook trigger.
 *
 * Builds a Stripe-shaped payment_intent.succeeded event server-side,
 * signs it with STRIPE_WEBHOOK_SECRET, POSTs it to our own
 * /api/webhooks/stripe receiver. Lets visitors exercise the drift-
 * tolerant persistence path with one click instead of needing Stripe
 * CLI access.
 *
 * The signing happens server-side so the secret never leaves Node.
 */

import { randomUUID } from "node:crypto";
import crypto from "node:crypto";

export const runtime = "nodejs";

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

/** Stripe signature scheme:  t=<unix>,v1=<HMAC-SHA256 of "<unix>.<rawBody>"> */
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
        metadata: { source: "loom-demo-test-webhook" },
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
  return Response.json({
    sent: true,
    eventId,
    eventType: event.type,
    receiverStatus: receiver.status,
    receiverBody,
  });
}
