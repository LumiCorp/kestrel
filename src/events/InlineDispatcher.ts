import type { OutboxEventRecord } from "../kestrel/contracts/store.js";

export interface RuntimeEventDispatcher {
  dispatch(event: OutboxEventRecord): Promise<void>;
}

export class NoopRuntimeEventDispatcher implements RuntimeEventDispatcher {
  async dispatch(_event: OutboxEventRecord): Promise<void> {
    return Promise.resolve();
  }
}
