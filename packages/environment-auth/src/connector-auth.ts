import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";

export const CONNECTOR_ENROLLMENT_TTL_MS = 10 * 60_000;
export const CONNECTOR_REQUEST_SKEW_SECONDS = 60;
export const CONNECTOR_NONCE_TTL_MS = 5 * 60_000;
export const CONNECTOR_CREDENTIAL_ROTATION_MS = 12 * 60 * 60_000;
export const CONNECTOR_PREVIOUS_CREDENTIAL_GRACE_MS = 5 * 60_000;
export const CONNECTOR_COMMAND_LEASE_SECONDS = 90;

export function normalizeConnectorSigningPublicKey(value: string) {
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    const pem = key.export({ type: "spki", format: "pem" }).toString();
    const der = key.export({ type: "spki", format: "der" });
    return {
      pem,
      fingerprint: createHash("sha256").update(der).digest("hex"),
    };
  } catch {
    throw new Error("Connector signing public key must be Ed25519.");
  }
}

export function hashConnectorSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

export function connectorSecretMatches(secret: string, expectedHash: string) {
  const actual = Buffer.from(hashConnectorSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createConnectorRequestNonce() {
  return randomBytes(24).toString("base64url");
}

export function buildConnectorRequestSigningInput(input: {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  bodyText: string;
}) {
  if (!input.path.startsWith("/") || input.path.includes("\n")) {
    throw new Error("Connector request path must be an absolute HTTP path.");
  }
  return [
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    input.nonce,
    createHash("sha256").update(input.bodyText).digest("hex"),
  ].join("\n");
}

export function signConnectorRequest(input: {
  privateKey: string;
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  bodyText: string;
}) {
  const key = createPrivateKey(input.privateKey);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Connector signing private key must be Ed25519.");
  }
  return sign(null, Buffer.from(buildConnectorRequestSigningInput(input)), key)
    .toString("base64url");
}

export function verifyConnectorRequestSignature(input: {
  publicKey: string;
  signature: string;
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  bodyText: string;
}) {
  try {
    return verify(
      null,
      Buffer.from(buildConnectorRequestSigningInput(input)),
      createPublicKey(input.publicKey),
      Buffer.from(input.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export function connectorTimestampIsCurrent(input: {
  timestamp: number;
  nowSeconds?: number | undefined;
  skewSeconds?: number | undefined;
}) {
  return (
    Number.isInteger(input.timestamp) &&
    Math.abs((input.nowSeconds ?? Math.floor(Date.now() / 1000)) - input.timestamp) <=
      (input.skewSeconds ?? CONNECTOR_REQUEST_SKEW_SECONDS)
  );
}
