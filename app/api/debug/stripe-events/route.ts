/**
 * Lists THIS visitor's persisted Stripe events from Upstash. Reads
 * from the per-visitor list seeded by send-test-webhook. Also
 * returns the visitor's consumer cursor so the UI can dim events
 * that have already been consumed.
 *
 * Global event store still exists; this endpoint just scopes to one
 * visitor's view to prevent cross-visitor confusion.
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

const LIMIT = 10;

export async function GET(req: Request): Promise<Response> {
  if (!redis) {
    return Response.json({ events: [], note: "upstash not configured" });
  }

  const { visitorId, setCookieHeader } = getOrCreateVisitor(req);

  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "payment_intent.succeeded";

  const ids = (await redis.lrange<string>(
    visitorEventListKey(visitorId, type),
    0,
    LIMIT - 1,
  )) as string[];

  const consumedIds = ((await redis.smembers(
    visitorConsumerCursorKey(visitorId),
  )) ?? []) as string[];
  const consumedSet = new Set(consumedIds);

  const events: Array<{
    id: string;
    type: string;
    created: number;
    consumed: boolean;
  }> = [];
  for (const id of ids) {
    const raw = await redis.get<
      string | { id: string; type: string; created: number }
    >(`loom:stripe:event:${id}`);
    if (!raw) continue;
    const ev = typeof raw === "string" ? JSON.parse(raw) : raw;
    events.push({
      id: ev.id,
      type: ev.type,
      created: ev.created,
      consumed: consumedSet.has(ev.id),
    });
  }

  const res = Response.json({ type, events, visitorId });
  if (setCookieHeader) {
    res.headers.set("Set-Cookie", setCookieHeader);
  }
  return res;
}
