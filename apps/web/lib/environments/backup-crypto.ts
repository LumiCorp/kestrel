import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type DecipherGCM,
} from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

const KWB1_HEADER_BYTES = 32;
const KWB2_HEADER_BYTES = 16;
const AUTH_TAG_BYTES = 16;

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
    encrypted.subarray(4, 16),
  );
  decipher.setAuthTag(encrypted.subarray(16, 32));
  return Buffer.concat([
    decipher.update(encrypted.subarray(32)),
    decipher.final(),
  ]);
}

export function createWorkspaceBackupEncryptionStream(key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let headerWritten = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        if (!headerWritten) {
          this.push(Buffer.concat([Buffer.from("KWB2"), iv]));
          headerWritten = true;
        }
        this.push(cipher.update(chunk));
        callback();
      } catch (error) {
        callback(asError(error));
      }
    },
    flush(callback) {
      try {
        if (!headerWritten) this.push(Buffer.concat([Buffer.from("KWB2"), iv]));
        this.push(cipher.final());
        this.push(cipher.getAuthTag());
        callback();
      } catch (error) {
        callback(asError(error));
      }
    },
  });
}

export function createWorkspaceBackupDecryptionStream(key: Buffer) {
  let header = Buffer.alloc(0);
  let trailing = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  let format: "KWB1" | "KWB2" | null = null;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        let input = Buffer.concat([header, chunk]);
        if (!format) {
          if (input.length < 4) {
            header = input;
            callback();
            return;
          }
          const magic = input.subarray(0, 4).toString("utf8");
          if (magic !== "KWB1" && magic !== "KWB2") {
            throw new Error("Workspace backup envelope is invalid.");
          }
          format = magic;
        }
        const requiredHeader =
          format === "KWB1" ? KWB1_HEADER_BYTES : KWB2_HEADER_BYTES;
        if (!decipher) {
          if (input.length < requiredHeader) {
            header = input;
            callback();
            return;
          }
          decipher = createDecipheriv(
            "aes-256-gcm",
            key,
            input.subarray(4, 16),
          ) as DecipherGCM;
          if (format === "KWB1") decipher.setAuthTag(input.subarray(16, 32));
          input = input.subarray(requiredHeader);
          header = Buffer.alloc(0);
        }
        if (format === "KWB2") {
          const buffered = Buffer.concat([trailing, input]);
          if (buffered.length <= AUTH_TAG_BYTES) {
            trailing = buffered;
          } else {
            this.push(decipher.update(buffered.subarray(0, -AUTH_TAG_BYTES)));
            trailing = buffered.subarray(-AUTH_TAG_BYTES);
          }
        } else {
          this.push(decipher.update(input));
        }
        callback();
      } catch (error) {
        callback(asError(error));
      }
    },
    flush(callback: TransformCallback) {
      try {
        if (!(decipher && format))
          throw new Error("Workspace backup envelope is incomplete.");
        if (format === "KWB2") {
          if (trailing.length !== AUTH_TAG_BYTES) {
            throw new Error("Workspace backup authentication tag is missing.");
          }
          decipher.setAuthTag(trailing);
        }
        this.push(decipher.final());
        callback();
      } catch (error) {
        callback(asError(error));
      }
    },
  });
}

function asError(error: unknown) {
  return error instanceof Error
    ? error
    : new Error("Workspace backup cryptography failed.");
}
