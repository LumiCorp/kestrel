"use client";

import { Check, ChevronRight, LoaderCircle, Search, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { WorkflowToolOption } from "./workflow-node-dialog";

export function WorkflowToolPicker({
  onSelect,
  selectedName,
  tools,
  toolsLoading,
}: {
  onSelect: (tool: WorkflowToolOption) => void;
  selectedName: string | null;
  tools: WorkflowToolOption[];
  toolsLoading: boolean;
}) {
  const selected = tools.find((tool) => tool.name === selectedName) ?? null;
  const [browsing, setBrowsing] = useState(!selected);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const visible = search
      ? tools.filter((tool) =>
          `${tool.label} ${tool.description} ${tool.appName}`
            .toLocaleLowerCase()
            .includes(search),
        )
      : tools;
    const grouped = new Map<string, WorkflowToolOption[]>();
    for (const tool of visible) {
      grouped.set(tool.appName, [...(grouped.get(tool.appName) ?? []), tool]);
    }
    return [...grouped.entries()];
  }, [query, tools]);

  if (selected && !browsing) {
    return (
      <div className="flex items-center gap-3 rounded-xl border bg-muted/15 p-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-amber-500/12 text-amber-700 dark:text-amber-300">
          <Wrench className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium text-sm">{selected.label}</p>
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700 uppercase tracking-wide dark:text-emerald-300">
              Selected
            </span>
          </div>
          <p className="truncate text-muted-foreground text-xs">
            {selected.appName} · {selected.description}
          </p>
        </div>
        <Button onClick={() => setBrowsing(true)} size="sm" type="button" variant="ghost">
          Browse tools <ChevronRight className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-muted/10">
      <div className="flex items-center gap-3 border-b bg-background/70 p-3">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search project tools"
            className="bg-background pl-9"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tools and Apps"
            value={query}
          />
        </div>
        {selected ? (
          <Button onClick={() => setBrowsing(false)} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
        ) : null}
      </div>
      <div className="max-h-80 overflow-y-auto p-3">
        {toolsLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground text-sm">
            <LoaderCircle className="size-4 animate-spin" /> Loading project tools…
          </div>
        ) : groups.length === 0 ? (
          <div className="py-10 text-center">
            <p className="font-medium text-sm">
              {tools.length === 0 ? "No project tools available" : "No matching tools"}
            </p>
            <p className="mt-1 text-muted-foreground text-xs">
              {tools.length === 0
                ? "Enable an App and its tools for this project first."
                : "Try a tool name, capability, or App."}
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {groups.map(([appName, appTools]) => (
              <section key={appName}>
                <div className="mb-2 flex items-center gap-2 px-1">
                  <span className="grid size-6 place-items-center rounded-md bg-foreground text-[10px] text-background uppercase">
                    {appName.slice(0, 2)}
                  </span>
                  <h3 className="font-medium text-xs">{appName}</h3>
                  <span className="text-muted-foreground text-[11px]">{appTools.length}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {appTools.map((tool) => {
                    const isSelected = tool.name === selectedName;
                    return (
                      <button
                        className={cn(
                          "group min-w-0 rounded-lg border bg-background p-3 text-left transition-colors hover:border-amber-500/50 hover:bg-amber-500/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          isSelected && "border-amber-500/60 bg-amber-500/7",
                        )}
                        key={tool.name}
                        onClick={() => {
                          onSelect(tool);
                          setBrowsing(false);
                          setQuery("");
                        }}
                        type="button"
                      >
                        <span className="flex items-start gap-2">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-sm">{tool.label}</span>
                            <span className="mt-1 line-clamp-2 block text-muted-foreground text-xs leading-relaxed">
                              {tool.description}
                            </span>
                          </span>
                          <span
                            className={cn(
                              "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-transparent transition-colors group-hover:border-amber-500/50",
                              isSelected && "border-amber-600 bg-amber-600 text-white",
                            )}
                          >
                            <Check className="size-3" />
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
