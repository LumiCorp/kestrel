import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  ModelReasoningContinuation,
  ModelRequest,
  ModelResponse,
} from "../kestrel/contracts/model-io.js";
import type {
  ProviderReasoningEncryptedRecord,
  RuntimeStore,
} from "../kestrel/contracts/store.js";
import { resolveKestrelHomePath } from "./kestrelHome.js";

export interface ProviderReasoningRetentionPolicy {
  mode: "live_only" | "provider_visible";
  days: number;
}

export interface ProviderReasoningCallContext {
  runId: string;
  sessionId: string;
  turnId?: string | undefined;
  retentionScope: string;
  provider?: string | undefined;
  model?: string | undefined;
  retention: ProviderReasoningRetentionPolicy;
}

export interface ProviderReasoningVaultStatus {
  ready: boolean;
  keySource: "environment" | "local_file";
  keyVersion: number;
}

const CONTINUATION_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_BYTES = 32;
const KEY_VERSION = 1;

export class ProviderReasoningVault {
  private readonly continuationKey: Buffer;
  private readonly retainedKey: Buffer;

  constructor(
    private readonly store: RuntimeStore,
    private readonly statusValue: ProviderReasoningVaultStatus,
    masterKey: Buffer,
  ) {
    this.continuationKey = deriveKey(masterKey, "kestrel-provider-continuation-v1");
    this.retainedKey = deriveKey(masterKey, "kestrel-provider-visible-retention-v1");
  }

  status(): ProviderReasoningVaultStatus {
    return { ...this.statusValue };
  }

  async prepareRequest(
    request: ModelRequest,
    context: ProviderReasoningCallContext,
  ): Promise<ModelRequest> {
    if (
      request.reasoning === undefined ||
      request.reasoning.mode === "off" ||
      context.turnId === undefined
    ) {
      return request;
    }
    await this.store.purgeExpiredProviderReasoning?.();
    const records = await this.store.listProviderReasoningRecords?.({
      sessionId: context.sessionId,
      turnId: context.turnId,
      kind: "continuation",
    }) ?? [];
    const matching = records.find(
      (record) => record.provider === context.provider && record.model === context.model,
    );
    for (const record of records) {
      if (record.recordId !== matching?.recordId) {
        await this.store.deleteProviderReasoningRecords?.({
          sessionId: context.sessionId,
          turnId: context.turnId,
          provider: record.provider,
          model: record.model,
          kind: "continuation",
        });
      }
    }
    if (matching === undefined) {
      return request;
    }
    const decoded = decryptJson<unknown>(matching, this.continuationKey);
    const continuation = readContinuationArray(decoded, matching.provider);
    return continuation.length === 0
      ? request
      : {
          ...request,
          reasoning: {
            ...request.reasoning,
            continuation,
          },
        };
  }

  async captureResponse(
    response: ModelResponse<unknown>,
    context: ProviderReasoningCallContext,
  ): Promise<void> {
    if (context.turnId === undefined) return;
    await this.store.purgeExpiredProviderReasoning?.();
    const now = new Date();
    const provider = context.provider ?? response.provider.name;
    const model = context.model ?? response.provider.model ?? "unknown";
    const continuation = response.reasoning?.continuation ?? [];
    if (continuation.length > 0) {
      const record = encryptRecord({
        kind: "continuation",
        runId: context.runId,
        sessionId: context.sessionId,
        turnId: context.turnId,
        retentionScope: context.retentionScope,
        provider,
        model,
        plaintext: JSON.stringify(continuation),
        key: this.continuationKey,
        createdAt: now,
        expiresAt: new Date(now.getTime() + CONTINUATION_TTL_MS),
      });
      await this.store.saveProviderReasoningRecord?.(record);
    }
    if (context.retention.mode !== "provider_visible") return;
    const retentionDays = normalizeRetentionDays(context.retention.days);
    for (const visible of response.reasoning?.visible ?? []) {
      if (visible.text.length === 0) continue;
      const record = encryptRecord({
        kind: "retained_visible",
        runId: context.runId,
        sessionId: context.sessionId,
        turnId: context.turnId,
        retentionScope: context.retentionScope,
        provider,
        model,
        format: visible.format,
        plaintext: visible.text,
        key: this.retainedKey,
        createdAt: now,
        expiresAt: new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000),
      });
      await this.store.saveProviderReasoningRecord?.(record);
    }
  }

  async purgeActiveTurn(input: { sessionId: string; turnId?: string | undefined; runId?: string | undefined }): Promise<number> {
    return await this.store.deleteProviderReasoningRecords?.({
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      sessionId: input.sessionId,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      kind: "continuation",
    }) ?? 0;
  }

  async purgeExpired(now = new Date().toISOString()): Promise<number> {
    return await this.store.purgeExpiredProviderReasoning?.(now) ?? 0;
  }

  async applyRetentionPolicy(
    retentionScope: string,
    policy: ProviderReasoningRetentionPolicy,
    now = new Date(),
  ): Promise<number> {
    const days = normalizeRetentionDays(policy.days);
    return await this.store.applyProviderReasoningRetentionPolicy?.({
      retentionScope,
      mode: policy.mode,
      expiresAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
    }) ?? 0;
  }

  async readRetainedForAdmin(input: {
    runId: string;
    sessionId: string;
    actorRole: string;
    actorId?: string | undefined;
  }): Promise<Array<{ provider: string; model: string; format: string; text: string; createdAt: string; expiresAt: string }>> {
    if (input.actorRole !== "org_admin") {
      throw new Error("Retained provider reasoning is restricted to organization administrators");
    }
    const records = await this.store.listProviderReasoningRecords?.({
      runId: input.runId,
      sessionId: input.sessionId,
      kind: "retained_visible",
    }) ?? [];
    const output = records.map((record) => ({
      provider: record.provider,
      model: record.model,
      format: record.format ?? "provider_visible",
      text: decryptText(record, this.retainedKey),
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    }));
    if (input.actorId !== undefined) {
      await this.store.appendProviderReasoningAccessAudit?.({
        runId: input.runId,
        sessionId: input.sessionId,
        actorId: input.actorId,
        actorRole: input.actorRole,
        action: "read",
        metadata: { recordCount: records.length },
      });
    }
    return output;
  }

  async deleteRetainedForAdmin(input: { runId: string; sessionId: string; actorRole: string; actorId?: string | undefined }): Promise<number> {
    if (input.actorRole !== "org_admin") {
      throw new Error("Retained provider reasoning is restricted to organization administrators");
    }
    const deletedCount = await this.store.deleteProviderReasoningRecords?.({
      runId: input.runId,
      sessionId: input.sessionId,
      kind: "retained_visible",
    }) ?? 0;
    if (input.actorId !== undefined) {
      await this.store.appendProviderReasoningAccessAudit?.({
        runId: input.runId,
        sessionId: input.sessionId,
        actorId: input.actorId,
        actorRole: input.actorRole,
        action: "delete",
        metadata: { deletedCount },
      });
    }
    return deletedCount;
  }
}

export function createProviderReasoningVaultFromEnv(
  store: RuntimeStore,
  env: NodeJS.ProcessEnv,
): ProviderReasoningVault {
  const configured = env.KESTREL_REASONING_MASTER_KEY?.trim();
  if (configured !== undefined && configured.length > 0) {
    return new ProviderReasoningVault(
      store,
      { ready: true, keySource: "environment", keyVersion: KEY_VERSION },
      decodeConfiguredKey(configured),
    );
  }
  if (env.KESTREL_HOSTED === "1" || env.KESTREL_HOSTED === "true") {
    throw new Error("KESTREL_REASONING_MASTER_KEY is required for hosted reasoning collection");
  }
  const keyPath = env.KESTREL_REASONING_KEY_FILE?.trim()
    || (env.KESTREL_HOME?.trim()
      ? join(resolveKestrelHomePath(env), "reasoning.key")
      : join(homedir(), ".kestrel", "reasoning.key"));
  if (!existsSync(keyPath)) {
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    writeFileSync(keyPath, randomBytes(KEY_BYTES).toString("base64"), { mode: 0o600, flag: "wx" });
  }
  chmodSync(keyPath, 0o600);
  return new ProviderReasoningVault(
    store,
    { ready: true, keySource: "local_file", keyVersion: KEY_VERSION },
    decodeConfiguredKey(readFileSync(keyPath, "utf8").trim()),
  );
}

function normalizeRetentionDays(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 30) {
    throw new Error("Provider reasoning retention must be an integer from 1 to 30 days");
  }
  return value;
}

function decodeConfiguredKey(value: string): Buffer {
  const decoded = /^[0-9a-f]{64}$/iu.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new Error("KESTREL_REASONING_MASTER_KEY must decode to exactly 32 bytes");
  }
  return decoded;
}

function deriveKey(masterKey: Buffer, domain: string): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), Buffer.from(domain), KEY_BYTES));
}

function encryptRecord(input: {
  kind: ProviderReasoningEncryptedRecord["kind"];
  runId: string;
  sessionId: string;
  turnId: string;
  retentionScope: string;
  provider: string;
  model: string;
  format?: string | undefined;
  plaintext: string;
  key: Buffer;
  createdAt: Date;
  expiresAt: Date;
}): ProviderReasoningEncryptedRecord {
  const recordId = randomUUID();
  const iv = randomBytes(12);
  const aad = Buffer.from(`${recordId}:${input.kind}:${input.sessionId}:${input.turnId}`);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  return {
    recordId,
    kind: input.kind,
    runId: input.runId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    retentionScope: input.retentionScope,
    provider: input.provider,
    model: input.model,
    ...(input.format !== undefined ? { format: input.format } : {}),
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: KEY_VERSION,
    createdAt: input.createdAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };
}

function decryptText(record: ProviderReasoningEncryptedRecord, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAAD(Buffer.from(`${record.recordId}:${record.kind}:${record.sessionId}:${record.turnId}`));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function decryptJson<T>(record: ProviderReasoningEncryptedRecord, key: Buffer): T {
  return JSON.parse(decryptText(record, key)) as T;
}

function readContinuationArray(value: unknown, provider: string): ModelReasoningContinuation[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ModelReasoningContinuation => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return record.provider === provider &&
      (record.kind === "encrypted_content" || record.kind === "signature" || record.kind === "reasoning_details") &&
      Object.hasOwn(record, "value");
  });
}
