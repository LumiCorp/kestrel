import { parentPort } from "node:worker_threads";

import { extractAttachmentText } from "./index.js";

const port = parentPort;
if (port === null) throw new Error("Attachment processor worker requires a parent port.");

port.once("message", async (message: unknown) => {
  try {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      throw new Error("Attachment processor worker input is invalid.");
    }
    const input = message as Record<string, unknown>;
    if (
      !(input.buffer instanceof Uint8Array)
      || typeof input.filename !== "string"
      || typeof input.mediaType !== "string"
      || (input.maxTextBytes !== undefined && typeof input.maxTextBytes !== "number")
    ) {
      throw new Error("Attachment processor worker input is invalid.");
    }
    const result = await extractAttachmentText({
      buffer: Buffer.from(input.buffer),
      filename: input.filename,
      mediaType: input.mediaType,
      ...(typeof input.maxTextBytes === "number" ? { maxTextBytes: input.maxTextBytes } : {}),
    });
    port.postMessage({ ok: true, result });
  } catch (error) {
    port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
