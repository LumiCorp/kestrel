import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const authSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "auth.ts"),
  "utf8"
);

test("the Next.js cookie bridge is the final Better Auth plugin", () => {
  const pluginsStart = authSource.indexOf("plugins: [");
  const pluginsEnd = authSource.indexOf("\n  ],", pluginsStart);
  const plugins = authSource.slice(pluginsStart, pluginsEnd);

  assert.ok(pluginsStart >= 0);
  assert.ok(pluginsEnd > pluginsStart);
  assert.match(plugins, /lastLoginMethod\(\),\s+nextCookies\(\),\s*$/u);
});
