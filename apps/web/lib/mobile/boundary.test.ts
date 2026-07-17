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
  fs.readFileSync(path.join(packageRoot, "openapi/mobile-v2.json"), "utf8")
) as {
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, Record<string, unknown>>;
    responses: Record<string, Record<string, unknown>>;
  };
};

test("mobile OpenAPI contract contains every implemented companion route", () => {
  assert.deepEqual(Object.keys(contract.paths).sort(), [
    "/account/deletion-request",
    "/bootstrap",
    "/devices",
    "/projects",
    "/projects/{id}",
    "/threads",
    "/threads/{id}",
    "/threads/{id}/branches",
    "/threads/{id}/interactions/{checkpointId}",
    "/threads/{id}/messages",
    "/threads/{id}/outline",
    "/threads/{id}/queue",
    "/threads/{id}/queue/resume",
    "/threads/{id}/read",
    "/threads/{id}/turns",
    "/turns/{turnId}",
    "/turns/{turnId}/events",
    "/turns/{turnId}/retry",
    "/turns/{turnId}/stop",
  ]);
  assert.deepEqual(Object.keys(contract.paths["/threads/{id}/turns"] ?? {}), [
    "post",
  ]);
  assert.deepEqual(Object.keys(contract.paths["/turns/{turnId}"] ?? {}), [
    "delete",
  ]);
});

test("every Thread mutation returns the authoritative snapshot", () => {
  const mutations = [
    ["/threads", "post", ["200", "202"]],
    ["/threads/{id}/turns", "post", ["200", "202"]],
    ["/threads/{id}/queue/resume", "post", ["200"]],
    ["/threads/{id}/queue", "put", ["200"]],
    ["/threads/{id}/branches", "post", ["200", "202"]],
    ["/threads/{id}/interactions/{checkpointId}", "post", ["200"]],
    ["/turns/{turnId}", "delete", ["200"]],
    ["/turns/{turnId}/retry", "post", ["200", "202"]],
    ["/turns/{turnId}/stop", "post", ["202"]],
  ] as const;
  for (const [pathName, method, statuses] of mutations) {
    const operation = contract.paths[pathName]?.[method] as {
      responses?: Record<string, { $ref?: string }>;
    };
    for (const status of statuses) {
      assert.match(
        operation.responses?.[status]?.$ref ?? "",
        /\/(?:AcceptedTurn|SnapshotEnvelope)$/u,
        `${method.toUpperCase()} ${pathName} ${status} must return a snapshot`
      );
    }
  }
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
    "app/api/mobile/v2/projects/route.ts",
    "app/api/mobile/v2/projects/[id]/route.ts",
  ]) {
    const source = fs.readFileSync(
      path.join(packageRoot, relativePath),
      "utf8"
    );
    assert.match(source, /export (?:async function GET|\{ GET \})/u);
    assert.doesNotMatch(
      source,
      /export async function (?:POST|PATCH|PUT|DELETE)/u
    );
  }
});

test("mobile wire inputs contain no model or agent configuration", () => {
  const createThread = JSON.stringify(
    contract.components.schemas.CreateThreadInput
  );
  const createTurn = JSON.stringify(
    contract.components.schemas.CreateTurnInput
  );
  const retryTurn = JSON.stringify(contract.components.schemas.RetryTurnInput);
  assert.doesNotMatch(
    `${createThread}\n${createTurn}\n${retryTurn}`,
    /model|agent/iu
  );
});

test("mobile responses, snapshots, message parts, errors, and SSE are concrete", () => {
  for (const [pathName, pathItem] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (
        !(
          operation &&
          typeof operation === "object" &&
          "responses" in operation
        )
      ) {
        continue;
      }
      const responses = (operation as { responses: Record<string, unknown> })
        .responses;
      for (const [status, response] of Object.entries(responses)) {
        if (status === "204") continue;
        const record = response as Record<string, unknown>;
        assert.ok(
          "$ref" in record || "content" in record,
          `${method.toUpperCase()} ${pathName} ${status} must name a response body`
        );
      }
    }
  }
  assert.deepEqual(contract.components.schemas.ThreadSnapshot.required, [
    "snapshotVersion",
    "thread",
    "messageWindow",
    "turns",
    "queue",
    "interactions",
    "readState",
  ]);
  assert.ok(Array.isArray(contract.components.schemas.MessagePart.oneOf));
  assert.deepEqual(
    (
      contract.components.schemas.MessagePart.oneOf as Array<{ $ref: string }>
    ).map((entry) => entry.$ref.split("/").at(-1)),
    [
      "TextPart",
      "SourceUrlPart",
      "SourceDocumentPart",
      "CitationPart",
      "ArtifactPart",
      "InteractionStatusPart",
      "ProgressPart",
      "ToolStatusPart",
    ]
  );
  assert.ok(Array.isArray(contract.components.schemas.TurnEvent.oneOf));
  assert.ok(contract.components.schemas.ErrorResponse.properties);
  assert.deepEqual(
    (
      contract.components.schemas.InteractionStatusPart.properties as Record<
        string,
        { enum?: string[] }
      >
    ).kind?.enum,
    ["question", "approval"]
  );
});
