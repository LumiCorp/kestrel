import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const localSettingsMutationTails = new Map<string, Promise<void>>();

export interface LocalCoreLocalSettingsMutation<T> {
  settings: Record<string, unknown>;
  result: T;
}

export async function readLocalCoreLocalSettings(
  homePath: string,
): Promise<Record<string, unknown>> {
  const filePath = localSettingsPath(homePath);
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray(parsed) === false
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function patchLocalCoreLocalSettings(
  homePath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await mutateLocalCoreLocalSettings(homePath, (current) => ({
    settings: { ...current, ...patch },
    result: undefined,
  }));
}

/**
 * Runs one process-scoped settings mutation against the latest durable value.
 * Every Local Core settings writer uses this boundary so callers cannot lose a
 * concurrent Browser authority change through a stale read-modify-write.
 */
export async function mutateLocalCoreLocalSettings<T>(
  homePath: string,
  mutate: (
    current: Record<string, unknown>,
  ) =>
    | LocalCoreLocalSettingsMutation<T>
    | Promise<LocalCoreLocalSettingsMutation<T>>,
): Promise<T> {
  const filePath = localSettingsPath(homePath);
  return await withLocalSettingsMutation(filePath, async () => {
    const current = await readLocalCoreLocalSettings(homePath);
    const mutation = await mutate(current);
    if (mutation.settings !== current) {
      await writeLocalCoreLocalSettingsFile(filePath, mutation.settings);
    }
    return mutation.result;
  });
}

export async function writeLocalCoreLocalSettings(
  homePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  const filePath = localSettingsPath(homePath);
  await withLocalSettingsMutation(filePath, async () => {
    await writeLocalCoreLocalSettingsFile(filePath, value);
  });
}

async function writeLocalCoreLocalSettingsFile(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function localSettingsPath(homePath: string): string {
  return path.resolve(homePath, "settings", "local-core-settings.json");
}

async function withLocalSettingsMutation<T>(
  filePath: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = localSettingsMutationTails.get(filePath) ?? Promise.resolve();
  const result = previous.then(action, action);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  localSettingsMutationTails.set(filePath, tail);
  void tail.finally(() => {
    if (localSettingsMutationTails.get(filePath) === tail) {
      localSettingsMutationTails.delete(filePath);
    }
  });
  return await result;
}
