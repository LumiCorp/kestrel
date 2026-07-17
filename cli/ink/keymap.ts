export type FocusRegion = "sessions" | "chat_list" | "composer" | "logs" | "details" | "command_bar";

export const REGION_ORDER: FocusRegion[] = [
  "sessions",
  "chat_list",
  "composer",
  "logs",
  "details",
];

export const REGION_LABEL: Record<FocusRegion, string> = {
  sessions: "Sessions",
  chat_list: "Chat",
  composer: "Composer",
  logs: "Logs",
  details: "Details",
  command_bar: "Command",
};

export function regionForDigit(input: string): FocusRegion | undefined {
  if (input === "1") {
    return "sessions";
  }
  if (input === "2") {
    return "chat_list";
  }
  if (input === "3") {
    return "composer";
  }
  if (input === "4") {
    return "logs";
  }
  if (input === "5") {
    return "details";
  }
  return ;
}

export function cycleRegion(current: FocusRegion, reverse: boolean): FocusRegion {
  const index = REGION_ORDER.indexOf(current);
  const start = index < 0 ? 0 : index;
  const next = reverse
    ? (start - 1 + REGION_ORDER.length) % REGION_ORDER.length
    : (start + 1) % REGION_ORDER.length;
  return REGION_ORDER[next] ?? "composer";
}

export const HELP_LINES = [
  "Core: F1 help · Ctrl+P actions · / slash commands · Ctrl+C quit",
  "Composer: Enter send · Shift+Enter newline · Esc clear draft",
  "Views: Ctrl+1 sessions · Ctrl+2 chat · Ctrl+3 composer · Ctrl+4 logs · Tab cycle",
  "Lists: j/k move · PgUp/PgDn page · g/G bounds · Enter select · i details",
  "Search: Ctrl+F filters sessions/logs; opens actions elsewhere",
] as const;
