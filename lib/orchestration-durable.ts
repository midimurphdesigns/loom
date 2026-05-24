/**
 * DurableStubProvider — an OrchestrationProvider that persists step
 * results to Upstash, the way Vercel Workflows persists internally.
 *
 * Why this exists separately from StubProvider: StubProvider's cache
 * is process-local. Kill the process and the cache is gone — the
 * workflow restarts from scratch on resume. Real durable execution
 * persists step results to an external store so a fresh worker can
 * read them and resume from the point of death.
 *
 * The Vercel `workflow` SDK does this internally with its own
 * managed store. DurableStubProvider does it with Upstash so we can:
 *   1. Run a failure-injection test harness locally without the
 *      Workflows runtime (the harness needs to be able to simulate
 *      process death).
 *   2. Demonstrate the durability mechanism mechanically — anyone
 *      reading lib/orchestration-durable.ts can see exactly which
 *      keys get written, when, and how resume reads them.
 *
 * Production uses the Workflows runtime directly via WorkflowsProvider.
 * DurableStubProvider exists for the failure-injection harness only —
 * it lets the harness inspect persisted step state at arbitrary points
 * so it can simulate crash-between-execute-and-record without bringing
 * up a real Workflows runtime.
 */

import { Redis } from "@upstash/redis";
import {
  type OrchestrationProvider,
  type StepFn,
} from "@/lib/orchestration";

const HAS_UPSTASH = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const redis = HAS_UPSTASH ? Redis.fromEnv() : null;

const STEP_TTL_SECONDS = 60 * 60 * 24; // 1 day

const stepKey = (workflowId: string, stepName: string) =>
  `loom:workflow:${workflowId}:step:${stepName}`;

const sleepKey = (workflowId: string, durationMs: number) =>
  `loom:workflow:${workflowId}:sleep:${durationMs}`;

export class DurableStubProvider implements OrchestrationProvider {
  constructor(public workflowId: string) {}

  async sleep(durationMs: number): Promise<void> {
    // Durable sleep: once the sleep completes, mark a sentinel in
    // Upstash. On resume, if the sentinel exists, skip the wait
    // entirely. (Vercel Workflows handles this internally; we
    // approximate the visible behavior.)
    if (redis) {
      const completed = await redis.get<string>(sleepKey(this.workflowId, durationMs));
      if (completed) return;
    }
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    if (redis) {
      await redis.set(sleepKey(this.workflowId, durationMs), "1", {
        ex: STEP_TTL_SECONDS,
      });
    }
  }

  async step<T>(name: string, fn: StepFn<T>): Promise<T> {
    if (redis) {
      const cached = await redis.get<string | T>(stepKey(this.workflowId, name));
      if (cached !== null && cached !== undefined) {
        return typeof cached === "string" ? (JSON.parse(cached) as T) : cached;
      }
    }
    const result = await fn();
    if (redis) {
      await redis.set(stepKey(this.workflowId, name), JSON.stringify(result), {
        ex: STEP_TTL_SECONDS,
      });
    }
    return result;
  }
}

/**
 * Clear all durable state for a workflow id. Used by the failure-
 * injection harness to reset between trials, and by the production
 * cleanup path after a workflow completes.
 */
export async function clearDurableWorkflowState(
  workflowId: string,
): Promise<void> {
  if (!redis) return;
  // SCAN by prefix — Upstash supports redis.scan with MATCH.
  let cursor: string | number = 0;
  do {
    const [next, keys] = (await redis.scan(cursor, {
      match: `loom:workflow:${workflowId}:*`,
      count: 100,
    })) as [string | number, string[]];
    if (keys.length > 0) {
      await redis.del(...(keys as [string, ...string[]]));
    }
    cursor = next;
  } while (cursor !== 0 && cursor !== "0");
}
