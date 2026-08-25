import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  resolveStagedPdfCanvasNativeBinding,
  STAGED_CANVAS_NATIVE_RELATIVE_PATH,
} from "./pdf-runtime-binding";

test("resolves the stable binding from a web-root working directory", () => {
  const cwd = "/var/task/apps/web";
  const expected = resolve(cwd, STAGED_CANVAS_NATIVE_RELATIVE_PATH);
  assert.equal(resolveStagedPdfCanvasNativeBinding(cwd, (path) => path === expected), expected);
});

test("resolves the stable binding from Vercel's repository-root working directory", () => {
  const cwd = "/var/task";
  const expected = resolve(cwd, "apps/web", STAGED_CANVAS_NATIVE_RELATIVE_PATH);
  assert.equal(resolveStagedPdfCanvasNativeBinding(cwd, (path) => path === expected), expected);
});

test("resolves the stable binding from the serverless task root", () => {
  const cwd = "/tmp";
  const taskRoot = "/var/task";
  const expected = resolve(taskRoot, "apps/web", STAGED_CANVAS_NATIVE_RELATIVE_PATH);
  assert.equal(
    resolveStagedPdfCanvasNativeBinding(cwd, (path) => path === expected, taskRoot),
    expected,
  );
});
