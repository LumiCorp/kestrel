export type SearchKnowledgeDocumentsToolSettings = {
  defaultLimit: number;
};

const DEFAULT_SEARCH_KNOWLEDGE_DOCUMENTS_SETTINGS: SearchKnowledgeDocumentsToolSettings =
  {
    defaultLimit: 5,
  };

export function resolveSearchKnowledgeDocumentsToolSettings(
  settings?: Record<string, unknown>
): SearchKnowledgeDocumentsToolSettings {
  const defaultLimitValue =
    typeof settings?.defaultLimit === "number"
      ? settings.defaultLimit
      : DEFAULT_SEARCH_KNOWLEDGE_DOCUMENTS_SETTINGS.defaultLimit;

  return {
    defaultLimit: Math.min(12, Math.max(1, Math.round(defaultLimitValue))),
  };
}
