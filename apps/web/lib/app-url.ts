export const KESTREL_APP_ORIGIN = "https://kestrelagents.dev";

type AppUrlEnvironment = Record<string, string | undefined> & {
  BETTER_AUTH_URL?: string;
  NEXT_PUBLIC_APP_URL?: string;
  VERCEL?: string;
  VERCEL_ENV?: string;
  VERCEL_URL?: string;
};

export function resolveKestrelAppUrl(
  environment: AppUrlEnvironment = process.env
): string {
  if (environment.VERCEL_ENV === "production") {
    return KESTREL_APP_ORIGIN;
  }

  return (
    environment.NEXT_PUBLIC_APP_URL?.trim() ||
    environment.BETTER_AUTH_URL?.trim() ||
    (environment.VERCEL === "1" && environment.VERCEL_URL
      ? `https://${environment.VERCEL_URL}`
      : "http://localhost:43103")
  );
}
