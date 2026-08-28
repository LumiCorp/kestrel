import {
  googleWorkspaceOperationHasRequiredScopes,
  normalizeGoogleCalendarEvent,
  scopesForGoogleWorkspacePacks,
  type GoogleWorkspaceOperation,
  type GoogleWorkspacePack,
  type GoogleWorkspaceServicePort,
} from "../apps/googleWorkspace.js";
import {
  createGoogleCalendarPageCursor,
  readGoogleCalendarPageCursor,
} from "../apps/googleCalendarPaging.js";
import {
  createGmailPageCursor,
  readGmailPageCursor,
} from "../apps/gmailPaging.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "../kestrel/contracts/tool-contract.js";
import {
  createGmailMutationRawMessage,
  sendGmailMutation,
} from "../apps/gmailMutation.js";
import type { LocalCoreCredentialId, LocalCoreCredentialStore } from "./credentialStore.js";

const CLIENT_ID = "mcp.standard.google_workspace.oauth.client" as LocalCoreCredentialId;
const TOKENS_ID = "mcp.standard.google_workspace.oauth.tokens" as LocalCoreCredentialId;

interface StoredGoogleTokens { accessToken: string; refreshToken: string; expiresAt: number; scope: string; }
type GmailAttachmentBinding = { fileId: string; filename: string; mediaType: string; sizeBytes: number; sha256: string };
type GmailMaterializedAttachment = GmailAttachmentBinding & { bytes: Buffer };
type GmailPreparedMutation = {
  version: "desktop_gmail_prepared_mutation_v1";
  operation: "gmail.messages.send" | "gmail.messages.reply";
  envelope: { to: string[]; cc: string[]; subject: string; text: string; html?: string; threadId?: string; replyHeaders?: { inReplyTo: string; references?: string } };
  attachments: GmailAttachmentBinding[];
};

export class GoogleWorkspaceMutationOutcomeUnknownError extends Error {
  readonly code = "GOOGLE_CALENDAR_OUTCOME_UNKNOWN";
  readonly outcomeUnknown = true;

  constructor() {
    super("Google Calendar may have completed this change. Check Calendar before retrying.");
    this.name = "GoogleWorkspaceMutationOutcomeUnknownError";
  }
}

export class LocalCoreGoogleWorkspaceService implements GoogleWorkspaceServicePort {
  readonly #store: LocalCoreCredentialStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #assertGmailRestrictedDataAdmission: (() => Promise<void>) | undefined;
  readonly #importGmailAttachment: ((input: { threadId: string; filename: string; data: Buffer; mimeType?: string | undefined }) => Promise<{ fileId: string; filename: string; sizeBytes: number; status: string }>) | undefined;
  readonly #resolveGmailAttachments: ((input: { threadId: string; fileIds: string[]; includeBytes: boolean }) => Promise<Array<GmailAttachmentBinding | GmailMaterializedAttachment>>) | undefined;
  constructor(options: { credentialStore: LocalCoreCredentialStore; fetchImpl?: typeof fetch; now?: () => number; assertGmailRestrictedDataAdmission?: () => Promise<void>; importGmailAttachment?: (input: { threadId: string; filename: string; data: Buffer; mimeType?: string | undefined }) => Promise<{ fileId: string; filename: string; sizeBytes: number; status: string }>; resolveGmailAttachments?: (input: { threadId: string; fileIds: string[]; includeBytes: boolean }) => Promise<Array<GmailAttachmentBinding | GmailMaterializedAttachment>> }) {
    this.#store = options.credentialStore;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#assertGmailRestrictedDataAdmission = options.assertGmailRestrictedDataAdmission;
    this.#importGmailAttachment = options.importGmailAttachment;
    this.#resolveGmailAttachments = options.resolveGmailAttachments;
  }

  async prepareApprovalInput(
    operation: "gmail.messages.send" | "gmail.messages.reply",
    input: Record<string, unknown>,
    options: { threadId: string },
  ): Promise<Record<string, unknown>> {
    await this.#assertGmailAdmission(operation);
    const raw = { ...input };
    delete raw.__kestrelGmailPrepared;
    const prepared = await this.#prepareGmailMutation(operation, raw, options.threadId);
    return { ...raw, __kestrelGmailPrepared: prepared };
  }

  async verify(packs: readonly GoogleWorkspacePack[]): Promise<{ verifiedAt: string }> {
    const tokens = await readGoogleTokens(this.#store);
    const granted = new Set(tokens.scope.split(/\s+/u));
    if (scopesForGoogleWorkspacePacks(packs).some((scope) => !granted.has(scope))) throw new Error("Google Workspace has not granted every selected capability.");
    const accessToken = await this.#accessToken();
    const response = await this.#fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error("Google Workspace needs to be reconnected.");
    return { verifiedAt: new Date(this.#now()).toISOString() };
  }

  async invoke(operation: GoogleWorkspaceOperation, input: Record<string, unknown>, options: { cursorScope?: string | undefined; threadId?: string | undefined } = {}): Promise<unknown> {
    const tokens = await readGoogleTokens(this.#store);
    if (!googleWorkspaceOperationHasRequiredScopes({
      operation,
      grantedScopes: tokens.scope.split(/\s+/u).filter(Boolean),
    })) {
      throw new Error("Google Workspace has not granted this operation.");
    }
    if (operation.startsWith("gmail.")) await this.#assertGmailAdmission(operation);
    const accessToken = await this.#accessToken();
    if (operation === "events.list") {
      const timeMin = requiredString(input.timeMin, "timeMin");
      const timeMax = requiredString(input.timeMax, "timeMax");
      const maxResults = integer(input.maxResults, 50);
      const cursorContext = {
        accountId: localAccountId(tokens),
        projectId: localProjectScopeId(options.cursorScope),
        timeMin,
        timeMax,
        maxResults,
      };
      const pageToken = optionalString(input.cursor) === undefined
        ? undefined
        : readGoogleCalendarPageCursor({
            secret: localCursorSecret(tokens),
            cursor: requiredString(input.cursor, "cursor"),
            context: cursorContext,
            now: this.#now(),
          }).pageToken;
      const url = eventUrl();
      url.searchParams.set("timeMin", timeMin);
      url.searchParams.set("timeMax", timeMax);
      url.searchParams.set("maxResults", String(maxResults));
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
      const result = record(await this.#request(accessToken, url));
      const nextPageToken = optionalString(result.nextPageToken);
      return {
        events: Array.isArray(result.items)
          ? result.items.map(normalizeGoogleCalendarEvent)
          : [],
        nextCursor: nextPageToken === undefined
          ? null
          : createGoogleCalendarPageCursor({
              secret: localCursorSecret(tokens),
              context: cursorContext,
              pageToken: nextPageToken,
              now: this.#now(),
            }),
      };
    }
    if (operation === "events.create") {
      const url = eventUrl();
      url.searchParams.set("sendUpdates", input.notifyAttendees === true ? "all" : "none");
      return normalizeGoogleCalendarEvent(await this.#request(accessToken, url, {
        method: "POST",
        body: record(input.event),
        externalEffect: true,
      }));
    }
    if (operation === "gmail.messages.search") {
      const query = requiredString(input.query, "query");
      const maxResults = integer(input.maxResults, 50);
      const cursorContext = {
        accountId: localAccountId(tokens),
        projectId: localProjectScopeId(options.cursorScope),
        threadId: localThreadScopeId(options.cursorScope),
        operation: "gmail.messages.search" as const,
        query,
        maxResults,
      };
      const pageToken = optionalString(input.cursor) === undefined ? undefined : readGmailPageCursor({
        secret: localCursorSecret(tokens), cursor: requiredString(input.cursor, "cursor"), context: cursorContext, now: this.#now(),
      }).pageToken;
      const url = gmailUrl("/users/me/messages");
      url.searchParams.set("q", query);
      url.searchParams.set("maxResults", String(maxResults));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = record(await this.#request(accessToken, url));
      const messages = Array.isArray(page.messages) ? page.messages : [];
      const normalized = await Promise.all(messages.map(async (value) => {
        const message = record(value);
        return await this.#gmailMessage(accessToken, requiredString(message.id, "message.id"));
      }));
      const nextPageToken = optionalString(page.nextPageToken);
      return {
        messages: normalized,
        nextCursor: nextPageToken === undefined ? null : createGmailPageCursor({ secret: localCursorSecret(tokens), context: cursorContext, pageToken: nextPageToken, now: this.#now() }),
      };
    }
    if (operation === "gmail.messages.get") {
      return await this.#gmailMessage(accessToken, requiredString(input.messageId, "messageId"));
    }
    if (operation === "gmail.threads.get") {
      const thread = record(await this.#request(accessToken, gmailUrl(`/users/me/threads/${encodeURIComponent(requiredString(input.threadId, "threadId"))}`)));
      const messages = Array.isArray(thread.messages) ? thread.messages : [];
      return {
        id: requiredString(thread.id, "thread.id"),
        messages: messages.map(normalizeGmailMessage),
      };
    }
    if (operation === "gmail.attachments.import") {
      const threadId = requiredString(options.threadId, "threadId");
      if (this.#importGmailAttachment === undefined) {
        throw new Error("Desktop Gmail attachment import is unavailable.");
      }
      const messageId = requiredString(input.messageId, "messageId");
      const attachmentId = requiredString(input.attachmentId, "attachmentId");
      const message = await this.#gmailMessage(accessToken, messageId);
      const attachment = message.attachments.find(
        (candidate) => candidate.attachmentId === attachmentId,
      );
      if (attachment === undefined) {
        throw new Error("The selected Gmail attachment is unavailable.");
      }
      const payload = record(await this.#request(
        accessToken,
        gmailUrl(`/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`),
      ));
      const encoded = requiredString(payload.data, "attachment.data");
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.byteLength !== attachment.sizeBytes) {
        throw new Error("The selected Gmail attachment failed integrity validation.");
      }
      return await this.#importGmailAttachment({
        threadId,
        filename: attachment.filename,
        data: bytes,
        ...(attachment.mediaType === null ? {} : { mimeType: attachment.mediaType }),
      });
    }
    if (operation === "gmail.messages.send" || operation === "gmail.messages.reply") {
      const threadId = requiredString(options.threadId, "threadId");
      const expected = await this.#prepareGmailMutation(operation, input, threadId);
      const approved = parsePreparedGmailMutation(input.__kestrelGmailPrepared);
      if (canonicalJson(expected) !== canonicalJson(approved)) {
        throw new Error("Desktop Gmail approval no longer matches the exact provider and Thread-file state.");
      }
      const attachments = await this.#materializeGmailAttachments(threadId, approved.attachments);
      return await sendGmailMutation({
        accessToken,
        raw: createGmailMutationRawMessage({ ...approved.envelope, attachments }),
        ...(approved.envelope.threadId === undefined ? {} : { threadId: approved.envelope.threadId }),
        fetchImpl: this.#fetch,
      });
    }
    const eventId = requiredString(input.eventId, "eventId");
    const url = eventUrl(eventId);
    url.searchParams.set("sendUpdates", input.notifyAttendees === true ? "all" : "none");
    if (operation === "events.update") {
      return normalizeGoogleCalendarEvent(await this.#request(accessToken, url, {
        method: "PATCH",
        body: record(input.patch),
        externalEffect: true,
      }));
    }
    await this.#request(accessToken, url, { method: "DELETE", externalEffect: true });
    return { deleted: true };
  }

  async #gmailMessage(accessToken: string, messageId: string) {
    return normalizeGmailMessage(record(await this.#request(accessToken, gmailUrl(`/users/me/messages/${encodeURIComponent(messageId)}`))));
  }

  async #assertGmailAdmission(operation: GoogleWorkspaceOperation) {
    if (this.#assertGmailRestrictedDataAdmission === undefined) {
      throw new Error("Desktop Gmail restricted-data admission is unavailable.");
    }
    await this.#assertGmailRestrictedDataAdmission();
    const tokens = await readGoogleTokens(this.#store);
    if (!googleWorkspaceOperationHasRequiredScopes({ operation, grantedScopes: tokens.scope.split(/\s+/u).filter(Boolean) })) {
      throw new Error("Google Workspace has not granted this operation.");
    }
  }

  async #prepareGmailMutation(operation: "gmail.messages.send" | "gmail.messages.reply", input: Record<string, unknown>, threadId: string): Promise<GmailPreparedMutation> {
    const tokens = await readGoogleTokens(this.#store);
    if (!googleWorkspaceOperationHasRequiredScopes({ operation, grantedScopes: tokens.scope.split(/\s+/u).filter(Boolean) })) {
      throw new Error("Google Workspace has not granted this operation.");
    }
    const accessToken = await this.#accessToken();
    const attachments = await this.#resolveGmailAttachmentBindings(threadId, stringArray(input.attachmentFileIds, "attachmentFileIds"));
    const text = requiredString(input.text, "text");
    const html = optionalString(input.html);
    if (operation === "gmail.messages.send") {
      return { version: "desktop_gmail_prepared_mutation_v1", operation, envelope: { to: stringArray(input.to, "to", true), cc: stringArray(input.cc, "cc"), subject: requiredString(input.subject, "subject"), text, ...(html === undefined ? {} : { html }) }, attachments };
    }
    const target = await this.#gmailReplyTarget(accessToken, requiredString(input.messageId, "messageId"));
    return { version: "desktop_gmail_prepared_mutation_v1", operation, envelope: { to: target.recipients, cc: [], subject: target.subject, text, ...(html === undefined ? {} : { html }), threadId: target.threadId, replyHeaders: { inReplyTo: target.inReplyTo, ...(target.references === undefined ? {} : { references: target.references }) } }, attachments };
  }

  async #gmailReplyTarget(accessToken: string, messageId: string) {
    const message = record(await this.#request(accessToken, gmailUrl(`/users/me/messages/${encodeURIComponent(messageId)}`)));
    const payload = record(message.payload);
    const headers = new Map((Array.isArray(payload.headers) ? payload.headers : []).flatMap((value) => {
      const header = record(value); const name = optionalString(header.name)?.toLowerCase();
      return name ? [[name, optionalString(header.value) ?? ""] as const] : [];
    }));
    const recipients = gmailAddresses(headers.get("reply-to") || headers.get("from")).map((entry) => entry.value);
    const inReplyTo = requiredString(headers.get("message-id"), "message-id");
    if (recipients.length === 0) throw new Error("Gmail reply target has no recipient.");
    const subject = headers.get("subject")?.trim() ?? "";
    return { threadId: requiredString(message.threadId, "message.threadId"), recipients, subject: /^re:/iu.test(subject) ? subject || "Re:" : `Re: ${subject}`.trim(), inReplyTo, ...(optionalString(headers.get("references")) === undefined ? {} : { references: optionalString(headers.get("references"))! }) };
  }

  async #resolveGmailAttachmentBindings(threadId: string, fileIds: string[]) {
    if (fileIds.length === 0) return [];
    if (this.#resolveGmailAttachments === undefined) throw new Error("Desktop Gmail Thread-file resolution is unavailable.");
    return (await this.#resolveGmailAttachments({ threadId, fileIds, includeBytes: false })).map(toGmailAttachmentBinding);
  }

  async #materializeGmailAttachments(threadId: string, approved: GmailAttachmentBinding[]) {
    if (approved.length === 0) return [];
    if (this.#resolveGmailAttachments === undefined) throw new Error("Desktop Gmail Thread-file resolution is unavailable.");
    const current = await this.#resolveGmailAttachments({ threadId, fileIds: approved.map((attachment) => attachment.fileId), includeBytes: true });
    return current.map((entry, index) => {
      const binding = toGmailAttachmentBinding(entry); const expected = approved[index];
      if (expected === undefined || canonicalJson(binding) !== canonicalJson(expected) || !("bytes" in entry) || !Buffer.isBuffer(entry.bytes)) throw new Error("Desktop Gmail attachment approval no longer matches the current Thread file.");
      return { filename: binding.filename, mediaType: binding.mediaType, bytes: entry.bytes };
    });
  }

  async #accessToken(): Promise<string> {
    const tokens = await readGoogleTokens(this.#store);
    if (tokens.expiresAt > this.#now() + 60_000) return tokens.accessToken;
    const clientId = await this.#store.get(CLIENT_ID);
    if (!clientId) throw new Error("Google Workspace needs to be reconnected.");
    const response = await this.#fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, refresh_token: tokens.refreshToken, grant_type: "refresh_token" }) });
    const body = record(await response.json().catch(() => ({})));
    if (!response.ok) throw new Error("Google Workspace needs to be reconnected.");
    const refreshed = parseGoogleTokenResponse(body, this.#now(), tokens.refreshToken, tokens.scope);
    await this.#store.set(TOKENS_ID, JSON.stringify(refreshed));
    return refreshed.accessToken;
  }

  async #request(accessToken: string, url: URL, options: { method?: "POST" | "PATCH" | "DELETE"; body?: unknown; externalEffect?: boolean } = {}) {
    let response: Response;
    try {
      response = await this.#fetch(url, { method: options.method ?? "GET", headers: { authorization: `Bearer ${accessToken}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    } catch {
      if (options.externalEffect) throw new GoogleWorkspaceMutationOutcomeUnknownError();
      throw new Error("Google Workspace is temporarily unavailable.");
    }
    if (!response.ok) { if (response.status === 401 || response.status === 403) throw new Error("Google Workspace needs to be reconnected."); if (response.status === 429) throw new Error("Google Workspace is rate limited. Try again shortly."); throw new Error(`Google Workspace request failed with HTTP ${response.status}.`); }
    if (response.status === 204) return {};
    try {
      return await response.json();
    } catch {
      if (options.externalEffect) throw new GoogleWorkspaceMutationOutcomeUnknownError();
      throw new Error("Google Workspace returned an invalid response.");
    }
  }
}

export async function readGoogleTokens(store: LocalCoreCredentialStore): Promise<StoredGoogleTokens> { const raw = await store.get(TOKENS_ID); if (!raw) throw new Error("Google Workspace is not connected."); const value = record(JSON.parse(raw)); if (typeof value.accessToken !== "string" || typeof value.refreshToken !== "string" || typeof value.expiresAt !== "number" || typeof value.scope !== "string") throw new Error("Stored Google Workspace authorization is invalid."); return value as unknown as StoredGoogleTokens; }
export function parseGoogleTokenResponse(body: Record<string, unknown>, now: number, fallbackRefresh?: string, fallbackScope?: string): StoredGoogleTokens { if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") throw new Error("Google returned an invalid authorization response."); const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : fallbackRefresh; const scope = typeof body.scope === "string" ? body.scope : fallbackScope; if (!refreshToken || !scope) throw new Error("Google did not grant offline access."); return { accessToken: body.access_token, refreshToken, expiresAt: now + body.expires_in * 1000, scope }; }
function eventUrl(eventId?: string) { return new URL(`https://www.googleapis.com/calendar/v3/calendars/primary/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`); }
function gmailUrl(path: string) { return new URL(`https://gmail.googleapis.com/gmail/v1${path}`); }
function record(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Google Workspace data is invalid."); return value as Record<string, unknown>; }
function requiredString(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`); return value; }
function integer(value: unknown, fallback: number): number { const parsed = value === undefined ? fallback : value; if (!Number.isInteger(parsed) || (parsed as number) < 1 || (parsed as number) > 100) throw new Error("The result limit is invalid."); return parsed as number; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function localCursorSecret(tokens: StoredGoogleTokens) { return createHash("sha256").update(tokens.refreshToken).digest("base64url"); }
function localAccountId(tokens: StoredGoogleTokens) { return createHash("sha256").update(tokens.refreshToken).digest("hex"); }
function localProjectScopeId(scope: string | undefined) { return createHash("sha256").update(scope?.trim() || "local-core-desktop").digest("hex"); }
function localThreadScopeId(scope: string | undefined) { return createHash("sha256").update(`thread:${scope?.trim() || "local-core-desktop"}`).digest("hex"); }

function normalizeGmailMessage(message: Record<string, unknown>) {
  const payload = record(message.payload);
  const headers = new Map((Array.isArray(payload.headers) ? payload.headers : []).flatMap((value) => {
    const header = record(value); const name = optionalString(header.name)?.toLowerCase();
    return name ? [[name, optionalString(header.value) ?? ""] as const] : [];
  }));
  const parts = gmailParts(payload);
  return {
    id: requiredString(message.id, "message.id"), threadId: requiredString(message.threadId, "message.threadId"),
    labels: Array.isArray(message.labelIds) ? message.labelIds.filter((label): label is string => typeof label === "string") : [],
    internalDate: optionalString(message.internalDate) ?? null,
    from: gmailAddresses(headers.get("from")), to: gmailAddresses(headers.get("to")), cc: gmailAddresses(headers.get("cc")), bcc: gmailAddresses(headers.get("bcc")), replyTo: gmailAddresses(headers.get("reply-to")),
    subject: headers.get("subject") || null,
    text: gmailBody(parts, "text/plain"), html: gmailBody(parts, "text/html"),
    attachments: parts.flatMap((part) => {
      const body = record(part.body); const attachmentId = optionalString(body.attachmentId); const filename = optionalString(part.filename);
      return attachmentId && filename ? [{ attachmentId, filename, mediaType: optionalString(part.mimeType) ?? null, sizeBytes: typeof body.size === "number" && Number.isInteger(body.size) && body.size >= 0 ? body.size : 0 }] : [];
    }),
  };
}
function gmailParts(part: Record<string, unknown>): Record<string, unknown>[] { const children = Array.isArray(part.parts) ? part.parts : []; return children.length ? children.map(record).flatMap(gmailParts) : [part]; }
function gmailBody(parts: Record<string, unknown>[], mimeType: string) { const part = parts.find((candidate) => optionalString(candidate.mimeType)?.toLowerCase() === mimeType && optionalString(record(candidate.body).data)); const data = part ? optionalString(record(part.body).data) : undefined; return data ? Buffer.from(data, "base64url").toString("utf8") : null; }
function gmailAddresses(value: string | undefined) { return value?.split(",").map((entry) => { const match = entry.trim().match(/^(.*)<([^<>]+)>$/u); return match ? { name: match[1]!.trim(), value: match[2]!.trim() } : { name: "", value: entry.trim() }; }).filter((entry) => entry.value) ?? []; }

function stringArray(value: unknown, label: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} must be a list of non-empty strings.`);
  }
  if (required && value.length === 0) throw new Error(`${label} is required.`);
  return value.map((entry) => entry.trim());
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value as number;
}

function toGmailAttachmentBinding(value: GmailAttachmentBinding | GmailMaterializedAttachment): GmailAttachmentBinding {
  return { fileId: value.fileId, filename: value.filename, mediaType: value.mediaType, sizeBytes: value.sizeBytes, sha256: value.sha256 };
}

function parsePreparedGmailMutation(value: unknown): GmailPreparedMutation {
  const prepared = record(value);
  if (prepared.version !== "desktop_gmail_prepared_mutation_v1" ||
    (prepared.operation !== "gmail.messages.send" && prepared.operation !== "gmail.messages.reply")) {
    throw new Error("Desktop Gmail approval preparation is invalid.");
  }
  const envelope = record(prepared.envelope);
  const attachments = Array.isArray(prepared.attachments) ? prepared.attachments.map((attachment) => {
    const entry = record(attachment);
    return { fileId: requiredString(entry.fileId, "prepared attachment.fileId"), filename: requiredString(entry.filename, "prepared attachment.filename"), mediaType: requiredString(entry.mediaType, "prepared attachment.mediaType"), sizeBytes: nonNegativeInteger(entry.sizeBytes, "prepared attachment.sizeBytes"), sha256: requiredString(entry.sha256, "prepared attachment.sha256") };
  }) : (() => { throw new Error("Desktop Gmail approval attachments are invalid."); })();
  const replyHeaders = envelope.replyHeaders === undefined ? undefined : record(envelope.replyHeaders);
  return {
    version: "desktop_gmail_prepared_mutation_v1",
    operation: prepared.operation,
    envelope: {
      to: stringArray(envelope.to, "prepared envelope.to", true), cc: stringArray(envelope.cc, "prepared envelope.cc"), subject: requiredString(envelope.subject, "prepared envelope.subject"), text: requiredString(envelope.text, "prepared envelope.text"),
      ...(optionalString(envelope.html) === undefined ? {} : { html: optionalString(envelope.html)! }),
      ...(optionalString(envelope.threadId) === undefined ? {} : { threadId: optionalString(envelope.threadId)! }),
      ...(replyHeaders === undefined ? {} : { replyHeaders: { inReplyTo: requiredString(replyHeaders.inReplyTo, "prepared replyHeaders.inReplyTo"), ...(optionalString(replyHeaders.references) === undefined ? {} : { references: optionalString(replyHeaders.references)! }) } }),
    },
    attachments,
  };
}
