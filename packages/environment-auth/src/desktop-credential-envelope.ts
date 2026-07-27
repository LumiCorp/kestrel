import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

export const DESKTOP_CREDENTIAL_ENVELOPE_VERSION = 1 as const;

export type DesktopCredentialEnvelope = {
  version: typeof DESKTOP_CREDENTIAL_ENVELOPE_VERSION;
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
  authTag: string;
};

export function generateDesktopCredentialEncryptionKeyPair() {
  return generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

export function normalizeDesktopCredentialEncryptionPublicKey(value: string) {
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== "x25519") {
    throw new Error("Desktop credential encryption key must be X25519.");
  }
  return key.export({ type: "spki", format: "pem" }).toString();
}

export function encryptDesktopCredential<T>(input: {
  value: T;
  recipientPublicKey: string;
  context: string;
}): DesktopCredentialEnvelope {
  const recipientPublicKey = createPublicKey(input.recipientPublicKey);
  if (recipientPublicKey.asymmetricKeyType !== "x25519") {
    throw new Error("Desktop credential encryption key must be X25519.");
  }
  const ephemeral = generateKeyPairSync("x25519");
  const key = deriveKey(
    diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: recipientPublicKey,
    }),
    input.context,
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(input.context));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(input.value), "utf8"),
    cipher.final(),
  ]);
  return {
    version: DESKTOP_CREDENTIAL_ENVELOPE_VERSION,
    ephemeralPublicKey: ephemeral.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptDesktopCredential<T>(input: {
  envelope: DesktopCredentialEnvelope;
  recipientPrivateKey: string;
  context: string;
}): T {
  if (input.envelope.version !== DESKTOP_CREDENTIAL_ENVELOPE_VERSION) {
    throw new Error("Desktop credential envelope version is invalid.");
  }
  const privateKey = createPrivateKey(input.recipientPrivateKey);
  const ephemeralPublicKey = createPublicKey(
    input.envelope.ephemeralPublicKey,
  );
  if (
    privateKey.asymmetricKeyType !== "x25519" ||
    ephemeralPublicKey.asymmetricKeyType !== "x25519"
  ) {
    throw new Error("Desktop credential envelope key is invalid.");
  }
  const key = deriveKey(
    diffieHellman({ privateKey, publicKey: ephemeralPublicKey }),
    input.context,
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(input.envelope.iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(input.context));
  decipher.setAuthTag(Buffer.from(input.envelope.authTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(input.envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function desktopCredentialEnvelopeContext(input: {
  organizationId: string;
  environmentId: string;
  connectionId: string;
  runId: string;
}) {
  return [
    "kestrel-desktop-model-grant-v1",
    input.organizationId,
    input.environmentId,
    input.connectionId,
    input.runId,
  ].join("\n");
}

function deriveKey(sharedSecret: Buffer, context: string) {
  return Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.alloc(0),
      Buffer.from(context),
      32,
    ),
  );
}
