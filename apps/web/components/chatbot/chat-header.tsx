"use client";

import { FolderCode, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { memo } from "react";
import { SidebarToggle } from "@/components/chatbot/sidebar-toggle";
import { Button } from "@/components/chatbot/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/chatbot/ui/tooltip";
import { PlusIcon } from "./icons";
import { VisibilitySelector, type VisibilityType } from "./visibility-selector";

function PureChatHeader({
  threadId,
  threadTitle,
  project,
  selectedVisibilityType,
  isReadonly,
}: {
  threadId: string;
  threadTitle?: string;
  project?: { id: string; name: string } | null;
  selectedVisibilityType: VisibilityType;
  isReadonly: boolean;
}) {
  const router = useRouter();

  return (
    <header className="sticky top-0 z-10 flex min-h-14 items-center gap-2 border-b bg-background px-3 py-2 md:px-5">
      <SidebarToggle className="md:hidden" />
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate font-semibold text-lg">
          {threadTitle || "New Thread"}
        </h1>
        {project ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={`Shared Project: ${project.name}`}
                className="hidden size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground sm:flex"
              >
                <Users className="size-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent>Shared Project: {project.name}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Button
          className="h-8 px-2 md:hidden"
          onClick={() => {
            router.push(
              project ? `/projects/${project.id}/threads/new` : "/threads/new"
            );
          }}
          variant="outline"
        >
          <PlusIcon />
          <span className="sr-only">New Thread</span>
        </Button>
        {!isReadonly && (
          <VisibilitySelector
            selectedVisibilityType={selectedVisibilityType}
            threadId={threadId}
          />
        )}
        {!isReadonly && (
          <Button
            className="h-8 px-2"
            onClick={() => router.push(`/threads/${threadId}/workspace`)}
            variant="outline"
          >
            <FolderCode className="size-4" />
            <span className="hidden sm:inline">Workspace</span>
          </Button>
        )}
      </div>
    </header>
  );
}

export const ChatHeader = memo(
  PureChatHeader,
  (prevProps, nextProps) =>
    prevProps.threadId === nextProps.threadId &&
    prevProps.threadTitle === nextProps.threadTitle &&
    prevProps.project?.id === nextProps.project?.id &&
    prevProps.project?.name === nextProps.project?.name &&
    prevProps.selectedVisibilityType === nextProps.selectedVisibilityType &&
    prevProps.isReadonly === nextProps.isReadonly
);
