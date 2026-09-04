import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";

// Execute the actual route and attachment parser, isolating only I/O owners.
// This catches a missing argument at the HTTP-to-durable-store boundary.
function loadModule(relative: string, dependencies: Record<string, unknown>) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as Record<string, (...args: any[]) => any> };
  new Function("require", "module", "exports", compiled)(
    (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
      return dependencies[id];
    }, module, module.exports,
  );
  return module.exports;
}

function harness(rejectFile = false) {
  const created: Array<Record<string, unknown>> = [];
  const dispatched: string[] = [];
  const attachments = loadModule("../attachments/store.ts", {
    "server-only": {}, "@/lib/files/service": {},
  });
  const validation = loadModule("../knowledge/validation.ts", { zod: { z } });
  const route = loadModule("../../app/api/threads/[id]/turns/route.ts", {
    "next/server": { NextResponse: Response },
    zod: { z },
    "@/lib/attachments/store": attachments,
    "@/lib/knowledge/validation": validation,
    "@/lib/knowledge/auth": {
      requireActiveOrganization: async () => ({ session: { user: { id: "user" } }, organizationId: "org" }),
    },
    "@/lib/knowledge/http": {
      errorResponse: (error: Error, status: number) => Response.json({ error: error.message }, { status }),
    },
    "@/lib/environments/store": { resolveThreadEnvironment: async () => ({ id: "env" }) },
    "@/lib/organizations/turn-readiness": { organizationSetupRequiredTurnResponse: async () => null },
    "@/lib/projects/runtime-context": { resolveProjectRuntimeContext: async () => null },
    "@/lib/threads/store": { getThreadForUser: async () => ({ id: "thread", mode: "chat", projectId: null }) },
    "@/lib/turns/interaction-mode": { KESTREL_ONE_INTERACTION_MODES: ["chat", "build"] },
    "@/lib/turns/conversation-snapshot.server": {},
    "@/lib/turns/queue": { enqueueDurableThreadTurn: async (id: string) => { dispatched.push(id); } },
    "@/lib/turns/store": {
      createDurableThreadTurn: async (input: Record<string, unknown>) => {
        if (rejectFile) throw new Error("File not authorized for this Thread.");
        created.push(input);
        return { turn: { id: "turn", sequence: 1, status: "queued" }, created: true, shouldDispatch: true };
      },
    },
  });
  return {
    created, dispatched,
    post: (parts: unknown[]) => route.POST(new Request("https://one.test/api/threads/thread/turns", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id: "message", parts }, interactionMode: "build" }),
    }), { params: Promise.resolve({ id: "thread" }) }) as Promise<Response>,
  };
}

test("queued HTTP messages pass their ordered file IDs to the durable store", async () => {
  const h = harness();
  const parts = [
    { type: "data-kestrel-file", data: { fileId: "file-b" } },
    { type: "text", text: "Inspect these fixtures." },
    { type: "data-kestrel-file", data: { fileId: "file-a" } },
  ];
  assert.equal((await h.post(parts)).status, 202);
  assert.deepEqual(h.created[0]?.attachmentIds, ["file-b", "file-a"]);
  assert.deepEqual(h.created[0]?.messageParts, parts);
  assert.equal(h.created[0]?.authorUserId, "user");
  assert.equal(h.created[0]?.organizationId, "org");
  assert.deepEqual(h.dispatched, ["turn"]);
});

test("queued text-only messages carry an empty attachment set", async () => {
  const h = harness();
  assert.equal((await h.post([{ type: "text", text: "Hello" }])).status, 202);
  assert.deepEqual(h.created[0]?.attachmentIds, []);
});

test("queued malformed file parts fail before persistence or dispatch", async () => {
  const h = harness();
  assert.equal((await h.post([{ type: "data-kestrel-file", data: {} }])).status, 400);
  assert.deepEqual(h.created, []);
  assert.deepEqual(h.dispatched, []);
});

test("queued file authorization failures never dispatch", async () => {
  const h = harness(true);
  assert.equal((await h.post([{ type: "data-kestrel-file", data: { fileId: "foreign-file" } }])).status, 400);
  assert.deepEqual(h.dispatched, []);
});
