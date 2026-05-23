/**
 * Webhook-consumer workflow trigger.
 *
 * Reads the most recent UNCONSUMED event from THIS visitor's event
 * list, "consumes" it, and records the consumption cursor so the UI
 * can dim it.
 *
 * Architecturally important: this does NOT delete the event from the
 * store. Real production event stores are durable logs, not queues —
 * multiple consumers can subscribe to the same event, and each one
 * tracks its own consumption cursor. TTL-based eviction handles
 * cleanup. Deleting on consume would break the multi-consumer pattern.
 *
 * For the demo, "consumed" means the visitor's consumer-cursor set
 * includes this event id. UI dims dimmed events with a checkmark.
 */

import { Redis } from "@upstash/redis";
import {
  getOrCreateVisitor,
  visitorConsumerCursorKey,
  visitorEventListKey,
} from "@/lib/visitor";

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

  const { visitorId, setCookieHeader } = getOrCreateVisitor(req);
  const body = (await req.json().catch(() => ({}))) as { eventType?: string };
  const eventType = body.eventType ?? "payment_intent.succeeded";

  const ids = (await redis.lrange<string>(
    visitorEventListKey(visitorId, eventType),
    0,
    49,
  )) as string[];

  const consumedIds = ((await redis.smembers(
    visitorConsumerCursorKey(visitorId),
  )) ?? []) as string[];
  const consumedSet = new Set(consumedIds);

  // Walk newest -> oldest, pick the first unconsumed one
  const nextId = ids.find((id) => !consumedSet.has(id));
  if (!nextId) {
    const res = Response.json({
      found: false,
      eventType,
      reason:
        ids.length === 0
          ? "no events persisted yet — send a test webhook first"
          : "all persisted events already consumed by your consumer — send another test webhook to add a new one",
    });
    if (setCookieHeader) res.headers.set("Set-Cookie", setCookieHeader);
    return res;
  }

  const raw = await redis.get<string | StripeEventLite>(
    `loom:stripe:event:${nextId}`,
  );
  if (!raw) {
    const res = Response.json({
      found: false,
      eventType,
      reason: `event id ${nextId} not found in store (TTL expired?)`,
    });
    if (setCookieHeader) res.headers.set("Set-Cookie", setCookieHeader);
    return res;
  }
  const ev = (typeof raw === "string" ? JSON.parse(raw) : raw) as StripeEventLite;

  // Record THIS visitor's consumer cursor. Event stays in the store.
  await redis.sadd(visitorConsumerCursorKey(visitorId), ev.id);
  await redis.expire(visitorConsumerCursorKey(visitorId), 60 * 60 * 24 * 30);

  const obj = ev.data?.object ?? {};
  const amountUsd = typeof obj.amount === "number" ? obj.amount / 100 : null;

  const res = Response.json({
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
      "Your consumer just read the persisted event and recorded its cursor. The event STAYS in the store — webhook stores are durable logs, not queues. Multiple consumers can subscribe; each one tracks its own cursor. TTL eviction handles cleanup. The UI dims the consumed event so you can see what your consumer has processed.",
  });
  if (setCookieHeader) res.headers.set("Set-Cookie", setCookieHeader);
  return res;
}
