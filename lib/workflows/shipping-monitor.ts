/**
 * Shipping monitor workflow with saga compensation.
 *
 * The saga pattern (per docs/ARCHITECTURE.md): multi-step flows pair
 * each "do" step with a "compensate" step that undoes it. If a later
 * step fails, the saga runs compensations in reverse order to roll
 * back partial work.
 *
 * Flow for the demo:
 *   1. Book shipment with carrier-A (idempotent at the receiver)
 *   2. Try to book with carrier-B for redundancy or failover
 *   3. If step 2 fails: COMPENSATE step 1 by cancelling the carrier-A
 *      booking, return outcome: rolled_back
 *   4. If step 2 succeeds: return outcome: completed with both bookings
 *
 * Crucial idempotency-key discipline: the BOOK keys and CANCEL keys
 * must use different stepNames so that the cancel doesn't return the
 * booking's cached response. Real-world bug: reusing keys across
 * different operations silently returns wrong cached values.
 *
 * Real-world saga shape: in production this would be carrier-A is the
 * primary, carrier-B is a fallback that only gets booked if A is
 * delayed. Demo simplifies to "book both, roll back on B failure" so
 * the saga is observable in one click.
 */

import { idempotencyKey, type OrchestrationProvider } from "@/lib/orchestration";
import {
  bookShipment,
  cancelShipment,
  CarrierFailureError,
  type BookingRecord,
  type CancellationRecord,
} from "@/lib/carrier";

export type ShippingMonitorInput = {
  orderId: string;
  /** When true, carrier-B's bookShipment throws — triggers the
   *  compensation path. The demo UI toggles this so visitors can
   *  watch the saga roll back. */
  failCarrierB?: boolean;
};

export type ShippingMonitorResult =
  | {
      outcome: "completed";
      carrierABooking: BookingRecord;
      carrierBBooking: BookingRecord;
      stepsExecuted: string[];
    }
  | {
      outcome: "rolled_back";
      carrierABooking: BookingRecord;
      carrierACancellation: CancellationRecord;
      failedCarrier: "carrier-b";
      failureReason: string;
      stepsExecuted: string[];
      compensationsExecuted: string[];
    }
  | {
      outcome: "failed_no_rollback";
      reason: string;
      stepsExecuted: string[];
    };

export async function runShippingMonitor(
  provider: OrchestrationProvider,
  input: ShippingMonitorInput,
): Promise<ShippingMonitorResult> {
  const stepsExecuted: string[] = [];

  // FORWARD STEP 1: book carrier-A.
  const carrierABooking = await provider.step("book_carrier_a", async () => {
    return bookShipment({
      orderId: input.orderId,
      carrier: "carrier-a",
      idempotencyKey: idempotencyKey(provider.workflowId, "book_carrier_a"),
    });
  });
  stepsExecuted.push("book_carrier_a");

  // FORWARD STEP 2: book carrier-B. May fail per the input flag.
  let carrierBBooking: BookingRecord;
  try {
    carrierBBooking = await provider.step("book_carrier_b", async () => {
      return bookShipment({
        orderId: input.orderId,
        carrier: "carrier-b",
        idempotencyKey: idempotencyKey(provider.workflowId, "book_carrier_b"),
        simulateFailure: input.failCarrierB ?? false,
      });
    });
    stepsExecuted.push("book_carrier_b");
  } catch (err) {
    // SAGA COMPENSATION PATH. carrier-B failed; roll back carrier-A.
    const reason =
      err instanceof CarrierFailureError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);

    const compensationsExecuted: string[] = [];

    // Cancel carrier-A. The cancel uses a DIFFERENT idempotency key
    // from the original booking — same workflowId but a distinct
    // stepName ("cancel_carrier_a") so the receiver doesn't return
    // the cached booking response by mistake.
    const carrierACancellation = await provider.step(
      "cancel_carrier_a",
      async () => {
        return cancelShipment({
          booking: carrierABooking,
          idempotencyKey: idempotencyKey(
            provider.workflowId,
            "cancel_carrier_a",
          ),
        });
      },
    );
    compensationsExecuted.push("cancel_carrier_a");

    console.log(
      `[shipping-monitor] ROLLED BACK workflow=${provider.workflowId} carrierA=${carrierABooking.bookingId} reason="${reason}"`,
    );

    return {
      outcome: "rolled_back",
      carrierABooking,
      carrierACancellation,
      failedCarrier: "carrier-b",
      failureReason: reason,
      stepsExecuted,
      compensationsExecuted,
    };
  }

  // Both forward steps completed. Saga not invoked.
  return {
    outcome: "completed",
    carrierABooking,
    carrierBBooking,
    stepsExecuted,
  };
}
