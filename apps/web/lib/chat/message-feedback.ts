import { getErrorFromResponse } from "@/lib/utils";

export type AssistantMessageFeedback = "positive" | "negative" | null;
type FetchMessageFeedback = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export function nextMessageFeedback(
  current: AssistantMessageFeedback,
  selected: Exclude<AssistantMessageFeedback, null>
): AssistantMessageFeedback {
  return current === selected ? null : selected;
}

export async function patchMessageFeedback(input: {
  feedback: AssistantMessageFeedback;
  fetchImpl?: FetchMessageFeedback;
  messageId: string;
  threadId: string;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`/api/messages/${input.messageId}/feedback`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      threadId: input.threadId,
      feedback: input.feedback,
    }),
  });

  if (!response.ok) {
    throw await getErrorFromResponse(response);
  }
}
