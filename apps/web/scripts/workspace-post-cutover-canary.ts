import { parseRunnerHostedToolApprovalInteractionV4 } from "@kestrel-agents/protocol";
import { hasCompletedExecCommandCanaryProof } from "../lib/environments/workspace-command-canary";
import type { ThreadInteractionView } from "../lib/turns/client-contract";
import {
  createWorkspaceCanaryTurnBody,
  readWorkspaceCanaryTurnStatus,
  selectWorkspaceCanaryModel,
  type WorkspaceCanaryApprovedModel,
  type WorkspaceCanaryModel,
} from "./lib/workspace-canary-model";
import { parseWorkspaceCanaryRevision } from "./lib/workspace-canary-revision";
import {
  assertExecCommandNoSpendPreflight,
  isCurrentExecCommandApprovalActionable,
} from "./lib/workspace-command-approval-canary";

type EnvironmentState = {
  binding?: {
    threadId?: string;
    environmentId?: string;
    workspaceId?: string;
  };
  environment?: { id?: string };
  workspace?: { id?: string; status?: string };
  activation?: {
    stage?: string;
    detail?: string;
    status?: "pending" | "ready" | "failed";
  };
  error?: unknown;
};

type WorkspaceApplication = {
  id: string;
  name: string;
  command: string;
  workingDirectory: string;
  port: number;
  desiredState: "running" | "stopped";
  status: "starting" | "running" | "stopped" | "failed";
};

type CanaryMessage = {
  role?: unknown;
  metadata?: { kestrelTurnId?: unknown } | null;
  parts?: unknown;
};

type ThreadSnapshot = {
  messages?: CanaryMessage[];
  interactions?: ThreadInteractionView[];
};

type ExactExecCommandApproval = {
  interactionId: string;
  requestId: string;
  turnId: string;
};

export {};

const ACTIVATION_TIMEOUT_MS = 120_000;
const APPLICATION_TIMEOUT_MS = 20_000;
const PTY_TIMEOUT_MS = 15_000;
const AGENT_TURN_TIMEOUT_MS = 300_000;
const APP_NAME = "Kestrel post-cutover canary";
const APP_RESPONSE = "kestrel-one-workspace-canary";
const APP_COMMAND = `node -e "require('http').createServer((_request,response)=>response.end('${APP_RESPONSE}')).listen(Number(process.env.PORT),'0.0.0.0')"`;

const baseUrl = requiredUrl("KESTREL_ONE_CANARY_URL");
const cookie = required("KESTREL_ONE_CANARY_COOKIE");
const threadId = required("KESTREL_ONE_CANARY_THREAD_ID");
const requestedModelId = required("KESTREL_ONE_CANARY_MODEL_ID");
const appPort = requiredPort("KESTREL_ONE_CANARY_APP_PORT");
const workspaceBase = `/api/threads/${threadId}/workspace`;
const nonce = crypto.randomUUID();
const filePath = `kestrel-one-canary-${nonce}.txt`;
const initialContent = `initial-${nonce}\n`;
const updatedContent = `updated-${nonce}\n`;
const ptyMarker = `pty-${nonce}`;
const agentCommandMarker = `kestrel-command-canary-${nonce}`;
const activationStages = new Set<string>();
let terminalSessionId: string | null = null;
let canaryApplication: WorkspaceApplication | null = null;
let fileCreated = false;

const thread = await requestJson<{ id?: string }>(`/api/threads/${threadId}`);
assert(thread.id === threadId, "The designated canary Thread is unavailable.");

const activationStarted = await requestJson<EnvironmentState>(
  `/api/threads/${threadId}/environment`,
  { method: "POST" },
);
recordActivation(activationStarted);
const readyState = await waitForActivation(activationStarted);
assertEnvironmentIdentity(readyState);
const environmentId = readyState.environment!.id!;
const workspaceId = readyState.workspace!.id!;
const approvedModels = await requestJson<{
  models?: WorkspaceCanaryApprovedModel[];
}>(
  `/api/models/approved?threadId=${encodeURIComponent(threadId)}&modality=language`,
);
const canaryModel: WorkspaceCanaryModel = selectWorkspaceCanaryModel(
  approvedModels.models ?? [],
  requestedModelId,
);

try {
  const exactToolPreflight = await requestJson<unknown>(
    `/api/threads/${threadId}/workspace/canary/exact-tool-preflight`,
    { method: "POST" },
  );
  assertExecCommandNoSpendPreflight(exactToolPreflight);
  await runAgentCommandCanary(agentCommandMarker);

  const created = await workspaceJson<{
    exitCode?: number | null;
    stderr?: string;
  }>("terminal/exec", {
    method: "POST",
    json: {
      command: `printf %s ${shellQuote(initialContent)} > ${shellQuote(filePath)}`,
    },
  });
  assert(
    created.exitCode === 0,
    `Canary file creation failed: ${created.stderr ?? "unknown error"}`,
  );
  fileCreated = true;

  const initialFile = await workspaceRequest(
    `files?path=${encodeURIComponent(filePath)}`,
  );
  await assertOk(initialFile, "Canary file read failed.");
  const initialRevision = parseWorkspaceCanaryRevision(
    initialFile.headers.get("etag"),
  );
  assert(
    (await initialFile.text()) === initialContent,
    "The initial canary file content was not preserved.",
  );

  const saved = await workspaceRequest(
    `files?path=${encodeURIComponent(filePath)}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "if-match": initialRevision!,
      },
      body: updatedContent,
    },
  );
  await assertOk(saved, "Optimistic Workspace file save failed.");
  const updatedRevision = parseWorkspaceCanaryRevision(
    saved.headers.get("etag"),
  );
  assert(
    updatedRevision !== initialRevision,
    "The Workspace file revision did not advance.",
  );

  const stale = await workspaceRequest(
    `files?path=${encodeURIComponent(filePath)}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "if-match": initialRevision!,
      },
      body: `stale-${nonce}\n`,
    },
  );
  assert(
    stale.status === 409,
    "A stale Workspace file write was not rejected.",
  );
  const stalePayload = (await stale.json()) as { error?: { code?: string } };
  assert(
    stalePayload.error?.code === "WORKSPACE_FILE_REVISION_CONFLICT",
    "The stale Workspace write returned the wrong failure code.",
  );

  const updatedFile = await workspaceRequest(
    `files?path=${encodeURIComponent(filePath)}`,
  );
  await assertOk(updatedFile, "Updated canary file read failed.");
  assert(
    (await updatedFile.text()) === updatedContent,
    "The accepted Workspace file edit was not retained.",
  );
  const tree = await workspaceJson<{
    entries?: Array<{ name?: string; path?: string }>;
  }>("tree");
  assert(
    tree.entries?.some(
      (entry) => entry.name === filePath || entry.path === filePath,
    ) === true,
    "The live Workspace tree did not contain the canary file.",
  );

  const terminal = await workspaceJson<{ id?: string; status?: string }>(
    "terminal/sessions",
    { method: "POST", json: { cwd: "" } },
  );
  assert(Boolean(terminal.id), "The audited PTY session did not open.");
  terminalSessionId = terminal.id!;
  await workspaceJson<{ ok?: boolean }>(
    `terminal/sessions/${terminalSessionId}/input`,
    {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: `printf '%s\\n' ${shellQuote(ptyMarker)}\n`,
    },
  );
  await waitForPtyOutput(terminalSessionId, ptyMarker);
  await closeTerminal();

  canaryApplication = await getOrCreateCanaryApplication();
  await setApplicationState(canaryApplication.id, "stop");
  await waitForApplication(canaryApplication.id, "stopped");
  await setApplicationState(canaryApplication.id, "start");
  canaryApplication = await waitForApplication(canaryApplication.id, "running");
  await waitForApplicationProxy(canaryApplication.id);
  await setApplicationState(canaryApplication.id, "stop");
  canaryApplication = await waitForApplication(canaryApplication.id, "stopped");

  const finalState = await requestJson<EnvironmentState>(
    `/api/threads/${threadId}/environment`,
  );
  assertEnvironmentIdentity(finalState, { environmentId, workspaceId });
} finally {
  await closeTerminal();
  if (canaryApplication?.id) {
    await setApplicationState(canaryApplication.id, "stop");
    canaryApplication = await waitForApplication(
      canaryApplication.id,
      "stopped",
    );
  }
  if (fileCreated) {
    const removed = await workspaceJson<{
      exitCode?: number | null;
      stderr?: string;
    }>("terminal/exec", {
      method: "POST",
      json: { command: `rm -f -- ${shellQuote(filePath)}` },
    });
    assert(
      removed.exitCode === 0,
      `Canary file cleanup failed: ${removed.stderr ?? "unknown error"}`,
    );
    const missing = await workspaceRequest(
      `files?path=${encodeURIComponent(filePath)}`,
    );
    assert(missing.status === 404, "The temporary canary file still exists.");
    const missingPayload = (await missing.json()) as {
      error?: { code?: string };
    };
    assert(
      missingPayload.error?.code === "WORKSPACE_FILE_NOT_FOUND",
      "Canary file cleanup returned the wrong terminal state.",
    );
  }
}

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      threadId,
      environmentId,
      workspaceId,
      canaryModel,
      activationStages: [...activationStages],
      applicationId: canaryApplication?.id,
      proofs: [
        "thread_identity_preserved",
        "environment_binding_stable",
        "activation_reached_ready",
        "live_workspace_tree",
        "optimistic_file_editing",
        "stale_file_write_rejected",
        "audited_terminal_execution",
        "agent_exec_command_no_spend_preflight",
        "agent_exec_command_reached_ask_first_card",
        "agent_exec_command_approve_once_submitted",
        "agent_exec_command_completed",
        "audited_pty_round_trip",
        "supervised_application_start_stop",
        "private_application_proxy",
        "canary_file_removed",
      ],
    },
    null,
    2,
  ) + "\n",
);

async function waitForActivation(initial: EnvironmentState) {
  let state = initial;
  const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;
  while (state.activation?.status === "pending") {
    if (Date.now() >= deadline) {
      throw new Error("Workspace activation timed out.");
    }
    await sleep(1000);
    state = await requestJson<EnvironmentState>(
      `/api/threads/${threadId}/environment`,
    );
    recordActivation(state);
  }
  if (state.activation?.status !== "ready") {
    throw new Error(
      state.activation?.detail ?? "Workspace activation did not become ready.",
    );
  }
  return state;
}

async function runAgentCommandCanary(marker: string) {
  const messageId = crypto.randomUUID();
  const command = `printf '%s' ${shellQuote(marker)}`;
  const created = await requestJson<{ turn?: { id?: string; status?: string } }>(
    `/api/threads/${threadId}/turns`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": messageId,
      },
      body: JSON.stringify(
        createWorkspaceCanaryTurnBody({
          messageId,
          modelId: canaryModel.id,
          command,
        }),
      ),
    },
  );
  const turnId = created.turn?.id;
  assert(Boolean(turnId), "The build-mode command canary turn was not queued.");

  const deadline = Date.now() + AGENT_TURN_TIMEOUT_MS;
  let approval: ExactExecCommandApproval | null = null;
  while (Date.now() < deadline) {
    const queue = await requestJson<{
      turns?: Array<{ id?: string; status?: string }>;
    }>(`/api/threads/${threadId}/turns`);
    const turn = queue.turns?.find((candidate) => candidate.id === turnId);
    const status = readWorkspaceCanaryTurnStatus(turn?.status);
    if (status === "completed") {
      throw new Error(
        "The exact exec_command completed without reaching an Ask First approval card.",
      );
    }
    if (turn?.status === "waiting_for_input") {
      const snapshot = await requestJson<ThreadSnapshot>(
        `/api/threads/${threadId}`,
      );
      approval = findExactExecCommandApproval({
        snapshot,
        turnId: turnId!,
        command,
      });
      if (approval) break;
    }
    await sleep(1000);
  }
  assert(
    approval !== null,
    "The exact exec_command did not reach its Ask First approval card before the canary timed out.",
  );

  const approvalMessageId = crypto.randomUUID();
  const approvalResponse = await request(`/api/threads/${threadId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      interactionResponse: {
        requestId: approval.requestId,
        eventType: "user.approval",
        turnId: approval.turnId,
        message: "Approve once",
        decision: "approve_once",
        reason: "Kestrel post-cutover exec_command canary",
        messageId: approvalMessageId,
      },
    }),
  });
  await assertOk(
    approvalResponse,
    "Approve Once was not accepted by the durable interaction API.",
  );
  const replayCompleted = approvalResponse.arrayBuffer();

  const completionDeadline = Date.now() + AGENT_TURN_TIMEOUT_MS;
  while (Date.now() < completionDeadline) {
    const queue = await requestJson<{
      turns?: Array<{ id?: string; status?: string }>;
    }>(`/api/threads/${threadId}/turns`);
    const turn = queue.turns?.find((candidate) => candidate.id === turnId);
    const status = readWorkspaceCanaryTurnStatus(turn?.status);
    if (status === "completed") {
      const snapshot = await requestJson<ThreadSnapshot>(
        `/api/threads/${threadId}`,
      );
      assert(
        hasApproveOnceTerminal(snapshot.interactions ?? [], approval),
        "The exact approval interaction did not record an accepted Approve Once decision and committed effect.",
      );
      assert(
        hasCompletedExecCommandCanaryProof(
          snapshot.messages ?? [],
          turnId!,
          marker,
        ),
        "The approved build-mode turn completed without an OK exec_command tool record containing the marker.",
      );
      await replayCompleted;
      return;
    }
    await sleep(1000);
  }
  throw new Error(
    "The approved build-mode command canary did not complete before timing out.",
  );
}

function findExactExecCommandApproval(input: {
  snapshot: ThreadSnapshot;
  turnId: string;
  command: string;
}): ExactExecCommandApproval | null {
  const toolCalls = new Set<string>();
  for (const message of input.snapshot.messages ?? []) {
    if (
      message.role !== "assistant" ||
      message.metadata?.kestrelTurnId !== input.turnId ||
      !Array.isArray(message.parts)
    ) {
      continue;
    }
    for (const part of message.parts) {
      const partRecord = asRecord(part);
      const data = asRecord(partRecord?.data);
      const toolInput = asRecord(data?.input);
      if (
        partRecord?.type === "data-kestrel-tool" &&
        data?.phase === "started" &&
        data.toolName === "exec_command" &&
        typeof data.toolCallId === "string" &&
        toolInput?.command === input.command
      ) {
        toolCalls.add(data.toolCallId);
      }
    }
  }

  for (const interaction of input.snapshot.interactions ?? []) {
    if (
      interaction.source !== "runtime" ||
      interaction.kind !== "approval" ||
      interaction.eventType !== "user.approval" ||
      interaction.status !== "pending" ||
      interaction.turnId !== input.turnId
    ) {
      continue;
    }
    let request;
    try {
      request = parseRunnerHostedToolApprovalInteractionV4(
        interaction.requestEnvelope,
        interaction.eventType,
      );
    } catch {
      continue;
    }
    const presentation = asRecord(request.approval.presentation);
    const policy = asRecord(presentation?.policy);
    const decisions = request.inputSchema.properties.decision.enum;
    const askFirstPolicy = interaction.approvalPolicy;
    if (
      request.requestId === interaction.requestId &&
      request.approval.toolName === "exec_command" &&
      toolCalls.has(request.approval.preparedInvocationId) &&
      decisions.length === 3 &&
      decisions[0] === "decline" &&
      decisions[1] === "approve_once" &&
      decisions[2] === "remember_approval" &&
      typeof presentation?.title === "string" &&
      presentation.title.length > 0 &&
      typeof presentation.summary === "string" &&
      presentation.summary.length > 0 &&
      policy?.mode === "ask" &&
      (policy.reasonCode === "environment_policy" ||
        policy.reasonCode === "project_restriction") &&
      isCurrentExecCommandApprovalActionable(askFirstPolicy)
    ) {
      return {
        interactionId: interaction.id,
        requestId: interaction.requestId,
        turnId: input.turnId,
      };
    }
  }
  return null;
}

function hasApproveOnceTerminal(
  interactions: ThreadInteractionView[],
  approval: ExactExecCommandApproval,
) {
  const interaction = interactions.find(
    (candidate) => candidate.id === approval.interactionId,
  );
  return interaction?.requestId === approval.requestId &&
    interaction.turnId === approval.turnId &&
    interaction.status === "resolved" &&
    interaction.responseEnvelope?.decision === "approve_once" &&
    interaction.approvalOutcome?.decision === "approved" &&
    interaction.approvalOutcome.authorizationState === "accepted" &&
    interaction.approvalOutcome.effectState === "committed";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordActivation(state: EnvironmentState) {
  if (state.activation?.stage) activationStages.add(state.activation.stage);
}

function assertEnvironmentIdentity(
  state: EnvironmentState,
  expected?: { environmentId: string; workspaceId: string },
) {
  assert(
    state.binding?.threadId === threadId,
    "The Environment binding changed the Thread identity.",
  );
  assert(
    Boolean(
      state.environment?.id &&
      state.workspace?.id &&
      state.binding.environmentId === state.environment.id &&
      state.binding.workspaceId === state.workspace.id,
    ),
    "The Environment, Workspace, and Thread binding identities disagree.",
  );
  if (expected) {
    assert(
      state.environment?.id === expected.environmentId &&
        state.workspace?.id === expected.workspaceId,
      "The Environment or Workspace identity changed during the canary.",
    );
  }
}

async function waitForPtyOutput(sessionId: string, marker: string) {
  const deadline = Date.now() + PTY_TIMEOUT_MS;
  let cursor = 0;
  let output = "";
  while (Date.now() < deadline) {
    const payload = await workspaceJson<{
      output?: string;
      cursor?: number;
      status?: string;
    }>(`terminal/sessions/${sessionId}/output?cursor=${cursor}`);
    output += payload.output ?? "";
    cursor = payload.cursor ?? cursor;
    if (output.includes(marker)) return;
    if (payload.status && payload.status !== "running") break;
    await sleep(250);
  }
  throw new Error("The audited PTY did not return the canary marker.");
}

async function closeTerminal() {
  if (!terminalSessionId) return;
  const sessionId = terminalSessionId;
  terminalSessionId = null;
  const response = await workspaceRequest(`terminal/sessions/${sessionId}`, {
    method: "DELETE",
  });
  await assertOk(response, "The audited PTY session did not close.");
}

async function getOrCreateCanaryApplication() {
  const applications = await listApplications();
  const existing = applications.find(
    (application) => application.name === APP_NAME,
  );
  if (existing) {
    assert(
      existing.command === APP_COMMAND &&
        existing.workingDirectory === "" &&
        existing.port === appPort,
      "The existing Workspace canary application has different configuration.",
    );
    return existing;
  }
  const payload = await workspaceJson<{ application?: WorkspaceApplication }>(
    "apps",
    {
      method: "POST",
      json: {
        name: APP_NAME,
        command: APP_COMMAND,
        workingDirectory: "",
        port: appPort,
      },
    },
  );
  assert(
    Boolean(payload.application),
    "The canary application was not created.",
  );
  return payload.application!;
}

async function listApplications() {
  const payload = await workspaceJson<{
    applications?: WorkspaceApplication[];
  }>("apps");
  return payload.applications ?? [];
}

async function setApplicationState(id: string, action: "start" | "stop") {
  const payload = await workspaceJson<{ application?: WorkspaceApplication }>(
    `apps/${id}/${action}`,
    { method: "POST" },
  );
  assert(
    Boolean(payload.application),
    `The canary application could not ${action}.`,
  );
  return payload.application!;
}

async function waitForApplication(id: string, expected: "running" | "stopped") {
  const deadline = Date.now() + APPLICATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const application = (await listApplications()).find(
      (candidate) => candidate.id === id,
    );
    if (application?.status === expected) return application;
    if (application?.status === "failed") {
      throw new Error("The supervised canary application failed.");
    }
    await sleep(250);
  }
  throw new Error(`The canary application did not become ${expected}.`);
}

async function waitForApplicationProxy(id: string) {
  const deadline = Date.now() + APPLICATION_TIMEOUT_MS;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const response = await workspaceRequest(`apps/${id}/proxy/`);
    lastStatus = response.status;
    if (response.ok && (await response.text()) === APP_RESPONSE) return;
    await sleep(250);
  }
  throw new Error(
    `The private application proxy did not become ready (last status ${lastStatus}).`,
  );
}

async function workspaceJson<T = unknown>(
  path: string,
  input: RequestInit & { json?: unknown } = {},
) {
  const { json, ...init } = input;
  const response = await workspaceRequest(path, {
    ...init,
    ...(json === undefined
      ? {}
      : {
          headers: {
            ...Object.fromEntries(new Headers(init.headers).entries()),
            "content-type": "application/json",
          },
          body: JSON.stringify(json),
        }),
  });
  await assertOk(response, `Workspace ${init.method ?? "GET"} ${path} failed.`);
  return (await response.json()) as T;
}

function workspaceRequest(path: string, init: RequestInit = {}) {
  return request(`${workspaceBase}/${path}`, init);
}

async function requestJson<T>(pathname: string, init: RequestInit = {}) {
  const response = await request(pathname, init);
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `${init.method ?? "GET"} ${pathname} returned non-JSON status ${response.status}.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${pathname} failed (${response.status}): ${JSON.stringify(payload)}`,
    );
  }
  return payload as T;
}

function request(pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("accept", headers.get("accept") ?? "application/json");
  headers.set("cookie", cookie);
  headers.set("origin", baseUrl.origin);
  return fetch(new URL(pathname, baseUrl), {
    ...init,
    headers,
    redirect: "manual",
  });
}

async function assertOk(response: Response, message: string) {
  if (response.ok) return;
  throw new Error(
    `${message} (${response.status}): ${(await response.text()).slice(0, 1000)}`,
  );
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredPort(name: string) {
  const value = Number(required(name));
  if (!(Number.isInteger(value) && value >= 1024 && value <= 65_535)) {
    throw new Error(`${name} must be an integer between 1024 and 65535.`);
  }
  if (value === 43_104 || value === 43_105) {
    throw new Error(`${name} conflicts with a reserved Workspace port.`);
  }
  return value;
}

function requiredUrl(name: string) {
  const url = new URL(required(name));
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") {
    throw new Error(`${name} must use HTTPS outside local development.`);
  }
  return url;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
