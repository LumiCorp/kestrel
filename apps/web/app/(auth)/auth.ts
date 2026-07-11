import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth as betterAuth } from "@/lib/auth";
import type { Session } from "@/lib/auth-types";

export type AuthSession = Session;
export type UserType = Session["user"] extends { type: infer T }
  ? T
  : "guest" | "regular";

const BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  (process.env.VERCEL && process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : undefined) ??
  "http://localhost:43103";

async function buildCookieHeader() {
  const cookieStore = await cookies();
  const cookieString = cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  return cookieString || undefined;
}

export async function auth(): Promise<Session | null> {
  try {
    return (await betterAuth.api.getSession({
      headers: await headers(),
    })) as Session | null;
  } catch {
    return null;
  }
}

export async function signOut({ redirectTo }: { redirectTo: string }) {
  "use server";

  const url = new URL("/api/auth/signout", BASE_URL);
  const headers: HeadersInit = {};
  const cookieHeader = await buildCookieHeader();
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  await fetch(url, {
    method: "POST",
    headers,
    cache: "no-store",
  });

  redirect(redirectTo);
}
