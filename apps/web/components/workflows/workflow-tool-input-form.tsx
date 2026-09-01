"use client";

import { Braces, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type JsonSchema = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[._-]+/gu, " ")
    .replace(/^./u, (character) => character.toUpperCase());
}

function schemaTitle(schema: JsonSchema, fallback: string): string {
  return typeof schema.title === "string" && schema.title.trim()
    ? schema.title
    : humanize(fallback);
}

function schemaDescription(schema: JsonSchema): string | null {
  return typeof schema.description === "string" && schema.description.trim()
    ? schema.description
    : null;
}

function schemaAlternatives(schema: JsonSchema): JsonSchema[] {
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : [];
  return alternatives.map(asRecord).filter((value): value is JsonSchema => Boolean(value));
}

function requiredNames(schema: JsonSchema): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
}

function alternativeLabel(schema: JsonSchema, index: number): string {
  if (typeof schema.title === "string" && schema.title.trim()) return schema.title;
  const required = requiredNames(schema);
  return required.length > 0
    ? required.map(humanize).join(" + ")
    : `Option ${index + 1}`;
}

function initialSchemaValue(schema: JsonSchema): unknown {
  if (schema.default !== undefined) return cloneJson(schema.default);
  const alternatives = schemaAlternatives(schema);
  if (alternatives.length > 0) return initialSchemaValue(alternatives[0]);
  const properties = asRecord(schema.properties);
  if (schema.type === "object" || properties) {
    const result: Record<string, unknown> = {};
    const required = new Set(requiredNames(schema));
    for (const [name, rawProperty] of Object.entries(properties ?? {})) {
      const property = asRecord(rawProperty);
      if (!property) continue;
      const value = initialSchemaValue(property);
      if (property.default !== undefined || (required.has(name) && value !== undefined)) {
        result[name] = value;
      }
    }
    return result;
  }
  return undefined;
}

export function createWorkflowToolInput(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const value = initialSchemaValue(schema ?? {});
  return asRecord(value) ?? {};
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function JsonFallback({
  label,
  onChange,
  required,
  value,
}: {
  label: string;
  onChange: (value: unknown) => void;
  required: boolean;
  value: unknown;
}) {
  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-2">
        <Braces className="size-3.5 text-muted-foreground" />
        {label}{required ? <span className="text-destructive">*</span> : null}
      </Label>
      <Textarea
        className="min-h-28 resize-y font-mono text-xs"
        defaultValue={JSON.stringify(value ?? null, null, 2)}
        key={JSON.stringify(value ?? null)}
        onBlur={(event) => {
          try {
            onChange(JSON.parse(event.target.value) as unknown);
          } catch {
            toast.error(`${label} must be valid JSON.`);
          }
        }}
        spellCheck={false}
      />
      <p className="text-muted-foreground text-xs">
        This provider uses an input shape that needs structured JSON.
      </p>
    </div>
  );
}

function ObjectFields({
  onChange,
  schema,
  value,
}: {
  onChange: (value: Record<string, unknown>) => void;
  schema: JsonSchema;
  value: Record<string, unknown>;
}) {
  const properties = asRecord(schema.properties);
  const required = new Set(requiredNames(schema));
  if (!properties || Object.keys(properties).length === 0) {
    return <p className="text-muted-foreground text-sm">No configuration is needed.</p>;
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {Object.entries(properties).map(([name, rawProperty]) => {
        const property = asRecord(rawProperty);
        if (!property) return null;
        const wide = property.type === "object" || property.type === "array" || schemaAlternatives(property).length > 0;
        return (
          <div className={wide ? "sm:col-span-2" : undefined} key={name}>
            <SchemaField
              name={name}
              onChange={(nextValue) => {
                const next = { ...value };
                if (nextValue === undefined) delete next[name];
                else next[name] = nextValue;
                onChange(next);
              }}
              required={required.has(name)}
              schema={property}
              value={value[name]}
            />
          </div>
        );
      })}
    </div>
  );
}

function UnionField({
  name,
  onChange,
  required,
  schema,
  value,
}: {
  name: string;
  onChange: (value: unknown) => void;
  required: boolean;
  schema: JsonSchema;
  value: unknown;
}) {
  const alternatives = schemaAlternatives(schema);
  const current = asRecord(value);
  const matchingIndex = alternatives.findIndex((alternative) =>
    requiredNames(alternative).every((field) => current?.[field] !== undefined),
  );
  const selectedIndex = matchingIndex >= 0 ? matchingIndex : 0;
  const selected = alternatives[selectedIndex] ?? {};
  return (
    <div className="space-y-3 rounded-xl border bg-muted/15 p-4">
      <div className="space-y-2">
        <Label>
          {schemaTitle(schema, name)}{required ? <span className="text-destructive"> *</span> : null}
        </Label>
        {schemaDescription(schema) ? (
          <p className="text-muted-foreground text-xs leading-relaxed">{schemaDescription(schema)}</p>
        ) : null}
        <Select
          onValueChange={(next) => onChange(initialSchemaValue(alternatives[Number(next)] ?? {}))}
          value={String(selectedIndex)}
        >
          <SelectTrigger aria-label={`${schemaTitle(schema, name)} input shape`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {alternatives.map((alternative, index) => (
              <SelectItem key={index} value={String(index)}>
                {alternativeLabel(alternative, index)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <SchemaField
        name={name}
        onChange={onChange}
        required={required}
        schema={selected}
        showLabel={false}
        value={value ?? initialSchemaValue(selected)}
      />
    </div>
  );
}

function ArrayField({
  name,
  onChange,
  required,
  schema,
  value,
}: {
  name: string;
  onChange: (value: unknown) => void;
  required: boolean;
  schema: JsonSchema;
  value: unknown;
}) {
  const values = Array.isArray(value) ? value : [];
  const itemSchema = asRecord(schema.items);
  const label = schemaTitle(schema, name);
  if (!itemSchema) {
    return <JsonFallback label={label} onChange={onChange} required={required} value={value ?? []} />;
  }
  const maxItems = typeof schema.maxItems === "number" ? schema.maxItems : undefined;
  return (
    <div className="space-y-3 rounded-xl border bg-muted/15 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label>{label}{required ? <span className="text-destructive"> *</span> : null}</Label>
          {schemaDescription(schema) ? (
            <p className="mt-1 text-muted-foreground text-xs leading-relaxed">{schemaDescription(schema)}</p>
          ) : null}
        </div>
        <Button
          disabled={maxItems !== undefined && values.length >= maxItems}
          onClick={() => onChange([...values, initialSchemaValue(itemSchema) ?? ""])}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="size-3.5" /> Add
        </Button>
      </div>
      {values.length === 0 ? (
        <p className="text-muted-foreground text-xs">No items added.</p>
      ) : (
        <div className="space-y-3">
          {values.map((item, index) => (
            <div className="flex items-start gap-2" key={index}>
              <div className="min-w-0 flex-1">
                <SchemaField
                  name={`${name} ${index + 1}`}
                  onChange={(nextItem) => {
                    const next = [...values];
                    next[index] = nextItem;
                    onChange(next);
                  }}
                  required
                  schema={itemSchema}
                  showLabel={itemSchema.type === "object" || schemaAlternatives(itemSchema).length > 0}
                  value={item}
                />
              </div>
              <Button
                aria-label={`Remove ${label} item ${index + 1}`}
                className="mt-0.5"
                onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SchemaField({
  name,
  onChange,
  required,
  schema,
  showLabel = true,
  value,
}: {
  name: string;
  onChange: (value: unknown) => void;
  required: boolean;
  schema: JsonSchema;
  showLabel?: boolean;
  value: unknown;
}) {
  const alternatives = schemaAlternatives(schema);
  if (alternatives.length > 0) {
    return <UnionField name={name} onChange={onChange} required={required} schema={schema} value={value} />;
  }
  const properties = asRecord(schema.properties);
  if (schema.type === "object" || properties) {
    const content = (
      <ObjectFields
        onChange={onChange}
        schema={schema}
        value={asRecord(value) ?? {}}
      />
    );
    if (!showLabel) return content;
    return (
      <div className="space-y-3 rounded-xl border bg-muted/15 p-4">
        <div>
          <Label>{schemaTitle(schema, name)}{required ? <span className="text-destructive"> *</span> : null}</Label>
          {schemaDescription(schema) ? (
            <p className="mt-1 text-muted-foreground text-xs leading-relaxed">{schemaDescription(schema)}</p>
          ) : null}
        </div>
        {content}
      </div>
    );
  }
  if (schema.type === "array") {
    return <ArrayField name={name} onChange={onChange} required={required} schema={schema} value={value} />;
  }

  const label = schemaTitle(schema, name);
  const description = schemaDescription(schema);
  const options = Array.isArray(schema.enum) ? schema.enum : [];
  if (options.length > 0 && options.every((option) => ["string", "number"].includes(typeof option))) {
    return (
      <div className="space-y-2">
        {showLabel ? <Label>{label}{required ? <span className="text-destructive"> *</span> : null}</Label> : null}
        <Select onValueChange={(next) => onChange(options.find((option) => String(option) === next))} value={value === undefined ? "" : String(value)}>
          <SelectTrigger aria-label={label}><SelectValue placeholder={`Choose ${label.toLowerCase()}`} /></SelectTrigger>
          <SelectContent>
            {options.map((option) => <SelectItem key={String(option)} value={String(option)}>{humanize(String(option))}</SelectItem>)}
          </SelectContent>
        </Select>
        {description ? <p className="text-muted-foreground text-xs leading-relaxed">{description}</p> : null}
      </div>
    );
  }
  if (schema.type === "boolean") {
    return (
      <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
        <div>
          <Label htmlFor={`workflow-tool-${name}`}>{label}{required ? <span className="text-destructive"> *</span> : null}</Label>
          {description ? <p className="mt-1 text-muted-foreground text-xs leading-relaxed">{description}</p> : null}
        </div>
        <Switch checked={value === true} id={`workflow-tool-${name}`} onCheckedChange={onChange} />
      </div>
    );
  }
  if (schema.type === "number" || schema.type === "integer") {
    return (
      <div className="space-y-2">
        {showLabel ? <Label htmlFor={`workflow-tool-${name}`}>{label}{required ? <span className="text-destructive"> *</span> : null}</Label> : null}
        <Input
          id={`workflow-tool-${name}`}
          max={typeof schema.maximum === "number" ? schema.maximum : undefined}
          min={typeof schema.minimum === "number" ? schema.minimum : undefined}
          onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
          required={required}
          step={schema.type === "integer" ? 1 : "any"}
          type="number"
          value={typeof value === "number" ? value : ""}
        />
        {description ? <p className="text-muted-foreground text-xs leading-relaxed">{description}</p> : null}
      </div>
    );
  }
  if (schema.type === "string" || schema.type === undefined) {
    const inputType = schema.format === "email" ? "email" : schema.format === "uri" || schema.format === "url" ? "url" : schema.format === "date" ? "date" : "text";
    return (
      <div className="space-y-2">
        {showLabel ? <Label htmlFor={`workflow-tool-${name}`}>{label}{required ? <span className="text-destructive"> *</span> : null}</Label> : null}
        <Input
          id={`workflow-tool-${name}`}
          maxLength={typeof schema.maxLength === "number" ? schema.maxLength : undefined}
          minLength={typeof schema.minLength === "number" ? schema.minLength : undefined}
          onChange={(event) => onChange(event.target.value === "" && !required ? undefined : event.target.value)}
          placeholder={typeof schema.examples === "object" && Array.isArray(schema.examples) && typeof schema.examples[0] === "string" ? schema.examples[0] : undefined}
          required={required}
          type={inputType}
          value={typeof value === "string" ? value : ""}
        />
        {description ? <p className="text-muted-foreground text-xs leading-relaxed">{description}</p> : null}
        {required && isMissing(value) ? <p className="text-amber-700 text-xs dark:text-amber-300">Required before activation.</p> : null}
      </div>
    );
  }
  return <JsonFallback label={label} onChange={onChange} required={required} value={value} />;
}

export function WorkflowToolInputForm({
  onChange,
  schema,
  value,
}: {
  onChange: (value: Record<string, unknown>) => void;
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="font-medium text-sm">Tool setup</p>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Configure the values this tool will use. Required fields are marked with an asterisk.
        </p>
      </div>
      <SchemaField name="Tool input" onChange={(next) => onChange(asRecord(next) ?? {})} required schema={schema} showLabel={false} value={value} />
    </div>
  );
}
