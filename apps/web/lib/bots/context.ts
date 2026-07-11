import type { Adapter } from "chat";

export type BotThreadContext = {
  platform: "github" | "discord";
  source: string;
  title: string;
  body: string;
  labels: string[];
  state?: string;
  number?: number;
  previousComments?: Array<{
    author: string;
    body: string;
    isBot?: boolean;
  }>;
};

export interface ContextProvider {
  fetchThreadContext(threadId: string): Promise<BotThreadContext>;
}

export function hasContextProvider(
  adapter: Adapter
): adapter is Adapter & ContextProvider {
  return (
    "fetchThreadContext" in adapter &&
    typeof (adapter as ContextProvider).fetchThreadContext === "function"
  );
}
