"use client";

import {
  collaboratorStateLabel,
  type CollaboratorGroup,
} from "@kestrel-agents/conversation";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet";

export function CollaboratorInspector({
  groups,
  open,
  onOpenChange,
  canAsk,
  onAsk,
}: {
  groups: readonly CollaboratorGroup[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canAsk: boolean;
  onAsk: (group: CollaboratorGroup) => void;
}) {
  const [selectedDialogId, setSelectedDialogId] = useState<string | undefined>(
    groups[0]?.dialogId,
  );
  const selected = groups.find((group) => group.dialogId === selectedDialogId)
    ?? groups[0];
  const openGroups = groups.filter((group) => group.lifecycle === "open");
  const archivedGroups = groups.filter((group) => group.lifecycle === "closed");

  useEffect(() => {
    if (selected !== undefined) return;
    setSelectedDialogId(groups[0]?.dialogId);
  }, [groups, selected]);

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="flex w-[min(30rem,100vw)] flex-col gap-0 p-0 sm:max-w-none" side="right">
        <SheetHeader className="border-b px-5 py-4 pr-12">
          <SheetTitle>Collaborators</SheetTitle>
          <SheetDescription>
            Private conversations Kestrel uses while working on this Thread.
          </SheetDescription>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(9rem,0.8fr)_minmax(0,1.4fr)] overflow-hidden">
          <nav aria-label="Collaborators" className="overflow-y-auto border-r p-2">
            <CollaboratorList
              groups={openGroups}
              label="Open"
              onSelect={setSelectedDialogId}
              selectedDialogId={selected?.dialogId}
            />
            <CollaboratorList
              groups={archivedGroups}
              label="Archived"
              onSelect={setSelectedDialogId}
              selectedDialogId={selected?.dialogId}
            />
          </nav>
          <section aria-label={selected?.name ?? "Collaborator details"} className="min-w-0 overflow-y-auto p-4">
            {selected === undefined ? (
              <p className="text-muted-foreground text-sm">No collaborator history is available.</p>
            ) : (
              <>
                <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="font-semibold">{selected.name}</h2>
                    <p className="text-muted-foreground text-sm" role="status">{collaboratorStateLabel(selected)}</p>
                    {selected.latestEvent === "replied" ? (
                      <p className="mt-1 text-muted-foreground text-xs">{selected.name} replied</p>
                    ) : null}
                  </div>
                  {canAsk ? (
                    <Button onClick={() => onAsk(selected)} size="sm" variant="outline">
                      Ask Kestrel
                    </Button>
                  ) : null}
                </div>
                <ol className="space-y-3">
                  {selected.messages.map((message) => (
                    <li className="rounded-md border bg-muted/20 p-3 text-sm" key={message.messageId}>
                      <p className="mb-1 font-medium text-xs text-muted-foreground">
                        {message.sender === "kestrel"
                          ? "Kestrel"
                          : message.sender === "collaborator"
                            ? selected.name
                            : "System"}
                      </p>
                      <p className="whitespace-pre-wrap">{message.text}</p>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CollaboratorList({
  groups,
  label,
  selectedDialogId,
  onSelect,
}: {
  groups: readonly CollaboratorGroup[];
  label: string;
  selectedDialogId: string | undefined;
  onSelect: (dialogId: string) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <section className="mb-3">
      <h2 className="px-2 pb-1 text-muted-foreground text-xs font-medium">{label}</h2>
      <ul className="space-y-1">
        {groups.map((group) => (
          <li key={group.dialogId}>
            <button
              aria-current={selectedDialogId === group.dialogId ? "true" : undefined}
              className={`w-full rounded-md px-2 py-2 text-left text-sm hover:bg-muted ${selectedDialogId === group.dialogId ? "bg-muted" : ""}`}
              onClick={() => onSelect(group.dialogId)}
              type="button"
            >
              <span className="block truncate font-medium">{group.name}</span>
              <span className="block truncate text-muted-foreground text-xs">{collaboratorStateLabel(group)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
