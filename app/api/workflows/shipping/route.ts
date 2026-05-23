/**
 * Shipping monitor workflow trigger.
 *
 * POST body:
 *   { orderId?: string, failCarrierB?: boolean }
 *
 * orderId auto-generated if absent. failCarrierB defaults to false;
 * set true via the demo UI to see saga compensation roll back the
 * carrier-A booking after carrier-B's simulated failure.
 */

import { randomUUID } from "node:crypto";
import { StubProvider } from "@/lib/orchestration";
import {
  runShippingMonitor,
  type ShippingMonitorInput,
} from "@/lib/workflows/shipping-monitor";

export const runtime = "nodejs";
export const maxDuration = 30;

type Body = Partial<ShippingMonitorInput>;

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Body;
  const input: ShippingMonitorInput = {
    orderId: body.orderId ?? `order_${randomUUID().slice(0, 8)}`,
    failCarrierB: body.failCarrierB ?? false,
  };

  const workflowId = `wf_ship_${randomUUID().slice(0, 8)}`;
  const provider = new StubProvider(workflowId);

  try {
    const result = await runShippingMonitor(provider, input);
    return Response.json({ workflowId, orderId: input.orderId, ...result });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return Response.json(
      { outcome: "failed_no_rollback", reason },
      { status: 500 },
    );
  }
}
