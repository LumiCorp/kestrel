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

export type GenerativeUiBlockKind =
  (typeof SUPPORTED_GENERATIVE_UI_BLOCKS)[number];
export type ClientSurface = "web" | "tui" | "unknown";

export interface ClientCapabilities {
  surface?: ClientSurface | undefined;
  generativeUi?:
    | {
        enabled: boolean;
        supportedBlocks?: GenerativeUiBlockKind[] | undefined;
      }
    | undefined;
  kestrelOne?:
    | {
        tenantId?: string | undefined;
        organizationId?: string | undefined;
        contextGrantId?: string | undefined;
        capabilities?: unknown;
      }
    | undefined;
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

export function normalizeClientCapabilities(
  value: unknown
): ClientCapabilities | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }

  const record = value as Record<string, unknown>;
  const surface = parseSurface(record.surface);
  const generativeUi = parseGenerativeUi(record.generativeUi);
  const kestrelOne = parseKestrelOneCapabilities(record.kestrelOne);

  if (
    surface === undefined &&
    generativeUi === undefined &&
    kestrelOne === undefined
  ) {
    return;
  }

  return {
    ...(surface !== undefined ? { surface } : {}),
    ...(generativeUi !== undefined ? { generativeUi } : {}),
    ...(kestrelOne !== undefined ? { kestrelOne } : {}),
  };
}

function parseKestrelOneCapabilities(
  value: unknown
): ClientCapabilities["kestrelOne"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const record = value as Record<string, unknown>;
  const tenantId = optionalString(record.tenantId);
  const organizationId = optionalString(record.organizationId);
  const contextGrantId = optionalString(record.contextGrantId);
  return {
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(organizationId !== undefined ? { organizationId } : {}),
    ...(contextGrantId !== undefined ? { contextGrantId } : {}),
    ...(record.capabilities !== undefined
      ? { capabilities: record.capabilities }
      : {}),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function clientSupportsGenerativeUi(
  value: ClientCapabilities | undefined
): boolean {
  return value?.generativeUi?.enabled === true;
}

export function getSupportedGenerativeUiBlocks(
  value: ClientCapabilities | undefined
): GenerativeUiBlockKind[] {
  if (value?.generativeUi?.enabled !== true) {
    return [];
  }

  const supportedBlocks = value.generativeUi.supportedBlocks;
  if (
    Array.isArray(supportedBlocks) === false ||
    supportedBlocks.length === 0
  ) {
    return [...SUPPORTED_GENERATIVE_UI_BLOCKS];
  }

  return supportedBlocks.filter(
    (item, index, array): item is GenerativeUiBlockKind =>
      SUPPORTED_GENERATIVE_UI_BLOCKS.includes(item) &&
      array.indexOf(item) === index
  );
}

function parseSurface(value: unknown): ClientSurface | undefined {
  if (value === "web" || value === "tui" || value === "unknown") {
    return value;
  }
  return;
}

function parseGenerativeUi(
  value: unknown
): ClientCapabilities["generativeUi"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") {
    return;
  }

  const supportedBlocks = Array.isArray(record.supportedBlocks)
    ? record.supportedBlocks.filter(
        (item): item is GenerativeUiBlockKind =>
          typeof item === "string" &&
          SUPPORTED_GENERATIVE_UI_BLOCKS.includes(item as GenerativeUiBlockKind)
      )
    : undefined;

  return {
    enabled: record.enabled,
    ...(supportedBlocks !== undefined && supportedBlocks.length > 0
      ? { supportedBlocks }
      : {}),
  };
}
