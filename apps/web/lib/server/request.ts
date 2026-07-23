import { headers } from "next/headers";
import { resolveKestrelAppUrl } from "@/lib/app-url";

export async function getRequestOrigin() {
  const headerStore = await headers();
  const explicitOrigin = headerStore.get("origin");

  if (explicitOrigin) {
    return explicitOrigin;
  }

  const host =
    headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? null;
  const proto =
    headerStore.get("x-forwarded-proto") ??
    (host?.includes("localhost") || host?.startsWith("127.0.0.1")
      ? "http"
      : "https");

  if (host) {
    return `${proto}://${host}`;
  }

  return resolveKestrelAppUrl(process.env);
}
