/**
 * OrchestrationProvider — thin interface over Vercel Workflows so the
 * workflow logic stays provider-agnostic. Default implementation uses
 * Vercel's `workflow` npm package, whose model is: any exported async
 * function becomes durable; calls to `sleep` and `fetch` (imported
 * from `workflow`) survive worker death and resume on restart.
 *
 * If Workflows breaks or gets pulled, swap the default impl for
 * InngestProvider or TemporalProvider in this one file; the workflow
 * functions themselves keep working against the same interface.
 *
 * Two abstractions baked in:
 *   1) sleep(durationMs) — durable sleep. Workflows handles via the
 *      package's own sleep primitive. Stub falls back to setTimeout
 *      (does NOT survive worker death — for unit tests only).
 *   2) step(name, fn) — checkpoints a step's result. Workflows
 *      provides durability via its internal step tracking; we wrap
 *      with a stable name so logs + idempotency keys are derivable.
 */

import { sleep as workflowSleep } from "workflow";

export type StepFn<T> = () => Promise<T>;

export type OrchestrationProvider = {
  /** Durable sleep across worker restarts. */
  sleep(durationMs: number): Promise<void>;
  /**
   * Run a named step. With Workflows, the SDK records the step's
   * result internally; on restart, completed steps return their
   * cached value instead of re-executing. The Stub impl emulates
   * this with an in-memory map (process-local, not durable).
   */
  step<T>(name: string, fn: StepFn<T>): Promise<T>;
  /** Workflow-level id for logging + idempotency-key derivation. */
  workflowId: string;
};

/**
 * Vercel Workflows-backed provider.
 *
 * The Workflows SDK's model is that any exported async function
 * becomes durable when it imports `sleep` / `fetch` from the package.
 * This provider wraps those primitives in our interface so workflow
 * logic doesn't import directly from `workflow`.
 *
 * The step() function here does NOT add durability on top of what
 * Workflows already gives you — it just provides a named-checkpoint
 * convention so logs and idempotency keys derive from stable names
 * rather than from line numbers.
 */
export class WorkflowsProvider implements OrchestrationProvider {
  constructor(public workflowId: string) {}

  async sleep(durationMs: number): Promise<void> {
    await workflowSleep(durationMs);
  }

  async step<T>(name: string, fn: StepFn<T>): Promise<T> {
    // Workflows tracks step results internally based on its own
    // mechanism (the SDK observes calls to its primitives like fetch
    // and sleep). For non-network steps we run the function directly;
    // if it makes a durable fetch call inside, Workflows handles
    // resumption. The `name` parameter is captured for our own logs
    // and for deriving idempotency keys.
    void name;
    return fn();
  }
}

/**
 * Stub provider for unit tests and the "what if Workflows breaks"
 * fallback. Sleeps via setTimeout (does NOT survive worker death).
 * Steps execute via an in-memory result cache keyed by step name —
 * within a single process, retries of the same step name return the
 * original value. Useful for verifying workflow logic in isolation;
 * not safe for prod.
 */
export class StubProvider implements OrchestrationProvider {
  private cache = new Map<string, unknown>();

  constructor(public workflowId: string) {}

  async sleep(durationMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  async step<T>(name: string, fn: StepFn<T>): Promise<T> {
    if (this.cache.has(name)) {
      return this.cache.get(name) as T;
    }
    const result = await fn();
    this.cache.set(name, result);
    return result;
  }
}

/**
 * Helper that derives a stable idempotency key for an external call
 * inside a step. Stripe (and most idempotency-aware APIs) accept
 * arbitrary strings up to ~255 chars; this format is human-readable
 * for debugging and stable across retries of the same step.
 */
export function idempotencyKey(
  workflowId: string,
  stepName: string,
  extra?: string,
): string {
  const parts = [workflowId, stepName];
  if (extra) parts.push(extra);
  return parts.join(":");
}
