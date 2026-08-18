import assert from "node:assert/strict";
import test from "node:test";

import { buildToolApprovalPresentation } from "../../src/runtime/toolApprovalPresentation.js";

test("approval presenters show meaningful normalized fields without transport secrets", () => {
  const presentation = buildToolApprovalPresentation({
    toolName: "kestrel_one.google_calendar_create_event",
    effectiveInput: {
      event: {
        summary: "Design review",
        start: { dateTime: "2026-08-18T14:00:00Z" },
        end: { dateTime: "2026-08-18T15:00:00Z" },
      },
      accessToken: "secret-token",
      transportEnvelope: { authorization: "hidden" },
    },
    disposition: {
      mode: "ask",
      reasonCode: "project_restriction",
      authority: { kind: "hosted_app_policy", revision: "policy-revision" },
    },
  });

  assert.equal(presentation.title, "Create a calendar event");
  assert.deepEqual(presentation.fields, [
    { label: "Title", value: "Design review" },
    { label: "Starts", value: "2026-08-18T14:00:00Z" },
    { label: "Ends", value: "2026-08-18T15:00:00Z" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(presentation),
    /secret-token|authorization|transportEnvelope/u,
  );
  assert.match(presentation.policy.explanation, /Project narrows/u);
});

test("approval presenters follow the executable email, calendar, Teams, and GitHub schemas", () => {
  const disposition = {
    mode: "ask" as const,
    reasonCode: "environment_policy" as const,
    authority: { kind: "hosted_app_policy" as const, revision: "revision" },
  };
  const calendar = buildToolApprovalPresentation({
    toolName: "kestrel_one.google_calendar_create_event",
    effectiveInput: {
      event: {
        summary: "Design review",
        start: { dateTime: "2026-08-18T14:00:00Z", timeZone: "UTC" },
        end: { dateTime: "2026-08-18T15:00:00Z", timeZone: "UTC" },
        attendees: [{ email: "person@example.com" }],
      },
      notifyAttendees: true,
    },
    disposition,
  });
  assert.deepEqual(calendar.fields, [
    { label: "Title", value: "Design review" },
    { label: "Starts", value: "2026-08-18T14:00:00Z (UTC)" },
    { label: "Ends", value: "2026-08-18T15:00:00Z (UTC)" },
    { label: "Attendees", value: "person@example.com" },
    { label: "Send invitations", value: "true" },
  ]);

  const email = buildToolApprovalPresentation({
    toolName: "kestrel_one.email_send",
    effectiveInput: {
      to: ["person@example.com"],
      subject: "Decision",
      text: "Approve the production change",
    },
    disposition,
  });
  assert.deepEqual(email.fields.at(-1), {
    label: "Message",
    value: "Approve the production change",
  });

  const teams = buildToolApprovalPresentation({
    toolName: "kestrel_one.microsoft_365_send_chat_message",
    effectiveInput: { chatId: "chat-1", content: "Hello team" },
    disposition,
  });
  assert.deepEqual(teams.fields.at(-1), {
    label: "Message",
    value: "Hello team",
  });

  const merge = buildToolApprovalPresentation({
    toolName: "kestrel_one.github_pull_request_merge",
    effectiveInput: {
      repository: "acme/widgets",
      pullNumber: 42,
      method: "squash",
    },
    disposition,
  });
  assert.deepEqual(merge.fields.slice(1), [
    { label: "Pull request", value: "42" },
    { label: "Merge method", value: "squash" },
  ]);
});

test("unknown tools receive a conservative redacted fallback", () => {
  const presentation = buildToolApprovalPresentation({
    toolName: "unknown.tool",
    effectiveInput: { apiKey: "never-render", arbitrary: "also-hidden" },
  });

  assert.deepEqual(presentation.fields, []);
  assert.doesNotMatch(
    JSON.stringify(presentation),
    /never-render|also-hidden|apiKey/u,
  );
  assert.match(presentation.summary, /Sensitive request data is hidden/u);
});
