/**
 * Cart abandonment workflow trigger.
 *
 * Local-dev surface: POST with a cartId to start the workflow under
 * the StubProvider (in-process, NOT durable across worker death —
 * fine for demonstrating logic).
 *
 * Production surface (deferred until the Workflows runtime wiring
 * lands): the same workflow function runs under WorkflowsProvider
 * with full durability. Code path is unchanged; provider swap is
 * one line.
 *
 * If a cartId is not supplied OR doesn't exist, the route seeds a
 * fictional Greywater Outfitters cart so the demo is one-click from
 * the live page.
 */

import { randomUUID } from "node:crypto";
import { putCart, type Cart } from "@/lib/cart-store";
import { StubProvider } from "@/lib/orchestration";
import {
  runCartAbandonment,
  type CartAbandonmentResult,
} from "@/lib/workflows/cart-abandonment";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = { cartId?: string };

function seedDemoCart(): Cart {
  const cartId = `cart_${randomUUID().slice(0, 8)}`;
  return {
    cartId,
    customerId: "cust_demo",
    customerEmail: "demo@example.com",
    customerName: "Alex Rivera",
    items: [
      {
        sku: "GW-TENT-001",
        name: "Greywater Two-Person Backcountry Tent",
        priceCents: 38900,
        quantity: 1,
      },
      {
        sku: "GW-STOVE-014",
        name: "Greywater Titanium Backpacking Stove",
        priceCents: 8900,
        quantity: 1,
      },
    ],
    subtotalCents: 47800,
    abandonedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    paymentIntentId: null,
    status: "abandoned",
  };
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Body;

  let cartId = body.cartId;
  if (!cartId) {
    const seeded = seedDemoCart();
    await putCart(seeded);
    cartId = seeded.cartId;
  }

  const workflowId = `wf_cart_${cartId}`;
  const provider = new StubProvider(workflowId);

  let result: CartAbandonmentResult;
  try {
    result = await runCartAbandonment(provider, { cartId });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return Response.json({ outcome: "error", reason }, { status: 500 });
  }

  return Response.json({ workflowId, cartId, ...result });
}
