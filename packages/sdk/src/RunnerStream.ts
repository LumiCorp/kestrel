import type { RunnerStream } from "./contracts.js";

export class BufferedRunnerStream<TEvent, TTerminal>
  implements RunnerStream<TEvent, TTerminal>, AsyncIterator<TEvent>
{
  readonly result: Promise<TTerminal>;

  private readonly cancelImpl: () => Promise<void>;
  private readonly queue: TEvent[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<TEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  constructor(
    result: Promise<TTerminal>,
    cancelImpl: () => Promise<void>,
  ) {
    this.result = result;
    this.cancelImpl = cancelImpl;
    void result.catch((error) => {
      this.fail(error);
    });
  }

  push(event: TEvent): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  finish(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failure = undefined;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failure = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.reject(error);
    }
  }

  async cancel(): Promise<void> {
    await this.cancelImpl();
  }

  next(): Promise<IteratorResult<TEvent>> {
    if (this.queue.length > 0) {
      const value = this.queue.shift() as TEvent;
      return Promise.resolve({ value, done: false });
    }
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<TEvent>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<TEvent> {
    return this;
  }
}
