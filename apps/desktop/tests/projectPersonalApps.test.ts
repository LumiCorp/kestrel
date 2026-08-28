import assert from "node:assert/strict";
import test from "node:test";

import { resolveProjectScopedDesktopAppIds } from "../src/projectPersonalApps.js";

const requested = {
  modelConfiguration: { id: "desktop-default", revision: 1 },
  apps: [
    { id: "built_in.weather", contractVersion: 1 },
    { id: "google_workspace", contractVersion: 1 },
    { id: "microsoft_365", contractVersion: 1 },
  ],
};

const enabledAppIds = [
  "built_in.weather",
  "google_workspace",
  "microsoft_365",
];

test("Desktop Projects receive only their selected, requested, and enabled personal Apps", () => {
  const projects = [
    {
      path: "/workspace/calendar",
      label: "Calendar",
      personalAppIds: ["google_workspace"],
    },
    {
      path: "/workspace/teams",
      label: "Teams",
      personalAppIds: ["microsoft_365"],
    },
  ];

  assert.deepEqual(
    resolveProjectScopedDesktopAppIds({
      projectPath: "/workspace/calendar",
      projects,
      requested,
      enabledAppIds,
    }),
    ["built_in.weather", "google_workspace"],
  );
  assert.deepEqual(
    resolveProjectScopedDesktopAppIds({
      projectPath: "/workspace/teams",
      projects,
      requested,
      enabledAppIds,
    }),
    ["built_in.weather", "microsoft_365"],
  );
});

test("Desktop Project personal Apps fail closed for missing Projects, renderer overreach, and disabled connections", () => {
  const projects = [
    {
      path: "/workspace/calendar",
      label: "Calendar",
      personalAppIds: ["google_workspace"],
    },
  ];

  assert.deepEqual(
    resolveProjectScopedDesktopAppIds({
      projectPath: "/workspace/missing",
      projects,
      requested,
      enabledAppIds,
    }),
    ["built_in.weather"],
  );
  assert.deepEqual(
    resolveProjectScopedDesktopAppIds({
      projectPath: "/workspace/calendar",
      projects,
      requested: {
        ...requested,
        apps: [{ id: "built_in.weather", contractVersion: 1 }],
      },
      enabledAppIds,
    }),
    ["built_in.weather"],
  );
  assert.deepEqual(
    resolveProjectScopedDesktopAppIds({
      projectPath: "/workspace/calendar",
      projects,
      requested,
      enabledAppIds: ["built_in.weather", "microsoft_365"],
    }),
    ["built_in.weather"],
  );
});
