import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const stylesPath = path.join(testDir, "..", "renderer", "src", "styles.css");
const appPath = path.join(testDir, "..", "renderer", "src", "DesktopApp.tsx");

test("thread messages and composer share the conversation width", async () => {
  const source = await readFile(stylesPath, "utf8");

  assert.match(source, /--conversation-content-width:\s*880px;/u);
  assert.match(source, /\.transcript\s*\{[^}]*padding:\s*28px var\(--conversation-gutter\) 18px;/su);
  assert.match(source, /\.message\s*\{[^}]*width:\s*min\(var\(--conversation-content-width\),\s*100%\);/su);
  assert.match(
    source,
    /\.message-user\s*\{[^}]*margin-right:\s*max\(0px,\s*calc\(\(100% - var\(--conversation-content-width\)\) \/ 2\)\);/su,
  );
  assert.match(source, /\.activity-line\s*\{[^}]*width:\s*min\(var\(--conversation-content-width\),/su);
  assert.match(source, /\.composer\s*\{[^}]*width:\s*min\(var\(--conversation-content-width\),/su);
});

test("composer controls are grouped by context and action", async () => {
  const [styles, app] = await Promise.all([
    readFile(stylesPath, "utf8"),
    readFile(appPath, "utf8"),
  ]);

  assert.match(styles, /\.composer-actions\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/su);
  assert.match(styles, /\.composer-actions-left\s*\{[^}]*justify-self:\s*start;/su);
  assert.match(styles, /\.composer-actions-right\s*\{[^}]*justify-self:\s*end;/su);
  assert.match(app, /className="composer-actions-left"[\s\S]*className="composer-actions-right"/u);
});

test("active runs suppress stale stalled-attention cards", async () => {
  const app = await readFile(appPath, "utf8");

  assert.match(app, /item\.kind !== "stalled_thread_attention" \|\| activeRun === undefined/u);
  assert.match(app, /\{operatorInboxItems\.map\(\(item\) => \(/u);
});
