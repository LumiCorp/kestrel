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
      attachment("image", Buffer.from([0x89, 0x50, 0x4e, 0x47])),
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
    assert.deepEqual(await readFile(image.path), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  } finally {
    await prepared.cleanup();
  }
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
