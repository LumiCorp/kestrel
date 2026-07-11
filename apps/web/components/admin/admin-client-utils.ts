"use client";

export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

export function formatErrorMessage(
  error: unknown,
  fallback = "Request failed"
) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}
