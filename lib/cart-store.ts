/**
 * Cart store — persists cart state for the cart-abandonment workflow.
 *
 * Stripe creates a Payment Intent when the customer reaches checkout
 * but hasn't captured. We persist the cart contents + customer +
 * abandoned-at timestamp here so the workflow can read them on wake.
 *
 * On Vercel serverless, this MUST live in Upstash; in-memory falls
 * back for local development only.
 */

import { Redis } from "@upstash/redis";

const HAS_UPSTASH = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const redis = HAS_UPSTASH ? Redis.fromEnv() : null;

export type CartLineItem = {
  sku: string;
  name: string;
  priceCents: number;
  quantity: number;
};

export type Cart = {
  cartId: string;
  customerId: string;
  customerEmail: string;
  customerName: string;
  items: CartLineItem[];
  subtotalCents: number;
  abandonedAt: string;
  paymentIntentId: string | null;
  status: "abandoned" | "checked-out" | "expired";
};

const memoryStore = new Map<string, Cart>();
const KEY = (cartId: string) => `loom:cart:${cartId}`;
const TTL_SECONDS = 60 * 60 * 24 * 14;

export async function putCart(cart: Cart): Promise<void> {
  if (redis) {
    await redis.set(KEY(cart.cartId), JSON.stringify(cart), { ex: TTL_SECONDS });
  } else {
    memoryStore.set(cart.cartId, cart);
  }
}

export async function getCart(cartId: string): Promise<Cart | null> {
  if (redis) {
    const raw = await redis.get<string | Cart>(KEY(cartId));
    if (!raw) return null;
    return typeof raw === "string" ? (JSON.parse(raw) as Cart) : raw;
  }
  return memoryStore.get(cartId) ?? null;
}

export async function markCartStatus(
  cartId: string,
  status: Cart["status"],
): Promise<void> {
  const cart = await getCart(cartId);
  if (!cart) return;
  cart.status = status;
  await putCart(cart);
}
