import assert from "node:assert/strict";
import { convertToUIMessages } from "@/lib/utils";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "stored durable turn identity survives UI message conversion", () => {
  const [message] = convertToUIMessages([
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "Done." }],
      createdAt: new Date("2026-07-15T12:00:00.000Z"),
      turnId: "turn-1",
    },
  ]);

  assert.equal(message?.metadata?.kestrelTurnId, "turn-1");
});
