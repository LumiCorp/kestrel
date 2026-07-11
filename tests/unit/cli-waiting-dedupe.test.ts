import test from "node:test";
import assert from "node:assert/strict";

import { isSameWaitFor } from "../../cli/app/App.js";

test("isSameWaitFor returns true when event and prompt match", () => {
  const left = {
    kind: "user" as const,
    eventType: "user.reply",
    metadata: {
      prompt: "Need one clarification",
    },
  };
  const right = {
    kind: "user" as const,
    eventType: "user.reply",
    metadata: {
      prompt: "Need one clarification",
    },
  };

  assert.equal(isSameWaitFor(left, right), true);
});

test("isSameWaitFor returns false when prompt or event differs", () => {
  assert.equal(
    isSameWaitFor(
      {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          prompt: "Prompt A",
        },
      },
      {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          prompt: "Prompt B",
        },
      },
    ),
    false,
  );

  assert.equal(
    isSameWaitFor(
      {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          prompt: "Prompt A",
        },
      },
      {
        kind: "region_merge",
        eventType: "system.meta_reasoning",
        metadata: {
          prompt: "Prompt A",
        },
      },
    ),
    false,
  );
});
