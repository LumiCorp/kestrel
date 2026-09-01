import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage } from "@/lib/types";
import {
  groupWebCollaboratorMessages,
  withoutWebCollaboratorMessages,
} from "./collaborators";

function dialogMessage(input: {
  id: string;
  dialogId: string;
  name: string;
  sender: "kestrel" | "collaborator" | "system";
  text: string;
  createdAt: string;
  status?: "failed" | "cancelled";
}) {
  return {
    id: input.id,
    role: "assistant",
    parts: [{
      type: "data-kestrel-dialog-message",
      data: {
        version: "v1",
        messageId: input.id,
        dialogId: input.dialogId,
        name: input.name,
        childSessionId: `child-${input.dialogId}`,
        sender: input.sender,
        text: input.text,
        createdAt: input.createdAt,
        dialogStatus: "open",
        dialogActivity: input.sender === "kestrel" ? "working" : "idle",
        ...(input.status === undefined ? {} : { status: input.status }),
      },
    }],
  } as unknown as ChatMessage;
}

test("groups Web dialog parts while removing them from the primary transcript", () => {
  const messages = [
    dialogMessage({ id: "research-1", dialogId: "research", name: "Research", sender: "kestrel", text: "Inspect the API.", createdAt: "2026-08-26T10:00:00.000Z" }),
    {
      id: "answer-1",
      role: "assistant",
      parts: [{ type: "text", text: "I found the contract issue." }],
    } as unknown as ChatMessage,
    dialogMessage({ id: "research-2", dialogId: "research", name: "Research", sender: "collaborator", text: "The validator is missing.", createdAt: "2026-08-26T10:01:00.000Z" }),
  ];

  const groups = groupWebCollaboratorMessages(messages);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.latestEvent, "replied");
  assert.deepEqual(groups[0]?.messages.map((message) => message.text), ["Inspect the API.", "The validator is missing."]);
  assert.deepEqual(withoutWebCollaboratorMessages(messages).map((message) => message.id), ["answer-1"]);
});

test("keeps ordinary parts from a mixed Web message", () => {
  const mixed = {
    id: "mixed",
    role: "assistant",
    parts: [
      { type: "text", text: "Kestrel's summary." },
      dialogMessage({ id: "embedded", dialogId: "review", name: "Review", sender: "collaborator", text: "Private review.", createdAt: "2026-08-26T10:00:00.000Z" }).parts[0],
    ],
  } as unknown as ChatMessage;
  const [visible] = withoutWebCollaboratorMessages([mixed]);
  assert.equal(visible?.parts.length, 1);
  assert.equal(visible?.parts[0]?.type, "text");
});
