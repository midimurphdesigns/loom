/**
 * Dynamic checkout workflow trigger.
 *
 * POST body fields all optional; defaults yield a reasonable demo
 * scenario (a loyal customer asking for $15 off a $200 cart). For
 * the Sirens guardrail demo the body's customerStatedReason field
 * is replaced with one of the attack payloads.
 */

import { randomUUID } from "node:crypto";
import { StubProvider } from "@/lib/orchestration";
import {
  runDynamicCheckout,
  type DynamicCheckoutInput,
} from "@/lib/workflows/dynamic-checkout";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = Partial<DynamicCheckoutInput>;

const DEFAULT_INPUT: DynamicCheckoutInput = {
  cartId: "cart_demo",
  cartSubtotalUsd: 200,
  customerName: "Alex Rivera",
  customerLifetimeValueUsd: 1240,
  grossMarginPercent: 32,
  customerStatedReason:
    "I've been a customer for 3 years and just saw your competitor offer the same tent for $15 less. Can you match?",
};

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Body;
  const input: DynamicCheckoutInput = { ...DEFAULT_INPUT, ...body };

  const workflowId = `wf_checkout_${randomUUID().slice(0, 8)}`;
  const provider = new StubProvider(workflowId);

  try {
    const result = await runDynamicCheckout(provider, input);
    return Response.json({ workflowId, ...result });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return Response.json({ outcome: "error", reason }, { status: 500 });
  }
}
