export const SUPPORTED_GENERATIVE_UI_BLOCKS = [
  "summary",
  "steps",
  "comparison",
  "code_preview",
  "status",
  "metric_list",
  "link_list",
  "web_preview",
] as const;

export type GenerativeUiBlockKind = (typeof SUPPORTED_GENERATIVE_UI_BLOCKS)[number];
export type ClientSurface = "web" | "tui" | "unknown";

export interface ClientCapabilities {
  surface?: ClientSurface | undefined;
  generativeUi?: {
    enabled: boolean;
    supportedBlocks?: GenerativeUiBlockKind[] | undefined;
  } | undefined;
}

export function createWebClientCapabilities(): ClientCapabilities {
  return {
    surface: "web",
    generativeUi: {
      enabled: true,
      supportedBlocks: [...SUPPORTED_GENERATIVE_UI_BLOCKS],
    },
  };
}

export function createTuiClientCapabilities(): ClientCapabilities {
  return {
    surface: "tui",
    generativeUi: {
      enabled: false,
    },
  };
}

export function normalizeClientCapabilities(value: unknown): ClientCapabilities | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const surface = parseSurface(record.surface);
  const generativeUi = parseGenerativeUi(record.generativeUi);

  if (surface === undefined && generativeUi === undefined) {
    return undefined;
  }

  return {
    ...(surface !== undefined ? { surface } : {}),
    ...(generativeUi !== undefined ? { generativeUi } : {}),
  };
}

export function clientSupportsGenerativeUi(value: ClientCapabilities | undefined): boolean {
  return value?.generativeUi?.enabled === true;
}

export function getSupportedGenerativeUiBlocks(
  value: ClientCapabilities | undefined,
): GenerativeUiBlockKind[] {
  if (value?.generativeUi?.enabled !== true) {
    return [];
  }

  const supportedBlocks = value.generativeUi.supportedBlocks;
  if (Array.isArray(supportedBlocks) === false || supportedBlocks.length === 0) {
    return [...SUPPORTED_GENERATIVE_UI_BLOCKS];
  }

  return supportedBlocks.filter((item, index, array): item is GenerativeUiBlockKind => {
    return SUPPORTED_GENERATIVE_UI_BLOCKS.includes(item) && array.indexOf(item) === index;
  });
}

function parseSurface(value: unknown): ClientSurface | undefined {
  if (value === "web" || value === "tui" || value === "unknown") {
    return value;
  }
  return undefined;
}

function parseGenerativeUi(
  value: unknown,
): ClientCapabilities["generativeUi"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") {
    return undefined;
  }

  const supportedBlocks = Array.isArray(record.supportedBlocks)
    ? record.supportedBlocks.filter((item): item is GenerativeUiBlockKind => {
        return typeof item === "string" && SUPPORTED_GENERATIVE_UI_BLOCKS.includes(item as GenerativeUiBlockKind);
      })
    : undefined;

  return {
    enabled: record.enabled,
    ...(supportedBlocks !== undefined && supportedBlocks.length > 0 ? { supportedBlocks } : {}),
  };
}
