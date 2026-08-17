export const conversationConformanceFixture = {
  threadId: "thread-conformance",
  turns: [
    {
      id: "turn-1",
      sequence: 1,
      inputMessageId: "message-user-1",
      rootRunId: "run-1",
      status: "completed",
    },
    {
      id: "turn-2",
      sequence: 2,
      inputMessageId: "message-user-2",
      rootRunId: "run-2",
      status: "running",
    },
  ],
  messages: [
    { id: "terminal:run-2", role: "assistant", turnId: "turn-2", text: "Working." },
    { id: "message-user-1", role: "user", text: "Inspect the workspace." },
    { id: "terminal:run-1", role: "assistant", turnId: "turn-1", text: "Ready." },
    { id: "message-user-2", role: "user", text: "Start the server." },
  ],
  expected: [
    { turnId: "turn-1", messageIds: ["message-user-1", "terminal:run-1"] },
    { turnId: "turn-2", messageIds: ["message-user-2", "terminal:run-2"] },
  ],
} as const;

export function normalizeConversationConformanceProjection(input: {
  items: ReadonlyArray<
    | { kind: "durable_turn"; turnId: string; messages: readonly { id: string }[] }
    | { kind: "standalone_message"; message: { id: string } }
  >;
}) {
  return input.items.flatMap((item) => item.kind === "durable_turn"
    ? [{ turnId: item.turnId, messageIds: item.messages.map((message) => message.id) }]
    : []);
}
