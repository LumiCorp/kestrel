import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MacOsDesktopHostOpenService,
  type DesktopHostOpenRequest,
  type DesktopHostOpenServicePort,
} from "../../src/desktopShell/hostOpen.js";
import { desktopHostOpenTool } from "../../tools/desktop/hostOpen.js";
import { defaultToolCatalog } from "../../tools/catalog.js";
import { resolveRuntimeProfileSelection } from "../../src/profile/runtimeProfile.js";

class CapturingHostOpenService implements DesktopHostOpenServicePort {
  readonly requests: DesktopHostOpenRequest[] = [];

  async open(request: DesktopHostOpenRequest): Promise<void> {
    this.requests.push(request);
  }
}

test("desktop.host.open launches applications through the typed service", async () => {
  const service = new CapturingHostOpenService();
  const output = await desktopHostOpenTool.createHandler({ desktopHostOpenService: service })({
    kind: "application",
    application: "Safari",
  });

  assert.deepEqual(service.requests, [{ kind: "application", application: "Safari" }]);
  assert.deepEqual(output, { status: "opened", kind: "application", application: "Safari" });
});

test("desktop.host.open resolves existing workspace paths without returning absolute paths", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-host-open-"));
  await mkdir(path.join(workspaceRoot, "reports"));
  await writeFile(path.join(workspaceRoot, "reports", "result.html"), "ok", "utf8");
  const service = new CapturingHostOpenService();

  const output = await desktopHostOpenTool.createHandler({
    desktopHostOpenService: service,
    fileSystem: { workspaceRoot, tempRoots: [] },
  })({
    kind: "workspace_path",
    path: "reports/result.html",
    application: "Safari",
  });

  assert.deepEqual(service.requests, [{
    kind: "workspace_path",
    targetPath: await realpath(path.join(workspaceRoot, "reports", "result.html")),
    application: "Safari",
  }]);
  assert.deepEqual(output, {
    status: "opened",
    kind: "workspace_path",
    target: "reports/result.html",
    application: "Safari",
  });
  assert.doesNotMatch(JSON.stringify(output), new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("desktop.host.open accepts only HTTP(S) URLs", async () => {
  const service = new CapturingHostOpenService();
  const handler = desktopHostOpenTool.createHandler({ desktopHostOpenService: service });

  assert.deepEqual(await handler({ kind: "url", url: "https://example.com/report" }), {
    status: "opened",
    kind: "url",
    target: "https://example.com/report",
  });
  await assert.rejects(handler({ kind: "url", url: "file:///etc/passwd" }), /HTTP or HTTPS/u);
  await assert.rejects(handler({ kind: "url", url: "not a url" }), /absolute HTTP\(S\) URL/u);
});

test("desktop.host.open rejects malformed applications and unsafe workspace paths", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-host-open-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-host-open-outside-"));
  await writeFile(path.join(outsideRoot, "secret.txt"), "secret", "utf8");
  await symlink(path.join(outsideRoot, "secret.txt"), path.join(workspaceRoot, "escape.txt"));
  const handler = desktopHostOpenTool.createHandler({
    desktopHostOpenService: new CapturingHostOpenService(),
    fileSystem: { workspaceRoot, tempRoots: [] },
  });

  await assert.rejects(handler({ kind: "application", application: "/Applications/Safari.app" }), /not a path/u);
  await assert.rejects(handler({ kind: "workspace_path", path: "../secret.txt" }), /must not escape/u);
  await assert.rejects(handler({ kind: "workspace_path", path: path.join(workspaceRoot, "file.txt") }), /must be relative/u);
  await assert.rejects(handler({ kind: "workspace_path", path: "missing.txt" }), /existing workspace/u);
  await assert.rejects(handler({ kind: "workspace_path", path: "escape.txt" }), /resolves outside/u);
});

test("macOS host-open uses argument execution for every typed variant", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const service = new MacOsDesktopHostOpenService("darwin", async (file, args) => {
    calls.push({ file, args });
  });

  await service.open({ kind: "application", application: "Safari" });
  await service.open({ kind: "workspace_path", targetPath: "/private/tmp/report.html", application: "Safari" });
  await service.open({ kind: "url", url: "https://example.com" });

  assert.deepEqual(calls, [
    { file: "open", args: ["-a", "Safari"] },
    { file: "open", args: ["-a", "Safari", "/private/tmp/report.html"] },
    { file: "open", args: ["https://example.com"] },
  ]);
});

test("host-open failures are typed and redact host targets", async () => {
  const unsupported = new MacOsDesktopHostOpenService("linux", async () => {});
  await assert.rejects(
    unsupported.open({ kind: "application", application: "Safari" }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "DESKTOP_HOST_OPEN_UNSUPPORTED_PLATFORM");
      return true;
    },
  );

  const secretPath = "/Users/example/private/report.html";
  const failing = new MacOsDesktopHostOpenService("darwin", async () => {
    throw new Error(`failed ${secretPath}`);
  });
  await assert.rejects(
    failing.open({ kind: "workspace_path", targetPath: secretPath }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "DESKTOP_HOST_OPEN_FAILED");
      assert.doesNotMatch(JSON.stringify(error), /private\/report\.html/u);
      return true;
    },
  );
});

test("desktop.host.open is limited to Chat and Build and requires no approval", () => {
  assert.deepEqual(desktopHostOpenTool.definition.capability?.allowedInteractionModes, ["chat", "build"]);
  assert.deepEqual(desktopHostOpenTool.definition.capability?.approvalCapabilities, undefined);
});

test("Desktop Safari requests survive profile selection, catalog registration, and service dispatch", async () => {
  const profile = resolveRuntimeProfileSelection({ shellKind: "desktop" });
  const service = new CapturingHostOpenService();
  const modelTools = defaultToolCatalog.toModelTools(profile.toolAllowlist);
  const handlers = defaultToolCatalog.createHandlers(["desktop.host.open"], {
    desktopHostOpenService: service,
    interactionMode: "chat",
  });

  assert.equal(modelTools.some((tool) => tool.name === "desktop.host.open"), true);
  const result = await handlers["desktop.host.open"]?.({
    kind: "application",
    application: "Safari",
  });
  assert.deepEqual(service.requests, [{ kind: "application", application: "Safari" }]);
  assert.equal(result?.status, "OK");
  assert.deepEqual(result?.auditRecord.output, {
    status: "opened",
    kind: "application",
    application: "Safari",
  });
});
