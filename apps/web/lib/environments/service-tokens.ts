import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SERVICE_TOKEN_BYTES = 32;

export function createEnvironmentServiceToken() {
  return randomBytes(SERVICE_TOKEN_BYTES).toString("base64url");
}

export function hashEnvironmentServiceToken(token: string) {
  return createHash("sha256").update(requireToken(token), "utf8").digest("base64url");
}

export function verifyEnvironmentServiceToken(input: {
  token: string;
  expectedHash: string;
}) {
  const supplied = Buffer.from(hashEnvironmentServiceToken(input.token), "utf8");
  const expected = Buffer.from(input.expectedHash, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requireToken(token: string) {
  const normalized = token.trim();
  if (!normalized) throw new Error("Environment service token is required.");
  return normalized;
}
