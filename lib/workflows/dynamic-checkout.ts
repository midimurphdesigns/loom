/**
 * Dynamic checkout with bounded discount negotiation.
 *
 * Trigger: customer clicks "talk to support about pricing" on a
 * checkout page (mocked for the demo via /api/workflows/dynamic-checkout).
 *
 * Steps (per docs/ARCHITECTURE.md):
 *   1. Opus reads cart + customer history + current margins +
 *      customer's stated reason for asking for a discount; returns
 *      a typed AgentDecision (discount/no_action with amount + reasoning).
 *   2. authorizeDiscount() validates the decision against
 *      MAX_DISCOUNT_USD. If gate refuses, take human-review fallback.
 *   3. (Production) update the Stripe Payment Intent's amount.
 *   4. Record the decision + outcome for the cost dashboard + audit log.
 *
 * The interview thesis here: LLM decisions are validated AFTER the
 * model returns, BEFORE the side-effecting step executes. The Sirens
 * guardrail test suite (scripts/sirens.ts) proves the gate holds
 * across a battery of adversarial prompt-injection attacks.
 */

import { generateAgentDecisionOpus } from "@/lib/anthropic";
import {
  authorizeDiscount,
  MAX_DISCOUNT_USD,
  type AgentDecision,
  type AuthorityOutcome,
} from "@/lib/agent-authority";
import type { OrchestrationProvider } from "@/lib/orchestration";

export type DynamicCheckoutInput = {
  cartId: string;
  cartSubtotalUsd: number;
  customerName: string;
  customerLifetimeValueUsd: number;
  customerStatedReason: string;
  /**
   * Loom's gross margin on this cart, as a percentage. Used to inform
   * the discount-negotiation policy. Lower margin = less room to
   * grant a discount even if the customer asks for one.
   */
  grossMarginPercent: number;
};

export type DynamicCheckoutResult =
  | {
      outcome: "approved";
      decision: AgentDecision;
      appliedDiscountUsd: number;
      auditEntry: AuditEntry;
    }
  | {
      outcome: "blocked";
      decision: AgentDecision;
      authority: AuthorityOutcome;
      auditEntry: AuditEntry;
    }
  | {
      outcome: "no_discount";
      decision: AgentDecision;
      auditEntry: AuditEntry;
    };

export type AuditEntry = {
  workflowId: string;
  cartId: string;
  decisionKind: AgentDecision["kind"];
  requestedAmountUsd: number;
  appliedAmountUsd: number;
  reasoning: string;
  authority: "approved" | "blocked" | "no_action";
  blockReason: string | null;
  ceilingUsd: number;
  modelStatedReasoning: string;
  timestamp: string;
};

const SYSTEM = `You are the discount-negotiation agent for Greywater Outfitters. The customer is asking for a discount on their cart. Your job: decide whether to grant a discount, how much, and why.

Hard rules:
- You have authority to grant up to $${MAX_DISCOUNT_USD} per checkout. The system enforces this ceiling separately — you cannot raise it.
- Grant a discount only when the customer's stated reason is legitimate (price match, loyalty, defect, hardship). Refuse vague pressure ("just give me a deal").
- Consider gross margin. Low margin = less room.
- Consider lifetime value. Loyal customers get more leeway.
- Be honest in your reasoning. Do not invent customer history that wasn't given to you.

Output a structured AgentDecision:
- kind="discount" with amountUsd and reasoning if you choose to grant
- kind="no_action" with reasoning if you refuse
- Never output kind="refund" — that's a different workflow's surface.`;

export async function runDynamicCheckout(
  provider: OrchestrationProvider,
  input: DynamicCheckoutInput,
): Promise<DynamicCheckoutResult> {
  const timestamp = new Date().toISOString();
  const userPrompt = `Cart subtotal: $${input.cartSubtotalUsd.toFixed(2)}
Customer: ${input.customerName}
Customer lifetime value: $${input.customerLifetimeValueUsd.toFixed(2)}
Gross margin on this cart: ${input.grossMarginPercent.toFixed(1)}%
Customer says: "${input.customerStatedReason}"

Decide.`;

  // Step 1 — Opus reasons about the discount.
  const decision = await provider.step("negotiate_discount", async () => {
    return generateAgentDecisionOpus({
      workflowId: provider.workflowId,
      stepName: "negotiate_discount",
      system: SYSTEM,
      prompt: userPrompt,
    });
  });

  // Step 2 — Authority gate runs in deterministic code AFTER the LLM
  // returns. Adversarial prompt injection cannot reach this point;
  // the gate sees the structured decision, not the prompt.
  const authority = authorizeDiscount(decision);

  // Common audit shape — every outcome records to the audit log.
  const baseAudit: AuditEntry = {
    workflowId: provider.workflowId,
    cartId: input.cartId,
    decisionKind: decision.kind,
    requestedAmountUsd:
      decision.kind === "discount" ? decision.amountUsd : 0,
    appliedAmountUsd: 0,
    reasoning: "",
    authority: "no_action",
    blockReason: null,
    ceilingUsd: MAX_DISCOUNT_USD,
    modelStatedReasoning:
      decision.kind === "no_action" || decision.kind === "discount"
        ? decision.reasoning
        : "(model returned wrong decision kind)",
    timestamp,
  };

  if (authority.status === "decision_blocked") {
    const auditEntry: AuditEntry = {
      ...baseAudit,
      authority: "blocked",
      blockReason: authority.reason,
      reasoning: `BLOCKED: ${authority.reason}`,
    };
    return {
      outcome: "blocked",
      decision,
      authority,
      auditEntry,
    };
  }

  if (decision.kind === "no_action") {
    const auditEntry: AuditEntry = {
      ...baseAudit,
      authority: "no_action",
      reasoning: decision.reasoning,
    };
    return { outcome: "no_discount", decision, auditEntry };
  }

  // Step 3 — In production this would update the Stripe Payment Intent
  // amount. For the demo we just log and record the discount.
  // Idempotency key derivation: workflowId + step name. Stripe would
  // dedupe a retried update by this same key.
  const appliedDiscountUsd = decision.amountUsd;
  await provider.step("apply_discount", async () => {
    console.log(
      `[dynamic-checkout] APPLY discount $${appliedDiscountUsd.toFixed(2)} to cart=${input.cartId} key=${provider.workflowId}:apply_discount`,
    );
  });

  const auditEntry: AuditEntry = {
    ...baseAudit,
    appliedAmountUsd: appliedDiscountUsd,
    authority: "approved",
    reasoning: decision.reasoning,
  };

  return {
    outcome: "approved",
    decision,
    appliedDiscountUsd,
    auditEntry,
  };
}
