import { parseRunnerEventV2 } from "@kestrel-agents/protocol";

import type { RunnerEvent } from "../../cli/protocol/contracts.js";
import type { LocalCoreClient } from "./client.js";
import {
  LocalCoreRuntimeBindingError,
  type LocalRuntimeBindingReleaseV1,
  type LocalCoreRuntimeBindingStore,
} from "./runtimeBindings.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;

type RuntimeReleasedEvent = Extract<RunnerEvent, { type: "runtime.released" }>;

export interface LocalCoreRuntimeBindingReleaseWorkerOptions {
  runtimeBindings(): LocalCoreRuntimeBindingStore | undefined;
  runnerClient: Pick<LocalCoreClient, "sendRunnerCommand">;
  pollIntervalMs?: number | undefined;
  retryDelayMs?: number | undefined;
  now?: (() => Date) | undefined;
  deliver?:
    | ((
        release: LocalRuntimeBindingReleaseV1,
        signal: AbortSignal,
      ) => Promise<RuntimeReleasedEvent>)
    | undefined;
}

/**
 * Drains Local Core's durable native-cleanup outbox through the same Runner
 * command endpoint used by normal Desktop execution. It owns no Runtime
 * credentials and can safely repeat a binding-scoped release after a crash.
 */
export class LocalCoreRuntimeBindingReleaseWorker {
  readonly #runtimeBindings: LocalCoreRuntimeBindingReleaseWorkerOptions["runtimeBindings"];
  readonly #runnerClient: Pick<LocalCoreClient, "sendRunnerCommand">;
  readonly #pollIntervalMs: number;
  readonly #retryDelayMs: number;
  readonly #now: () => Date;
  readonly #deliver: NonNullable<LocalCoreRuntimeBindingReleaseWorkerOptions["deliver"]>;

  #timer: NodeJS.Timeout | undefined;
  #activeDrain: Promise<void> | undefined;
  #activeDelivery: AbortController | undefined;
  #closed = false;
  #wakeRequested = false;

  constructor(options: LocalCoreRuntimeBindingReleaseWorkerOptions) {
    this.#runtimeBindings = options.runtimeBindings;
    this.#runnerClient = options.runnerClient;
    this.#pollIntervalMs = positiveDuration(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.#retryDelayMs = positiveDuration(
      options.retryDelayMs,
      DEFAULT_RETRY_DELAY_MS,
      "retryDelayMs",
    );
    this.#now = options.now ?? (() => new Date());
    this.#deliver = options.deliver ?? ((release, signal) =>
      deliverLocalRuntimeBindingRelease(this.#runnerClient, release, signal));
  }

  start(): void {
    if (this.#closed || this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.wake().catch(() => {});
    }, this.#pollIntervalMs);
    this.#timer.unref();
    void this.wake().catch(() => {});
  }

  async wake(): Promise<void> {
    if (this.#closed) return;
    if (this.#activeDrain !== undefined) {
      this.#wakeRequested = true;
      return await this.#activeDrain;
    }
    const drain = this.#drain();
    this.#activeDrain = drain;
    try {
      await drain;
    } finally {
      if (this.#activeDrain === drain) this.#activeDrain = undefined;
      if (this.#wakeRequested && !this.#closed) {
        this.#wakeRequested = false;
        void this.wake().catch(() => {});
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      await this.#activeDrain;
      return;
    }
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#activeDelivery?.abort();
    await this.#activeDrain;
  }

  async #drain(): Promise<void> {
    while (!this.#closed) {
      const runtimeBindings = this.#runtimeBindings();
      if (runtimeBindings === undefined) return;
      const retryBefore = new Date(this.#now().getTime() - this.#retryDelayMs);
      const release = await runtimeBindings.claimRuntimeBindingRelease({
        retryBefore,
      });
      if (release === undefined) return;

      const delivery = new AbortController();
      this.#activeDelivery = delivery;
      try {
        const event = await this.#deliver(release, delivery.signal);
        await runtimeBindings.completeRuntimeBindingRelease({
          releaseId: release.id,
          eventId: event.id,
          commandId: event.commandId ?? "",
          bindingId: event.payload.bindingId,
          participantId: event.payload.participantId,
          canonicalThreadId: event.payload.threadId,
          runtimeId: requireForeignRuntimeId(event.payload.runtimeId),
          environmentId: event.payload.environmentId,
        });
      } catch (error) {
        if (this.#closed && isAbortError(error)) return;
        await runtimeBindings.failRuntimeBindingRelease(
          release.id,
          releaseFailureCode(error),
        ).catch(() => {
          // A matching durable event may have completed the row before the
          // transport reported failure. The next drain re-reads authority.
        });
        return;
      } finally {
        if (this.#activeDelivery === delivery) this.#activeDelivery = undefined;
      }
    }
  }
}

export async function deliverLocalRuntimeBindingRelease(
  client: Pick<LocalCoreClient, "sendRunnerCommand">,
  release: LocalRuntimeBindingReleaseV1,
  signal: AbortSignal,
): Promise<RuntimeReleasedEvent> {
  const command = JSON.stringify({
    version: "runner_command_v2",
    id: release.id,
    type: "runtime.release",
    metadata: {
      actor: {
        actorId: "local-core-runtime-release-worker",
        actorType: "service",
      },
    },
    payload: {
      runtimeId: release.runtimeId,
      bindingId: release.bindingId,
      participantId: release.participantId,
      threadId: release.canonicalThreadId,
      environmentId: release.environmentId,
    },
  });
  let acknowledged: RuntimeReleasedEvent | undefined;
  let failure: RunnerEvent | undefined;
  await client.sendRunnerCommand(command, {
    signal,
    onLine(line) {
      const event = parseRunnerEventV2(JSON.parse(line) as unknown) as RunnerEvent;
      if (event.commandId !== release.id) return;
      if (event.type === "runtime.released") acknowledged = event;
      if (event.type === "runner.error") failure = event;
    },
  });
  if (acknowledged !== undefined) {
    assertReleasedEventMatches(release, acknowledged);
    return acknowledged;
  }
  if (failure?.type === "runner.error") {
    throw new LocalRuntimeReleaseDeliveryError(failure.payload.code);
  }
  throw new LocalRuntimeReleaseDeliveryError("RUNTIME_RELEASE_ACKNOWLEDGEMENT_MISSING");
}

class LocalRuntimeReleaseDeliveryError extends Error {
  constructor(readonly code: string) {
    super("Local Core Runtime release delivery failed.");
    this.name = "LocalRuntimeReleaseDeliveryError";
  }
}

function assertReleasedEventMatches(
  release: LocalRuntimeBindingReleaseV1,
  event: RuntimeReleasedEvent,
): void {
  if (
    event.commandId !== release.id ||
    event.payload.runtimeId !== release.runtimeId ||
    event.payload.bindingId !== release.bindingId ||
    event.payload.participantId !== release.participantId ||
    event.payload.threadId !== release.canonicalThreadId ||
    event.payload.environmentId !== release.environmentId
  ) {
    throw new LocalCoreRuntimeBindingError(
      "RUNTIME_RELEASE_CORRELATION_INVALID",
      "The Runner release acknowledgement does not match the durable cleanup job.",
    );
  }
}

function requireForeignRuntimeId(
  runtimeId: RuntimeReleasedEvent["payload"]["runtimeId"],
): "codex" | "claude" {
  if (runtimeId !== "codex" && runtimeId !== "claude") {
    throw new LocalCoreRuntimeBindingError(
      "RUNTIME_RELEASE_CORRELATION_INVALID",
      "The local release outbox cannot acknowledge Kestrel cleanup.",
    );
  }
  return runtimeId;
}

function releaseFailureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "RUNTIME_RELEASE_DELIVERY_FAILED";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function positiveDuration(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return resolved;
}
