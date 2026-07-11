interface QueueCallbacks {
  onEnqueued?: ((meta: {
    queueDepthRun: number;
    queueDepthGlobal: number;
    aheadInRun: number;
    aheadGlobal: number;
  }) => void) | undefined;
  onDequeued?: ((meta: {
    queueDepthRun: number;
    queueDepthGlobal: number;
    queueWaitMs: number;
  }) => void) | undefined;
  onRetry?: ((meta: {
    attempt: number;
    maxAttempts: number;
    error: unknown;
  }) => void) | undefined;
}

export interface EnqueueToolJobInput<T> extends QueueCallbacks {
  runId: string;
  maxConcurrentPerRun: number;
  maxConcurrentGlobal: number;
  maxQueuedPerRun: number;
  maxQueuedGlobal?: number | undefined;
  retryCount: number;
  execute: () => Promise<T>;
  isRetryableError?: ((error: unknown) => boolean) | undefined;
  signal?: AbortSignal | undefined;
}

export interface EnqueueToolJobResult<T> {
  result: T;
  queueWaitMs: number;
  attempts: number;
  queueDepthRun: number;
  queueDepthGlobal: number;
}

interface PendingJob<T> extends QueueCallbacks {
  runId: string;
  maxConcurrentPerRun: number;
  maxConcurrentGlobal: number;
  retryCount: number;
  execute: () => Promise<T>;
  isRetryableError: (error: unknown) => boolean;
  signal?: AbortSignal | undefined;
  enqueuedAtMs: number;
  resolve: (value: EnqueueToolJobResult<T>) => void;
  reject: (reason: unknown) => void;
}

interface RunQueueState {
  active: number;
  pending: PendingJob<unknown>[];
}

export class ToolQueueOverflowError extends Error {
  readonly code = "TOOL_QUEUE_OVERFLOW";
  readonly details: Record<string, unknown>;

  constructor(
    message: string,
    details: Record<string, unknown>,
  ) {
    super(message);
    this.details = details;
  }
}

/**
 * In-process fair scheduler for tool calls across active runs.
 * Uses round-robin selection by run id, with per-run and global caps.
 */
export class ToolJobQueue {
  private readonly runs = new Map<string, RunQueueState>();
  private readonly runOrder: string[] = [];
  private activeGlobal = 0;
  private dispatching = false;
  private cursor = 0;

  enqueue<T>(input: EnqueueToolJobInput<T>): Promise<EnqueueToolJobResult<T>> {
    const run = this.ensureRun(input.runId);
    const aheadInRun = run.pending.length;
    const aheadGlobal = this.totalPending();

    if (aheadInRun >= this.ensurePositiveInt(input.maxQueuedPerRun, 1)) {
      const details = {
        runId: input.runId,
        queueDepthRun: aheadInRun,
        queueDepthGlobal: aheadGlobal,
        maxQueuedPerRun: input.maxQueuedPerRun,
      };
      throw new ToolQueueOverflowError(
        `Run queue overflow: maxQueuedToolJobsPerRun=${input.maxQueuedPerRun}`,
        details,
      );
    }
    if (aheadGlobal >= this.ensureNonNegativeInt(input.maxQueuedGlobal ?? Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) {
      const details = {
        runId: input.runId,
        queueDepthRun: aheadInRun,
        queueDepthGlobal: aheadGlobal,
        maxQueuedGlobal: input.maxQueuedGlobal,
      };
      throw new ToolQueueOverflowError(
        `Global tool queue overflow: maxQueuedToolJobsGlobal=${input.maxQueuedGlobal}`,
        details,
      );
    }

    return new Promise<EnqueueToolJobResult<T>>((resolve, reject) => {
      const job: PendingJob<T> = {
        runId: input.runId,
        maxConcurrentPerRun: this.ensurePositiveInt(input.maxConcurrentPerRun, 1),
        maxConcurrentGlobal: this.ensurePositiveInt(input.maxConcurrentGlobal, 1),
        retryCount: this.ensureNonNegativeInt(input.retryCount, 0),
        execute: input.execute,
        isRetryableError: input.isRetryableError ?? (() => false),
        signal: input.signal,
        enqueuedAtMs: Date.now(),
        resolve,
        reject,
        onEnqueued: input.onEnqueued,
        onDequeued: input.onDequeued,
        onRetry: input.onRetry,
      };

      run.pending.push(job as PendingJob<unknown>);
      input.onEnqueued?.({
        queueDepthRun: run.pending.length,
        queueDepthGlobal: this.totalPending(),
        aheadInRun,
        aheadGlobal,
      });
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.dispatching) {
      return;
    }

    this.dispatching = true;
    try {
      while (true) {
        const next = this.pickNextRunnableJob();
        if (next === undefined) {
          break;
        }

        this.activeGlobal += 1;
        next.run.active += 1;

        const queueWaitMs = Date.now() - next.job.enqueuedAtMs;
        next.job.onDequeued?.({
          queueDepthRun: next.run.pending.length,
          queueDepthGlobal: this.totalPending(),
          queueWaitMs,
        });

        void this.executeJob(next.runId, next.run, next.job, queueWaitMs);
      }
    } finally {
      this.dispatching = false;
    }
  }

  private async executeJob(
    runId: string,
    run: RunQueueState,
    job: PendingJob<unknown>,
    queueWaitMs: number,
  ): Promise<void> {
    let attempt = 0;
    const maxAttempts = job.retryCount + 1;
    try {
      while (true) {
        throwIfAborted(job.signal);
        try {
          const result = await job.execute();
          job.resolve({
            result,
            queueWaitMs,
            attempts: attempt + 1,
            queueDepthRun: run.pending.length,
            queueDepthGlobal: this.totalPending(),
          });
          return;
        } catch (error) {
          if (attempt >= job.retryCount || job.isRetryableError(error) === false) {
            job.reject(error);
            return;
          }
          attempt += 1;
          job.onRetry?.({
            attempt: attempt + 1,
            maxAttempts,
            error,
          });
          await sleep(resolveRetryDelayMs(attempt - 1), job.signal);
        }
      }
    } finally {
      run.active = Math.max(0, run.active - 1);
      this.activeGlobal = Math.max(0, this.activeGlobal - 1);
      this.cleanupRun(runId);
      this.dispatch();
    }
  }

  private pickNextRunnableJob():
    | {
        runId: string;
        run: RunQueueState;
        job: PendingJob<unknown>;
      }
    | undefined {
    if (this.runOrder.length === 0) {
      return undefined;
    }

    for (let i = 0; i < this.runOrder.length; i += 1) {
      const index = (this.cursor + i) % this.runOrder.length;
      const runId = this.runOrder[index]!;
      const run = this.runs.get(runId);
      if (run === undefined || run.pending.length === 0) {
        continue;
      }

      const job = run.pending[0]!;
      if (run.active >= job.maxConcurrentPerRun) {
        continue;
      }
      if (this.activeGlobal >= job.maxConcurrentGlobal) {
        continue;
      }

      run.pending.shift();
      this.cursor = (index + 1) % this.runOrder.length;
      return {
        runId,
        run,
        job,
      };
    }

    return undefined;
  }

  private ensureRun(runId: string): RunQueueState {
    const existing = this.runs.get(runId);
    if (existing !== undefined) {
      return existing;
    }

    const created: RunQueueState = {
      active: 0,
      pending: [],
    };
    this.runs.set(runId, created);
    this.runOrder.push(runId);
    if (this.runOrder.length > 1 && this.activeGlobal > 0) {
      this.cursor = this.runOrder.length - 1;
    }
    return created;
  }

  private cleanupRun(runId: string): void {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return;
    }

    if (run.active > 0 || run.pending.length > 0) {
      return;
    }

    this.runs.delete(runId);
    const index = this.runOrder.indexOf(runId);
    if (index >= 0) {
      this.runOrder.splice(index, 1);
      if (this.runOrder.length === 0) {
        this.cursor = 0;
      } else if (this.cursor >= this.runOrder.length) {
        this.cursor = 0;
      }
    }
  }

  private totalPending(): number {
    let total = 0;
    for (const run of this.runs.values()) {
      total += run.pending.length;
    }
    return total;
  }

  private ensurePositiveInt(value: number, fallback: number): number {
    if (!Number.isFinite(value) || value <= 0) {
      return fallback;
    }
    return Math.floor(value);
  }

  private ensureNonNegativeInt(value: number, fallback: number): number {
    if (!Number.isFinite(value) || value < 0) {
      return fallback;
    }
    return Math.floor(value);
  }
}

function resolveRetryDelayMs(attempt: number): number {
  const baseMs = 250;
  const maxMs = 4_000;
  const raw = Math.min(maxMs, baseMs * 2 ** attempt);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.floor(raw * jitter);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new Error("Tool execution cancelled"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Tool execution cancelled"));
      },
      { once: true },
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    const error = new Error("Tool execution cancelled") as Error & { code: string };
    error.code = "RUN_CANCELLED";
    throw error;
  }
}
