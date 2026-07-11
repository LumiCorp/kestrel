export function getWebhookSecret() {
  return process.env.GITHUB_WEBHOOK_SECRET || "";
}

export function getBotUserName() {
  return (process.env.GITHUB_BOT_USERNAME || process.env.GITHUB_APP_NAME || "")
    .replace(/^@/, "")
    .trim();
}
