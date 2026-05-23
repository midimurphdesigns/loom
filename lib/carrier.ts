/**
 * Mock carrier API for the shipping-monitor saga.
 *
 * Two carriers exposed: 'carrier-a' (preferred) and 'carrier-b'
 * (fallback). Each supports:
 *   - bookShipment(orderId, idempotencyKey)
 *   - cancelShipment(bookingId, idempotencyKey)
 *
 * Both operations are idempotent at the receiver — same key returns
 * the cached result. This mirrors how real carrier APIs (FedEx, UPS,
 * Shippo) handle retries.
 *
 * Failure injection: the global LOOM_DEMO_FAIL_CARRIER_B flag (or a
 * per-call `simulateFailure` override) makes carrier-b throw on
 * bookShipment. That's the trigger for the saga to roll back the
 * carrier-a booking via compensation.
 *
 * State persists in Upstash so the saga can resume across worker
 * death.
 */

import { Redis } from "@upstash/redis";

const HAS_UPSTASH = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const redis = HAS_UPSTASH ? Redis.fromEnv() : null;

const memBookings = new Map<string, BookingRecord>();
const memCancellations = new Map<string, CancellationRecord>();

export type Carrier = "carrier-a" | "carrier-b";

export type BookingRecord = {
  bookingId: string;
  carrier: Carrier;
  orderId: string;
  trackingNumber: string;
  status: "booked" | "cancelled";
  createdAt: string;
};

export type CancellationRecord = {
  bookingId: string;
  cancelledAt: string;
};

const bookingKey = (key: string) => `loom:carrier:booking:${key}`;
const cancelKey = (key: string) => `loom:carrier:cancel:${key}`;
const TTL_SECONDS = 60 * 60 * 24 * 7;

export class CarrierFailureError extends Error {
  constructor(public carrier: Carrier, reason: string) {
    super(`carrier ${carrier} failed: ${reason}`);
    this.name = "CarrierFailureError";
  }
}

export type BookShipmentOptions = {
  orderId: string;
  carrier: Carrier;
  idempotencyKey: string;
  /** Override the env-level failure flag for a single call. */
  simulateFailure?: boolean;
};

export async function bookShipment(
  opts: BookShipmentOptions,
): Promise<BookingRecord> {
  // Receiver-side dedup — same key returns cached result without
  // re-creating the booking. Mirrors how real carriers handle retries.
  if (redis) {
    const prior = await redis.get<string | BookingRecord>(
      bookingKey(opts.idempotencyKey),
    );
    if (prior) {
      const record =
        typeof prior === "string" ? (JSON.parse(prior) as BookingRecord) : prior;
      console.log(
        `[carrier] DEDUPED booking key=${opts.idempotencyKey} carrier=${record.carrier}`,
      );
      return record;
    }
  } else if (memBookings.has(opts.idempotencyKey)) {
    return memBookings.get(opts.idempotencyKey)!;
  }

  // Failure injection (per-call override OR env flag for carrier-b)
  const envFailB =
    opts.carrier === "carrier-b" &&
    process.env.LOOM_DEMO_FAIL_CARRIER_B === "true";
  if (opts.simulateFailure || envFailB) {
    throw new CarrierFailureError(
      opts.carrier,
      "simulated upstream failure",
    );
  }

  const record: BookingRecord = {
    bookingId: `${opts.carrier}_${Math.random().toString(36).slice(2, 10)}`,
    carrier: opts.carrier,
    orderId: opts.orderId,
    trackingNumber: `${opts.carrier.toUpperCase()}-${Math.random()
      .toString(36)
      .slice(2, 10)
      .toUpperCase()}`,
    status: "booked",
    createdAt: new Date().toISOString(),
  };
  console.log(
    `[carrier] BOOKED ${record.bookingId} carrier=${opts.carrier} key=${opts.idempotencyKey}`,
  );
  if (redis) {
    await redis.set(bookingKey(opts.idempotencyKey), JSON.stringify(record), {
      ex: TTL_SECONDS,
    });
  } else {
    memBookings.set(opts.idempotencyKey, record);
  }
  return record;
}

export type CancelShipmentOptions = {
  booking: BookingRecord;
  idempotencyKey: string;
};

export async function cancelShipment(
  opts: CancelShipmentOptions,
): Promise<CancellationRecord> {
  // Receiver-side dedup on the cancellation key — IMPORTANT: this
  // key MUST be different from the booking's idempotency key.
  // Reusing the booking key would return the booking record from
  // cache instead of executing the cancellation. The saga MUST
  // derive cancel-keys from a different stepName.
  if (redis) {
    const prior = await redis.get<string | CancellationRecord>(
      cancelKey(opts.idempotencyKey),
    );
    if (prior) {
      const record =
        typeof prior === "string"
          ? (JSON.parse(prior) as CancellationRecord)
          : prior;
      console.log(
        `[carrier] DEDUPED cancel key=${opts.idempotencyKey} booking=${record.bookingId}`,
      );
      return record;
    }
  } else if (memCancellations.has(opts.idempotencyKey)) {
    return memCancellations.get(opts.idempotencyKey)!;
  }

  const record: CancellationRecord = {
    bookingId: opts.booking.bookingId,
    cancelledAt: new Date().toISOString(),
  };
  console.log(
    `[carrier] CANCELLED booking=${opts.booking.bookingId} key=${opts.idempotencyKey}`,
  );
  if (redis) {
    await redis.set(cancelKey(opts.idempotencyKey), JSON.stringify(record), {
      ex: TTL_SECONDS,
    });
  } else {
    memCancellations.set(opts.idempotencyKey, record);
  }
  return record;
}
