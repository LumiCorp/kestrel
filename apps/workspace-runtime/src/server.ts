import { randomBytes } from "node:crypto";
import {
  KestrelClient,
  type KestrelRequestContext,
} from "@kestrel-agents/sdk/runner";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import path from "node:path";
import { WorkspaceApplicationRegistry } from "./applications.js";
import { WorkspaceBackupImportRegistry } from "./backup-imports.js";
import { readWorkspaceFile, writeWorkspaceFile } from "./files.js";
import { requestGitHubToolCredential } from "./github-credentials.js";
import { notifyWorkspaceIdle } from "./idle.js";
import { workspaceListenHost } from "./network.js";
import { buildWorkspaceProxyHeaders } from "./proxy.js";
import { resolveRunnerServiceEntrypoint } from "./runner-entrypoint.js";
import { authorizeWorkspaceRequest, resolveWorkspacePath, WorkspaceRequestError } from "./security.js";
import { WorkspaceTerminalRegistry } from "./terminals.js";

const config = readConfig();
await mkdir(config.workspaceRoot, { recursive: true });
await mkdir(path.join(config.workspaceRoot, ".kestrel"), { recursive: true });
const applications = new WorkspaceApplicationRegistry(config.workspaceRoot);
await applications.restore();
const backupImports = new WorkspaceBackupImportRegistry(config.workspaceRoot);
const terminals = new WorkspaceTerminalRegistry();
const runnerToken = randomBytes(32).toString("base64url");
let runner: ChildProcess | null = null;
let runnerReady: Promise<void> | null = null;
let sourceInitialization: Promise<void> | null = null;
let lastActivityAt = Date.now();
let activeRequests = 0;
let idleNotificationInFlight = false;
let idleStopAccepted = false;
let drainingForIdleStop = false;

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { ok: true, workspaceId: config.workspaceId });
    return;
  }
  if (drainingForIdleStop) {
    writeJson(response, 503, {
      error: { code: "WORKSPACE_IDLE_STOPPING" },
    });
    return;
  }
  activeRequests += 1;
  lastActivityAt = Date.now();
  try {
    const ticket = authorizeWorkspaceRequest({
      authorization: request.headers.authorization,
      publicKey: config.ticketPublicKey,
      workspaceId: config.workspaceId,
      organizationId: config.organizationId,
      environmentId: config.environmentId,
      machineId: config.machineId,
    });
    const url = new URL(request.url ?? "/", "http://workspace.internal");
    if (!url.pathname.startsWith("/v1/backups/imports")) {
      await ensureWorkspaceSource(request.headers.authorization ?? "");
    }
    if (url.pathname === "/commands" || url.pathname === "/commands/stream") {
      await ensureRunnerReady();
      await proxyHttp(request, response, {
        port: 43_105,
        path: request.url ?? url.pathname,
        authorization: `Bearer ${runnerToken}`,
      });
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/git/push-agent-branch"
    ) {
      const body = parseJson(await readBody(request, 100_000));
      if (
        !isRecord(body) ||
        typeof body.promotionId !== "string" ||
        !body.promotionId.trim() ||
        typeof body.candidateFingerprint !== "string" ||
        !body.candidateFingerprint.trim()
      ) {
        throw new WorkspaceRequestError(400, "GITHUB_PUSH_INPUT_INVALID");
      }
      const result = await pushManagedCandidateBranch({
        ticket,
        authorization: request.headers.authorization ?? "",
        promotionId: body.promotionId,
        candidateFingerprint: body.candidateFingerprint,
      });
      writeJson(response, 200, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/apps") {
      requireCapability(ticket.capabilities, "workspace.apps.read");
      writeJson(response, 200, { applications: applications.list() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/promotions") {
      requireCapability(ticket.capabilities, "workspace.promotions.read");
      const payload = await withRunnerClient((client, context) =>
        client.listWorkspacePromotions(
          { sessionId: ticket.threadId },
          context
        )
      , ticket);
      writeJson(response, 200, {
        promotions: payload.promotions ?? [],
      });
      return;
    }
    const promotionPath = url.pathname.match(
      /^\/v1\/promotions\/([^/]+)(?:\/(apply))?$/u
    );
    if (promotionPath?.[1]) {
      if (request.method === "GET" && promotionPath[2] === undefined) {
        requireCapability(ticket.capabilities, "workspace.promotions.read");
        const payload = await withRunnerClient(
          (client, context) =>
            client.previewWorkspacePromotion(
              {
                sessionId: ticket.threadId,
                promotionId: promotionPath[1]!,
              },
              context
            ),
          ticket
        );
        writeJson(response, 200, { preview: payload.preview });
        return;
      }
      if (request.method === "POST" && promotionPath[2] === "apply") {
        requireCapability(ticket.capabilities, "workspace.promotions.apply");
        const body = parseJson(await readBody(request, 100_000));
        if (
          !isRecord(body) ||
          typeof body.candidateFingerprint !== "string" ||
          !body.candidateFingerprint.trim()
        ) {
          throw new WorkspaceRequestError(
            400,
            "WORKSPACE_PROMOTION_FINGERPRINT_REQUIRED"
          );
        }
        const payload = await withRunnerClient(
          (client, context) =>
            client.applyWorkspacePromotion(
              {
                sessionId: ticket.threadId,
                promotionId: promotionPath[1]!,
                candidateFingerprint: body.candidateFingerprint as string,
              },
              context
            ),
          ticket
        );
        writeJson(response, 200, { promotion: payload.promotion });
        return;
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/backups/export") {
      requireCapability(ticket.capabilities, "workspace.backups.export");
      await streamWorkspaceBackup(response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/backups/imports") {
      requireCapability(ticket.capabilities, "workspace.backups.restore");
      const body = parseJson(await readBody(request, 100_000));
      if (!isRecord(body) || typeof body.checksumSha256 !== "string") {
        throw new WorkspaceRequestError(400, "WORKSPACE_BACKUP_INPUT_INVALID");
      }
      writeJson(response, 201, await backupImports.create(body.checksumSha256));
      return;
    }
    const backupImportChunk = url.pathname.match(
      /^\/v1\/backups\/imports\/([^/]+)\/chunks\/(\d+)$/u
    );
    if (
      request.method === "PUT" &&
      backupImportChunk?.[1] &&
      backupImportChunk[2]
    ) {
      requireCapability(ticket.capabilities, "workspace.backups.restore");
      writeJson(
        response,
        202,
        await backupImports.append(
          backupImportChunk[1],
          Number.parseInt(backupImportChunk[2], 10),
          await readBody(request, 768 * 1024)
        )
      );
      return;
    }
    const backupImport = url.pathname.match(
      /^\/v1\/backups\/imports\/([^/]+)(?:\/(complete))?$/u
    );
    if (backupImport?.[1]) {
      requireCapability(ticket.capabilities, "workspace.backups.restore");
      if (request.method === "POST" && backupImport[2] === "complete") {
        writeJson(response, 200, await backupImports.complete(backupImport[1]));
        return;
      }
      if (request.method === "DELETE" && backupImport[2] === undefined) {
        await backupImports.abort(backupImport[1]);
        writeJson(response, 200, { ok: true });
        return;
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/apps") {
      requireCapability(ticket.capabilities, "workspace.apps.write");
      const application = await applications.register(
        parseJson(await readBody(request, 100_000))
      );
      writeJson(response, 201, { application });
      return;
    }
    const applicationControl = url.pathname.match(
      /^\/v1\/apps\/([^/]+)\/(start|stop)$/u
    );
    if (request.method === "POST" && applicationControl?.[1]) {
      requireCapability(ticket.capabilities, "workspace.apps.write");
      const application =
        applicationControl[2] === "start"
          ? await applications.start(applicationControl[1])
          : await applications.stop(applicationControl[1]);
      writeJson(response, 200, { application });
      return;
    }
    const applicationProxy = url.pathname.match(
      /^\/v1\/apps\/([^/]+)\/proxy(\/.*)?$/u
    );
    if (applicationProxy?.[1]) {
      requireCapability(ticket.capabilities, "workspace.apps.read");
      const application = applications.get(applicationProxy[1]);
      if (!application || application.status !== "running") {
        throw new WorkspaceRequestError(404, "APPLICATION_NOT_RUNNING");
      }
      await proxyHttp(request, response, {
        port: application.port,
        path: `${applicationProxy[2] ?? "/"}${url.search}`,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/files") {
      requireCapability(ticket.capabilities, "workspace.files.read");
      const file = await readWorkspaceFile(
        config.workspaceRoot,
        url.searchParams.get("path") ?? ""
      );
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        etag: file.revision,
      });
      response.end(file.content);
      return;
    }
    if (request.method === "PUT" && url.pathname === "/v1/files") {
      requireCapability(ticket.capabilities, "workspace.files.write");
      const saved = await writeWorkspaceFile({
        workspaceRoot: config.workspaceRoot,
        requestedPath: url.searchParams.get("path") ?? "",
        expectedRevision: request.headers["if-match"],
        content: await readBody(request, 5_000_000),
      });
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        etag: saved.revision,
      });
      response.end(JSON.stringify({ ok: true, revision: saved.revision }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/tree") {
      requireCapability(ticket.capabilities, "workspace.files.read");
      const directory = resolveWorkspacePath(config.workspaceRoot, url.searchParams.get("path") ?? "");
      writeJson(response, 200, { entries: await listDirectory(directory, config.workspaceRoot) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/terminal/exec") {
      requireCapability(ticket.capabilities, "workspace.terminal.exec");
      const body = parseJson(await readBody(request, 100_000));
      if (!isRecord(body) || typeof body.command !== "string" || !body.command.trim()) {
        throw new WorkspaceRequestError(400, "TERMINAL_COMMAND_INVALID");
      }
      const cwd = resolveWorkspacePath(
        config.workspaceRoot,
        typeof body.cwd === "string" ? body.cwd : ""
      );
      writeJson(response, 200, await executeCommand(body.command, cwd));
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/terminal/sessions"
    ) {
      requireCapability(ticket.capabilities, "workspace.terminal.exec");
      const body = parseJson(await readBody(request, 100_000));
      const cwd = resolveWorkspacePath(
        config.workspaceRoot,
        isRecord(body) && typeof body.cwd === "string" ? body.cwd : ""
      );
      writeJson(response, 201, terminals.create(cwd));
      return;
    }
    const terminalSession = url.pathname.match(
      /^\/v1\/terminal\/sessions\/([^/]+)(?:\/(input|output))?$/u
    );
    if (terminalSession?.[1]) {
      requireCapability(ticket.capabilities, "workspace.terminal.exec");
      const sessionId = terminalSession[1];
      if (request.method === "POST" && terminalSession[2] === "input") {
        terminals.write(
          sessionId,
          (await readBody(request, 100_000)).toString("utf8")
        );
        writeJson(response, 202, { ok: true });
        return;
      }
      if (request.method === "GET" && terminalSession[2] === "output") {
        const cursor = Number.parseInt(url.searchParams.get("cursor") ?? "0", 10);
        writeJson(
          response,
          200,
          terminals.read(sessionId, Number.isSafeInteger(cursor) ? cursor : 0)
        );
        return;
      }
      if (request.method === "DELETE" && terminalSession[2] === undefined) {
        terminals.close(sessionId);
        writeJson(response, 200, { ok: true });
        return;
      }
    }
    writeJson(response, 404, { error: { code: "WORKSPACE_ROUTE_NOT_FOUND" } });
  } catch (error) {
    const status = error instanceof WorkspaceRequestError ? error.status : 500;
    const code = error instanceof WorkspaceRequestError ? error.code : "WORKSPACE_REQUEST_FAILED";
    process.stdout.write(
      `${JSON.stringify({
        type: "workspace.request.denied",
        workspaceId: config.workspaceId,
        code,
        status,
        occurredAt: new Date().toISOString(),
      })}\n`
    );
    writeJson(response, status, { error: { code } });
  } finally {
    activeRequests -= 1;
    lastActivityAt = Date.now();
  }
});

server.listen(config.port, config.listenHost);
const idleTimer = setInterval(() => {
  if (
    !(idleNotificationInFlight ||idleStopAccepted ) &&
    activeRequests === 0 &&
    terminals.activeCount === 0 &&
    Date.now() - lastActivityAt >= config.idleTimeoutMinutes * 60_000
  ) {
    const reportedLastActivityAt = new Date(lastActivityAt);
    idleNotificationInFlight = true;
    drainingForIdleStop = true;
    void notifyWorkspaceIdle({
      controlPlaneUrl: config.controlPlaneUrl,
      authorizationToken: config.credentialBrokerToken,
      organizationId: config.organizationId,
      environmentId: config.environmentId,
      workspaceId: config.workspaceId,
      machineId: config.machineId,
      lastActivityAt: reportedLastActivityAt,
    })
      .then((accepted) => {
        idleStopAccepted = accepted;
        if (!accepted) drainingForIdleStop = false;
      })
      .finally(() => {
        idleNotificationInFlight = false;
      });
  }
}, 30_000);
idleTimer.unref();

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

function startRunner(authToken: string): ChildProcess {
  const entrypoint = resolveRunnerServiceEntrypoint();
  const child = spawn(process.execPath, [entrypoint], {
    cwd: config.workspaceRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      HOME: config.workspaceRoot,
      KESTREL_RUNNER_SERVICE_HOST: "127.0.0.1",
      KESTREL_RUNNER_SERVICE_PORT: "43105",
      KESTREL_RUNNER_SERVICE_TOKEN: authToken,
    },
  });
  child.once("exit", (code) => {
    if (runner === child) runner = null;
    runnerReady = null;
    if (code !== 0) shutdown(code ?? 1);
  });
  return child;
}

function ensureRunnerReady() {
  runner ??= startRunner(runnerToken);
  runnerReady ??= waitForRunnerService().catch((error) => {
    runnerReady = null;
    throw error;
  });
  return runnerReady;
}

async function waitForRunnerService() {
  const client = new KestrelClient({
    target: {
      kind: "remote",
      baseUrl: "http://127.0.0.1:43105",
      authToken: runnerToken,
    },
  });
  try {
    await waitForRunner(client);
  } finally {
    await client.close();
  }
}

async function withRunnerClient<T>(
  run: (
    client: KestrelClient,
    context: KestrelRequestContext
  ) => Promise<T>,
  ticket: { actorId: string; organizationId: string }
): Promise<T> {
  await ensureRunnerReady();
  const client = new KestrelClient({
    target: {
      kind: "remote",
      baseUrl: "http://127.0.0.1:43105",
      authToken: runnerToken,
    },
  });
  try {
    const context: KestrelRequestContext = {
      actor: {
        actorId: ticket.actorId,
        actorType: "end_user",
        tenantId: ticket.organizationId,
      },
      tenantId: ticket.organizationId,
    };
    const profile = await client.getProfile(config.profileId, context);
    return await run(client, { ...context, profile });
  } finally {
    await client.close();
  }
}

async function waitForRunner(client: KestrelClient) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await client.getHealth();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new WorkspaceRequestError(503, "WORKSPACE_RUNNER_UNAVAILABLE");
}

async function ensureWorkspaceSource(authorization: string) {
  if (config.sourceType !== "github") return;
  if (!sourceInitialization) {
    sourceInitialization = initializeGitHubSource(authorization).catch((error) => {
      sourceInitialization = null;
      throw error;
    });
  }
  await sourceInitialization;
}

async function initializeGitHubSource(authorization: string) {
  try {
    if ((await stat(path.join(config.workspaceRoot, ".git"))).isDirectory()) return;
  } catch {}
  if (!(config.sourceResourceId && config.controlPlaneUrl)) {
    throw new WorkspaceRequestError(500, "WORKSPACE_SOURCE_NOT_CONFIGURED");
  }
  const temporaryRoot = await mkdtemp("/tmp/kestrel-source-");
  const cloneRoot = path.join(temporaryRoot, "repository");
  const proxyUrl = new URL(
    `/api/runtime/github/git/${config.sourceResourceId}`,
    config.controlPlaneUrl
  );
  try {
    const credential = await requestGitHubToolCredential({
      controlPlaneUrl: config.controlPlaneUrl,
      executionAuthorization: authorization,
      resourceId: config.sourceResourceId,
      operation: "git.upload_pack",
    });
    await runProcess(
      "git",
      [
        "clone",
        ...(config.sourceDefaultBranch
          ? ["--branch", config.sourceDefaultBranch]
          : []),
        "--",
        proxyUrl.toString(),
        cloneRoot,
      ],
      "/tmp",
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: ${credential.authorization}`,
        GIT_TERMINAL_PROMPT: "0",
      }
    );
    for (const entry of await readdir(cloneRoot)) {
      await cp(path.join(cloneRoot, entry), path.join(config.workspaceRoot, entry), {
        recursive: true,
        force: true,
      });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function pushManagedCandidateBranch(input: {
  ticket: ReturnType<typeof authorizeWorkspaceRequest>;
  authorization: string;
  promotionId: string;
  candidateFingerprint: string;
}) {
  if (!(config.sourceResourceId && config.controlPlaneUrl)) {
    throw new WorkspaceRequestError(500, "WORKSPACE_SOURCE_NOT_CONFIGURED");
  }
  const preview = await withRunnerClient(
    (client, context) =>
      client.previewWorkspacePromotion(
        {
          sessionId: input.ticket.threadId,
          promotionId: input.promotionId,
        },
        context
      ),
    input.ticket
  );
  const promotion = preview.preview?.promotion;
  const worktreeRoot = readRecordString(promotion, "managedWorktreeRoot");
  const baseHead = readRecordString(promotion, "baseHead");
  if (
    preview.preview?.status !== "ready" ||
    preview.preview.candidateFingerprint !== input.candidateFingerprint ||
    promotion?.runId !== input.ticket.runId ||
    !worktreeRoot ||
    !baseHead
  ) {
    throw new WorkspaceRequestError(409, "GITHUB_PUSH_CANDIDATE_CHANGED");
  }
  const temporaryRoot = await mkdtemp("/tmp/kestrel-git-bundle-");
  const bundlePath = path.join(temporaryRoot, "candidate.bundle");
  const indexPath = path.join(temporaryRoot, "candidate.index");
  const bundleRef = `refs/kestrel/bundles/${input.ticket.runId}`;
  try {
    const candidateEnvironment = {
      GIT_INDEX_FILE: indexPath,
      GIT_AUTHOR_NAME: "Kestrel Agent",
      GIT_AUTHOR_EMAIL: "agent@kestrel.invalid",
      GIT_COMMITTER_NAME: "Kestrel Agent",
      GIT_COMMITTER_EMAIL: "agent@kestrel.invalid",
    };
    await runProcess(
      "git",
      ["read-tree", baseHead],
      worktreeRoot,
      candidateEnvironment
    );
    await runProcess(
      "git",
      ["add", "-A", "--", "."],
      worktreeRoot,
      candidateEnvironment
    );
    const candidateTree = (
      await runProcessOutput(
        "git",
        ["write-tree"],
        worktreeRoot,
        candidateEnvironment
      )
    ).trim();
    const candidateCommit = (
      await runProcessOutput(
        "git",
        [
          "commit-tree",
          candidateTree,
          "-p",
          baseHead,
          "-m",
          `Kestrel candidate ${input.ticket.runId}`,
        ],
        worktreeRoot,
        candidateEnvironment
      )
    ).trim();
    await runProcess(
      "git",
      ["update-ref", bundleRef, candidateCommit],
      worktreeRoot,
      {}
    );
    await runProcess(
      "git",
      ["bundle", "create", bundlePath, bundleRef, `^${baseHead}`],
      worktreeRoot,
      {}
    );
    const bundleStream = Readable.toWeb(
      createReadStream(bundlePath)
    ) as ReadableStream<Uint8Array>;
    const credential = await requestGitHubToolCredential({
      controlPlaneUrl: config.controlPlaneUrl,
      executionAuthorization: input.authorization,
      resourceId: config.sourceResourceId,
      operation: "repository.push_agent_branch",
      candidateFingerprint: input.candidateFingerprint,
    });
    const pushResponse = await fetch(
      new URL("/api/runtime/github/push", config.controlPlaneUrl),
      {
        method: "POST",
        headers: {
          authorization: credential.authorization,
          "content-type": "application/x-git-bundle",
          "x-kestrel-resource-id": config.sourceResourceId,
          "x-kestrel-candidate-fingerprint": input.candidateFingerprint,
        },
        body: bundleStream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }
    );
    const payload = (await pushResponse.json()) as {
      branch?: string;
      repository?: string;
      error?: { code?: string };
    };
    if (!(pushResponse.ok && payload.branch)) {
      throw new WorkspaceRequestError(
        pushResponse.status,
        payload.error?.code ?? "GITHUB_PUSH_FAILED"
      );
    }
    return payload;
  } finally {
    await runProcess(
      "git",
      ["update-ref", "-d", bundleRef],
      worktreeRoot,
      {}
    ).catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function readRecordString(value: unknown, key: string) {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string>
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.resume();
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new WorkspaceRequestError(502, "WORKSPACE_SOURCE_CLONE_FAILED")
        );
    });
  });
}

function runProcessOutput(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string>
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.resume();
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new WorkspaceRequestError(502, "WORKSPACE_GIT_COMMAND_FAILED"));
    });
  });
}

function proxyHttp(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  target: { port: number; path: string; authorization?: string }
) {
  return new Promise<void>((resolve) => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: target.port,
        method: incoming.method,
        path: target.path,
        headers: buildWorkspaceProxyHeaders({
          incoming: incoming.headers,
          port: target.port,
          ...(target.authorization
            ? { authorization: target.authorization }
            : {}),
        }),
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
        response.once("end", resolve);
      }
    );
    upstream.on("error", () => {
      writeJson(outgoing, 502, { error: { code: "UPSTREAM_UNAVAILABLE" } });
      resolve();
    });
    incoming.pipe(upstream);
  });
}

async function listDirectory(directory: string, root: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    const metadata = await stat(absolute);
    return {
      name: entry.name,
      path: path.relative(root, absolute),
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      size: metadata.size,
      updatedAt: metadata.mtime.toISOString(),
    };
  }));
}

function executeCommand(command: string, cwd: string) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("/bin/sh", ["-lc", command], { cwd, env: process.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("exit", (exitCode) => resolve({
      exitCode,
      stdout: Buffer.concat(stdout).subarray(0, 1_000_000).toString("utf8"),
      stderr: Buffer.concat(stderr).subarray(0, 1_000_000).toString("utf8"),
    }));
  });
}

function streamWorkspaceBackup(response: ServerResponse) {
  return new Promise<void>((resolve, reject) => {
    response.writeHead(200, {
      "content-type": "application/gzip",
      "cache-control": "no-store",
      "content-disposition": "attachment; filename=workspace.tar.gz",
    });
    const child = spawn("tar", ["-czf", "-", "-C", config.workspaceRoot, "."]);
    child.stdout.pipe(response);
    child.stderr.on("data", () => {});
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new WorkspaceRequestError(500, "WORKSPACE_BACKUP_FAILED"));
    });
  });
}

async function readBody(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new WorkspaceRequestError(413, "REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function requireCapability(capabilities: string[], capability: string) {
  if (!capabilities.includes(capability)) {
    throw new WorkspaceRequestError(403, "WORKSPACE_CAPABILITY_DENIED");
  }
}

function readConfig() {
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  return {
    port: Number.parseInt(process.env.KESTREL_WORKSPACE_PORT ?? "43104", 10),
    listenHost: workspaceListenHost({
      flyPrivateIp: process.env.FLY_PRIVATE_IP,
      configuredHost: process.env.KESTREL_WORKSPACE_HOST,
    }),
    workspaceRoot: path.resolve(process.env.KESTREL_WORKSPACE_ROOT ?? "/workspace"),
    workspaceId: required("KESTREL_WORKSPACE_ID"),
    organizationId: required("KESTREL_ORGANIZATION_ID"),
    environmentId: required("KESTREL_ENVIRONMENT_ID"),
    machineId: required("FLY_MACHINE_ID"),
    ticketPublicKey: required("KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY"),
    profileId: process.env.KESTREL_ONE_PROFILE_ID?.trim() || "kestrel-one",
    controlPlaneUrl: required("KESTREL_CONTROL_PLANE_URL"),
    credentialBrokerToken: required(
      "KESTREL_ONE_CREDENTIAL_BROKER_TOKEN"
    ),
    sourceType: process.env.KESTREL_WORKSPACE_SOURCE_TYPE?.trim() ?? "blank",
    sourceResourceId:
      process.env.KESTREL_WORKSPACE_SOURCE_RESOURCE_ID?.trim() ?? "",
    sourceRepository:
      process.env.KESTREL_WORKSPACE_SOURCE_REPOSITORY?.trim() ?? "",
    sourceDefaultBranch:
      process.env.KESTREL_WORKSPACE_SOURCE_DEFAULT_BRANCH?.trim() ?? "",
    idleTimeoutMinutes: Number.parseInt(process.env.KESTREL_IDLE_TIMEOUT_MINUTES ?? "15", 10),
  };
}

function parseJson(value: Buffer) {
  try { return JSON.parse(value.toString("utf8")) as unknown; }
  catch { throw new WorkspaceRequestError(400, "REQUEST_JSON_INVALID"); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJson(response: ServerResponse, status: number, body: unknown) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function shutdown(code: number) {
  clearInterval(idleTimer);
  void applications.stopAll();
  void backupImports.closeAll();
  terminals.closeAll();
  runner?.kill("SIGTERM");
  server.close(() => process.exit(code));
}
