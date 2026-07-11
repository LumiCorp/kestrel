import type { AppRenderState } from "../contracts.js";

const MAX_CHAT_LINES = 14;
const MAX_LOG_LINES = 10;

export class Renderer {
  render(state: AppRenderState): void {
    process.stdout.write("\x1bc");

    const header =
      `${state.appName} | profile=${state.activeProfile.label} | session=${state.activeSession.name}`;
    process.stdout.write(`${header}\n`);
    process.stdout.write(`${"-".repeat(Math.max(header.length, 48))}\n`);

    process.stdout.write("chat\n");
    process.stdout.write(`${"-".repeat(Math.max(header.length, 48))}\n`);

    const lines = state.transcript.slice(-MAX_CHAT_LINES);
    for (const line of lines) {
      process.stdout.write(`${formatRole(line.role)} ${line.text}\n`);
      if (line.data !== undefined) {
        process.stdout.write(`    ${safeStringify(line.data)}\n`);
      }
    }

    process.stdout.write("\n");
    process.stdout.write("execution\n");
    process.stdout.write(`${"-".repeat(Math.max(header.length, 48))}\n`);
    const logs = state.runLogs.slice(-MAX_LOG_LINES);
    for (const entry of logs) {
      const level = entry.level.toLowerCase();
      const scope = entry.stepIndex !== undefined ? ` step=${entry.stepIndex}` : "";
      process.stdout.write(`[${level}] ${entry.eventName}${scope}\n`);
      if (entry.metadata !== undefined) {
        process.stdout.write(`    ${safeStringify(entry.metadata, 240)}\n`);
      }
    }

    process.stdout.write("\n");
    process.stdout.write(`${"-".repeat(Math.max(header.length, 48))}\n`);
    process.stdout.write(`status: ${state.statusLine}\n`);
    process.stdout.write("Type /help for commands.\n\n");
  }

  printSystem(message: string): void {
    process.stdout.write(`${formatRole("system")} ${message}\n`);
  }
}

function formatRole(role: "user" | "assistant" | "system"): string {
  if (role === "user") {
    return "[you]";
  }
  if (role === "assistant") {
    return "[agent]";
  }

  return "[system]";
}

function safeStringify(value: unknown, maxLength = 400): string {
  try {
    const json = JSON.stringify(value);
    if (json.length <= maxLength) {
      return json;
    }

    return `${json.slice(0, maxLength - 3)}...`;
  } catch {
    return "<unserializable>";
  }
}
