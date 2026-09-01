import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyEnvironmentToolCredential } from "@lumi/kestrel-environment-auth";

const MAX_BROWSER_REVISION_BYTES = 256 * 1024;
const BROWSER_REVISION_TIMEOUT_MS = 10_000;

type BrowserRevisionEnvelope = {
  organizationId: string;
  environmentId: string;
  userId: string;
  threadId: string;
  runId: string;
  instruction: {
    version: "hosted_browser_revision_instruction_v1";
    sessionId: string;
    generation: number;
    revision: string;
    cause: "personal_grant" | "personal_revocation";
    authority: {
      version: "browser_effective_domain_authority_v1";
      environmentId: string;
      projectId: string;
      userId: string;
      enabledModes: unknown[];
      personalGrantsEnabled: boolean;
      publicDomains: unknown[];
      qaTarget: unknown;
      effectiveAllowlistRevision: string;
    };
    capability: string;
    machine: { appName: string; machineId: string };
  };
};

export async function handleBrowserRevisionControl(input: {
  request: IncomingMessage;
  response: ServerResponse;
  publicKey: string;
  environmentId: string;
  expectedAppName: string;
  fetchImpl?: typeof fetch | undefined;
}) {
  let body: Buffer;
  let envelope: BrowserRevisionEnvelope;
  try {
    body = await readBoundedBody(input.request);
    envelope = authorizeBrowserRevisionControl({
      authorization: input.request.headers.authorization,
      body,
      publicKey: input.publicKey,
      environmentId: input.environmentId,
      expectedAppName: input.expectedAppName,
    });
  } catch {
    return writeError(input.response, 403, "BROWSER_REVISION_CONTROL_DENIED");
  }

  const { appName, machineId } = envelope.instruction.machine;
  let worker: Response;
  try {
    worker = await (input.fetchImpl ?? fetch)(
      new URL(
        `http://${machineId}.vm.${appName}.internal:43105/v1/operations/revision`,
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope.instruction),
        redirect: "error",
        signal: AbortSignal.timeout(BROWSER_REVISION_TIMEOUT_MS),
      },
    );
  } catch {
    return writeError(
      input.response,
      503,
      "BROWSER_REVISION_INSTALL_UNCONFIRMED",
    );
  }
  let responseBody: Buffer;
  try {
    responseBody = await readBoundedWorkerBody(worker);
  } catch {
    return writeError(
      input.response,
      503,
      "BROWSER_REVISION_INSTALL_UNCONFIRMED",
    );
  }
  input.response.writeHead(worker.ok ? 200 : 503, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  input.response.end(
    worker.ok
      ? responseBody
      : JSON.stringify({
          error: { code: "BROWSER_REVISION_INSTALL_UNCONFIRMED" },
        }),
  );
}

export async function readBoundedWorkerBody(
  response: Response,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_BROWSER_REVISION_BYTES
  )
    throw new Error("Browser revision response is too large.");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > MAX_BROWSER_REVISION_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("Browser revision response is too large.");
    }
    chunks.push(item.value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    length,
  );
}

export function authorizeBrowserRevisionControl(input: {
  authorization: string | undefined;
  body: Buffer;
  publicKey: string;
  environmentId: string;
  expectedAppName: string;
  now?: number | undefined;
}): BrowserRevisionEnvelope {
  const token = input.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (!token) throw new Error("Browser revision credential is required.");
  const credential = verifyEnvironmentToolCredential({
    token,
    publicKey: input.publicKey,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const envelope = parseEnvelope(JSON.parse(input.body.toString("utf8")));
  const instruction = envelope.instruction;
  const binding = `sha256:${createHash("sha256").update(input.body).digest("base64url")}`;
  if (
    credential.organizationId !== envelope.organizationId ||
    credential.environmentId !== input.environmentId ||
    credential.environmentId !== envelope.environmentId ||
    credential.workspaceId !== `browser:${instruction.sessionId}` ||
    credential.threadId !== envelope.threadId ||
    credential.runId !== envelope.runId ||
    credential.actorId !== envelope.userId ||
    credential.agentId !== "kestrel-control-plane" ||
    credential.providerKey !== "built_in.browser" ||
    credential.resourceId !== instruction.sessionId ||
    credential.capability !== "browser.allowlist.adopt" ||
    credential.operation !== "revision.install" ||
    credential.operationBinding !== binding ||
    instruction.machine.appName !== input.expectedAppName ||
    instruction.authority.environmentId !== envelope.environmentId ||
    instruction.authority.userId !== envelope.userId ||
    instruction.authority.effectiveAllowlistRevision !== instruction.revision
  )
    throw new Error("Browser revision credential scope is invalid.");
  return envelope;
}

function parseEnvelope(value: unknown): BrowserRevisionEnvelope {
  const envelope = record(value);
  const instruction = record(envelope.instruction);
  const authority = record(instruction.authority);
  const machine = record(instruction.machine);
  if (
    !exactKeys(envelope, [
      "organizationId",
      "environmentId",
      "userId",
      "threadId",
      "runId",
      "instruction",
    ]) ||
    !exactKeys(instruction, [
      "version",
      "sessionId",
      "generation",
      "revision",
      "cause",
      "authority",
      "capability",
      "machine",
    ]) ||
    !exactKeys(authority, [
      "version",
      "environmentId",
      "projectId",
      "userId",
      "enabledModes",
      "personalGrantsEnabled",
      "publicDomains",
      "qaTarget",
      "effectiveAllowlistRevision",
    ]) ||
    !exactKeys(machine, ["appName", "machineId"]) ||
    typeof envelope.organizationId !== "string" ||
    typeof envelope.environmentId !== "string" ||
    typeof envelope.userId !== "string" ||
    typeof envelope.threadId !== "string" ||
    typeof envelope.runId !== "string" ||
    instruction.version !== "hosted_browser_revision_instruction_v1" ||
    typeof instruction.sessionId !== "string" ||
    !Number.isSafeInteger(instruction.generation) ||
    Number(instruction.generation) < 1 ||
    typeof instruction.revision !== "string" ||
    (instruction.cause !== "personal_grant" &&
      instruction.cause !== "personal_revocation") ||
    typeof instruction.capability !== "string" ||
    authority.version !== "browser_effective_domain_authority_v1" ||
    typeof authority.environmentId !== "string" ||
    typeof authority.projectId !== "string" ||
    typeof authority.userId !== "string" ||
    !Array.isArray(authority.enabledModes) ||
    typeof authority.personalGrantsEnabled !== "boolean" ||
    !Array.isArray(authority.publicDomains) ||
    !(
      authority.qaTarget === null ||
      (typeof authority.qaTarget === "object" &&
        !Array.isArray(authority.qaTarget))
    ) ||
    typeof authority.effectiveAllowlistRevision !== "string" ||
    typeof machine.appName !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(machine.appName) ||
    typeof machine.machineId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(machine.machineId)
  )
    throw new Error("Browser revision request is invalid.");
  return value as BrowserRevisionEnvelope;
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_BROWSER_REVISION_BYTES) {
      throw new Error("Browser revision request is too large.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Browser revision request is invalid.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function writeError(response: ServerResponse, status: number, code: string) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ error: { code } }));
}
