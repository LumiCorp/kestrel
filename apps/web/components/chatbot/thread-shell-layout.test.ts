import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

function readWebSource(relativePath: string) {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}

contractTest(
  "web.hermetic",
  "the Thread shell owns one viewport and only its transcript scrolls",
  () => {
    const workspaceLayout = readWebSource("app/(workspace)/layout.tsx");
    const workspaceRail = readWebSource("components/workspace-rail.tsx");
    const chat = readWebSource("components/chatbot/chat.tsx");
    const messages = readWebSource("components/chatbot/messages.tsx");

    assert.match(
      workspaceLayout,
      /className="h-dvh overflow-hidden"[\s\S]*className="min-h-0 overflow-hidden"/
    );
    assert.match(
      workspaceLayout,
      /className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto"/
    );
    assert.match(
      workspaceRail,
      /className="hidden h-full min-h-0 w-72 shrink-0 flex-col/
    );
    assert.match(
      chat,
      /className="overscroll-behavior-contain flex h-full min-h-0 min-w-0 touch-pan-y flex-col overflow-hidden bg-background"/
    );
    assert.match(
      messages,
      /className="relative min-h-0 flex-1 overflow-hidden bg-background"/
    );
  }
);
