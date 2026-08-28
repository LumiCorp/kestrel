import { resolveKestrelAppUrl } from "@/lib/app-url";
import { prepareResendWebhookCreateIntent } from "./receiving-provider";

export class ReceivingWebhookTargetError extends Error {
  constructor(
    readonly code:
      | "RESEND_RECEIVING_PUBLIC_WEBHOOK_URL_REQUIRED"
      | "RESEND_RECEIVING_WEBHOOK_URL_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ReceivingWebhookTargetError";
  }
}

export function requiresReceivingWebhookOverride(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isLoopbackUrl(resolveKestrelAppUrl(env));
}

export function resolveReceivingWebhookBaseUrl(input: {
  requestedBaseUrl?: string | undefined;
  env?: NodeJS.ProcessEnv;
}): string {
  const configuredAppUrl = resolveKestrelAppUrl(input.env);
  const requestedBaseUrl = input.requestedBaseUrl?.trim();
  if (requestedBaseUrl) {
    if (!isLoopbackUrl(configuredAppUrl)) {
      throw new ReceivingWebhookTargetError(
        "RESEND_RECEIVING_WEBHOOK_URL_INVALID",
        "Hosted inbound email uses the configured Kestrel application URL.",
      );
    }
    return normalizePublicWebhookBaseUrl(requestedBaseUrl);
  }
  if (isLoopbackUrl(configuredAppUrl)) {
    throw new ReceivingWebhookTargetError(
      "RESEND_RECEIVING_PUBLIC_WEBHOOK_URL_REQUIRED",
      "Paste a public HTTPS tunnel URL for local inbound email.",
    );
  }
  return normalizePublicWebhookBaseUrl(configuredAppUrl);
}

export function prepareReceivingWebhookIntent(input: {
  routeLocator: string;
  requestedBaseUrl?: string | undefined;
  env?: NodeJS.ProcessEnv;
}) {
  return prepareResendWebhookCreateIntent(
    new URL(
      `/api/webhooks/resend/inbound/${encodeURIComponent(input.routeLocator)}`,
      resolveReceivingWebhookBaseUrl(input),
    ).toString(),
  );
}

function normalizePublicWebhookBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidWebhookUrl();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    isLoopbackHostname(url.hostname)
  ) {
    throw invalidWebhookUrl();
  }
  return url.origin;
}

function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function invalidWebhookUrl() {
  return new ReceivingWebhookTargetError(
    "RESEND_RECEIVING_WEBHOOK_URL_INVALID",
    "Enter a public HTTPS origin with no path, query, or fragment.",
  );
}
