import {
  assertBudgetLedgerAppendOnly,
  createEmptyBudgetRepositoryState,
  parseBudgetRepositoryState,
  type BudgetRepositoryStateV1,
  type BudgetRepositoryTransactionResult,
  type BudgetRepositoryV1,
} from "./repository.js";

export class InMemoryBudgetRepository implements BudgetRepositoryV1 {
  private state: BudgetRepositoryStateV1;
  private tail: Promise<void> = Promise.resolve();

  constructor(initialState: BudgetRepositoryStateV1 = createEmptyBudgetRepositoryState()) {
    this.state = parseBudgetRepositoryState(structuredClone(initialState));
  }

  async transaction<T>(
    operation: (state: BudgetRepositoryStateV1) =>
      Promise<BudgetRepositoryTransactionResult<T>> | BudgetRepositoryTransactionResult<T>,
  ): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      const outcome = await operation(structuredClone(this.state));
      const next = parseBudgetRepositoryState(structuredClone(outcome.state));
      assertBudgetLedgerAppendOnly(this.state, next);
      this.state = next;
      return structuredClone(outcome.result);
    } finally {
      release();
    }
  }

  async read(): Promise<BudgetRepositoryStateV1> {
    await this.tail;
    return structuredClone(this.state);
  }
}
