import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function encryptWorkspaceBackup(archive: Buffer, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(archive), cipher.final()]);
  return Buffer.concat([
    Buffer.from("KWB1"),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

export function decryptWorkspaceBackup(encrypted: Buffer, key: Buffer) {
  if (encrypted.subarray(0, 4).toString("utf8") !== "KWB1") {
    throw new Error("Workspace backup envelope is invalid.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    encrypted.subarray(4, 16)
  );
  decipher.setAuthTag(encrypted.subarray(16, 32));
  return Buffer.concat([
    decipher.update(encrypted.subarray(32)),
    decipher.final(),
  ]);
}
