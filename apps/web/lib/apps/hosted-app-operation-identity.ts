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

export const googleMutationTools: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS.filter(
        (operation) =>
          operation.pack === "calendar" &&
          (operation.sideEffect === "external_side_effect" ||
            operation.serviceOperation === "events.list"),
      ).map((operation) => [
        operation.hostedToolName,
        operation.serviceOperation,
      ]),
    ),
  );

export const gmailMutationTools: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS.filter(
        (operation) =>
          operation.pack === "gmail" &&
          operation.sideEffect === "external_side_effect",
      ).map((operation) => [
        operation.hostedToolName,
        operation.serviceOperation,
      ]),
    ),
  );

export const microsoftMutationTools: Readonly<Record<string, string>> =
  Object.freeze({
    "kestrel_one.microsoft_365_send_mail": "mail.send",
    ...Object.fromEntries(
      MICROSOFT_365_OPERATION_DESCRIPTORS.filter(
        (operation) => operation.sideEffect === "external_side_effect",
      ).map((operation) => [
        operation.hostedToolName,
        operation.serviceOperation,
      ]),
    ),
  });

export function hostedMutationOperationKey(toolName: string): string | null {
  if (toolName === "kestrel_one.email_send") return "email.send";
  const github = githubMutationTools[toolName as keyof typeof githubMutationTools];
  if (github) return github[0];
  const google = googleMutationTools[toolName];
  if (google) return google;
  const gmail = gmailMutationTools[toolName];
  if (gmail) return gmail;
  const microsoft = microsoftMutationTools[toolName];
  return microsoft ?? null;
}
import { GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS } from "../../../../src/apps/googleWorkspace.js";
import { MICROSOFT_365_OPERATION_DESCRIPTORS } from "../../../../src/apps/microsoft365.js";
