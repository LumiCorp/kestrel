export type ChatSuggestionLane = "thinking" | "making" | "grounding" | "media";

type BaseChatSuggestion = {
  id: string;
  feature: string;
  label: string;
  lane: ChatSuggestionLane;
  prompt: string;
};

export type PromptChatSuggestion = BaseChatSuggestion & {
  kind: "prompt";
};

export type MediaChatSuggestion = BaseChatSuggestion & {
  kind: "media";
  mediaKind: "image" | "video";
};

export type ChatSuggestion = PromptChatSuggestion | MediaChatSuggestion;

export const chatSuggestionCatalog: ChatSuggestion[] = [
  {
    id: "thinking-nextjs-spa",
    feature: "reasoning",
    kind: "prompt",
    label:
      "Explain when Next.js is a better fit than a SPA for a B2B dashboard.",
    lane: "thinking",
    prompt:
      "Explain when Next.js is a better fit than a SPA for a B2B dashboard.",
  },
  {
    id: "thinking-rag-vs-finetune",
    feature: "reasoning",
    kind: "prompt",
    label: "Compare RAG and fine-tuning for an internal support assistant.",
    lane: "thinking",
    prompt: "Compare RAG and fine-tuning for an internal support assistant.",
  },
  {
    id: "thinking-ai-rollout",
    feature: "planning",
    kind: "prompt",
    label:
      "Outline a rollout plan for adding AI to a customer support workflow.",
    lane: "thinking",
    prompt:
      "Outline a rollout plan for adding AI to a customer support workflow.",
  },
  {
    id: "thinking-server-actions",
    feature: "reasoning",
    kind: "prompt",
    label:
      "Break down the tradeoffs of Server Actions versus route handlers in Next.js.",
    lane: "thinking",
    prompt:
      "Break down the tradeoffs of Server Actions versus route handlers in Next.js.",
  },
  {
    id: "thinking-tool-approvals",
    feature: "tools",
    kind: "prompt",
    label: "What are the risks of letting agents call tools automatically?",
    lane: "thinking",
    prompt: "What are the risks of letting agents call tools automatically?",
  },
  {
    id: "thinking-ai-eval",
    feature: "planning",
    kind: "prompt",
    label: "Design an evaluation rubric for an internal AI assistant.",
    lane: "thinking",
    prompt: "Design an evaluation rubric for an internal AI assistant.",
  },
  {
    id: "making-dijkstra",
    feature: "code",
    kind: "prompt",
    label:
      "Write a TypeScript implementation of Dijkstra's algorithm and explain it step by step.",
    lane: "making",
    prompt:
      "Write a TypeScript implementation of Dijkstra's algorithm and explain it step by step.",
  },
  {
    id: "making-debounced-search",
    feature: "code",
    kind: "prompt",
    label: "Build a React hook for debounced search with example usage.",
    lane: "making",
    prompt: "Build a React hook for debounced search with example usage.",
  },
  {
    id: "making-csv-sql",
    feature: "code",
    kind: "prompt",
    label:
      "Create a Python script that converts CSV rows into SQL insert statements.",
    lane: "making",
    prompt:
      "Create a Python script that converts CSV rows into SQL insert statements.",
  },
  {
    id: "making-launch-brief",
    feature: "text_artifact",
    kind: "prompt",
    label: "Draft a one-page launch brief for an AI meeting notes product.",
    lane: "making",
    prompt: "Draft a one-page launch brief for an AI meeting notes product.",
  },
  {
    id: "making-outage-email",
    feature: "text_artifact",
    kind: "prompt",
    label: "Write a calm customer email explaining a two-hour outage.",
    lane: "making",
    prompt: "Write a calm customer email explaining a two-hour outage.",
  },
  {
    id: "making-llm-sheet",
    feature: "sheet_artifact",
    kind: "prompt",
    label:
      "Create a spreadsheet to compare LLM vendors by cost, latency, and context window.",
    lane: "making",
    prompt:
      "Create a spreadsheet to compare LLM vendors by cost, latency, and context window.",
  },
  {
    id: "grounding-pdf-summary",
    feature: "attachments",
    kind: "prompt",
    label: "Summarize the attached PDF and extract the top five action items.",
    lane: "grounding",
    prompt: "Summarize the attached PDF and extract the top five action items.",
  },
  {
    id: "grounding-compare-files",
    feature: "attachments",
    kind: "prompt",
    label: "Compare the attached files and list where they disagree.",
    lane: "grounding",
    prompt: "Compare the attached files and list where they disagree.",
  },
  {
    id: "grounding-meeting-plan",
    feature: "attachments",
    kind: "prompt",
    label:
      "Turn the attached meeting notes into a project plan with owners and dates.",
    lane: "grounding",
    prompt:
      "Turn the attached meeting notes into a project plan with owners and dates.",
  },
  {
    id: "grounding-onboarding-search",
    feature: "knowledge",
    kind: "prompt",
    label:
      "Search our knowledge base for enterprise onboarding steps and summarize the happy path.",
    lane: "grounding",
    prompt:
      "Search our knowledge base for enterprise onboarding steps and summarize the happy path.",
  },
  {
    id: "grounding-sso-search",
    feature: "knowledge",
    kind: "prompt",
    label: "Find docs about SSO setup and turn them into a checklist.",
    lane: "grounding",
    prompt: "Find docs about SSO setup and turn them into a checklist.",
  },
  {
    id: "grounding-weather",
    feature: "tools",
    kind: "prompt",
    label:
      "What's the weather in San Francisco this weekend, and what should I pack?",
    lane: "grounding",
    prompt:
      "What's the weather in San Francisco this weekend, and what should I pack?",
  },
  {
    id: "media-fintech-image",
    feature: "image",
    kind: "media",
    label: "Generate a landing page hero image for a fintech startup.",
    lane: "media",
    mediaKind: "image",
    prompt: "Generate a landing page hero image for a fintech startup.",
  },
  {
    id: "media-editorial-image",
    feature: "image",
    kind: "media",
    label:
      "Create an editorial illustration of an AI agent organizing a messy inbox.",
    lane: "media",
    mediaKind: "image",
    prompt:
      "Create an editorial illustration of an AI agent organizing a messy inbox.",
  },
  {
    id: "media-dashboard-image",
    feature: "image",
    kind: "media",
    label: "Generate a product concept image for a smart home dashboard.",
    lane: "media",
    mediaKind: "image",
    prompt: "Generate a product concept image for a smart home dashboard.",
  },
  {
    id: "media-devtool-video",
    feature: "video",
    kind: "media",
    label: "Generate a 12-second teaser video for a new developer tool launch.",
    lane: "media",
    mediaKind: "video",
    prompt:
      "Generate a 12-second teaser video for a new developer tool launch.",
  },
  {
    id: "media-research-video",
    feature: "video",
    kind: "media",
    label:
      "Create a short cinematic product promo for an AI research workspace.",
    lane: "media",
    mediaKind: "video",
    prompt:
      "Create a short cinematic product promo for an AI research workspace.",
  },
  {
    id: "media-saas-loop-video",
    feature: "video",
    kind: "media",
    label: "Generate a looping background video for a modern SaaS homepage.",
    lane: "media",
    mediaKind: "video",
    prompt: "Generate a looping background video for a modern SaaS homepage.",
  },
];

function hashString(input: string) {
  let hash = 2_166_136_261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

function sortBySeed<T extends { id: string }>(items: T[], seed: string) {
  return [...items].sort((left, right) => {
    const leftScore = hashString(`${seed}:${left.id}`);
    const rightScore = hashString(`${seed}:${right.id}`);

    if (leftScore === rightScore) {
      return left.id.localeCompare(right.id);
    }

    return leftScore - rightScore;
  });
}

export function selectChatSuggestions(input: {
  count?: number;
  imageEnabled?: boolean;
  knowledgeEnabled?: boolean;
  seed: string;
  videoEnabled?: boolean;
}) {
  const count = input.count ?? 4;
  const eligibleSuggestions = chatSuggestionCatalog.filter((suggestion) => {
    if (suggestion.feature === "knowledge" && !input.knowledgeEnabled) {
      return false;
    }

    if (suggestion.kind !== "media") {
      return true;
    }

    if (suggestion.mediaKind === "image") {
      return input.imageEnabled;
    }

    return input.videoEnabled;
  });

  const selectedSuggestionIds = new Set<string>();
  const selectedSuggestions: ChatSuggestion[] = [];

  for (const lane of ["thinking", "making", "grounding", "media"] as const) {
    if (selectedSuggestions.length >= count) {
      break;
    }

    const laneSuggestion = sortBySeed(
      eligibleSuggestions.filter(
        (suggestion) =>
          suggestion.lane === lane && !selectedSuggestionIds.has(suggestion.id)
      ),
      `${input.seed}:${lane}`
    )[0];

    if (!laneSuggestion) {
      continue;
    }

    selectedSuggestionIds.add(laneSuggestion.id);
    selectedSuggestions.push(laneSuggestion);
  }

  if (selectedSuggestions.length >= count) {
    return selectedSuggestions;
  }

  const remainingSuggestions = sortBySeed(
    eligibleSuggestions.filter(
      (suggestion) => !selectedSuggestionIds.has(suggestion.id)
    ),
    `${input.seed}:backfill`
  );

  for (const suggestion of remainingSuggestions) {
    if (selectedSuggestions.length >= count) {
      break;
    }

    selectedSuggestionIds.add(suggestion.id);
    selectedSuggestions.push(suggestion);
  }

  return selectedSuggestions;
}
