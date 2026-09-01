import assert from "node:assert/strict";
import test from "node:test";

import { buildToolApprovalPresentation } from "../../src/runtime/toolApprovalPresentation.js";
import { normalizeToolActionInput } from "../../tools/runtime/normalizeToolInput.js";

test("Browser upload approval presents only the exact approval-hashed effect", () => {
  const presentation = buildToolApprovalPresentation({
    toolName: "browser.upload",
    effectiveInput: {
      sessionId: "browser-session-1",
      snapshotId: "snapshot-1",
      targetRef: "@e1",
      attachmentId: "attachment-1",
      sourceUrl: "https://storage.example/secret",
    },
    inputAdapters: [{
      adapterId: "kestrel.browser-upload-effect:v1",
      metadata: {
        version: "browser_upload_preparation_v1",
        turnId: "turn-1",
        threadId: "thread-1",
        attachmentId: "attachment-1",
        filename: "evidence.txt",
        declaredMediaType: "text/plain",
        detectedMediaType: "text/plain",
        sizeBytes: 19,
        sha256: "a".repeat(64),
        sessionId: "browser-session-1",
        generation: 1,
        snapshotId: "snapshot-1",
        documentRevision: "document-1",
        targetRef: "@e1",
        targetLabel: "Supporting evidence",
      },
    }],
    disposition: {
      mode: "ask",
      reasonCode: "tool_minimum",
      authority: { kind: "runtime_policy", revision: "approval-revision" },
    },
  });

  assert.equal(presentation.title, "Upload attachment");
  assert.deepEqual(presentation.fields, [
    { label: "File", value: "evidence.txt" },
    { label: "Measured size", value: "19 bytes (100 MiB maximum)" },
    { label: "Declared media type", value: "text/plain (untrusted metadata)" },
    { label: "Browser target", value: "Supporting evidence" },
  ]);
  assert.equal(presentation.policy.rememberApprovalEligible, false);
  assert.doesNotMatch(JSON.stringify(presentation), /sourceUrl|storage\.example|sha256/u);
});

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

test("Desktop Gmail approvals display the exact provider and Thread-file preparation", () => {
  const presentation = buildToolApprovalPresentation({
    toolName: "google_workspace.reply_gmail",
    effectiveInput: {
      messageId: "model-supplied-message-id",
      text: "The exact reply body.",
      __kestrelGmailPrepared: {
        envelope: {
          to: ["recipient@example.com"],
          cc: [],
          subject: "Re: Planning",
          text: "The exact reply body.",
          threadId: "provider-thread-1",
        },
        attachments: [{
          fileId: "file-1",
          filename: "plan.pdf",
          mediaType: "application/pdf",
          sizeBytes: 42,
          sha256: "a".repeat(64),
        }],
      },
    },
  });
  assert.equal(presentation.title, "Reply with Gmail");
  assert.deepEqual(presentation.fields.slice(0, 4), [
    { label: "Thread", value: "provider-thread-1" },
    { label: "To", value: "recipient@example.com" },
    { label: "Subject", value: "Re: Planning" },
    { label: "Message", value: "The exact reply body." },
  ]);
  assert.match(presentation.fields.at(-1)?.value ?? "", /plan\.pdf/u);
  assert.doesNotMatch(JSON.stringify(presentation), /model-supplied-message-id/u);
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

test("Browser domain grants expose one canonical allow-and-remember decision", () => {
  const presentation = buildToolApprovalPresentation({
    toolName: "browser.request_grant",
    effectiveInput: {
      sessionId: "browser-session-1",
      destination:
        "https://tenant.docs.example.com/private/path?token=secret#fragment",
    },
    disposition: {
      mode: "ask",
      reasonCode: "environment_policy",
      authority: { kind: "hosted_app_policy", revision: "browser-policy-7" },
    },
    hostedApprovalScope: {
      requestingActorId: "user-7",
      environmentId: "environment-3",
    },
  });

  assert.equal(presentation.title, "Allow this Browser domain");
  assert.deepEqual(presentation.browserDomainGrant, {
    version: "browser_domain_grant_approval_v1",
    sessionId: "browser-session-1",
    sessionMode: "operator",
    canonicalDomain: "example.com",
    scheme: "https",
    scope: "apex_and_subdomains",
    includeSubdomains: true,
    port: 443,
    ownerEffect: "requesting_person",
    environmentEffect: "future_eligible_projects_in_environment",
    sessionEffect: "immediate",
    actionLabel: "Allow and remember",
    requestingActorId: "user-7",
    environmentId: "environment-3",
    approvalAuthorityRevision: "browser-policy-7",
  });
  assert.equal(presentation.policy.rememberApprovalEligible, false);
  assert.match(JSON.stringify(presentation), /Apex and subdomains/u);
  assert.match(JSON.stringify(presentation), /user-7/u);
  assert.match(JSON.stringify(presentation), /environment-3/u);
  assert.doesNotMatch(JSON.stringify(presentation), /private|token|secret|fragment/u);
  assert.throws(
    () =>
      buildToolApprovalPresentation({
        toolName: "browser.request_grant",
        effectiveInput: {
          sessionId: "browser-session-1",
          destination: "http://example.com",
        },
      }),
    /HTTPS/u,
  );
});

test("Workspace file-share approval names every selected path and public-link control", () => {
  const presentation = buildToolApprovalPresentation({
    toolName: "workspace.files.share",
    effectiveInput: {
      mode: "zip",
      paths: ["reports/summary.pdf", "reports/data.csv"],
      downloadName: "analysis.zip",
      ttlMinutes: 60,
    },
  });

  assert.equal(presentation.title, "Share Workspace files");
  assert.deepEqual(presentation.fields, [
    { label: "Mode", value: "zip" },
    {
      label: "Selected files",
      value: '["reports/summary.pdf","reports/data.csv"]',
    },
    { label: "Download name", value: "analysis.zip" },
    { label: "Lifetime (minutes)", value: "60" },
  ]);
  assert.match(presentation.warnings.join(" "), /Anyone with the temporary link/u);
});

test("Workspace file-share approval shows deterministic effective defaults", () => {
  const fileInput = normalizeToolActionInput("workspace.files.share", {
    mode: "file",
    paths: ["reports/final report.pdf"],
  });
  const zipInput = normalizeToolActionInput("workspace.files.share", {
    mode: "zip",
    paths: ["reports/summary.pdf", "reports/data.csv"],
  });

  const filePresentation = buildToolApprovalPresentation({
    toolName: "workspace.files.share",
    effectiveInput: fileInput,
  });
  const zipPresentation = buildToolApprovalPresentation({
    toolName: "workspace.files.share",
    effectiveInput: zipInput,
  });

  assert.deepEqual(filePresentation.fields.slice(2), [
    { label: "Download name", value: "final report.pdf" },
    { label: "Lifetime (minutes)", value: "60" },
  ]);
  assert.deepEqual(zipPresentation.fields.slice(2), [
    { label: "Download name", value: "kestrel-files.zip" },
    { label: "Lifetime (minutes)", value: "60" },
  ]);
});

test("Workspace file-share approval preserves comma-bearing path boundaries", () => {
  const effectiveInput = normalizeToolActionInput("workspace.files.share", {
    mode: "zip",
    paths: ["reports/alpha,beta.csv", "reports/alpha", "beta.csv"],
    downloadName: "  selected reports.zip  ",
    ttlMinutes: 90,
  });
  const presentation = buildToolApprovalPresentation({
    toolName: "workspace.files.share",
    effectiveInput,
  });

  assert.deepEqual(presentation.fields, [
    { label: "Mode", value: "zip" },
    {
      label: "Selected files",
      value: '["reports/alpha,beta.csv","reports/alpha","beta.csv"]',
    },
    { label: "Download name", value: "selected reports.zip" },
    { label: "Lifetime (minutes)", value: "90" },
  ]);
});
