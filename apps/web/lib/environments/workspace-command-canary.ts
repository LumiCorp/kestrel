type CanaryMessage = {
  role?: unknown;
  metadata?: { kestrelTurnId?: unknown } | null;
  parts?: unknown;
};

export function hasCompletedExecCommandCanaryProof(
  messages: CanaryMessage[],
  turnId: string,
  marker: string,
): boolean {
  return messages.some((message) => {
    if (
      message.role !== "assistant" ||
      message.metadata?.kestrelTurnId !== turnId ||
      !Array.isArray(message.parts)
    ) {
      return false;
    }
    return message.parts.some((part) => {
      if (!isRecord(part) || part.type !== "data-kestrel-tool") return false;
      const data = isRecord(part.data) ? part.data : undefined;
      const output = isRecord(data?.output) ? data.output : undefined;
      const auditRecord = isRecord(output?.auditRecord) ? output.auditRecord : undefined;
      const commandOutput = isRecord(auditRecord?.output) ? auditRecord.output : undefined;
      return data?.toolName === "exec_command" &&
        data.phase === "completed" &&
        output?.status === "OK" &&
        commandOutput?.status === "completed" &&
        commandOutput.exitCode === 0 &&
        [commandOutput.output, commandOutput.text, commandOutput.stdout]
          .some((value) => typeof value === "string" && value.includes(marker));
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
