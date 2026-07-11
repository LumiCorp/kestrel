import {
  writeKestrelRunnerEventsToUi,
  type KestrelUiStreamWriter,
} from "@/lib/agent/kestrel-ui-stream";
import type { KestrelStreamEventForUi } from "@/lib/agent/kestrel-stream-events";

export async function writeKestrelReconnectStreamToUi(input: {
  writer: KestrelUiStreamWriter;
  events: AsyncIterable<KestrelStreamEventForUi>;
  assistantMessageId: string;
  textPartId: string;
  reasoningPartId: string;
}) {
  const result = await writeKestrelRunnerEventsToUi(input);
  input.writer.write({ type: "finish", finishReason: "stop" });
  return result;
}
