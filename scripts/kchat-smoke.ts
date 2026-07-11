import { ProtocolClient } from "../cli/client/ProtocolClient.js";
import { InProcessRunnerTransport } from "../cli/client/InProcessRunnerTransport.js";

async function main(): Promise<void> {
  const client = new ProtocolClient(new InProcessRunnerTransport());
  try {
    const pong = await client.sendCommand("runner.ping", { nonce: "kchat-smoke" });
    if (pong.type !== "runner.pong" || pong.payload.nonce !== "kchat-smoke") {
      throw new Error("runner.ping did not round-trip");
    }

    const described = await client.sendCommand("session.describe", {
      sessionId: "smoke-session",
    });
    if (described.type !== "session.described" || described.payload.sessionId !== "smoke-session") {
      throw new Error("session.describe did not return expected session");
    }

    process.stdout.write("kchat smoke: protocol ok\n");
  } finally {
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`kchat smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
