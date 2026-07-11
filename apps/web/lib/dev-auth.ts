function parseHost(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith("[") && trimmed.includes("]")) {
    return trimmed.slice(1, trimmed.indexOf("]"));
  }

  return trimmed.split(":")[0] ?? null;
}

export function isLocalHostname(hostname: string | null | undefined) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

export function isLocalDevAuthBypassEnabled(host?: string | null) {
  if (process.env.DEV_AUTH_BYPASS !== "true") {
    return false;
  }

  const resolvedHost =
    parseHost(host) ??
    parseHost(process.env.BETTER_AUTH_URL) ??
    parseHost(process.env.NEXT_PUBLIC_APP_URL);

  return isLocalHostname(resolvedHost);
}
