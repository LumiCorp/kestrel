import assert from "node:assert/strict";
import { KESTREL_APP_IDS } from "@kestrel-agents/protocol";
import {
  addProjectAppDependencyStatuses,
  formatActiveProjectWorkflowContext,
  selectEffectiveConnection,
} from "./project-service";
import type {
  ProjectAppConfiguration,
  ProjectAppConnection,
} from "./project-service";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


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

function appConfiguration(input: {
  appKey: string;
  name: string;
  enabled?: boolean;
  executable?: boolean;
}): ProjectAppConfiguration {
  return {
    projectId: "project-1",
    environmentId: "environment-1",
    app: {
      key: input.appKey,
      displayName: input.name,
      description: `${input.name} description`,
      icon: null,
      connectionModel: "none",
      connectionRequirement: "none",
      authMethods: ["none"],
    },
    enabled: input.enabled ?? true,
    availableConnections: [],
    attachedConnections: [],
    capabilities: [
      {
        key: "coordinate",
        runtimeName: input.executable === false ? null : `${input.appKey}.tool`,
        displayName: "Coordinate",
        description: "Coordinate work.",
        groupKey: "general",
        enabled: true,
        approvalMode: "auto",
        environmentEnabled: true,
        environmentApprovalMode: "auto",
        loggingMode: "metadata_only",
        rateLimitMode: "default",
        inherited: true,
      },
    ],
    dependencies: [],
    dependencyReady: true,
  };
}

contractTest("web.hermetic", "hybrid App resolution chooses the actor personal default first", () => {
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

contractTest("web.hermetic", "hybrid App resolution falls back to the Project shared default", () => {
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

contractTest("web.hermetic", "optional Environment Apps may resolve without a connection", () => {
  assert.equal(
    selectEffectiveConnection({
      connectionModel: "environment",
      connections: [],
    }),
    null
  );
});

contractTest("web.hermetic", "a degraded default remains executable when no healthy connection is available", () => {
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

contractTest("web.hermetic", "workflow readiness requires every dependency role without widening App access", () => {
  const configurations = addProjectAppDependencyStatuses([
    appConfiguration({
      appKey: KESTREL_APP_IDS.SOFTWARE_DELIVERY,
      name: "Software delivery",
      executable: false,
    }),
    appConfiguration({ appKey: KESTREL_APP_IDS.GITHUB, name: "GitHub" }),
    appConfiguration({ appKey: KESTREL_APP_IDS.ATLASSIAN, name: "Atlassian" }),
    appConfiguration({ appKey: KESTREL_APP_IDS.VERCEL, name: "Vercel" }),
  ]);
  const workflow = configurations.find(
    (configuration) =>
      configuration.app.key === KESTREL_APP_IDS.SOFTWARE_DELIVERY
  );
  assert.equal(workflow?.dependencyReady, true);
  assert.deepEqual(
    workflow?.dependencies.map((dependency) => [
      dependency.role,
      dependency.satisfied,
    ]),
    [
      ["Source control", true],
      ["Work tracking", true],
      ["Deployment", true],
    ]
  );
  const context = formatActiveProjectWorkflowContext(configurations);
  assert.match(context ?? "", /Software delivery/u);
  assert.match(context ?? "", /Source control: GitHub/u);
  assert.match(context ?? "", /Work tracking: Atlassian/u);
  assert.match(context ?? "", /do not grant additional access/iu);
});

contractTest("web.hermetic", "workflow context is absent when a required App role is missing", () => {
  const configurations = addProjectAppDependencyStatuses([
    appConfiguration({
      appKey: KESTREL_APP_IDS.SOFTWARE_DELIVERY,
      name: "Software delivery",
      executable: false,
    }),
    appConfiguration({ appKey: KESTREL_APP_IDS.GITHUB, name: "GitHub" }),
    appConfiguration({ appKey: KESTREL_APP_IDS.LINEAR, name: "Linear" }),
  ]);
  const workflow = configurations.find(
    (configuration) =>
      configuration.app.key === KESTREL_APP_IDS.SOFTWARE_DELIVERY
  );
  assert.equal(workflow?.dependencyReady, false);
  assert.equal(formatActiveProjectWorkflowContext(configurations), null);
});
