/**
 * Lists persisted Stripe events from Upstash. Used by the demo
 * surface to prove the drift-tolerant persistence path is working
 * after a test webhook fires.
 */

import { Redis } from "@upstash/redis";

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

  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "payment_intent.succeeded";

  const ids = (await redis.lrange<string>(
    `loom:stripe:type:${type}`,
    0,
    LIMIT - 1,
  )) as string[];

  const events: Array<{ id: string; type: string; created: number }> = [];
  for (const id of ids) {
    const raw = await redis.get<string | { id: string; type: string; created: number }>(
      `loom:stripe:event:${id}`,
    );
    if (!raw) continue;
    const ev = typeof raw === "string" ? JSON.parse(raw) : raw;
    events.push({ id: ev.id, type: ev.type, created: ev.created });
  }

  return Response.json({ type, events });
}
