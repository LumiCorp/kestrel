import {
  EnvironmentTicketError,
  verifyEnvironmentExecutionTicket,
  type EnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";

export type RouterDecision =
  | { status: 200; targetUrl: string; ticket: EnvironmentExecutionTicket }
  | { status: 400 | 401 | 403; code: string };

export function authorizeEnvironmentHttpRequest(input: {
  authorization: string | undefined;
  pathname: string;
  method: string;
  publicKey: string;
  expectedAppName?: string | undefined;
  now?: number;
}): RouterDecision {
  const verified = verifyBearer({
    authorization: input.authorization,
    publicKey: input.publicKey,
    expectedAppName: input.expectedAppName,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if ("status" in verified) return verified;
  const capability = workspaceHttpCapability(input.method, input.pathname);
  if (!capability || !verified.ticket.capabilities.includes(capability)) {
    return { status: 403, code: "ENVIRONMENT_CAPABILITY_DENIED" };
  }
  return {
    status: 200,
    targetUrl: workspaceTarget(verified.ticket),
    ticket: verified.ticket,
  };
}

const COMMAND_CAPABILITIES: Readonly<Record<string, string>> = {
  "profile.get": "profile.read",
  "run.start": "run.stream",
  "run.cancel": "run.cancel",
  "session.describe": "session.read",
  "session.state": "session.read",
};

export function authorizeEnvironmentSubscription(input: {
  authorization: string | undefined;
  body: unknown;
  publicKey: string;
  expectedAppName?: string | undefined;
  now?: number;
}): RouterDecision {
  const verified = verifyBearer(input);
  if ("status" in verified) return verified;
  if (!verified.ticket.capabilities.includes("events.subscribe")) {
    return { status: 403, code: "ENVIRONMENT_CAPABILITY_DENIED" };
  }
  const body = isRecord(input.body) ? input.body : null;
  const metadata = body && isRecord(body.metadata) ? body.metadata : null;
  const filter = body && isRecord(body.filter) ? body.filter : null;
  if (metadata?.tenantId !== verified.ticket.organizationId) {
    return { status: 403, code: "ENVIRONMENT_TENANT_MISMATCH" };
  }
  if (filter?.sessionId !== verified.ticket.threadId) {
    return { status: 403, code: "ENVIRONMENT_THREAD_MISMATCH" };
  }
  return {
    status: 200,
    targetUrl: workspaceTarget(verified.ticket),
    ticket: verified.ticket,
  };
}

export function authorizeEnvironmentRequest(input: {
  authorization: string | undefined;
  body: unknown;
  publicKey: string;
  expectedAppName?: string | undefined;
  now?: number;
}): RouterDecision {
  const verified = verifyBearer(input);
  if ("status" in verified) return verified;
  const { ticket } = verified;
  const command = parseCommand(input.body);
  if (!command) return { status: 400, code: "RUNNER_COMMAND_INVALID" };
  if (command.tenantId !== ticket.organizationId) {
    return { status: 403, code: "ENVIRONMENT_TENANT_MISMATCH" };
  }
  const requiredCapability = command.type === "operator.run.reasoning"
    ? command.action === "delete" ? "reasoning.delete" : "reasoning.read"
    : COMMAND_CAPABILITIES[command.type];
  if (!requiredCapability || !ticket.capabilities.includes(requiredCapability)) {
    return { status: 403, code: "ENVIRONMENT_CAPABILITY_DENIED" };
  }
  if (command.sessionId && command.sessionId !== ticket.threadId) {
    return { status: 403, code: "ENVIRONMENT_THREAD_MISMATCH" };
  }
  return {
    status: 200,
    targetUrl: workspaceTarget(ticket),
    ticket,
  };
}

function verifyBearer(input: {
  authorization: string | undefined;
  publicKey: string;
  expectedAppName?: string | undefined;
  now?: number;
}):
  | { ticket: EnvironmentExecutionTicket }
  | { status: 401 | 403; code: string } {
  const token = readBearer(input.authorization);
  if (!token) return { status: 401, code: "ENVIRONMENT_TICKET_REQUIRED" };
  try {
    const ticket = verifyEnvironmentExecutionTicket({
      token,
      publicKey: input.publicKey,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    if (
      input.expectedAppName &&
      ticket.flyAppName !== input.expectedAppName
    ) {
      return { status: 403, code: "ENVIRONMENT_APP_MISMATCH" };
    }
    return { ticket };
  } catch (error) {
    return {
      status: 401,
      code:
        error instanceof EnvironmentTicketError
          ? error.code
          : "TICKET_INVALID",
    };
  }
}

function workspaceTarget(ticket: EnvironmentExecutionTicket) {
  const host = `${ticket.flyMachineId}.vm.${ticket.flyAppName}.internal`;
  return `http://${host}:43104`;
}

function workspaceHttpCapability(method: string, pathname: string) {
  if (method === "GET" && (pathname === "/v1/files" || pathname === "/v1/tree")) {
    return "workspace.files.read";
  }
  if (method === "PUT" && pathname === "/v1/files") {
    return "workspace.files.write";
  }
  if (method === "POST" && pathname === "/v1/terminal/exec") {
    return "workspace.terminal.exec";
  }
  if (
    (method === "POST" && pathname === "/v1/terminal/sessions") ||
    (method === "POST" &&
      /^\/v1\/terminal\/sessions\/[^/]+\/input$/u.test(pathname)) ||
    (method === "GET" &&
      /^\/v1\/terminal\/sessions\/[^/]+\/output$/u.test(pathname)) ||
    (method === "DELETE" &&
      /^\/v1\/terminal\/sessions\/[^/]+$/u.test(pathname))
  ) {
    return "workspace.terminal.exec";
  }
  if (
    method === "GET" &&
    (pathname === "/v1/apps" ||
      /^\/v1\/apps\/[^/]+\/proxy(?:\/.*)?$/u.test(pathname))
  ) {
    return "workspace.apps.read";
  }
  if (method === "POST" && pathname === "/v1/apps") {
    return "workspace.apps.write";
  }
  if (method === "GET" && pathname === "/v1/backups/export") {
    return "workspace.backups.export";
  }
  if (
    method === "GET" &&
    (pathname === "/v1/promotions" ||
      /^\/v1\/promotions\/[^/]+$/u.test(pathname))
  ) {
    return "workspace.promotions.read";
  }
  if (
    method === "POST" &&
    /^\/v1\/promotions\/[^/]+\/apply$/u.test(pathname)
  ) {
    return "workspace.promotions.apply";
  }
  if (
    (method === "POST" && pathname === "/v1/backups/imports") ||
    (method === "PUT" &&
      /^\/v1\/backups\/imports\/[^/]+\/chunks\/\d+$/u.test(pathname)) ||
    (method === "POST" &&
      /^\/v1\/backups\/imports\/[^/]+\/complete$/u.test(pathname)) ||
    (method === "DELETE" &&
      /^\/v1\/backups\/imports\/[^/]+$/u.test(pathname))
  ) {
    return "workspace.backups.restore";
  }
  return null;
}

function parseCommand(value: unknown): {
  type: string;
  tenantId: string | undefined;
  sessionId: string | undefined;
  action: string | undefined;
} | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const metadata = isRecord(value.metadata) ? value.metadata : null;
  const payload = isRecord(value.payload) ? value.payload : null;
  const turn = payload && isRecord(payload.turn) ? payload.turn : null;
  return {
    type: value.type,
    action: payload && typeof payload.action === "string" ? payload.action : undefined,
    tenantId:
      metadata && typeof metadata.tenantId === "string"
        ? metadata.tenantId
        : undefined,
    sessionId:
      turn && typeof turn.sessionId === "string"
        ? turn.sessionId
        : payload && typeof payload.sessionId === "string"
          ? payload.sessionId
          : undefined,
  };
}

function readBearer(value: string | undefined) {
  const match = value?.match(/^Bearer ([^\s]+)$/u);
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
