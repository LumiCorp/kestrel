"use client";

import { useEffect } from "react";
import { useSWRConfig } from "swr";

export function ThreadReadMarker({
  threadId,
  messageId,
}: {
  threadId: string;
  messageId: string;
}) {
  const { mutate } = useSWRConfig();

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/mobile/v2/threads/${threadId}/read`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId }),
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) return;
        void mutate(
          (key) => typeof key === "string" && key.startsWith("/api/threads")
        );
      })
      .catch(() => {
        // Read state is a best-effort enhancement and navigation aborts requests.
      });
    return () => controller.abort();
  }, [messageId, mutate, threadId]);

  return null;
}
