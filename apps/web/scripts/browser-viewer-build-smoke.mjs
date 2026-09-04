import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const route = resolve(webRoot, ".next/server/app/api/threads/[id]/browser-viewer/v1/route.js");
const trace = JSON.parse(await readFile(`${route}.nft.json`, "utf8"));
const require = createRequire(route);
const wsEntry = await realpath(require.resolve("ws"));
const traced = new Set(await Promise.all(trace.files.map(async (file) => {
  try { return await realpath(resolve(dirname(route), file)); }
  catch { return resolve(dirname(route), file); }
})));
assert.ok(traced.has(wsEntry), "Browser viewer must trace the external ws runtime, not a bundled optional-native stub");
const { Receiver, Sender } = require(wsEntry);
const payload = Buffer.from(JSON.stringify({ type: "authenticate", ticket: "synthetic-viewer-ticket-".repeat(64) }));
assert.ok(payload.length > 125, "Exercise the native unmask threshold and extended frame length");
const receiver = new Receiver({ isServer: true, maxPayload: 64 * 1024 });
const received = once(receiver, "message");
const frame = Sender.frame(payload, {
  fin: true, mask: true, opcode: 1, readOnly: true, rsv1: false,
  generateMask(mask) { mask.set([1, 2, 3, 4]); }, maskBuffer: Buffer.alloc(4),
});
for (const chunk of frame) receiver.write(chunk);
const [decoded, binary] = await received;
assert.equal(binary, false);
assert.deepEqual(decoded, payload);
receiver.end();
console.log("Browser viewer traced WebSocket masked-authentication smoke passed.");
