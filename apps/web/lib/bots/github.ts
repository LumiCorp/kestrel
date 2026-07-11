import { getUnifiedBotRuntime } from "@/lib/bots/runtime";

export async function handleGitHubWebhook(
  request: Request,
  apiUrl: string,
  waitUntil?: (task: Promise<unknown>) => void
) {
  return getUnifiedBotRuntime().handleWebhook(
    "github",
    request,
    waitUntil ? { waitUntil } : undefined,
    apiUrl
  );
}
