export type AppProviderHealthTransition = "degraded" | "healthy" | "unchanged";

export function appProviderHealthTransition(input: {
  status: number;
  degradedStatusCodes: readonly number[];
}): AppProviderHealthTransition {
  if (input.degradedStatusCodes.includes(input.status)) return "degraded";
  if (input.status >= 200 && input.status <= 299) return "healthy";
  return "unchanged";
}
