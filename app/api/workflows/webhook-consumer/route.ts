/**
 * Webhook-consumer workflow trigger.
 *
 * Models what a real downstream workflow would do when it needs to
 * act on a Stripe event: read the persisted event store, pick the
 * most recent event of the type it cares about, take action.
 *
 * The point of this endpoint in the demo is to make the drift-
 * reconciliation architecture visible end-to-end:
 *
 *   click 1: "send test webhook"
 *     -> receiver verifies signature, persists event to Upstash
 *
 *   click 2: "fire consumer workflow"
 *     -> a separate process (this endpoint, simulating a workflow
 *        running at any later time) reads the persisted event
 *        store and acts on the event
 *
 * In production this would be a Vercel Workflow polling the event
 * store inside a durable step. For the demo we shape it as a single
 * HTTP request so it's clickable.
 *
 * Honest non-goal: this endpoint doesn't subscribe in real time. It
 * polls. That's deliberate — polling is what the architecture doc
 * describes as the "DURING workflow" mechanism, and it's the
 * simplest reconciliation pattern for the four drift cases.
 */

import { Redis } from "@upstash/redis";

export const runtime = "nodejs";

const HAS_UPSTASH = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const redis = HAS_UPSTASH ? Redis.fromEnv() : null;

type StripeEventLite = {
  id: string;
  type: string;
  created: number;
  data?: { object?: { id?: string; amount?: number; currency?: string } };
};

export async function POST(req: Request): Promise<Response> {
  if (!redis) {
    return Response.json(
      { found: false, reason: "upstash not configured" },
      { status: 200 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    eventType?: string;
  };
  const eventType = body.eventType ?? "payment_intent.succeeded";

  // Read the most recent event id of this type from the per-type list.
  // This is the same persistence shape the webhook handler writes.
  const ids = (await redis.lrange<string>(
    `loom:stripe:type:${eventType}`,
    0,
    0,
  )) as string[];

  if (ids.length === 0) {
    return Response.json({
      found: false,
      eventType,
      reason: "no events persisted yet — send a test webhook first",
    });
  }

  const eventId = ids[0];
  const raw = await redis.get<string | StripeEventLite>(
    `loom:stripe:event:${eventId}`,
  );
  if (!raw) {
    return Response.json({
      found: false,
      eventType,
      reason: `event id ${eventId} not found in store`,
    });
  }
  const ev = (typeof raw === "string" ? JSON.parse(raw) : raw) as StripeEventLite;

  // Shape the response as what a real consumer workflow would log:
  // it found the event it was waiting for, here's what it would do.
  const obj = ev.data?.object ?? {};
  const amountUsd = typeof obj.amount === "number" ? obj.amount / 100 : null;

  return Response.json({
    found: true,
    eventType,
    eventId: ev.id,
    paymentIntentId: obj.id ?? null,
    amountUsd,
    currency: obj.currency ?? null,
    arrivedAt: new Date(ev.created * 1000).toISOString(),
    consumedAt: new Date().toISOString(),
    action: "would_fulfill_order",
    explainer:
      "A real workflow polled this event store and read the persisted event. The event arrived at any earlier time; the workflow consumed it now. Decoupling receive-time from process-time is the drift-reconciliation pattern.",
  });
}
