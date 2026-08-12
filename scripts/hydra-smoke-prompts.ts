export const HYDRA_SMOKE_PROMPT_VERSION = "hydra_smoke_prompts_v1" as const;

export function firstTurnPrompt(nonce: string): string {
  return `Remember the exact marker ${nonce}. Read both attached files and reply with ATTACHMENTS_OK.`;
}

export function continuityPrompt(nonce: string): string {
  return `Reply with exactly CONTINUITY_OK:${nonce} using the marker from the previous turn.`;
}

export const INTERACTION_PROMPT =
  "Use your native shell tool to run `printf HYDRA_INTERACTION_OK`. Do not replace the tool call with prose. Request approval if the Runtime requires it.";

export const CANCELLATION_PROMPT =
  "Work continuously and do not give a final answer until explicitly cancelled.";
