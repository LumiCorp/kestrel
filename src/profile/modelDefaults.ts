import type { ModelProviderId } from "./runtimeProfile.js";
import { DEFAULT_OPENROUTER_MODEL } from "../../models/openrouter/constants.js";

/** Browser-safe model defaults shared by configuration and runtime profiles. */
export const DEFAULT_MODEL_BY_PROVIDER: Readonly<Record<ModelProviderId, string>> = Object.freeze({
  openrouter: DEFAULT_OPENROUTER_MODEL,
  openai: "gpt-5.4-2026-03-05",
  anthropic: "claude-3-5-haiku-latest",
  ollama: "llama3.2:3b",
  lmstudio: "local-model",
});
