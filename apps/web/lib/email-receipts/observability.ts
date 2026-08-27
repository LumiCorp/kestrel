import "server-only";

export type EmailReceiptTelemetryEvent =
  | "hydration_started"
  | "admitted"
  | "rejected"
  | "failed"
  | "materialized"
  | "execution_routed"
  | "worker_reconciled";

const MAX_DURATION_MS = 60_000;
const MAX_QUEUE_LATENCY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Emits bounded, content-free lifecycle evidence. Telemetry must never alter
 * receipt admission, materialization, or durable dispatch behavior.
 */
export function recordEmailReceiptTelemetry(
  input: {
    event: EmailReceiptTelemetryEvent;
    receiptId?: string;
    durationMs?: number;
    queueLatencyMs?: number;
  },
  sink: (message: string, fields: Record<string, unknown>) => void =
    console.info,
) {
  try {
    sink("Kestrel One email receipt lifecycle.", {
      event: input.event,
      ...(input.receiptId ? { receiptId: input.receiptId } : {}),
      ...(input.durationMs === undefined
        ? {}
        : { durationMs: clampMetric(input.durationMs, MAX_DURATION_MS) }),
      ...(input.queueLatencyMs === undefined
        ? {}
        : {
            queueLatencyMs: clampMetric(
              input.queueLatencyMs,
              MAX_QUEUE_LATENCY_MS,
            ),
          }),
    });
  } catch {
    // Telemetry is secondary evidence and cannot replace lifecycle outcomes.
  }
}

function clampMetric(value: number, maximum: number) {
  return Math.min(maximum, Math.max(0, Math.round(value)));
}
