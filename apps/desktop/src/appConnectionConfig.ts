import { existsSync, readFileSync } from "node:fs";

export interface DesktopPublicAppConnectionConfig {
  version: 1;
  publicClientIds: Record<string, string>;
}

export function parseDesktopPublicAppConnectionConfig(
  value: unknown,
): DesktopPublicAppConnectionConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Desktop public App configuration must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== "version" && key !== "publicClientIds",
    ) ||
    record.version !== 1 ||
    typeof record.publicClientIds !== "object" ||
    record.publicClientIds === null ||
    Array.isArray(record.publicClientIds)
  ) {
    throw new Error("Desktop public App configuration is invalid.");
  }
  const publicClientIds: Record<string, string> = {};
  for (const [appId, clientId] of Object.entries(
    record.publicClientIds as Record<string, unknown>,
  )) {
    if (
      /^[a-zA-Z0-9._-]+$/u.test(appId) === false ||
      typeof clientId !== "string" ||
      clientId.trim() !== clientId ||
      clientId.length === 0 ||
      clientId.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(clientId)
    ) {
      throw new Error("Desktop public App client identity is invalid.");
    }
    publicClientIds[appId] = clientId;
  }
  return { version: 1, publicClientIds };
}

export function resolveDesktopPublicAppClientId(input: {
  appId: string;
  environmentVariable?: string | undefined;
  env?: Readonly<NodeJS.ProcessEnv> | undefined;
  configPath?: string | undefined;
}): string | undefined {
  const environmentValue = input.environmentVariable
    ? input.env?.[input.environmentVariable]?.trim()
    : undefined;
  if (environmentValue) return environmentValue;
  if (!input.configPath || existsSync(input.configPath) === false) return;
  const parsed = parseDesktopPublicAppConnectionConfig(
    JSON.parse(readFileSync(input.configPath, "utf8")),
  );
  return parsed.publicClientIds[input.appId];
}
