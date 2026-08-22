import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./message.tsx", import.meta.url), "utf8");
const componentSource = source.slice(
  source.indexOf("function AgentProgress("),
  source.indexOf("export function KestrelActivityTimeline("),
);

test("Agent progress presents only the latest durable update", () => {
  assert.match(componentSource, /const latestPart = parts\.at\(-1\)/u);
  assert.match(componentSource, /\{latestPart\.data\.text\}/u);
  assert.doesNotMatch(componentSource, /parts\.map/u);
  assert.doesNotMatch(componentSource, /overflow-y-auto/u);
});

test("Agent progress fades each update out before the next update fades in", () => {
  assert.match(componentSource, /<AnimatePresence mode="wait">/u);
  assert.match(componentSource, /initial=\{\{ opacity: 0/u);
  assert.match(componentSource, /animate=\{\{ opacity: 1/u);
  assert.match(componentSource, /exit=\{\{ opacity: 0/u);
  assert.match(componentSource, /key=\{latestPart\.data\.id\}/u);
});

test("Agent progress respects reduced motion and announces replacements", () => {
  assert.match(componentSource, /useReducedMotion\(\)/u);
  assert.match(componentSource, /duration: shouldReduceMotion \? 0/u);
  assert.match(componentSource, /aria-live="polite"/u);
  assert.match(componentSource, /aria-atomic="true"/u);
});
