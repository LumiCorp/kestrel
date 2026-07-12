"use client";

import { useState } from "react";
import { toast } from "sonner";
import useSWR, { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import {
  getThreadHistoryPaginationKey,
  type ThreadHistory,
} from "@/components/chatbot/sidebar-history";
import type { VisibilityType } from "@/components/visibility-selector";

export function useChatVisibility({
  threadId,
  initialVisibilityType,
  initialShareToken,
}: {
  threadId: string;
  initialVisibilityType: VisibilityType;
  initialShareToken?: string | null;
}) {
  const { mutate } = useSWRConfig();
  const [shareToken, setShareToken] = useState<string | null>(
    initialShareToken ?? null
  );

  const { data: localVisibility, mutate: setLocalVisibility } = useSWR(
    `${threadId}-visibility`,
    null,
    {
      fallbackData: initialVisibilityType,
    }
  );

  const setVisibilityType = async (updatedVisibilityType: VisibilityType) => {
    const previousVisibilityType = localVisibility ?? initialVisibilityType;

    setLocalVisibility(updatedVisibilityType, { revalidate: false });
    mutate<ThreadHistory[]>(
      unstable_serialize(getThreadHistoryPaginationKey),
      (pages) =>
        pages?.map((page) => ({
          ...page,
          threads: page.threads.map((thread) =>
            thread.id === threadId
              ? { ...thread, visibility: updatedVisibilityType }
              : thread
          ),
        })),
      { revalidate: false }
    );

    try {
      const response = await fetch(`/api/threads/${threadId}/share`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          isPublic: updatedVisibilityType === "public",
        }),
      });

      const json = (await response.json().catch(() => null)) as {
        shareToken?: string | null;
      } | null;

      if (!response.ok) {
        throw new Error("Failed to update visibility");
      }

      const nextShareToken =
        updatedVisibilityType === "public"
          ? (json?.shareToken ?? shareToken)
          : null;
      setShareToken(nextShareToken);
      mutate(unstable_serialize(getThreadHistoryPaginationKey));
      mutate("/api/threads?limit=30");
      mutate(`/api/threads/${threadId}`);

      if (updatedVisibilityType === "public" && nextShareToken) {
        const shareUrl = `${window.location.origin}/shared/${nextShareToken}`;
        void navigator.clipboard
          .writeText(shareUrl)
          .then(() => toast.success("Share link copied to clipboard"))
          .catch(() => toast.success("Thread is now public"));
      }
    } catch (_error) {
      setLocalVisibility(previousVisibilityType, { revalidate: false });
      mutate(unstable_serialize(getThreadHistoryPaginationKey));
      mutate("/api/threads?limit=30");
      mutate(`/api/threads/${threadId}`);
      toast.error("Failed to update Thread visibility");
    }
  };

  const copyShareLink = async () => {
    if (!shareToken) {
      toast.error("No share link is available for this Thread yet.");
      return;
    }

    await navigator.clipboard.writeText(
      `${window.location.origin}/shared/${shareToken}`
    );
    toast.success("Share link copied to clipboard");
  };

  return {
    visibilityType: localVisibility,
    shareToken,
    setVisibilityType,
    copyShareLink,
  };
}
