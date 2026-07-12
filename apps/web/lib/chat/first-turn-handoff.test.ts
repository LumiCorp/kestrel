import assert from "node:assert/strict";
import test from "node:test";
import type { ChatFirstTurnHandoff } from "@/lib/types";
import {
  clearChatFirstTurnHandoff,
  readChatFirstTurnHandoff,
  writeChatFirstTurnHandoff,
} from "./first-turn-handoff";

class MemorySessionStorage {
  private store = new Map<string, string>();

  getItem(key: string) {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.store.set(key, value);
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

const sessionStorageMock = new MemorySessionStorage();
const originalWindow = globalThis.window;
const originalSessionStorage = globalThis.sessionStorage;
const originalDateNow = Date.now;

function buildRecord(): ChatFirstTurnHandoff {
  return {
    threadId: "chat-1",
    messageId: "message-1",
    messageParts: [
      {
        type: "file",
        url: "https://example.com/report.txt",
        filename: "report.txt",
        mediaType: "text/plain",
      },
      {
        type: "text",
        text: "Review this file",
      },
    ],
    modelId: "chat-model-1",
    createdAt: 1_700_000_000_000,
    pendingAssistant: true,
  };
}

test.beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: sessionStorageMock,
  });
  sessionStorageMock.clear();
  Date.now = () => 1_700_000_000_000;
});

test.afterEach(() => {
  if (originalWindow === undefined) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: undefined,
    });
  } else {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }

  if (originalSessionStorage === undefined) {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: undefined,
    });
  } else {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: originalSessionStorage,
    });
  }

  Date.now = originalDateNow;
});

test("first-turn handoff round-trips exact message parts", () => {
  const record = buildRecord();

  writeChatFirstTurnHandoff(record);

  assert.deepEqual(readChatFirstTurnHandoff(record.threadId), record);
});

test("first-turn handoff expires after the ttl", () => {
  const record = buildRecord();

  writeChatFirstTurnHandoff(record);
  Date.now = () => record.createdAt + 60_001;

  assert.equal(readChatFirstTurnHandoff(record.threadId), null);
});

test("first-turn handoff rejects invalid payloads", () => {
  sessionStorageMock.setItem(
    "chat:first-turn:chat-1",
    JSON.stringify({
      threadId: "chat-1",
      messageId: "message-1",
      messageParts: [{ text: "missing type" }],
      modelId: "chat-model-1",
      createdAt: 1_700_000_000_000,
      pendingAssistant: true,
    })
  );

  assert.equal(readChatFirstTurnHandoff("chat-1"), null);
});

test("first-turn handoff clears by chat id", () => {
  const record = buildRecord();

  writeChatFirstTurnHandoff(record);
  clearChatFirstTurnHandoff(record.threadId);

  assert.equal(readChatFirstTurnHandoff(record.threadId), null);
});
