import { randomUUID } from "node:crypto";

import type { TuiProfile } from "../cli/contracts.js";
import { KestrelChatRuntime } from "../cli/runtime/KestrelChatRuntime.js";

async function main(): Promise<void> {
  const message = process.argv.slice(2).join(" ").trim();
  if (message.length === 0) {
    throw new Error("usage: pnpm -s tsx scripts/debug-turn.ts \"<message>\"");
  }

  const profile: TuiProfile = {
    id: "debug-reference-react",
    label: "Debug Reference React",
    agent: "reference-react",
    sessionPrefix: "debug",
  };

  const runtime = new KestrelChatRuntime(profile, undefined, {
    onRunLog: (entry) => {
      process.stdout.write(
        `[${entry.level}] ${entry.eventName}` +
          `${entry.stepIndex !== undefined ? ` step=${entry.stepIndex}` : ""}` +
          `${entry.metadata !== undefined ? ` ${JSON.stringify(entry.metadata)}` : ""}\n`,
      );
    },
  });

  try {
    const sessionId = `debug-${randomUUID()}`;
    const result = await runtime.runTurn({
      sessionId,
      message,
      eventType: "user.message",
      stepAgent: runtime.getEntryStepAgent(),
    });

    process.stdout.write(`output=${JSON.stringify(result.output)}\n`);
    if (result.finalizedPayload !== undefined) {
      process.stdout.write(`finalized=${JSON.stringify(result.finalizedPayload)}\n`);
    }
  } finally {
    await runtime.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`[debug-turn] failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
