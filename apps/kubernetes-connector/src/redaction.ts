const SENSITIVE_KEY = /(?:authorization|token|secret|privatekey|password|credential|data|stringdata)/iu;

export function redactConnectorValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConnectorValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : redactConnectorValue(child),
      ]),
    );
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
      .replace(/authorization\s*[:=]\s*\S+/giu, "authorization=[redacted]");
  }
  return value;
}

export function connectorLog(
  level: "info" | "warn" | "error",
  event: string,
  detail: Record<string, unknown> = {},
) {
  const line = JSON.stringify({
    level,
    event,
    ...redactConnectorValue(detail) as Record<string, unknown>,
    at: new Date().toISOString(),
  });
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}
