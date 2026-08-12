import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { claudePrompt, prepareCodexInput } from "../../src/runtimes/input.js";
import type { RuntimeTurnInput } from "../../src/runtime/RuntimeTurn.js";

function attachment(kind: "image" | "text", payload: Buffer) {
  return {
    attachmentId: `${kind}-1`,
    threadId: "thread-1",
    filename: kind === "image" ? "image.png" : "notes.txt",
    mimeType: kind === "image" ? "image/png" : "text/plain",
    sizeBytes: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
    kind,
    ...(kind === "image"
      ? { data: payload.toString("base64") }
      : { text: payload.toString("utf8") }),
  } as const;
}

function turn(): RuntimeTurnInput {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  return {
    sessionId: "thread-1",
    eventType: "user.message",
    message: "Continue",
    history: [
      { role: "user", text: "Remember alpha", timestamp: "2026-08-11T00:00:00.000Z" },
      { role: "assistant", text: "I remember alpha", timestamp: "2026-08-11T00:00:01.000Z" },
    ],
    attachments: [
      attachment("text", Buffer.from("text attachment")),
      attachment("image", png),
    ],
  };
}

test("Codex input preserves canonical history and verified attachments", async () => {
  const prepared = await prepareCodexInput(turn());
  try {
    assert.match(JSON.stringify(prepared.input), /Remember alpha/u);
    assert.match(JSON.stringify(prepared.input), /text attachment/u);
    const image = prepared.input.find((item) => item.type === "localImage");
    assert.ok(image?.type === "localImage");
    assert.deepEqual(
      await readFile(image.path),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
  } finally {
    await prepared.cleanup();
  }
});

test("adapter attachment defense rejects unsupported MIME and non-canonical base64", async () => {
  const unsupported = turn();
  unsupported.attachments![0] = {
    ...unsupported.attachments![0]!,
    mimeType: "application/octet-stream",
  };
  assert.throws(() => claudePrompt(unsupported), /unsupported MIME/u);

  const nonCanonical = turn();
  nonCanonical.attachments![1] = {
    ...nonCanonical.attachments![1]!,
    data: `${nonCanonical.attachments![1]!.data}\n`,
  };
  assert.throws(() => claudePrompt(nonCanonical), /canonical base64/u);
});

test("Claude input uses structured image content and rejects attachment tampering", async () => {
  const prompt = claudePrompt(turn());
  assert.equal(typeof prompt, "object");
  const messages = [];
  for await (const message of prompt as AsyncIterable<unknown>) messages.push(message);
  assert.match(JSON.stringify(messages), /base64/u);

  const invalid = turn();
  invalid.attachments![0] = { ...invalid.attachments![0]!, sha256: "0".repeat(64) };
  assert.throws(() => claudePrompt(invalid), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error &&
    error.code === "RUNTIME_ATTACHMENT_UNSUPPORTED");
});
