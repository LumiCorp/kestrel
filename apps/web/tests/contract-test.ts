import { appendFileSync } from "node:fs";
import {
  test,
  type Page,
  type TestInfo,
} from "@playwright/test";

type ContractId = string | readonly string[];
type ProductFixtures = { page: Page };
type ProductBody = (fixtures: ProductFixtures, testInfo: TestInfo) => Promise<void> | void;

export function contractTest(contractId: ContractId, name: string, body: ProductBody): void {
  const ids = typeof contractId === "string" ? [contractId] : contractId;
  if (ids.length === 0 || ids.some((id) => !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(id))) {
    throw new Error(`Invalid validation contract id: ${ids.join(", ")}`);
  }
  const testFile = new Error().stack?.match(/(?:\(|\s)((?:file:\/\/)?\/[^)\s]+\.(?:test|spec)\.[cm]?[jt]sx?):\d+:\d+/u)?.[1];
  test(name, async ({ page }, testInfo) => {
    const startedAt = performance.now();
    try {
      await body({ page }, testInfo);
    } finally {
      const file = process.env.KESTREL_CONTRACT_TIMINGS;
      if (file) for (const id of ids) appendFileSync(file, `${JSON.stringify({ contractId: id, testFile, testTitle: name, durationMs: performance.now() - startedAt })}\n`);
    }
  });
}
