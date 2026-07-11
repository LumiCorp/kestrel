export interface FinalizePayload {
  message: string;
  data?: Record<string, unknown> | undefined;
}

export interface FinalizePayloadResult {
  ok: boolean;
  payload?: FinalizePayload | undefined;
  error?: string | undefined;
}

export function parseFinalizePayload(value: unknown): FinalizePayloadResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: "FinalizeAnswer payload must be an object with 'message' field",
    };
  }

  const record = value as Record<string, unknown>;
  if (typeof record.message !== "string" || record.message.trim().length === 0) {
    return {
      ok: false,
      error: "FinalizeAnswer payload.message must be a non-empty string",
    };
  }

  if (
    record.data !== undefined &&
    (typeof record.data !== "object" || record.data === null || Array.isArray(record.data))
  ) {
    return {
      ok: false,
      error: "FinalizeAnswer payload.data must be an object when present",
    };
  }

  return {
    ok: true,
    payload: {
      message: record.message,
      ...(record.data !== undefined ? { data: record.data as Record<string, unknown> } : {}),
    },
  };
}

export function buildFinalizePlainText(data: Record<string, unknown> | undefined): string | undefined {
  if (data === undefined) {
    return undefined;
  }

  const explicit = readNonEmptyString(data.plainText);
  if (explicit !== undefined) {
    return explicit;
  }

  const ui = asRecord(data.ui);
  if (ui === undefined) {
    return undefined;
  }

  const blocks = Array.isArray(ui.blocks) ? ui.blocks : [];
  const rendered = blocks
    .map((block) => renderPlainTextBlock(block))
    .filter((value): value is string => value !== undefined && value.length > 0);
  if (rendered.length === 0) {
    return undefined;
  }

  return rendered.join("\n\n").trim();
}

function renderPlainTextBlock(value: unknown): string | undefined {
  const block = asRecord(value);
  const kind = readNonEmptyString(block?.kind);
  if (block === undefined || kind === undefined) {
    return undefined;
  }

  if (kind === "summary") {
    const body =
      readNonEmptyString(block.body) ??
      readNonEmptyString(block.text) ??
      readNonEmptyString(block.content) ??
      readNonEmptyString(block.summary);
    return joinPlainTextSections(readNonEmptyString(block.title), body);
  }

  if (kind === "steps") {
    const items = Array.isArray(block.items)
      ? block.items
          .map((item) => renderPlainTextStep(item))
          .filter((entry): entry is string => entry !== undefined && entry.length > 0)
      : [];
    if (items.length === 0) {
      return undefined;
    }
    return joinPlainTextSections(readNonEmptyString(block.title), items.join("\n"));
  }

  if (kind === "comparison") {
    const rows = Array.isArray(block.rows)
      ? block.rows
          .map((row) => {
            const record = asRecord(row);
            const label = readNonEmptyString(record?.label);
            const left = readNonEmptyString(record?.left);
            const right = readNonEmptyString(record?.right);
            if (label === undefined || left === undefined || right === undefined) {
              return undefined;
            }
            return `- ${label}: ${left} | ${right}`;
          })
          .filter((entry): entry is string => entry !== undefined)
      : [];
    if (rows.length === 0) {
      return undefined;
    }
    return joinPlainTextSections(readNonEmptyString(block.title), rows.join("\n"));
  }

  if (kind === "code_preview") {
    const code = readNonEmptyString(block.code) ?? readNonEmptyString(block.text);
    if (code === undefined) {
      return undefined;
    }
    const label = [readNonEmptyString(block.title), readNonEmptyString(block.filename)]
      .filter((entry): entry is string => entry !== undefined)
      .join(" - ");
    return joinPlainTextSections(label.length > 0 ? label : "Code preview", code);
  }

  if (kind === "status") {
    const valueText = readNonEmptyString(block.value) ?? readNonEmptyString(block.status);
    if (valueText === undefined) {
      return undefined;
    }
    const detail = readNonEmptyString(block.detail) ?? readNonEmptyString(block.description);
    return joinPlainTextSections(readNonEmptyString(block.title), [valueText, detail].filter(Boolean).join("\n"));
  }

  if (kind === "metric_list") {
    const metrics = Array.isArray(block.metrics)
      ? block.metrics
          .map((item) => {
            const record = asRecord(item);
            const label = readNonEmptyString(record?.label);
            const valueText = readNonEmptyString(record?.value);
            const detail = readNonEmptyString(record?.detail);
            if (label === undefined || valueText === undefined) {
              return undefined;
            }
            return detail !== undefined ? `- ${label}: ${valueText} (${detail})` : `- ${label}: ${valueText}`;
          })
          .filter((entry): entry is string => entry !== undefined)
      : [];
    if (metrics.length === 0) {
      return undefined;
    }
    return joinPlainTextSections(readNonEmptyString(block.title), metrics.join("\n"));
  }

  if (kind === "link_list") {
    const links = Array.isArray(block.links)
      ? block.links
          .map((item) => {
            const record = asRecord(item);
            const label = readNonEmptyString(record?.label);
            const url = readNonEmptyString(record?.url);
            const description = readNonEmptyString(record?.description);
            if (label === undefined || url === undefined) {
              return undefined;
            }
            return description !== undefined
              ? `- ${label}: ${url} - ${description}`
              : `- ${label}: ${url}`;
          })
          .filter((entry): entry is string => entry !== undefined)
      : [];
    if (links.length === 0) {
      return undefined;
    }
    return joinPlainTextSections(readNonEmptyString(block.title), links.join("\n"));
  }

  if (kind === "web_preview") {
    const url = readNonEmptyString(block.url);
    if (url === undefined) {
      return undefined;
    }
    const title = readNonEmptyString(block.title);
    const summary = readNonEmptyString(block.summary) ?? readNonEmptyString(block.description);
    return joinPlainTextSections(title ?? url, summary);
  }

  return undefined;
}

function renderPlainTextStep(value: unknown): string | undefined {
  if (typeof value === "string") {
    const title = readNonEmptyString(value);
    return title !== undefined ? `- ${title}` : undefined;
  }

  const record = asRecord(value);
  const title =
    readNonEmptyString(record?.title) ??
    readNonEmptyString(record?.label) ??
    readNonEmptyString(record?.text);
  if (title === undefined) {
    return undefined;
  }

  const status = readNonEmptyString(record?.status);
  const detail = readNonEmptyString(record?.detail);
  const prefix = status !== undefined ? `- [${status}] ${title}` : `- ${title}`;
  return detail !== undefined ? `${prefix}: ${detail}` : prefix;
}

function joinPlainTextSections(...parts: Array<string | undefined>): string | undefined {
  const filtered = parts
    .map((part) => readNonEmptyString(part))
    .filter((part): part is string => part !== undefined);
  if (filtered.length === 0) {
    return undefined;
  }
  return filtered.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
