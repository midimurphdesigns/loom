/**
 * Visitor scoping — each browser gets a UUID stored in a cookie. The
 * webhook handler writes to the global event store (real Stripe doesn't
 * know about our cookies) AND to a per-visitor list, so each visitor's
 * "list events" view only shows their own clicks. Prevents the cross-
 * visitor confusion where one demo viewer sees events another viewer
 * sent hours ago.
 *
 * Honest non-goal: this is not a real multi-tenancy implementation.
 * It's a demo-isolation layer. Production multi-tenant would scope by
 * authenticated team id, not by an anonymous cookie. But the
 * architectural shape (per-tenant event lists, per-tenant consumer
 * cursors) IS production-shaped — swap the visitor id source and the
 * code stays the same.
 */

import { randomUUID } from "node:crypto";

const COOKIE_NAME = "loom_visitor";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * Read the visitor id from request cookies, or generate a new one.
 * Returns the id plus a Set-Cookie header value if a new one was
 * minted (caller responsible for adding to the response).
 */
export function getOrCreateVisitor(req: Request): {
  visitorId: string;
  setCookieHeader: string | null;
} {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (match) {
    return { visitorId: match[1], setCookieHeader: null };
  }
  const visitorId = `v_${randomUUID().slice(0, 12)}`;
  const setCookieHeader = `${COOKIE_NAME}=${visitorId}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
  return { visitorId, setCookieHeader };
}

/** Per-visitor event list — the list a "list events" call reads from. */
export const visitorEventListKey = (visitorId: string, type: string) =>
  `loom:visitor:${visitorId}:stripe:type:${type}`;

/** Per-visitor consumer cursor — tracks which events this visitor's
 * consumer workflow has marked consumed. UI dims consumed events. */
export const visitorConsumerCursorKey = (visitorId: string) =>
  `loom:visitor:${visitorId}:consumer:cursor`;
