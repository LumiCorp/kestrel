import type {
  ConsoleReporter,
  ProgressReporter,
  ReasoningReporter,
  RunLogger,
} from "../kestrel/contracts/execution.js";
import type {
  ProgressUpdateV1,
  ModelReasoningUpdateV1,
  ReasoningUpdateV1,
  RunConsoleUpdateV1,
  RunLogEntry,
} from "../kestrel/contracts/events.js";
import type { EventStore } from "../kestrel/contracts/store.js";

export class StructuredRunLogger implements RunLogger {
  private readonly store: EventStore;

  constructor(store: EventStore) {
    this.store = store;
  }

  async info(entry: Omit<RunLogEntry, "level">): Promise<void> {
    await this.store.appendRunLog({ ...entry, level: "INFO" });
  }

  async warn(entry: Omit<RunLogEntry, "level">): Promise<void> {
    await this.store.appendRunLog({ ...entry, level: "WARN" });
  }

  async error(entry: Omit<RunLogEntry, "level">): Promise<void> {
    await this.store.appendRunLog({ ...entry, level: "ERROR" });
  }
}

export type RunLogListener = (entry: RunLogEntry) => void | Promise<void>;

export class FanoutRunLogger implements RunLogger {
  private readonly primary: RunLogger;
  private readonly listener: RunLogListener;

  constructor(primary: RunLogger, listener: RunLogListener) {
    this.primary = primary;
    this.listener = listener;
  }

  async info(entry: Omit<RunLogEntry, "level">): Promise<void> {
    await this.primary.info(entry);
    await this.notify({ ...entry, level: "INFO" });
  }

  async warn(entry: Omit<RunLogEntry, "level">): Promise<void> {
    await this.primary.warn(entry);
    await this.notify({ ...entry, level: "WARN" });
  }

  async error(entry: Omit<RunLogEntry, "level">): Promise<void> {
    await this.primary.error(entry);
    await this.notify({ ...entry, level: "ERROR" });
  }

  async notify(entry: RunLogEntry): Promise<void> {
    try {
      await this.listener(entry);
    } catch {
      // Listener errors should not fail runtime execution.
    }
  }

}

export class NoopProgressReporter implements ProgressReporter {
  async emit(): Promise<void> {
    // No-op by default.
  }
}

export type ProgressListener = (update: ProgressUpdateV1) => void | Promise<void>;

export class FanoutProgressReporter implements ProgressReporter {
  private readonly primary: ProgressReporter;
  private readonly listener: ProgressListener;

  constructor(primary: ProgressReporter, listener: ProgressListener) {
    this.primary = primary;
    this.listener = listener;
  }

  async emit(update: ProgressUpdateV1): Promise<void> {
    await this.primary.emit(update);
    try {
      await this.listener(update);
    } catch {
      // Listener errors should not fail runtime execution.
    }
  }
}

export class NoopConsoleReporter implements ConsoleReporter {
  async emit(): Promise<void> {
    // No-op by default.
  }
}

export type ConsoleListener = (update: RunConsoleUpdateV1) => void | Promise<void>;

export class FanoutConsoleReporter implements ConsoleReporter {
  private readonly primary: ConsoleReporter;
  private readonly listener: ConsoleListener;

  constructor(primary: ConsoleReporter, listener: ConsoleListener) {
    this.primary = primary;
    this.listener = listener;
  }

  async emit(update: RunConsoleUpdateV1): Promise<void> {
    await this.primary.emit(update);
    try {
      await this.listener(update);
    } catch {
      // Listener errors should not fail runtime execution.
    }
  }
}

export class NoopReasoningReporter implements ReasoningReporter {
  async emit(): Promise<void> {
    // No-op by default.
  }
}

export type ReasoningListener = (update: ReasoningUpdateV1 | ModelReasoningUpdateV1) => void | Promise<void>;

export class FanoutReasoningReporter implements ReasoningReporter {
  private readonly primary: ReasoningReporter;
  private readonly listener: ReasoningListener;

  constructor(primary: ReasoningReporter, listener: ReasoningListener) {
    this.primary = primary;
    this.listener = listener;
  }

  async emit(update: ReasoningUpdateV1 | ModelReasoningUpdateV1): Promise<void> {
    await this.primary.emit(update);
    try {
      const delivery = this.listener(update);
      if (delivery !== undefined) {
        void Promise.resolve(delivery).catch(() => {
          // Live reasoning delivery is best-effort and must not delay inference.
        });
      }
    } catch {
      // Listener errors should not fail runtime execution.
    }
  }
}
