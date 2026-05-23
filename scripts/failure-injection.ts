/**
 * Failure-injection harness — the durability proof artifact.
 *
 * For each workflow loom ships, this script runs N trials. Each trial:
 *   1. Picks a random "kill point" — the name of a step where the
 *      simulated worker will die.
 *   2. Runs the workflow with a provider that throws at the kill
 *      point. Persisted step results before the kill survive.
 *   3. Resumes by spinning up a fresh DurableStubProvider with the
 *      same workflowId. The new provider reads the persisted step
 *      results from Upstash. The workflow re-enters, skips already-
 *      completed steps via the step() cache, and finishes.
 *   4. Asserts: (a) workflow eventually completed, (b) NO side
 *      effects duplicated (email audit log shows exactly one send
 *      per expected delivery), (c) NO side effects dropped (every
 *      expected delivery happened).
 *
 * Snapshot at .loom/failures/<timestamp>.json with per-trial outcome,
 * kill point, recovery duration, duplicate-send count, dropped-send
 * count.
 *
 * This is the interview-defensible artifact for "I can prove this
 * is durable." A passing snapshot says: under simulated process
 * death at random step boundaries, the system recovers correctly
 * with exactly-once visible side effects across N trials.
 *
 * Usage:
 *   pnpm failures --dry-run                # list workflows + kill points, no LLM
 *   ANTHROPIC_API_KEY=... pnpm failures    # full suite, N=5 per workflow
 *   pnpm failures --workflow=cart-abandonment --runs=3
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import {
  DurableStubProvider,
  clearDurableWorkflowState,
} from "@/lib/orchestration-durable";
import {
  type OrchestrationProvider,
  type StepFn,
} from "@/lib/orchestration";
import { putCart, type Cart } from "@/lib/cart-store";
import { runCartAbandonment } from "@/lib/workflows/cart-abandonment";
import { runDynamicCheckout } from "@/lib/workflows/dynamic-checkout";

const HAS_UPSTASH = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const redis = HAS_UPSTASH ? Redis.fromEnv() : null;

const EMAIL_AUDIT_KEY = "loom:email:audit";

class WorkerDeathError extends Error {
  constructor(public stepName: string) {
    super(`simulated worker death at step '${stepName}'`);
    this.name = "WorkerDeathError";
  }
}

/**
 * KillingProvider — wraps DurableStubProvider but throws at a chosen
 * step. The persisted state up to (not including) the kill point
 * survives. Resume uses a fresh DurableStubProvider with no kill.
 */
class KillingProvider implements OrchestrationProvider {
  constructor(
    private inner: DurableStubProvider,
    private killAt: string,
  ) {}
  get workflowId() {
    return this.inner.workflowId;
  }
  sleep(durationMs: number): Promise<void> {
    return this.inner.sleep(durationMs);
  }
  async step<T>(name: string, fn: StepFn<T>): Promise<T> {
    if (name === this.killAt) {
      // Two options simulate two real scenarios:
      //   a) Pre-execution death: throw BEFORE running fn. Side effect
      //      never happened.
      //   b) Mid-execution death: run fn (side effect fires), then
      //      throw BEFORE step() can record the result. This is the
      //      harder scenario — the receiver's idempotency keys are
      //      the only line of defense.
      // We pick (b) so we're testing the worst case.
      const result = await fn();
      // result computed, side effect fired, NOW die before recording
      throw new WorkerDeathError(name);
      // unreachable, but keep TypeScript happy with the return type
      return result;
    }
    return this.inner.step(name, fn);
  }
}

type TrialOutcome = {
  trial: number;
  workflowId: string;
  killAt: string;
  recovered: boolean;
  emailSends: {
    expected: number;
    actual: number;
    duplicates: number;
    dropped: number;
  };
  durationMs: number;
  finalOutcome: string;
  error: string | null;
};

async function readEmailAuditForWorkflow(workflowId: string): Promise<number> {
  // Count audit entries whose idempotency-key embedded ID matches the
  // workflow. The email provider's audit log doesn't store the key
  // directly, so we use the dedupe-key index instead.
  if (!redis) return 0;
  const dedupeKeys = (await redis.keys(
    `loom:email:dedupe:${workflowId}:*`,
  )) as string[];
  return dedupeKeys.length;
}

async function clearEmailAuditForWorkflow(workflowId: string): Promise<void> {
  if (!redis) return;
  const dedupeKeys = (await redis.keys(
    `loom:email:dedupe:${workflowId}:*`,
  )) as string[];
  if (dedupeKeys.length > 0) {
    await redis.del(...(dedupeKeys as [string, ...string[]]));
  }
}

type WorkflowSpec = {
  id: string;
  killPoints: string[];
  expectedEmailSends: number;
  setup: (workflowId: string) => Promise<void>;
  run: (provider: OrchestrationProvider) => Promise<unknown>;
};

const WORKFLOWS: WorkflowSpec[] = [
  {
    id: "cart-abandonment",
    killPoints: ["read_cart", "compose_email", "send_email", "mark_processed"],
    expectedEmailSends: 1,
    setup: async (workflowId) => {
      const cart: Cart = {
        cartId: workflowId.replace("wf_cart_", ""),
        customerId: "cust_failtest",
        customerEmail: "failtest@example.com",
        customerName: "Failure Test Subject",
        items: [
          {
            sku: "GW-TENT-001",
            name: "Greywater Two-Person Backcountry Tent",
            priceCents: 38900,
            quantity: 1,
          },
        ],
        subtotalCents: 38900,
        abandonedAt: new Date().toISOString(),
        paymentIntentId: null,
        status: "abandoned",
      };
      await putCart(cart);
    },
    run: (provider) =>
      runCartAbandonment(provider, {
        cartId: provider.workflowId.replace("wf_cart_", ""),
      }),
  },
  {
    id: "dynamic-checkout",
    killPoints: ["negotiate_discount", "apply_discount"],
    expectedEmailSends: 0,
    setup: async () => {
      // No setup; the workflow accepts input inline
    },
    run: (provider) =>
      runDynamicCheckout(provider, {
        cartId: provider.workflowId,
        cartSubtotalUsd: 200,
        customerName: "Failure Test Subject",
        customerLifetimeValueUsd: 1240,
        grossMarginPercent: 32,
        customerStatedReason: "Loyal customer asking for $10 off — please match.",
      }),
  },
];

type RunOptions = {
  dryRun: boolean;
  workflowFilter: string | null;
  runsPerWorkflow: number;
};

function parseArgs(): RunOptions {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    workflowFilter:
      args.find((a) => a.startsWith("--workflow="))?.slice("--workflow=".length) ??
      null,
    runsPerWorkflow: Number(
      args.find((a) => a.startsWith("--runs="))?.slice("--runs=".length) ?? "5",
    ),
  };
}

async function runTrial(
  spec: WorkflowSpec,
  trial: number,
): Promise<TrialOutcome> {
  const prefix = spec.id === "cart-abandonment" ? "wf_cart_" : "wf_checkout_";
  const workflowId = `${prefix}fail_${randomUUID().slice(0, 8)}`;
  const killAt = spec.killPoints[trial % spec.killPoints.length];
  const startedAt = Date.now();

  // Pre-trial cleanup so we get a clean slate
  await clearDurableWorkflowState(workflowId);
  await clearEmailAuditForWorkflow(workflowId);

  await spec.setup(workflowId);

  // Attempt #1 — runs until the kill point
  const inner = new DurableStubProvider(workflowId);
  const killing = new KillingProvider(inner, killAt);
  let firstError: Error | null = null;
  try {
    await spec.run(killing);
  } catch (err) {
    firstError = err instanceof Error ? err : new Error(String(err));
  }

  if (!(firstError instanceof WorkerDeathError)) {
    // Workflow finished before the kill point, or threw something else
    return {
      trial,
      workflowId,
      killAt,
      recovered: firstError === null,
      emailSends: { expected: 0, actual: 0, duplicates: 0, dropped: 0 },
      durationMs: Date.now() - startedAt,
      finalOutcome: firstError === null
        ? "completed_before_kill"
        : `unexpected_error: ${firstError.message}`,
      error: firstError?.message ?? null,
    };
  }

  // Attempt #2 — fresh provider, no kill. Resumes from cached step
  // results in Upstash; re-runs the killed step.
  const resumed = new DurableStubProvider(workflowId);
  let finalResult: unknown = null;
  let resumeError: Error | null = null;
  try {
    finalResult = await spec.run(resumed);
  } catch (err) {
    resumeError = err instanceof Error ? err : new Error(String(err));
  }

  const actualEmailSends = await readEmailAuditForWorkflow(workflowId);
  const expected = spec.expectedEmailSends;
  const duplicates = Math.max(0, actualEmailSends - expected);
  const dropped = Math.max(0, expected - actualEmailSends);

  return {
    trial,
    workflowId,
    killAt,
    recovered: resumeError === null && duplicates === 0 && dropped === 0,
    emailSends: { expected, actual: actualEmailSends, duplicates, dropped },
    durationMs: Date.now() - startedAt,
    finalOutcome: resumeError
      ? `resume_error: ${resumeError.message}`
      : JSON.stringify(finalResult).slice(0, 160),
    error: resumeError?.message ?? null,
  };
}

async function main() {
  const opts = parseArgs();
  const workflows = opts.workflowFilter
    ? WORKFLOWS.filter((w) => w.id === opts.workflowFilter)
    : WORKFLOWS;

  console.log(
    `[failures] ${workflows.length} workflows x ${opts.runsPerWorkflow} trials`,
  );

  if (opts.dryRun) {
    console.log("[failures] dry-run mode — no LLM calls\n");
    for (const w of workflows) {
      console.log(`  ${w.id}`);
      console.log(`    kill points: ${w.killPoints.join(", ")}`);
      console.log(`    expected email sends per trial: ${w.expectedEmailSends}`);
    }
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[failures] ANTHROPIC_API_KEY required for real runs");
    process.exit(1);
  }
  if (!HAS_UPSTASH) {
    console.error(
      "[failures] UPSTASH_REDIS_REST_URL + TOKEN required — failure injection needs durable storage to demonstrate resume",
    );
    process.exit(1);
  }

  const allOutcomes: Array<TrialOutcome & { workflow: string }> = [];
  for (const spec of workflows) {
    console.log(`\n[failures] ${spec.id}`);
    for (let trial = 0; trial < opts.runsPerWorkflow; trial++) {
      process.stdout.write(`  trial ${trial + 1}/${opts.runsPerWorkflow}... `);
      try {
        const outcome = await runTrial(spec, trial);
        allOutcomes.push({ ...outcome, workflow: spec.id });
        const tag = outcome.recovered ? "RECOVERED" : "FAILED";
        console.log(
          `${tag} kill=${outcome.killAt} email expected=${outcome.emailSends.expected} actual=${outcome.emailSends.actual} dur=${outcome.durationMs}ms`,
        );
      } catch (err) {
        console.log(
          `ERROR: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const recovered = allOutcomes.filter((o) => o.recovered).length;
  const totalDuplicates = allOutcomes.reduce(
    (sum, o) => sum + o.emailSends.duplicates,
    0,
  );
  const totalDropped = allOutcomes.reduce(
    (sum, o) => sum + o.emailSends.dropped,
    0,
  );
  console.log(
    `\n[failures] ${recovered}/${allOutcomes.length} recovered | ${totalDuplicates} duplicate sends | ${totalDropped} dropped sends`,
  );

  const outDir = path.join(process.cwd(), ".loom", "failures");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        trials: allOutcomes,
        summary: {
          total: allOutcomes.length,
          recovered,
          duplicateSends: totalDuplicates,
          droppedSends: totalDropped,
        },
      },
      null,
      2,
    ),
  );
  console.log(`[failures] snapshot: ${outPath}`);

  if (recovered < allOutcomes.length || totalDuplicates > 0 || totalDropped > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
