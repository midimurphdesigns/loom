/**
 * Agent spending authority — the budget gate that enforces hard
 * ceilings on what an LLM can decide to spend.
 *
 * The principle: LLM decisions are validated AFTER the model
 * returns, BEFORE the side-effecting step (Stripe call) executes.
 * If the LLM tries to exceed the ceiling for any reason — including
 * adversarial prompt injection — the gate returns `decision_blocked`
 * and the workflow takes the human-review fallback branch.
 *
 * Two ceilings today:
 *   LOOM_MAX_DISCOUNT_USD (default $25) — max discount the
 *     dynamic-checkout agent can grant on a single transaction.
 *   LOOM_MAX_REFUND_USD (default $50) — max refund the
 *     return-triage agent can auto-issue.
 *
 * These ceilings are env-driven so the demo can run with conservative
 * defaults and production can raise them per business policy. They
 * are NOT prompt-driven — the LLM cannot see them, cannot argue
 * against them, cannot raise them via reasoning. The gate runs in
 * deterministic application code after the model has finished.
 */

export const MAX_DISCOUNT_USD = Number(
  process.env.LOOM_MAX_DISCOUNT_USD ?? "25",
);
export const MAX_REFUND_USD = Number(process.env.LOOM_MAX_REFUND_USD ?? "50");

export type AgentDecision =
  | { kind: "discount"; amountUsd: number; reasoning: string }
  | { kind: "refund"; amountUsd: number; reasoning: string }
  | { kind: "no_action"; reasoning: string };

export type AuthorityOutcome =
  | {
      status: "approved";
      decision: AgentDecision;
    }
  | {
      status: "decision_blocked";
      decision: AgentDecision;
      reason: string;
      ceilingUsd: number;
    };

/**
 * Validate a discount decision against MAX_DISCOUNT_USD. Returns
 * approved or decision_blocked. The workflow MUST take the blocked
 * branch when this returns decision_blocked — do not retry, do not
 * argue with the model, fall to human review.
 */
export function authorizeDiscount(decision: AgentDecision): AuthorityOutcome {
  if (decision.kind === "no_action") {
    return { status: "approved", decision };
  }
  if (decision.kind !== "discount") {
    return {
      status: "decision_blocked",
      decision,
      reason: `expected discount decision, got ${decision.kind}`,
      ceilingUsd: MAX_DISCOUNT_USD,
    };
  }
  if (!Number.isFinite(decision.amountUsd) || decision.amountUsd < 0) {
    return {
      status: "decision_blocked",
      decision,
      reason: `invalid amount: ${decision.amountUsd}`,
      ceilingUsd: MAX_DISCOUNT_USD,
    };
  }
  if (decision.amountUsd > MAX_DISCOUNT_USD) {
    return {
      status: "decision_blocked",
      decision,
      reason: `discount $${decision.amountUsd.toFixed(2)} exceeds ceiling $${MAX_DISCOUNT_USD.toFixed(2)}`,
      ceilingUsd: MAX_DISCOUNT_USD,
    };
  }
  return { status: "approved", decision };
}

/**
 * Validate a refund decision against MAX_REFUND_USD. Same shape as
 * authorizeDiscount; same workflow contract.
 */
export function authorizeRefund(decision: AgentDecision): AuthorityOutcome {
  if (decision.kind === "no_action") {
    return { status: "approved", decision };
  }
  if (decision.kind !== "refund") {
    return {
      status: "decision_blocked",
      decision,
      reason: `expected refund decision, got ${decision.kind}`,
      ceilingUsd: MAX_REFUND_USD,
    };
  }
  if (!Number.isFinite(decision.amountUsd) || decision.amountUsd < 0) {
    return {
      status: "decision_blocked",
      decision,
      reason: `invalid amount: ${decision.amountUsd}`,
      ceilingUsd: MAX_REFUND_USD,
    };
  }
  if (decision.amountUsd > MAX_REFUND_USD) {
    return {
      status: "decision_blocked",
      decision,
      reason: `refund $${decision.amountUsd.toFixed(2)} exceeds ceiling $${MAX_REFUND_USD.toFixed(2)}`,
      ceilingUsd: MAX_REFUND_USD,
    };
  }
  return { status: "approved", decision };
}
