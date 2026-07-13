import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ReplayDoctorReport, ReplayQuery } from "../../src/replay/RunReplayService.js";
import {
  buildRuntimeReplayBundle,
  type RuntimeReplayBundleV1,
} from "../../src/replay/RuntimeReplayBundle.js";
import type { SessionStore } from "../../src/kestrel/contracts/store.js";

export { buildRuntimeReplayBundle, type RuntimeReplayBundleV1 };

export async function writeRuntimeReplayBundle(
  store: SessionStore,
  query: ReplayQuery,
  outPath: string,
): Promise<RuntimeReplayBundleV1> {
  const { bundle } = await buildRuntimeReplayBundle(store, query);
  const target = resolve(process.cwd(), outPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return bundle;
}

export async function writeDoctorReport(
  store: SessionStore,
  query: ReplayQuery,
  outPath: string,
): Promise<ReplayDoctorReport> {
  const { doctor } = await buildRuntimeReplayBundle(store, query);
  const target = resolve(process.cwd(), outPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(doctor, null, 2)}\n`, "utf8");
  return doctor;
}
