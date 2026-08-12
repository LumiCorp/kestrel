import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

test("Thread Turn retries resolve before Hydra admission side effects", () => {
  const route = read("app/api/threads/[id]/route.ts");
  const post = route.slice(
    route.indexOf("export async function POST"),
    route.indexOf("export async function PATCH"),
  );
  const replay = post.indexOf("getExistingDurableThreadTurnForAdmission");
  assert.ok(replay >= 0);
  assert.ok(replay < post.indexOf("assertRuntimeReleased"));
  assert.ok(replay < post.indexOf('thread.runtimeBinding.status === "degraded"'));
  assert.match(post, /const requestedRuntimeId = body\.runtimeId \?\? "kestrel"/u);
});

test("existing foreign Threads pin their persisted model in presentation", () => {
  const route = read("app/api/threads/[id]/route.ts");
  const page = read("app/(workspace)/threads/[id]/page.tsx");
  const chat = read("components/chatbot/chat.tsx");
  const composer = read("components/chatbot/multimodal-input.tsx");
  assert.match(route, /runtimeId: thread\.runtimeId/u);
  assert.match(route, /selectedModelId: thread\.runtimeBinding\.selectedModelId/u);
  assert.match(
    page,
    /persistedRuntimeModelId \?\? chatModelFromCookie\?\.value/u,
  );
  assert.match(
    composer,
    /disabled=\{threadExists && runtimeId !== "kestrel"\}/u,
  );
  assert.match(
    chat,
    /setCurrentModelId\(initialChatModel\);[\s\S]*initialChatModel, threadId/u,
  );
});

test("recovery removes only the exactly failed live interaction", () => {
  const recovery = read("lib/threads/runtime-recovery.ts");
  assert.match(
    recovery,
    /schema\.runtimeInteractionDeliveries\.bindingId,[\s\S]*sourceBinding\.id/u,
  );
  assert.match(
    recovery,
    /schema\.runtimeInteractionDeliveries\.state, "failed"/u,
  );
  assert.match(recovery, /lostInteractions\.length !== 1/u);
  assert.doesNotMatch(
    recovery,
    /threadInteractions\.findMany\([\s\S]*latestTurn\.id/u,
  );
});

test("mobile foreign branches carry a fresh immutable Runtime proof", () => {
  const route = read("app/api/mobile/v2/threads/[id]/branches/route.ts");
  const store = read("lib/turns/store.ts");
  assert.match(route, /resolveFreshForeignRuntimeAdmission/u);
  assert.match(route, /requestedRuntimeId,/u);
  assert.match(route, /runtimeAdmission,/u);
  assert.match(
    store,
    /capabilityDigest: input\.runtimeAdmission\?\.capabilityDigest \?\? null/u,
  );
  assert.match(
    store,
    /The branch Runtime route must match its parent Thread\./u,
  );
});
