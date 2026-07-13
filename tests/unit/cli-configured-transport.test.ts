import assert from "node:assert/strict";
import test from "node:test";

import { LocalCoreRunnerTransport } from "../../cli/client/LocalCoreRunnerTransport.js";
import { RemoteRunnerTransport } from "../../cli/client/RemoteRunnerTransport.js";
import { createConfiguredRunnerTransport } from "../../cli/client/configuredTransport.js";

test("configured CLI transport selects Local Core only with a complete local target", () => {
  const transport = createConfiguredRunnerTransport({
    KESTREL_LOCAL_CORE_API_SOCKET: " /tmp/kestrel-core.sock ",
    KESTREL_LOCAL_CORE_API_TOKEN: " local-token ",
  });
  assert.equal(transport instanceof LocalCoreRunnerTransport, true);
});

test("configured CLI transport preserves an explicitly configured remote target", () => {
  const transport = createConfiguredRunnerTransport({
    KESTREL_RUNNER_SERVICE_URL: " https://runner.example.test/v2 ",
    KESTREL_RUNNER_SERVICE_TOKEN: " remote-token ",
    KESTREL_LOCAL_CORE_API_SOCKET: "/tmp/kestrel-core.sock",
    KESTREL_LOCAL_CORE_API_TOKEN: "local-token",
  });
  assert.equal(transport instanceof RemoteRunnerTransport, true);
  assert.equal(transport instanceof LocalCoreRunnerTransport, false);
});

test("configured CLI transport has no child or in-process runtime fallback", () => {
  assert.throws(
    () => createConfiguredRunnerTransport({}),
    /Local Core execution transport is unavailable/u,
  );
  assert.throws(
    () => createConfiguredRunnerTransport({
      KESTREL_LOCAL_CORE_API_SOCKET: "/tmp/kestrel-core.sock",
    }),
    /requires both KESTREL_LOCAL_CORE_API_SOCKET and KESTREL_LOCAL_CORE_API_TOKEN/u,
  );
  assert.throws(
    () => createConfiguredRunnerTransport({
      KESTREL_LOCAL_CORE_API_TOKEN: "local-token",
    }),
    /requires both KESTREL_LOCAL_CORE_API_SOCKET and KESTREL_LOCAL_CORE_API_TOKEN/u,
  );
});
