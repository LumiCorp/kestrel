import assert from "node:assert/strict";
import test from "node:test";
import { selectEffectiveConnection } from "./project-service";
import type { ProjectAppConnection } from "./project-service";

function connection(
  input: Partial<ProjectAppConnection> &
    Pick<ProjectAppConnection, "id" | "scope">
): ProjectAppConnection {
  return {
    id: input.id,
    scope: input.scope,
    name: input.name ?? input.id,
    ownerType:
      input.ownerType ??
      (input.scope === "personal" ? "personal" : "environment"),
    status: input.status ?? "connected",
    environmentId: input.environmentId ?? null,
    isMine: input.isMine ?? input.scope === "personal",
    lastHealthAt: input.lastHealthAt ?? null,
    isDefault: input.isDefault ?? true,
  };
}

test("hybrid App resolution chooses the actor personal default first", () => {
  const shared = connection({ id: "shared", scope: "shared" });
  const personal = connection({ id: "personal", scope: "personal" });
  assert.equal(
    selectEffectiveConnection({
      connectionModel: "hybrid",
      connections: [shared, personal],
    })?.id,
    "personal"
  );
});

test("hybrid App resolution falls back to the Project shared default", () => {
  const personal = connection({
    id: "personal",
    scope: "personal",
    status: "degraded",
  });
  const shared = connection({ id: "shared", scope: "shared" });
  assert.equal(
    selectEffectiveConnection({
      connectionModel: "hybrid",
      connections: [personal, shared],
    })?.id,
    "shared"
  );
});

test("optional Environment Apps may resolve without a connection", () => {
  assert.equal(
    selectEffectiveConnection({
      connectionModel: "environment",
      connections: [],
    }),
    null
  );
});

test("a degraded default remains executable when no healthy connection is available", () => {
  const degraded = connection({
    id: "degraded-shared",
    scope: "shared",
    status: "degraded",
  });
  assert.equal(
    selectEffectiveConnection({
      connectionModel: "environment",
      connections: [degraded],
    })?.id,
    "degraded-shared"
  );
});
