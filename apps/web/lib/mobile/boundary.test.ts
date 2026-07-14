import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const contract = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "openapi/mobile-v1.json"), "utf8")
) as { paths: Record<string, Record<string, unknown>> };

test("mobile OpenAPI contract contains every implemented companion route", () => {
  assert.deepEqual(Object.keys(contract.paths).sort(), [
    "/account/deletion-request",
    "/bootstrap",
    "/devices",
    "/projects",
    "/projects/{id}",
    "/threads",
    "/threads/{id}",
    "/threads/{id}/interactions",
    "/threads/{id}/interactions/{checkpointId}",
    "/threads/{id}/queue/resume",
    "/threads/{id}/turns",
    "/turns/{turnId}",
    "/turns/{turnId}/events",
    "/turns/{turnId}/stop",
  ]);
  assert.deepEqual(Object.keys(contract.paths["/threads/{id}/turns"] ?? {}), [
    "get",
    "post",
  ]);
});

test("Projects are read-only and the contract exposes no management verbs", () => {
  assert.deepEqual(Object.keys(contract.paths["/projects"] ?? {}), ["get"]);
  assert.deepEqual(Object.keys(contract.paths["/projects/{id}"] ?? {}), [
    "get",
  ]);
  const paths = Object.keys(contract.paths).join("\n");
  for (const forbidden of [
    "admin",
    "billing",
    "environment",
    "gateway",
    "model",
    "upload",
    "artifact",
  ]) {
    assert.doesNotMatch(paths, new RegExp(forbidden, "iu"));
  }
});

test("mobile Project routes export GET only", () => {
  for (const relativePath of [
    "app/api/mobile/v1/projects/route.ts",
    "app/api/mobile/v1/projects/[id]/route.ts",
  ]) {
    const source = fs.readFileSync(
      path.join(packageRoot, relativePath),
      "utf8"
    );
    assert.match(source, /export async function GET/u);
    assert.doesNotMatch(
      source,
      /export async function (?:POST|PATCH|PUT|DELETE)/u
    );
  }
});
