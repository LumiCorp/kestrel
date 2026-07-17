import assert from "node:assert/strict";
import test from "node:test";

import {
  createWebCommandStartupMetadata,
  formatWebCommandStartupLines,
  generateRunnerServiceToken,
  parseWebCommandArgs,
  resolveWebCommandConfig,
  resolveWebCommandLocalCoreTarget,
} from "../../cli/webCommand.js";
import { DEFAULT_KESTREL_RUNNER_SERVICE_PORT } from "../../src/config/localDev.js";

test("parseWebCommandArgs parses host, port, and token flags", () => {
  assert.deepEqual(parseWebCommandArgs(["--host", "0.0.0.0", "--port", "43120", "--token", "secret"]), {
    host: "0.0.0.0",
    port: 43_120,
    token: "secret",
  });
});

test("resolveWebCommandConfig uses stable defaults and generates a token", () => {
  const resolved = resolveWebCommandConfig([], {});

  assert.equal(resolved.host, "127.0.0.1");
  assert.equal(resolved.port, DEFAULT_KESTREL_RUNNER_SERVICE_PORT);
  assert.equal(resolved.tokenSource, "generated");
  assert.match(resolved.token, /^[0-9a-f]{48}$/u);
});

test("resolveWebCommandConfig prefers explicit token and port inputs", () => {
  const resolved = resolveWebCommandConfig(["--port", "43155", "--token", "flag-token"], {
    KESTREL_RUNNER_SERVICE_PORT: "49999",
    KESTREL_RUNNER_SERVICE_TOKEN: "env-token",
  });

  assert.equal(resolved.port, 43_155);
  assert.equal(resolved.token, "flag-token");
  assert.equal(resolved.tokenSource, "provided");
});

test("resolveWebCommandConfig accepts env-provided token and port", () => {
  const resolved = resolveWebCommandConfig([], {
    KESTREL_RUNNER_SERVICE_HOST: "0.0.0.0",
    KESTREL_RUNNER_SERVICE_PORT: "43144",
    KESTREL_RUNNER_SERVICE_TOKEN: "env-token",
  });

  assert.equal(resolved.host, "0.0.0.0");
  assert.equal(resolved.port, 43_144);
  assert.equal(resolved.token, "env-token");
  assert.equal(resolved.tokenSource, "provided");
});

test("resolveWebCommandLocalCoreTarget requires the ready Core socket and private token", () => {
  assert.deepEqual(resolveWebCommandLocalCoreTarget({
    KESTREL_LOCAL_CORE_API_SOCKET: " /tmp/kestrel-core.sock ",
    KESTREL_LOCAL_CORE_API_TOKEN: " core-private-token ",
  }), {
    socketPath: "/tmp/kestrel-core.sock",
    authToken: "core-private-token",
  });

  assert.throws(
    () => resolveWebCommandLocalCoreTarget({
      KESTREL_LOCAL_CORE_API_SOCKET: "/tmp/kestrel-core.sock",
    }),
    /already-ready Local Core API socket and token/u,
  );
  assert.throws(
    () => resolveWebCommandLocalCoreTarget({
      KESTREL_LOCAL_CORE_API_TOKEN: "core-private-token",
    }),
    /already-ready Local Core API socket and token/u,
  );
});

test("formatWebCommandStartupLines redacts a provided token from startup output", () => {
  const metadata = createWebCommandStartupMetadata(
    {
      url: "http://127.0.0.1:43102",
      host: "127.0.0.1",
      port: 43_102,
    },
    {
      host: "127.0.0.1",
      token: "abc'def",
      tokenSource: "provided",
    },
  );

  const lines = formatWebCommandStartupLines(metadata);
  assert.equal(lines[0], JSON.stringify({ ...metadata, token: "[redacted]" }));
  assert.equal(lines[2], "export KESTREL_RUNNER_SERVICE_URL='http://127.0.0.1:43102'");
  assert.equal(lines[3], "KESTREL_RUNNER_SERVICE_TOKEN is configured; value withheld.");
  assert.doesNotMatch(lines.join("\n"), /abc|def/u);
});

test("formatWebCommandStartupLines emits a generated token for local setup", () => {
  const metadata = createWebCommandStartupMetadata(
    {
      url: "http://127.0.0.1:43102",
      host: "127.0.0.1",
      port: 43_102,
    },
    {
      host: "127.0.0.1",
      token: "generated-token",
      tokenSource: "generated",
    },
  );

  const lines = formatWebCommandStartupLines(metadata);
  assert.equal(lines[0], JSON.stringify(metadata));
  assert.equal(lines[3], "export KESTREL_RUNNER_SERVICE_TOKEN='generated-token'");
});

test("createWebCommandStartupMetadata rewrites wildcard bind hosts to a local connect URL", () => {
  const metadata = createWebCommandStartupMetadata(
    {
      url: "http://0.0.0.0:43102",
      host: "0.0.0.0",
      port: 43_102,
    },
    {
      host: "0.0.0.0",
      token: "secret",
      tokenSource: "provided",
    },
  );

  assert.equal(metadata.url, "http://127.0.0.1:43102");
  assert.equal(metadata.host, "0.0.0.0");
});

test("generateRunnerServiceToken returns unique hex tokens", () => {
  const first = generateRunnerServiceToken();
  const second = generateRunnerServiceToken();

  assert.match(first, /^[0-9a-f]{48}$/u);
  assert.match(second, /^[0-9a-f]{48}$/u);
  assert.notEqual(first, second);
});
