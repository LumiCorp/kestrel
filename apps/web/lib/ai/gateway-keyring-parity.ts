import { createHash } from "node:crypto";

export type GatewayKeyringSummary = {
  activeKeyId: string;
  configuredKeyIds: string[];
  keyringFingerprint: string;
};

export function summarizeGatewayKeyring(input: {
  activeKeyId: string;
  keys: string;
}): GatewayKeyringSummary {
  return {
    activeKeyId: input.activeKeyId,
    configuredKeyIds: Object.keys(JSON.parse(input.keys)).sort(),
    keyringFingerprint: createHash("sha256").update(input.keys).digest("hex"),
  };
}

export function assertGatewayKeyringParity(input: {
  canonical: GatewayKeyringSummary;
  worker: GatewayKeyringSummary;
}) {
  const { canonical, worker } = input;
  if (
    canonical.activeKeyId !== worker.activeKeyId ||
    canonical.keyringFingerprint !== worker.keyringFingerprint ||
    JSON.stringify(canonical.configuredKeyIds) !==
      JSON.stringify(worker.configuredKeyIds)
  ) {
    throw new Error(
      "Kestrel One worker gateway keyring does not match Vercel production.",
    );
  }
}
