"use client";

import { ArrowRight } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WorkflowActionInputBinding } from "@/lib/workflows/contracts";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function escapePointer(value: string) { return value.replace(/~/gu, "~0").replace(/\//gu, "~1"); }
function label(value: string) { return value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[._-]+/gu, " ").replace(/^./u, c => c.toUpperCase()); }

function stringFields(schema: Record<string, unknown>, prefix = ""): Array<{ pointer: string; label: string }> {
  const properties = record(schema.properties);
  if (!properties) return [];
  return Object.entries(properties).flatMap(([name, raw]) => {
    const field = record(raw);
    if (!field) return [];
    const pointer = `${prefix}/${escapePointer(name)}`;
    if (field.type === "string") return [{ pointer, label: typeof field.title === "string" ? field.title : label(name) }];
    if (field.type === "object" || record(field.properties)) return stringFields(field, pointer);
    return [];
  });
}

export function WorkflowActionBindings({ bindings, onChange, schema, sources }: {
  bindings: Record<string, WorkflowActionInputBinding>;
  onChange: (bindings: Record<string, WorkflowActionInputBinding>, newlyBoundPointer?: string) => void;
  schema: Record<string, unknown>;
  sources: Array<{ id: string; label: string }>;
}) {
  const fields = stringFields(schema);
  if (fields.length === 0 || sources.length === 0) return null;
  return <div className="space-y-3 rounded-xl border bg-muted/15 p-4">
    <div><p className="font-medium text-sm">Dynamic values</p><p className="text-muted-foreground text-xs">Fill a text field with an upstream Kestrel response.</p></div>
    <div className="space-y-3">{fields.map(field => {
      const binding = bindings[field.pointer];
      return <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.35fr)]" key={field.pointer}>
        <Label>{field.label}</Label><ArrowRight className="hidden size-3.5 text-muted-foreground sm:block" />
        <Select value={binding?.sourceNodeId ?? "fixed"} onValueChange={value => {
          const next = { ...bindings };
          if (value === "fixed") delete next[field.pointer];
          else next[field.pointer] = { kind: "kestrel_response_text", sourceNodeId: value };
          onChange(next, value === "fixed" ? undefined : field.pointer);
        }}><SelectTrigger aria-label={`${field.label} value source`}><SelectValue /></SelectTrigger><SelectContent>
          <SelectItem value="fixed">Fixed value</SelectItem>
          {sources.map(source => <SelectItem key={source.id} value={source.id}>{source.label} · Response text</SelectItem>)}
        </SelectContent></Select>
      </div>;
    })}</div>
  </div>;
}
