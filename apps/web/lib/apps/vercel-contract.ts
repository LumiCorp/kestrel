class VercelRuntimeContractError extends Error {
  readonly status: number;

  constructor(readonly code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export const VERCEL_RUNTIME_CAPABILITIES = [
  "projects.read",
  "deployments.read",
  "operations.read",
] as const;

type VercelRuntimeCapability =
  (typeof VERCEL_RUNTIME_CAPABILITIES)[number];

export function assertVercelProxyTarget(input: {
  capability: VercelRuntimeCapability;
  method: string;
  path: string[];
}) {
  const expectedPath: Record<VercelRuntimeCapability, string> = {
    "projects.read": "projects",
    "deployments.read": "deployments",
    "operations.read": "deployment-events",
  };
  if (
    input.method === "POST" &&
    input.path.length === 1 &&
    input.path[0] === expectedPath[input.capability]
  ) {
    return;
  }
  throw new VercelRuntimeContractError("VERCEL_PROXY_TARGET_DENIED", 404);
}

export function createVercelApiUrl(input: {
  capability: VercelRuntimeCapability;
  body?: ArrayBuffer;
  teamId?: string;
}) {
  const body = parseBody(input.body);
  const url = new URL("https://api.vercel.com");
  if (input.capability === "projects.read") {
    assertOnlyKeys(body, ["limit", "search"]);
    url.pathname = "/v9/projects";
    appendBoundedInteger(url, body, "limit", 1, 100);
    appendBoundedString(url, body, "search", 256);
  } else if (input.capability === "deployments.read") {
    assertOnlyKeys(body, ["limit", "projectId", "state", "target"]);
    url.pathname = "/v6/deployments";
    appendBoundedInteger(url, body, "limit", 1, 100);
    appendBoundedString(url, body, "projectId", 256);
    appendEnum(url, body, "state", ["BUILDING", "ERROR", "INITIALIZING", "QUEUED", "READY", "CANCELED"]);
    appendEnum(url, body, "target", ["production", "preview"]);
  } else {
    assertOnlyKeys(body, ["deploymentId", "limit", "direction", "since", "until"]);
    const deploymentId = boundedString(body.deploymentId, "deploymentId", 512);
    url.pathname = `/v3/deployments/${encodeURIComponent(deploymentId)}/events`;
    appendBoundedInteger(url, body, "limit", 1, 1000);
    appendEnum(url, body, "direction", ["backward", "forward"]);
    appendBoundedInteger(url, body, "since", 0, Number.MAX_SAFE_INTEGER);
    appendBoundedInteger(url, body, "until", 0, Number.MAX_SAFE_INTEGER);
  }
  if (input.teamId) url.searchParams.set("teamId", input.teamId);
  return url;
}

function parseBody(body: ArrayBuffer | undefined): Record<string, unknown> {
  if (!body) return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Normalize all malformed input to the same provider-safe error.
  }
  throw new VercelRuntimeContractError("VERCEL_PROXY_PAYLOAD_INVALID");
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new VercelRuntimeContractError("VERCEL_PROXY_PAYLOAD_INVALID");
  }
}

function boundedString(value: unknown, key: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new VercelRuntimeContractError("VERCEL_PROXY_PAYLOAD_INVALID");
  }
  return value.trim();
}

function appendBoundedString(
  url: URL,
  body: Record<string, unknown>,
  key: string,
  maxLength: number
) {
  if (body[key] !== undefined) {
    url.searchParams.set(key, boundedString(body[key], key, maxLength));
  }
}

function appendBoundedInteger(
  url: URL,
  body: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
) {
  const value = body[key];
  if (value === undefined) return;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new VercelRuntimeContractError("VERCEL_PROXY_PAYLOAD_INVALID");
  }
  url.searchParams.set(key, String(value));
}

function appendEnum(
  url: URL,
  body: Record<string, unknown>,
  key: string,
  allowed: string[]
) {
  const value = body[key];
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new VercelRuntimeContractError("VERCEL_PROXY_PAYLOAD_INVALID");
  }
  url.searchParams.set(key, value);
}
