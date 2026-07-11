import type { Outbox } from "../kestrel/contracts/execution.js";
import type { OutboxStore } from "../kestrel/contracts/store.js";
import type { RuntimeEventDispatcher } from "./InlineDispatcher.js";

export class InlineOutbox implements Outbox {
  private readonly store: OutboxStore;
  private readonly dispatcher: RuntimeEventDispatcher;

  constructor(store: OutboxStore, dispatcher: RuntimeEventDispatcher) {
    this.store = store;
    this.dispatcher = dispatcher;
  }

  async dispatchInline(runId: string): Promise<void> {
    const pending = await this.store.listUndeliveredOutbox(100, runId);
    const deliveredIds: number[] = [];
    const failed: Array<{ id: number; error: string }> = [];
    for (const event of pending) {
      try {
        await this.dispatcher.dispatch(event);
        deliveredIds.push(event.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Outbox dispatch failed";
        failed.push({ id: event.id, error: message });
      }
    }

    await this.store.markOutboxDeliveredBatch(deliveredIds);
    await this.store.markOutboxAttemptFailedBatch(failed);
  }
}
