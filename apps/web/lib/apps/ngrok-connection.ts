import type { CreateEnvironmentAppConnectionInput } from "./contracts";

export const NGROK_VALIDATION_PENDING = "NGROK_GATEWAY_VALIDATION_PENDING";

export async function validateNgrokConnection(
  input: CreateEnvironmentAppConnectionInput
) {
  if (input.kind !== "ngrok_agent") {
    throw new Error("Ngrok requires an agent credential.");
  }
  return {
    status: "degraded" as const,
    checkedAt: new Date(),
    failureCode: NGROK_VALIDATION_PENDING,
    failureMessage:
      "The Environment gateway has not validated this wildcard endpoint yet.",
  };
}
