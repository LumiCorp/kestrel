export interface ServerSentEvent {
  event?: string | undefined;
  data: string;
}

/** Minimal spec-shaped SSE reader shared by provider adapters. */
export async function readServerSentEvents(
  response: Response,
  onEvent: (event: ServerSentEvent) => void | Promise<void>,
): Promise<void> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("Provider returned an empty streaming response body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    buffer = await drainEvents(buffer, onEvent, false);
  }
  await drainEvents(buffer, onEvent, true);
}

async function drainEvents(
  input: string,
  onEvent: (event: ServerSentEvent) => void | Promise<void>,
  flush: boolean,
): Promise<string> {
  const normalized = input
    .replace(/\r\n/gu, "\n")
    .replace(flush ? /\r/gu : /\r(?!$)/gu, "\n");
  const frames = normalized.split("\n\n");
  const trailing = flush ? "" : (frames.pop() ?? "");
  for (const frame of frames) {
    const parsed = parseFrame(frame);
    if (parsed !== undefined) {
      await onEvent(parsed);
    }
  }
  if (flush && trailing.length > 0) {
    const parsed = parseFrame(trailing);
    if (parsed !== undefined) {
      await onEvent(parsed);
    }
  }
  return trailing;
}

function parseFrame(frame: string): ServerSentEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trimStart();
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  if (data.length === 0) {
    return ;
  }
  return {
    ...(event !== undefined ? { event } : {}),
    data: data.join("\n"),
  };
}
