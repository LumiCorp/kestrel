import assert from "node:assert/strict";
import {
  workspaceChildEnvironment,
  workspaceRunnerEnvironment,
} from "../src/child-environment.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

contractTest(
  "services.hermetic",
  "interactive child processes do not inherit Workspace infrastructure credentials",
  () => {
    assert.deepEqual(
      workspaceChildEnvironment({
        PATH: "/usr/bin",
        KESTREL_ONE_APP_URL: "https://kestrel.example",
        NGROK_AUTHTOKEN: "ngrok-secret",
        KESTREL_ONE_CREDENTIAL_BROKER_TOKEN: "broker-secret",
        KESTREL_WORKSPACE_SERVICE_TOKEN: "workspace-secret",
        KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY: "ticket-secret",
        FLY_API_TOKEN: "fly-secret",
      }),
      {
        PATH: "/usr/bin",
        KESTREL_ONE_APP_URL: "https://kestrel.example",
      }
    );
  }
);

contractTest(
  "services.hermetic",
  "trusted runner receives only the workspace-scoped relay token",
  () => {
    assert.deepEqual(
      workspaceRunnerEnvironment({
        source: {
          PATH: "/usr/bin",
          KESTREL_ONE_APP_URL: "https://kestrel.example",
          NGROK_AUTHTOKEN: "ngrok-secret",
          KESTREL_ONE_CREDENTIAL_BROKER_TOKEN: "ambient-broker-secret",
          KESTREL_WORKSPACE_SERVICE_TOKEN: "ambient-workspace-secret",
          FLY_API_TOKEN: "fly-secret",
        },
        home: "/workspace",
        runtimeUrl: "http://127.0.0.1:43104",
        serviceToken: "runner-token",
        workspaceServiceToken: "workspace-secret",
      }),
      {
        PATH: "/usr/bin",
        KESTREL_ONE_APP_URL: "https://kestrel.example",
        HOME: "/workspace",
        KESTREL_CORE_HOME: "/workspace/.kestrel/runtime",
        KESTREL_WORKSPACE_SERVICE_TOKEN: "workspace-secret",
        KESTREL_WORKSPACE_RUNTIME_URL: "http://127.0.0.1:43104",
        KESTREL_RUNNER_SERVICE_HOST: "127.0.0.1",
        KESTREL_RUNNER_SERVICE_PORT: "43105",
        KESTREL_RUNNER_SERVICE_TOKEN: "runner-token",
      }
    );
  }
);
