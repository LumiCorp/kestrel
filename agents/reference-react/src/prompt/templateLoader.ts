import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_ROOT_FROM_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../prompts",
);
const PROMPT_ROOT_ENV = "KESTREL_REFERENCE_REACT_PROMPT_ROOT";

function promptTemplateLoadError(
  templateId: string,
  candidates: readonly string[],
): Error & { code: "PROMPT_TEMPLATE_NOT_FOUND"; details: Record<string, unknown> } {
  const error = new Error(`Prompt template not found: ${templateId}. Searched: ${candidates.join(", ")}`) as Error & {
    code: "PROMPT_TEMPLATE_NOT_FOUND";
    details: Record<string, unknown>;
  };
  error.code = "PROMPT_TEMPLATE_NOT_FOUND";
  error.details = {
    templateId,
    candidates: [...candidates],
  };
  return error;
}

export function readPromptTemplate(templateId: string): string {
  const relativePath = templateId.endsWith(".md") ? templateId : `${templateId}.md`;
  const candidates = [
    process.env[PROMPT_ROOT_ENV] !== undefined
      ? path.join(process.env[PROMPT_ROOT_ENV] ?? "", relativePath)
      : undefined,
    path.join(process.cwd(), "agents/reference-react/prompts", relativePath),
    path.join(TEMPLATE_ROOT_FROM_SOURCE, relativePath),
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw promptTemplateLoadError(templateId, candidates);
}
