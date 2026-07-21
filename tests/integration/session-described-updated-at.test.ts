import assert from "node:assert/strict";

import type { TuiProfile } from "../../cli/contracts.js";
import { normalizeRunnerEventPayload } from "../../cli/runner/EventWriter.js";
import { createInMemoryRunnerService } from "../../cli/runner/RunnerService.js";
import { contractTest } from "../helpers/contract-test.js";


const profile: TuiProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};

contractTest("runtime.process", "runner event shaping removes blank session timestamps before protocol validation", () => {
  const described = normalizeRunnerEventPayload("session.described", {
    sessionId: "session-legacy-blank-timestamp",
    version: 1,
    updatedAt: "   ",
  });
  assert.equal("updatedAt" in described, false);

  const state = normalizeRunnerEventPayload("session.state", {
    session: {
      sessionId: "session-legacy-blank-timestamp",
      version: 1,
      updatedAt: "",
    },
    version: 1,
    graph: {
      version: 1,
      rootTaskIds: [],
      tasks: {},
    },
  });
  assert.equal("updatedAt" in state.session, false);
});

contractTest("runtime.process", "runner service describes a legacy session repeatedly without emitting a protocol error", async () => {
  let descriptions = 0;
  const service = createInMemoryRunnerService({
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("not used");
      },
      describeSession: async (sessionId) => {
        descriptions += 1;
        return {
          sessionId,
          version: descriptions,
          updatedAt: "",
        };
      },
      close: async () => {},
    }),
  });

  try {
    for (let turn = 1; turn <= 3; turn += 1) {
      const response = await service.dispatch({
        method: "POST",
        url: "/commands",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: `cmd-session-describe-${turn}`,
          type: "session.describe",
          metadata: {
            actor: {
              actorId: "test-user",
              actorType: "end_user",
            },
            profile,
          },
          payload: {
            sessionId: "session-legacy-blank-timestamp",
          },
        }),
      });

      const event = JSON.parse(response.body) as {
        type: string;
        payload: Record<string, unknown>;
      };
      assert.equal(response.statusCode, 200);
      assert.equal(event.type, "session.described");
      assert.equal(event.payload.sessionId, "session-legacy-blank-timestamp");
      assert.equal(event.payload.version, turn);
      assert.equal("updatedAt" in event.payload, false);
    }
  } finally {
    await service.close();
  }
});
