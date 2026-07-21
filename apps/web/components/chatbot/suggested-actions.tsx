"use client";

import { motion } from "framer-motion";
import { memo, useMemo } from "react";
import {
  type ChatSuggestion,
  selectChatSuggestions,
} from "@/lib/chat/suggestion-catalog";
import { Suggestion } from "./elements/suggestion";
import type { VisibilityType } from "./visibility-selector";

type SuggestedActionsProps = {
  threadId: string;
  imageEnabled: boolean;
  knowledgeEnabled: boolean;
  onSuggestionSelect: (suggestion: ChatSuggestion) => void;
  selectedVisibilityType: VisibilityType;
  videoEnabled: boolean;
};

function PureSuggestedActions({
  threadId,
  imageEnabled,
  knowledgeEnabled,
  onSuggestionSelect,
  videoEnabled,
}: SuggestedActionsProps) {
  const suggestedActions = useMemo(
    () =>
      selectChatSuggestions({
        seed: threadId,
        imageEnabled,
        knowledgeEnabled,
        videoEnabled,
      }),
    [threadId, imageEnabled, knowledgeEnabled, videoEnabled]
  );

  return (
    <div
      className="grid w-full gap-2 sm:grid-cols-2"
      data-testid="suggested-actions"
    >
      {suggestedActions.map((suggestedAction, index) => (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          initial={{ opacity: 0, y: 20 }}
          key={suggestedAction.id}
          transition={{ delay: 0.05 * index }}
        >
          <Suggestion
            className="h-auto min-h-9 w-full justify-start whitespace-normal px-3 py-2 text-left font-normal text-muted-foreground text-xs leading-4 hover:text-foreground"
            onClick={() => onSuggestionSelect(suggestedAction)}
            suggestion={suggestedAction.label}
          >
            {suggestedAction.label}
          </Suggestion>
        </motion.div>
      ))}
    </div>
  );
}

export const SuggestedActions = memo(
  PureSuggestedActions,
  (prevProps, nextProps) => {
    if (prevProps.threadId !== nextProps.threadId) {
      return false;
    }
    if (prevProps.imageEnabled !== nextProps.imageEnabled) {
      return false;
    }
    if (prevProps.knowledgeEnabled !== nextProps.knowledgeEnabled) {
      return false;
    }
    if (prevProps.selectedVisibilityType !== nextProps.selectedVisibilityType) {
      return false;
    }
    if (prevProps.videoEnabled !== nextProps.videoEnabled) {
      return false;
    }

    return true;
  }
);
