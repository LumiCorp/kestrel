import { isPromptSlotId, type PromptSlotId, type PromptSlotValues } from "./promptSlots.js";

const SLOT_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu;

export interface RenderPromptTemplateOptions {
  requiredSlots?: readonly PromptSlotId[] | undefined;
  criticalSlots?: readonly PromptSlotId[] | undefined;
  maxChars?: number | undefined;
}

type PromptTemplateErrorCode = "PROMPT_TEMPLATE_UNKNOWN_SLOT" | "PROMPT_TEMPLATE_REQUIRED_SLOT_MISSING";

function promptTemplateError(
  code: PromptTemplateErrorCode,
  message: string,
  details: Record<string, unknown>,
): Error & { code: PromptTemplateErrorCode; details: Record<string, unknown> } {
  const error = new Error(message) as Error & {
    code: PromptTemplateErrorCode;
    details: Record<string, unknown>;
  };
  error.code = code;
  error.details = details;
  return error;
}

export function renderPromptTemplate(
  template: string,
  slots: PromptSlotValues,
  options: RenderPromptTemplateOptions = {},
): string {
  const placeholders = collectTemplatePlaceholders(template);
  for (const placeholder of placeholders) {
    if (isPromptSlotId(placeholder) === false) {
      throw promptTemplateError(
        "PROMPT_TEMPLATE_UNKNOWN_SLOT",
        `Unknown prompt template slot: ${placeholder}`,
        { slot: placeholder },
      );
    }
  }
  for (const requiredSlot of options.requiredSlots ?? []) {
    const rendered = slots[requiredSlot]?.trim();
    if (rendered === undefined || rendered.length === 0) {
      throw promptTemplateError(
        "PROMPT_TEMPLATE_REQUIRED_SLOT_MISSING",
        `Missing required prompt slot: ${requiredSlot}`,
        { slot: requiredSlot },
      );
    }
  }

  const rendered = normalizePromptWhitespace(
    template.replace(SLOT_PATTERN, (_match, slotName: string) => slots[slotName as PromptSlotId] ?? ""),
  );
  return clampPromptPreservingCriticalSlots(rendered, slots, options);
}

export function collectTemplatePlaceholders(template: string): string[] {
  const placeholders = new Set<string>();
  for (const match of template.matchAll(SLOT_PATTERN)) {
    placeholders.add(match[1] ?? "");
  }
  return [...placeholders].filter((item) => item.length > 0);
}

function normalizePromptWhitespace(value: string): string {
  return value
    .split(/\n{3,}/u)
    .map((section) => section.trimEnd())
    .join("\n\n")
    .trim();
}

function clampPromptPreservingCriticalSlots(
  rendered: string,
  slots: PromptSlotValues,
  options: RenderPromptTemplateOptions,
): string {
  const maxChars = options.maxChars;
  if (maxChars === undefined || rendered.length <= maxChars) {
    return rendered;
  }
  const criticalText = (options.criticalSlots ?? [])
    .map((slot) => slots[slot]?.trim())
    .filter((slot): slot is string => slot !== undefined && slot.length > 0)
    .join("\n\n");
  if (criticalText.length === 0) {
    return `${rendered.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n... [prompt clipped]`;
  }
  const suffixBudget = Math.max(0, maxChars - criticalText.length - 48);
  const suffix = rendered.includes(criticalText)
    ? rendered.replace(criticalText, "").trim()
    : rendered;
  return `${criticalText}\n\n${suffix.slice(0, suffixBudget).trimEnd()}\n... [prompt clipped]`.slice(0, maxChars);
}
