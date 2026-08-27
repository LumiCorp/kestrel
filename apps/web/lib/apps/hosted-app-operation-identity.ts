export const githubMutationTools = {
  "kestrel_one.github_issue_create": ["issue.create", "issue.write"],
  "kestrel_one.github_pull_request_create": [
    "pull_request.create",
    "pull_request.write",
  ],
  "kestrel_one.github_pull_request_merge": [
    "pull_request.merge",
    "merge.write",
  ],
  "kestrel_one.github_release_create": ["release.create", "release.write"],
  "kestrel_one.github_workflow_dispatch": [
    "workflow.dispatch",
    "workflow.dispatch",
  ],
} as const;

export const googleMutationTools = {
  "kestrel_one.google_calendar_create_event": "events.create",
  "kestrel_one.google_calendar_update_event": "events.update",
  "kestrel_one.google_calendar_delete_event": "events.delete",
} as const;

export const microsoftMutationTools = {
  "kestrel_one.microsoft_365_send_mail": "mail.send",
  "kestrel_one.microsoft_365_send_chat_message": "chat.send",
} as const;

export function hostedMutationOperationKey(toolName: string): string | null {
  if (toolName === "kestrel_one.email_send") return "email.send";
  const github =
    githubMutationTools[toolName as keyof typeof githubMutationTools];
  if (github) return github[0];
  const google =
    googleMutationTools[toolName as keyof typeof googleMutationTools];
  if (google) return google;
  const microsoft =
    microsoftMutationTools[toolName as keyof typeof microsoftMutationTools];
  return microsoft ?? null;
}
