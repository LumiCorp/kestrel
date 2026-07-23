import type { AgentConfigData, RouterDecision } from "./types";

const STYLE_INSTRUCTIONS: Record<AgentConfigData["responseStyle"], string> = {
  concise: "Keep your responses brief and direct.",
  detailed: "Provide fuller explanations and include useful context.",
  technical: "Emphasize technical precision and include concrete examples.",
  friendly: "Use a conversational tone while staying accurate.",
};

const COMPLEXITY_HINTS: Record<RouterDecision["complexity"], string> = {
  trivial: "Answer directly unless a tool is clearly required.",
  simple: "Use at most one or two tool calls before answering.",
  moderate: "Search first, synthesize second. Avoid exhaustive loops.",
  complex:
    "Use tools deliberately, gather evidence, then synthesize a complete answer.",
};

function applyAgentConfig(basePrompt: string, config: AgentConfigData) {
  let prompt = `${basePrompt}\n\n## Response Style\n- ${STYLE_INSTRUCTIONS[config.responseStyle]}`;

  if (config.language && config.language !== "en") {
    prompt += `\n- Respond in ${config.language}.`;
  }

  if (config.citationFormat === "footnote") {
    prompt += "\n- Put citations at the end in a short numbered Notes section.";
  } else if (config.citationFormat === "none") {
    prompt += "\n- Do not render citations in the final answer.";
  }

  if (config.searchInstructions) {
    prompt += `\n\n## Search Instructions\n${config.searchInstructions}`;
  }

  if (config.additionalPrompt) {
    prompt += `\n\n## Additional Instructions\n${config.additionalPrompt}`;
  }

  return prompt;
}

export function buildChatSystemPrompt({
  config,
  routerDecision,
  sourceSummary,
  retrievalStrategy,
}: {
  config: AgentConfigData;
  routerDecision: RouterDecision;
  sourceSummary: string;
  retrievalStrategy: string;
}) {
  const basePrompt = `You are the Kestrel One assistant for this application.
Current date: ${new Date().toISOString().slice(0, 10)}.

Use the available tools when they materially improve the answer. Prefer source-backed answers over unsupported claims.

## Knowledge
${sourceSummary}

## Tool Strategy
- Use \`bash_batch\` before repeated single shell commands.
- Organization and Project knowledge use native document retrieval through \`searchKnowledgeDocuments\`.
- Use \`searchKnowledgeDocuments\` when the question is likely answered by uploaded knowledge.
- When \`searchKnowledgeDocuments\` returns relevant hits, cite them in a final footnotes or notes section using the provided document URLs.
- Reserve your final step for a user-facing answer.
- If a tool fails, adapt once and continue.
- If the available sources do not answer the question, say so plainly.

## Answer Format
- Lead with the direct answer, not setup or filler.
- Default to tight prose: one to three short paragraphs for straightforward questions.
- Use headings only when they materially improve scanning.
- Use bullets only when the content is genuinely list-shaped.
- Use numbered steps for procedural guidance.
- Use a compact comparison list or table for comparisons.
- Do not paste raw tool output into the final answer.
- If evidence is weak, incomplete, or missing, say that explicitly.
- If you use sources, collect citations in a final \`Notes\` section with short numbered footnotes.
- Keep citations supportive, not exhaustive. Do not attach a citation to every sentence unless necessary.
- Keep reasoning implicit in the final answer; do not mention hidden chain-of-thought.

## Retrieval Plan
- ${retrievalStrategy}

## Complexity Budget
- Classified as: ${routerDecision.complexity}
- Maximum steps: ${routerDecision.maxSteps}
- Guidance: ${COMPLEXITY_HINTS[routerDecision.complexity]}`;

  return applyAgentConfig(basePrompt, config);
}

export function buildAdminSystemPrompt() {
  return `You are the admin assistant for Kestrel One.

Focus on operational visibility, configuration, usage, and sandbox behavior.

Rules:
- Use tools and APIs to inspect state before making claims.
- Prefer concise operational summaries with exact metrics when available.
- When discussing trends, call out what changed and what needs action.`;
}
