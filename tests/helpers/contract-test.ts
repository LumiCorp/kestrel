import { appendFileSync } from "node:fs";
import test, { type TestFn, type TestOptions } from "node:test";

type ContractId = string | readonly string[];

export function contractTest(contractId: ContractId, name: string, fn: TestFn): Promise<void>;
export function contractTest(contractId: ContractId, name: string, options: TestOptions, fn: TestFn): Promise<void>;
export function contractTest(contractId: ContractId, ...args: [string, TestFn] | [string, TestOptions, TestFn]): Promise<void> {
  const ids = normalizeIds(contractId);
  const title = args[0];
  const file = callerFile();
  const values = [...args] as [string, TestFn] | [string, TestOptions, TestFn];
  const callbackIndex = values.length - 1;
  const callback = values[callbackIndex] as TestFn;
  const invoke = (context?: Parameters<TestFn>[0], done?: Parameters<TestFn>[1]) => {
    const startedAt = performance.now();
    const result = callback(context!, done!);
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).finally(() => record(ids, title, file, performance.now() - startedAt));
    }
    record(ids, title, file, performance.now() - startedAt);
    return result;
  };
  values[callbackIndex] = (callback.length === 0
    ? function measured() { return invoke(); }
    : callback.length === 1
      ? function measured(context) { return invoke(context); }
      : function measured(context, done) { return invoke(context, done); }) as TestFn;
  return (test as (...input: unknown[]) => Promise<void>)(...values);
}

function normalizeIds(contractId: ContractId): readonly string[] {
  const ids = typeof contractId === "string" ? [contractId] : contractId;
  if (ids.length === 0 || ids.some((id) => !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(id))) {
    throw new Error(`Invalid validation contract id: ${ids.join(", ")}`);
  }
  return ids;
}

function record(ids: readonly string[], testTitle: string, testFile: string | undefined, durationMs: number): void {
  const file = process.env.KESTREL_CONTRACT_TIMINGS;
  if (!file) return;
  for (const contractId of ids) appendFileSync(file, `${JSON.stringify({ contractId, testFile, testTitle, durationMs })}\n`);
}

function callerFile(): string | undefined {
  const stack = new Error().stack;
  const match = stack?.match(/(?:\(|\s)((?:file:\/\/)?\/[^)\s]+\.(?:test|spec)\.[cm]?[jt]sx?):\d+:\d+/u);
  return match?.[1];
}
