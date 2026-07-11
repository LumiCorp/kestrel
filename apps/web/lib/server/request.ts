import { headers } from "next/headers";

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

  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:43103";
}
