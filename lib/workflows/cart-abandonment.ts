/**
 * Cart abandonment workflow.
 *
 * Trigger: Stripe Payment Intent created without capture (or the
 * /api/workflows/cart-abandonment endpoint for the demo).
 *
 * Steps (per docs/ARCHITECTURE.md):
 *   1. Wait 6h durably
 *   2. Read cart contents + current pricing/inventory from Upstash
 *   3. Skip if customer checked out during the wait
 *   4. LLM (Haiku) composes personalized re-engagement email body
 *   5. Send email keyed by stable idempotency key
 *   6. (deferred) Schedule a 48h follow-up workflow
 *
 * Local dev hint: set LOOM_DEMO_SLEEP_MS=500 to shrink the 6h sleep
 * to 500ms so you can run the workflow end-to-end without waiting
 * six real hours. Production should never set this.
 */

import { generateTextHaiku } from "@/lib/anthropic";
import { getCart, markCartStatus } from "@/lib/cart-store";
import { sendEmail, type EmailResult } from "@/lib/email";
import {
  idempotencyKey,
  type OrchestrationProvider,
} from "@/lib/orchestration";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const DEMO_SLEEP_MS = process.env.LOOM_DEMO_SLEEP_MS
  ? Number(process.env.LOOM_DEMO_SLEEP_MS)
  : null;

export type CartAbandonmentInput = {
  cartId: string;
};

export type CartAbandonmentResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: "sent"; email: EmailResult }
  | { outcome: "deduplicated"; email: EmailResult };

const SYSTEM = `You write personalized re-engagement emails for Greywater Outfitters, an outdoor-gear retailer. Tone: warm, specific, never desperate. Reference the actual items in the cart by name. Mention any pricing changes since abandonment. Keep the body under 90 words. Output PLAIN TEXT email body only — no subject line, no greeting markers, no signature.`;

export async function runCartAbandonment(
  provider: OrchestrationProvider,
  input: CartAbandonmentInput,
): Promise<CartAbandonmentResult> {
  const sleepDuration = DEMO_SLEEP_MS ?? SIX_HOURS_MS;

  // Step 1 — durable wait. With Workflows this survives worker death.
  await provider.sleep(sleepDuration);

  // Step 2 — read cart. If the cart vanished (TTL expired, manual
  // cleanup), the workflow exits gracefully rather than crashing.
  const cart = await provider.step("read_cart", async () => {
    return getCart(input.cartId);
  });
  if (!cart) {
    return { outcome: "skipped", reason: "cart not found" };
  }

  // Step 3 — short-circuit if customer checked out during the sleep.
  if (cart.status === "checked-out") {
    return { outcome: "skipped", reason: "customer already checked out" };
  }
  if (cart.status === "expired") {
    return { outcome: "skipped", reason: "cart expired" };
  }

  // Step 4 — LLM composes the email body. Haiku because cheap
  // generator, not high-stakes negotiation.
  const cartSummary = cart.items
    .map(
      (item) =>
        `- ${item.name} (${item.sku}) x${item.quantity} @ $${(item.priceCents / 100).toFixed(2)}`,
    )
    .join("\n");
  const subtotal = (cart.subtotalCents / 100).toFixed(2);
  const userPrompt = `Customer: ${cart.customerName} <${cart.customerEmail}>
Abandoned at: ${cart.abandonedAt}
Cart subtotal: $${subtotal}
Items:
${cartSummary}

Write the re-engagement email body. Under 90 words. Reference at least one item by name.`;

  const emailBody = await provider.step("compose_email", async () => {
    return generateTextHaiku({
      workflowId: provider.workflowId,
      stepName: "compose_email",
      system: SYSTEM,
      prompt: userPrompt,
    });
  });

  // Step 5 — send. The idempotency key is derived from workflow id
  // plus step name so retries (within or across worker restarts)
  // dedupe at the email provider.
  const sendResult = await provider.step("send_email", async () => {
    return sendEmail({
      to: cart.customerEmail,
      subject: `Greywater Outfitters — still thinking it over?`,
      body: emailBody,
      idempotencyKey: idempotencyKey(provider.workflowId, "send_email"),
    });
  });

  // Step 6 — mark the cart so a duplicate trigger short-circuits.
  await provider.step("mark_processed", async () => {
    await markCartStatus(cart.cartId, "expired");
  });

  return {
    outcome: sendResult.deduplicated ? "deduplicated" : "sent",
    email: sendResult,
  };
}
