import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
  const current = await readLocalCoreLocalSettings(homePath);
  await writeLocalCoreLocalSettings(homePath, {
    ...current,
    ...patch,
  });
}

export async function writeLocalCoreLocalSettings(
  homePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  const filePath = localSettingsPath(homePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function localSettingsPath(homePath: string): string {
  return path.join(homePath, "settings", "local-core-settings.json");
}
