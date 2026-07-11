import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

interface DotEnvLoadOptions {
  preferDotEnvKeys?: string[] | undefined;
}

export async function loadShellAndDotEnv(
  cwd = process.cwd(),
  options?: DotEnvLoadOptions,
): Promise<void> {
  if (process.env.KESTREL_DISABLE_DOTENV === "1") {
    return;
  }

  const envPath = path.join(cwd, ".env");

  try {
    await access(envPath, constants.F_OK);
  } catch {
    return;
  }

  const raw = await readFile(envPath, "utf8");
  const parsed = parseDotEnv(raw);
  const preferDotEnv = new Set(options?.preferDotEnvKeys ?? []);

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] !== undefined && preferDotEnv.has(key) === false) {
      continue;
    }

    process.env[key] = value;
  }
}

export function parseDotEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const equals = trimmed.indexOf("=");
    if (equals <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equals).trim();
    const rawValue = trimmed.slice(equals + 1).trim();

    if (key.length === 0) {
      continue;
    }

    values[key] = unquote(rawValue);
  }

  return values;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
