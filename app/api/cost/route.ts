import { BUDGET_CAP_USD, getTodaySpend } from "@/lib/cost";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const spent = await getTodaySpend();
  return Response.json({
    capUsd: BUDGET_CAP_USD,
    spentUsd: spent,
    remainingUsd: Math.max(0, BUDGET_CAP_USD - spent),
    overCap: spent >= BUDGET_CAP_USD,
  });
}
