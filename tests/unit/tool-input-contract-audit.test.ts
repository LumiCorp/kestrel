import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { defaultToolCatalog } from "../../tools/catalog.js";
import {
  BUILT_IN_TOOL_INPUT_CONTRACTS,
  validateBuiltInToolInputContract,
} from "../../tools/runtime/builtInToolInputContracts.js";
import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { adaptTrustedLegacyToolInput } from "../../tools/runtime/trustedToolInputCompatibility.js";
import {
  buildAgentToolFailedOutputResult,
  buildAgentToolSuccessResult,
  replaceAgentToolResultOutput,
} from "../../tools/toolResult.js";

const compileIntentSource = readFileSync(
  new URL("../../agents/reference-react/src/decision/compileIntent.ts", import.meta.url),
  "utf8",
);
const acterSource = readFileSync(
  new URL("../../agents/reference-react/src/steps/acter.ts", import.meta.url),
  "utf8",
);


test("trusted compatibility normalization strips unexpected top-level keys", () => {
  const strictTools = defaultToolCatalog.list().filter((tool) =>
    tool.inputSchema.type === "object" && tool.inputSchema.additionalProperties === false,
  );

  for (const tool of strictTools) {
    if (tool.name === "code.execute") {
      assert.throws(
        () => adaptTrustedLegacyToolInput({
          name: tool.name,
          schema: tool.inputSchema,
          value: { unexpected: true },
        }),
        /unknown field 'unexpected'/u,
      );
      continue;
    }
    const sanitized = adaptTrustedLegacyToolInput({
      name: tool.name,
      schema: tool.inputSchema,
      value: {
        unexpected: true,
      },
    });
    assert.equal(
      Object.hasOwn(sanitized as Record<string, unknown>, "unexpected"),
      false,
      `strict schema sanitizer leaked unexpected field for ${tool.name}`,
    );
  }
});

test("model decision and execution paths cannot import trusted compatibility adaptation", () => {
  for (const source of [compileIntentSource, acterSource]) {
    assert.doesNotMatch(source, /adaptTrustedLegacyToolInput/u);
    assert.doesNotMatch(source, /normalizeToolActionInput/u);
    assert.doesNotMatch(source, /sanitizeToolInputForSchema/u);
  }
});

test("every built-in tool has an explicit input contract entry", () => {
  const toolNames = defaultToolCatalog.list().map((tool) => tool.name).sort();
  const contractNames = Object.keys(BUILT_IN_TOOL_INPUT_CONTRACTS).sort();

  assert.deepEqual(contractNames, toolNames);
});

test("Gmail mutation audit records retain no approved message content", () => {
  const result = buildAgentToolSuccessResult({
    toolName: "google_workspace.send_gmail",
    input: {
      to: ["recipient@example.com"],
      subject: "Sensitive subject",
      text: "Sensitive message body",
      __kestrelGmailPrepared: {
        envelope: {
          to: ["recipient@example.com"],
          cc: [],
          subject: "Sensitive subject",
          text: "Sensitive message body",
        },
        attachments: [{ fileId: "file-1", sha256: "a".repeat(64) }],
      },
    },
    output: { id: "provider-message-1", threadId: "provider-thread-1" },
  });
  assert.deepEqual(result.auditRecord.input, {
    operation: "gmail.messages.send",
    recipientCount: 1,
    attachmentCount: 1,
    attachments: [{ fileId: "file-1", sha256: "a".repeat(64) }],
  });
  assert.doesNotMatch(JSON.stringify(result.auditRecord), /Sensitive/u);
});

test("Teams chat-read audit records retain no message body or cursor", () => {
  const result = buildAgentToolSuccessResult({
    toolName: "microsoft_365.list_chat_messages",
    input: { chatId: "chat-1", cursor: "sealed-cursor" },
    output: {
      items: [{
        id: "message-1",
        chatId: "chat-1",
        body: { format: "html", content: "Sensitive Teams message body" },
      }],
      nextCursor: "next-sealed-cursor",
    },
  });
  assert.deepEqual(result.auditRecord.output, {
    operation: "chat.messages.list",
    resultCount: 1,
    providerChatId: "chat-1",
    providerMessageIds: ["message-1"],
    cursorState: "continued",
    nextPage: true,
  });
  assert.deepEqual(result.auditRecord.input, {
    operation: "chat.messages.list",
    cursorState: "continued",
    providerChatId: "chat-1",
  });
  assert.match(result.modelContext.text, /Sensitive Teams message body/u);
  assert.doesNotMatch(
    JSON.stringify(result.auditRecord),
    /Sensitive Teams message body|sealed-cursor/u,
  );
});

test("Teams send audit records retain a content commitment, not the message body", () => {
  const result = buildAgentToolSuccessResult({
    toolName: "microsoft_365.send_chat_message",
    input: {
      chatId: "chat-1",
      content: "Sensitive Teams message body",
    },
    output: {
      id: "provider-message-1",
      createdAt: "2026-08-28T12:00:00Z",
    },
  });
  assert.deepEqual(result.auditRecord.input, {
    operation: "chat.send",
    providerChatId: "chat-1",
    contentBytes: 28,
    contentHash: "a5de82407d716213146036718bb9f652006cf43208790e215278a037fb9c1e98",
  });
  assert.deepEqual(result.auditRecord.output, {
    operation: "chat.send",
    providerChatId: "chat-1",
    contentBytes: 28,
    contentHash: "a5de82407d716213146036718bb9f652006cf43208790e215278a037fb9c1e98",
    mutationOutcome: "confirmed",
    providerMessageId: "provider-message-1",
    providerCreatedAt: "2026-08-28T12:00:00Z",
  });
  assert.doesNotMatch(JSON.stringify(result.auditRecord), /Sensitive Teams message body/u);
});

test("Calendar audit records retain no event or attendee content", () => {
  const result = buildAgentToolSuccessResult({
    toolName: "kestrel_one.google_calendar_list_events",
    input: {
      timeMin: "2026-08-28T00:00:00Z",
      timeMax: "2026-08-29T00:00:00Z",
      cursor: "sealed-calendar-cursor",
      maxResults: 25,
    },
    output: {
      operation: "events.list",
      result: {
        events: [{
          id: "provider-event-1",
          summary: "Sensitive event title",
          description: "Sensitive event description",
          location: "Sensitive location",
          attendees: [{ email: "attendee@example.com" }],
        }],
        nextCursor: "next-sealed-calendar-cursor",
      },
    },
  });
  assert.deepEqual(result.auditRecord.input, {
    operation: "events.list",
    timeMin: "2026-08-28T00:00:00Z",
    timeMax: "2026-08-29T00:00:00Z",
    maxResults: 25,
    cursorState: "continued",
  });
  assert.deepEqual(result.auditRecord.output, {
    operation: "events.list",
    resultCount: 1,
    providerEventIds: ["provider-event-1"],
    cursorState: "continued",
    nextPage: true,
  });
  assert.match(result.modelContext.text, /Sensitive event title/u);
  assert.doesNotMatch(
    JSON.stringify(result.auditRecord),
    /Sensitive event|attendee@example.com|sealed-calendar-cursor/u,
  );
});

test("Calendar mutation failure audit retains no event content", () => {
  const result = buildAgentToolFailedOutputResult({
    toolName: "google_workspace.update_event",
    input: {
      eventId: "provider-event-1",
      patch: {
        summary: "Sensitive event title",
        description: "Sensitive event description",
        attendees: [{ email: "attendee@example.com" }],
      },
      notifyAttendees: true,
    },
    output: {
      status: "FAILED",
      errorCode: "GOOGLE_CALENDAR_OUTCOME_UNKNOWN",
    },
  });
  assert.deepEqual(result.auditRecord.input, {
    operation: "events.update",
    providerEventId: "provider-event-1",
    attendeeCount: 1,
    notifyAttendees: true,
  });
  assert.deepEqual(result.auditRecord.output, {
    operation: "events.update",
    providerEventId: "provider-event-1",
    attendeeCount: 1,
    notifyAttendees: true,
    mutationOutcome: "outcome_unknown",
    providerErrorCode: "GOOGLE_CALENDAR_OUTCOME_UNKNOWN",
  });
  assert.doesNotMatch(
    JSON.stringify(result.auditRecord),
    /Sensitive event|attendee@example.com/u,
  );
});

test("replacing a Calendar result preserves its content-free continuation evidence", () => {
  const initial = buildAgentToolSuccessResult({
    toolName: "google_workspace.list_events",
    input: {
      timeMin: "2026-08-28T00:00:00Z",
      timeMax: "2026-08-29T00:00:00Z",
      cursor: "sealed-calendar-cursor",
    },
    output: { events: [], nextCursor: "sealed-next-cursor" },
  });
  const replaced = replaceAgentToolResultOutput(initial, {
    events: [{ id: "provider-event-1", summary: "Live calendar content" }],
    nextCursor: "another-sealed-cursor",
  });

  assert.deepEqual(replaced.auditRecord.output, {
    operation: "events.list",
    resultCount: 1,
    providerEventIds: ["provider-event-1"],
    cursorState: "continued",
    nextPage: true,
  });
  assert.match(replaced.modelContext.text, /Live calendar content/u);
  assert.doesNotMatch(
    JSON.stringify(replaced.auditRecord),
    /Live calendar content|sealed-calendar-cursor|another-sealed-cursor/u,
  );
});

test("internet catalog exposes canonical Tavily tools and removes old semantic names", () => {
  const toolNames = new Set(defaultToolCatalog.list().map((tool) => tool.name));

  for (const name of [
    "internet.search",
    "internet.search_advanced",
    "internet.news",
    "internet.images",
    "internet.extract",
    "internet.crawl",
    "internet.map",
    "internet.research",
    "internet.research_status",
    "internet.usage",
  ]) {
    assert.equal(toolNames.has(name), true, `${name} should be registered`);
  }

  for (const name of [
    "internet.get_url",
    "internet.scrape",
    "internet.headlines",
    "internet.deep_report",
  ]) {
    assert.equal(toolNames.has(name), false, `${name} should not be registered`);
  }
});

test("internet.search_advanced contract still validates dates when country is ignored for non-general topics", () => {
  assert.throws(
    () => validateBuiltInToolInputContract("internet.search_advanced", {
      query: "TCS latest revenue and headcount",
      topic: "news",
      country: "india",
      startDate: "2026-02-31",
    }),
    (error: unknown) => {
      assert.equal(error instanceof RuntimeFailure, true);
      const failure = error as RuntimeFailure;
      assert.equal(failure.code, "TOOL_INPUT_INVALID");
      assert.equal(failure.details?.field, "startDate");
      assert.deepEqual(failure.details?.invalidValues, ["2026-02-31"]);
      return true;
    },
  );
});

const workspaceRootMutationCases = [
  ["fs.mkdir", "."],
  ["fs.mkdir", "./"],
  ["fs.delete", "."],
] as const;

const assertWorkspaceRootMutationRejected = (
  [toolName, inputPath]: (typeof workspaceRootMutationCases)[number],
) => {
  assert.throws(
    () => validateBuiltInToolInputContract(toolName, { path: inputPath }),
    (error: unknown) => {
      assert.equal(error instanceof RuntimeFailure, true);
      const failure = error as RuntimeFailure;
      assert.equal(failure.code, "TOOL_INPUT_INVALID");
      assert.equal(failure.details?.field, "path");
      assert.deepEqual(failure.details?.invalidValues, [inputPath]);
      return true;
    },
  );
};

test("fs.mkdir rejects the dot workspace-root mutation target", () =>
  assertWorkspaceRootMutationRejected(workspaceRootMutationCases[0]));
test("fs.mkdir rejects the dot-slash workspace-root mutation target", () =>
  assertWorkspaceRootMutationRejected(workspaceRootMutationCases[1]));
test("fs.delete rejects the dot workspace-root mutation target", () =>
  assertWorkspaceRootMutationRejected(workspaceRootMutationCases[2]));
