import {
  decryptDesktopCredential,
  encryptDesktopCredential,
  generateDesktopCredentialEncryptionKeyPair,
  normalizeDesktopCredentialEncryptionPublicKey,
  type DesktopCredentialEnvelope,
} from "./desktop-credential-envelope.js";

export type ConnectorCredentialEnvelope = DesktopCredentialEnvelope;

export const generateConnectorCredentialEncryptionKeyPair =
  generateDesktopCredentialEncryptionKeyPair;

export function normalizeConnectorCredentialEncryptionPublicKey(value: string) {
  try {
    return normalizeDesktopCredentialEncryptionPublicKey(value);
  } catch {
    throw new Error("Connector credential encryption key must be X25519.");
  }
}

export function connectorCredentialEnvelopeContext(requestId: string) {
  return `kestrel-infrastructure-connector-enrollment-v1\n${requestId}`;
}

export function encryptConnectorCredential<T>(input: {
  value: T;
  recipientPublicKey: string;
  requestId: string;
}) {
  return encryptDesktopCredential({
    value: input.value,
    recipientPublicKey: input.recipientPublicKey,
    context: connectorCredentialEnvelopeContext(input.requestId),
  });
}

export function decryptConnectorCredential<T>(input: {
  envelope: ConnectorCredentialEnvelope;
  recipientPrivateKey: string;
  requestId: string;
}) {
  return decryptDesktopCredential<T>({
    envelope: input.envelope,
    recipientPrivateKey: input.recipientPrivateKey,
    context: connectorCredentialEnvelopeContext(input.requestId),
  });
}

export function connectorCommandEnvelopeContext(commandId: string) {
  return `kestrel-infrastructure-connector-command-v1\n${commandId}`;
}

export function encryptConnectorCommandSecrets<T>(input: {
  value: T;
  recipientPublicKey: string;
  commandId: string;
}) {
  return encryptDesktopCredential({
    value: input.value,
    recipientPublicKey: input.recipientPublicKey,
    context: connectorCommandEnvelopeContext(input.commandId),
  });
}

export function decryptConnectorCommandSecrets<T>(input: {
  envelope: ConnectorCredentialEnvelope;
  recipientPrivateKey: string;
  commandId: string;
}) {
  return decryptDesktopCredential<T>({
    envelope: input.envelope,
    recipientPrivateKey: input.recipientPrivateKey,
    context: connectorCommandEnvelopeContext(input.commandId),
  });
}

export function serializeConnectorCommandSecrets(
  envelope: ConnectorCredentialEnvelope,
) {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function parseConnectorCommandSecrets(value: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Connector command secrets envelope is invalid.");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Connector command secrets envelope is invalid.");
  }
  const envelope = decoded as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (
    keys.join(",") !==
      "authTag,ciphertext,ephemeralPublicKey,iv,version" ||
    envelope.version !== 1 ||
    typeof envelope.ephemeralPublicKey !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.authTag !== "string" ||
    !/^[A-Za-z0-9_-]{16}$/u.test(envelope.iv) ||
    !/^[A-Za-z0-9_-]+$/u.test(envelope.ciphertext) ||
    !/^[A-Za-z0-9_-]{22}$/u.test(envelope.authTag)
  ) {
    throw new Error("Connector command secrets envelope is invalid.");
  }
  normalizeConnectorCredentialEncryptionPublicKey(envelope.ephemeralPublicKey);
  return envelope as ConnectorCredentialEnvelope;
}
