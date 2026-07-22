import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const route = fs.readFileSync(path.join(root, "app/api/threads/[id]/route.ts"), "utf8");
const page = fs.readFileSync(path.join(root, "app/(workspace)/threads/[id]/page.tsx"), "utf8");
const chat = fs.readFileSync(path.join(root, "components/chatbot/chat.tsx"), "utf8");
const turnStore = fs.readFileSync(path.join(root, "lib/turns/store.ts"), "utf8");
const worker = fs.readFileSync(path.join(root, "lib/turns/process-runtime.ts"), "utf8");

contractTest("web.hermetic", "task interaction mode is canonical across API, composer, turns, and runtime switches", () => {
  assert.match(route, /interactionMode: thread\.interactionMode/u);
  assert.match(route, /updateThreadInteractionModeForUser/u);
  assert.match(page, /initialInteractionMode=\{chat\?\.interactionMode \?\? "chat"\}/u);
  assert.match(chat, /body: JSON\.stringify\(\{ interactionMode: nextMode \}\)/u);
  assert.match(chat, /shared\.setInteractionMode\(previousMode\)/u);
  assert.match(turnStore, /set\(\{ interactionMode: requestedInteractionMode, updatedAt: now \}\)/u);
  assert.match(worker, /interactionMode: meta\.selectedInteractionMode/u);
});
