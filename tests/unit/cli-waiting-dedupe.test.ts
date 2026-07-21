import assert from "node:assert/strict";

import { isSameWaitFor } from "../../cli/app/App.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "isSameWaitFor returns true when event and prompt match", () => {
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

contractTest("runtime.hermetic", "isSameWaitFor returns false when prompt or event differs", () => {
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
