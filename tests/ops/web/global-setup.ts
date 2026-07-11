import { rmSync } from "node:fs";
import type { FullConfig } from "@playwright/test";

import { prepareOpsFixtures, resolveOpsTestDatabaseUrl } from "../helpers/database.js";

export default async function globalSetup(_config: FullConfig): Promise<void> {
  await prepareOpsFixtures(resolveOpsTestDatabaseUrl());
  rmSync("/tmp/kestrel-ops-web-profile.json", { force: true });
}
