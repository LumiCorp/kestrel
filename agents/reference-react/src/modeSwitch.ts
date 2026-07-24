export function buildModeSwitchMessage(mode: "chat" | "plan" | "build") {
  const label = mode === "chat" ? "Chat" : mode === "plan" ? "Plan" : "Build";
  return `${label} mode is selected and will apply to your next message.`;
}
