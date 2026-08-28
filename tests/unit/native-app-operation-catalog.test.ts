import test from "node:test";
import assert from "node:assert/strict";

import {
  MICROSOFT_365_OPERATION_DESCRIPTORS,
  MICROSOFT_365_PACK_SCOPES,
  microsoft365MinimumApprovalMode,
  microsoft365OperationDescriptor,
} from "../../src/apps/microsoft365.js";
import {
  GOOGLE_WORKSPACE_BASE_SCOPES,
  GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS,
  GOOGLE_WORKSPACE_PACK_SCOPES,
  googleWorkspaceMinimumApprovalMode,
  googleWorkspaceOperationDescriptor,
} from "../../src/apps/googleWorkspace.js";

test("the canonical Teams operations map scopes, tools, and service methods", () => {
  assert.deepEqual(MICROSOFT_365_OPERATION_DESCRIPTORS, [
    {
      id: "teams.chat.read",
      inputContractId: "microsoft365.teams.chats.list.input.v1",
      resultContractId: "microsoft365.teams.chats.list.result.v1",
      approvalResourceSelector: "account.primary",
      auditIdentity: "microsoft365.teams.chats.list",
      pack: "teams",
      requiredScopes: ["Chat.Read"],
      serviceOperation: "chats.list",
      desktopToolName: "microsoft_365.list_chats",
      hostedToolName: "kestrel_one.microsoft_365_list_chats",
      sideEffect: "read",
      minimumApprovalMode: "auto",
    },
    {
      id: "teams.chat.messages.read",
      inputContractId: "microsoft365.teams.chat.messages.list.input.v1",
      resultContractId: "microsoft365.teams.chat.messages.list.result.v1",
      approvalResourceSelector: "chat.input.chatId",
      auditIdentity: "microsoft365.teams.chat.messages.list",
      pack: "teams",
      requiredScopes: ["Chat.Read"],
      serviceOperation: "chat.messages.list",
      desktopToolName: "microsoft_365.list_chat_messages",
      hostedToolName: "kestrel_one.microsoft_365_list_chat_messages",
      sideEffect: "read",
      minimumApprovalMode: "auto",
    },
    {
      id: "teams.chat.send",
      inputContractId: "microsoft365.teams.chats.send.input.v1",
      resultContractId: "microsoft365.teams.chats.send.result.v1",
      approvalResourceSelector: "chat.input.chatId",
      auditIdentity: "microsoft365.teams.chats.send",
      pack: "teams",
      requiredScopes: ["ChatMessage.Send"],
      serviceOperation: "chat.send",
      desktopToolName: "microsoft_365.send_chat_message",
      hostedToolName: "kestrel_one.microsoft_365_send_chat_message",
      sideEffect: "external_side_effect",
      minimumApprovalMode: "ask",
    },
  ]);
  assert.equal(
    microsoft365OperationDescriptor("chat.send").minimumApprovalMode,
    "ask",
  );
  assert.equal(microsoft365MinimumApprovalMode("chats.list"), "auto");
});

test("the canonical Calendar operations require approval for every mutation", () => {
  assert.equal(googleWorkspaceMinimumApprovalMode("events.list"), "auto");
  for (const operation of [
    "events.create",
    "events.update",
    "events.delete",
  ] as const) {
    const descriptor = googleWorkspaceOperationDescriptor(operation);
    assert.equal(descriptor.sideEffect, "external_side_effect");
    assert.equal(descriptor.minimumApprovalMode, "ask");
    assert.ok(descriptor.requiredScopes.length > 0);
    assert.match(descriptor.inputContractId, /\.input\.v1$/u);
    assert.match(descriptor.resultContractId, /\.result\.v1$/u);
    assert.match(descriptor.auditIdentity, /^google_workspace\.calendar\./u);
    assert.ok(descriptor.approvalResourceSelector.length > 0);
  }
  assert.deepEqual(
    GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS.filter(
      (descriptor) => descriptor.pack === "calendar",
    ).map(
      (descriptor) => descriptor.desktopToolName,
    ),
    [
      "google_workspace.list_events",
      "google_workspace.create_event",
      "google_workspace.update_event",
      "google_workspace.delete_event",
    ],
  );
});

test("the canonical Gmail operations retain distinct readonly and approval-required contracts", () => {
  const gmail = GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS.filter(
    (descriptor) => descriptor.pack === "gmail",
  );
  assert.deepEqual(
    gmail.map((descriptor) => descriptor.serviceOperation),
    [
      "gmail.messages.search",
      "gmail.messages.get",
      "gmail.threads.get",
      "gmail.attachments.import",
      "gmail.messages.send",
      "gmail.messages.reply",
    ],
  );
  for (const descriptor of gmail.filter((descriptor) => descriptor.sideEffect === "read")) {
    assert.equal(descriptor.sideEffect, "read");
    assert.equal(descriptor.minimumApprovalMode, "auto");
    assert.deepEqual(descriptor.requiredScopes, [
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
  }
  for (const descriptor of gmail.filter((descriptor) => descriptor.sideEffect === "external_side_effect")) {
    assert.equal(descriptor.minimumApprovalMode, "ask");
    assert.deepEqual(descriptor.requiredScopes, ["https://www.googleapis.com/auth/gmail.send"]);
  }
});

test("deferred Microsoft packs and Google resource scopes remain explicit", () => {
  assert.deepEqual(MICROSOFT_365_PACK_SCOPES.outlook, [
    "Mail.Read",
    "Mail.Send",
    "Calendars.Read",
  ]);
  assert.deepEqual(MICROSOFT_365_PACK_SCOPES.sharepoint, ["Sites.Read.All"]);
  assert.deepEqual(GOOGLE_WORKSPACE_BASE_SCOPES, ["openid", "email", "profile"]);
  assert.deepEqual(GOOGLE_WORKSPACE_PACK_SCOPES.calendar, [
    "https://www.googleapis.com/auth/calendar.events.owned",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
  ]);
  assert.deepEqual(GOOGLE_WORKSPACE_PACK_SCOPES.gmail, [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ]);
});
