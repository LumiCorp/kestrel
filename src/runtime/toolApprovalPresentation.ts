import { CONVERSATION_ATTACHMENT_MAX_FILE_BYTES } from "@kestrel-agents/conversation";

import type {
  ToolApprovalDispositionV1,
  ToolApprovalReasonCode,
} from "../mode/contracts.js";
import { isRememberApprovalEligibleV1 } from "../mode/contracts.js";
import { canonicalizePublicBrowserDestination } from "../browser/domainAuthority.js";
import {
  parseBrowserDownloadPreparedEffectV1,
  parseBrowserUploadPreparedEffectV1,
} from "../browser/contracts.js";
import type { PreparedToolInputAdapterV1 } from "../kestrel/contracts/tool-invocation.js";

export interface BrowserDomainGrantApprovalPresentationV1 {
  version: "browser_domain_grant_approval_v1";
  sessionId: string;
  sessionMode: "operator";
  canonicalDomain: string;
  scheme: "https";
  scope: "apex_and_subdomains";
  includeSubdomains: true;
  port: 443;
  ownerEffect: "requesting_person";
  environmentEffect: "future_eligible_projects_in_environment";
  sessionEffect: "immediate";
  actionLabel: "Allow and remember";
  requestingActorId?: string | undefined;
  environmentId?: string | undefined;
  approvalAuthorityRevision?: string | undefined;
}

export interface ToolApprovalPresentationV1 {
  title: string;
  summary: string;
  fields: Array<{ label: string; value: string }>;
  warnings: string[];
  policy: {
    mode: "ask";
    reasonCode: ToolApprovalReasonCode;
    explanation: string;
    authorityKind: ToolApprovalDispositionV1["authority"]["kind"];
    authorityRevision: string;
    rememberApprovalEligible: boolean;
  };
  browserDomainGrant?: BrowserDomainGrantApprovalPresentationV1 | undefined;
}

type Presenter = {
  title: string;
  summary: string;
  fields: ReadonlyArray<{
    path: string;
    label: string;
    format?:
      | "default"
      | "event_time"
      | "attendees"
      | "string_list"
      | "json_string_list"
      | undefined;
  }>;
  warnings?: readonly string[] | undefined;
};

const PRESENTERS: Readonly<Record<string, Presenter>> = Object.freeze({
  exec_command: presenter(
    "Run command",
    "Review this command before it runs.",
    [
      ["command", "Command"],
      ["cwd", "Working directory"],
      ["envNames", "Environment access", "string_list"],
    ],
    [
      "Allow for thread remembers only this exact command in this folder.",
    ],
  ),
  "internet.search": presenter("Search the web", "Run a Tavily web search.", [
    ["query", "Query"],
  ]),
  "internet.search_advanced": presenter(
    "Run an advanced web search",
    "Search the web with the selected controls.",
    [
      ["query", "Query"],
      ["topic", "Topic"],
      ["includeDomains", "Included domains"],
      ["excludeDomains", "Excluded domains"],
      ["startDate", "Start date"],
      ["endDate", "End date"],
    ],
  ),
  "internet.news": presenter(
    "Search recent news",
    "Search recent news sources.",
    [
      ["query", "Query"],
      ["days", "Recency (days)"],
    ],
  ),
  "internet.images": presenter(
    "Search for images",
    "Find images and their source pages.",
    [["query", "Query"]],
  ),
  "internet.extract": presenter(
    "Extract web pages",
    "Extract readable content from selected pages.",
    [["urls", "Pages"]],
  ),
  "internet.crawl": presenter(
    "Crawl a site",
    "Crawl pages within the selected site.",
    [
      ["url", "Site"],
      ["maxDepth", "Maximum depth"],
      ["maxBreadth", "Maximum breadth"],
    ],
  ),
  "internet.map": presenter(
    "Map a site",
    "Discover pages within the selected site.",
    [
      ["url", "Site"],
      ["maxDepth", "Maximum depth"],
    ],
  ),
  "internet.research": presenter(
    "Run web research",
    "Start a multi-source Tavily research task.",
    [
      ["query", "Research request"],
      ["model", "Research model"],
    ],
  ),
  "internet.research_status": presenter(
    "Check research status",
    "Read the status of a Tavily research task.",
    [["requestId", "Research request"]],
  ),
  "kestrel_one.email_send": presenter(
    "Send an email",
    "Send an organization email.",
    [
      ["to", "To"],
      ["cc", "Cc"],
      ["bcc", "Bcc"],
      ["subject", "Subject"],
      ["text", "Message"],
    ],
    ["Organization email always requires approval for each send."],
  ),
  "google_workspace.send_gmail": presenter(
    "Send a Gmail message",
    "Review the exact Gmail message and Thread-file revisions before it is sent.",
    [
      ["__kestrelGmailPrepared.envelope.to", "To", "string_list"],
      ["__kestrelGmailPrepared.envelope.cc", "Cc", "string_list"],
      ["__kestrelGmailPrepared.envelope.subject", "Subject"],
      ["__kestrelGmailPrepared.envelope.text", "Message"],
      ["__kestrelGmailPrepared.attachments", "Attachments", "json_string_list"],
    ],
    ["Gmail sends require approval for this exact prepared message."],
  ),
  "google_workspace.reply_gmail": presenter(
    "Reply with Gmail",
    "Review the provider-resolved recipient, thread, message, and Thread-file revisions before sending.",
    [
      ["__kestrelGmailPrepared.envelope.threadId", "Thread"],
      ["__kestrelGmailPrepared.envelope.to", "To", "string_list"],
      ["__kestrelGmailPrepared.envelope.subject", "Subject"],
      ["__kestrelGmailPrepared.envelope.text", "Message"],
      ["__kestrelGmailPrepared.attachments", "Attachments", "json_string_list"],
    ],
    ["Gmail supplies the reply recipient and RFC reply headers from the selected message."],
  ),
  "kestrel_one.google_calendar_create_event": presenter(
    "Create a calendar event",
    "Create an event in Google Calendar.",
    [
      ["event.summary", "Title"],
      ["event.start", "Starts", "event_time"],
      ["event.end", "Ends", "event_time"],
      ["event.attendees", "Attendees", "attendees"],
      ["notifyAttendees", "Send invitations"],
    ],
  ),
  "kestrel_one.google_calendar_update_event": presenter(
    "Update a calendar event",
    "Change an existing Google Calendar event.",
    [
      ["eventId", "Event"],
      ["patch.summary", "Title"],
      ["patch.start", "Starts", "event_time"],
      ["patch.end", "Ends", "event_time"],
      ["patch.attendees", "Attendees", "attendees"],
      ["notifyAttendees", "Send updates"],
    ],
  ),
  "kestrel_one.google_calendar_delete_event": presenter(
    "Delete a calendar event",
    "Delete an event from Google Calendar.",
    [
      ["eventId", "Event"],
      ["notifyAttendees", "Send cancellations"],
    ],
    ["This removes the selected event from the calendar."],
  ),
  "kestrel_one.microsoft_365_send_mail": presenter(
    "Send an Outlook email",
    "Send mail through Microsoft 365.",
    [
      ["to", "To"],
      ["cc", "Cc"],
      ["subject", "Subject"],
      ["body", "Message"],
    ],
  ),
  "kestrel_one.microsoft_365_send_chat_message": presenter(
    "Send a Teams message",
    "Send a message to a Microsoft Teams chat.",
    [
      ["chatId", "Chat"],
      ["content", "Message"],
    ],
  ),
  "kestrel_one.github_push_agent_branch": presenter(
    "Push a GitHub branch",
    "Push the selected agent branch to GitHub.",
    [
      ["repository", "Repository"],
      ["branch", "Branch"],
    ],
  ),
  "kestrel_one.github_pull_request_create": presenter(
    "Create a pull request",
    "Open a pull request on GitHub.",
    [
      ["repository", "Repository"],
      ["head", "Source branch"],
      ["base", "Target branch"],
      ["title", "Title"],
      ["body", "Description"],
    ],
  ),
  "kestrel_one.github_issue_create": presenter(
    "Create a GitHub issue",
    "Open a new issue on GitHub.",
    [
      ["repository", "Repository"],
      ["title", "Title"],
      ["body", "Description"],
      ["labels", "Labels"],
    ],
  ),
  "kestrel_one.github_pull_request_merge": presenter(
    "Merge a pull request",
    "Merge the selected GitHub pull request.",
    [
      ["repository", "Repository"],
      ["pullNumber", "Pull request"],
      ["method", "Merge method"],
    ],
    ["Merging changes the target branch and may trigger deployments."],
  ),
  "kestrel_one.github_release_create": presenter(
    "Create a GitHub release",
    "Publish a new GitHub release.",
    [
      ["repository", "Repository"],
      ["tagName", "Tag"],
      ["name", "Release name"],
      ["draft", "Draft"],
    ],
  ),
  "kestrel_one.github_workflow_dispatch": presenter(
    "Run a GitHub workflow",
    "Dispatch a GitHub Actions workflow.",
    [
      ["repository", "Repository"],
      ["workflowId", "Workflow"],
      ["ref", "Ref"],
      ["inputs", "Workflow inputs"],
    ],
  ),
  "kestrel_one.vercel_list_projects": presenter(
    "List Vercel projects",
    "Read the projects visible to this App connection.",
    [["teamId", "Team"]],
  ),
  "kestrel_one.vercel_list_deployments": presenter(
    "List Vercel deployments",
    "Read deployments for the selected Vercel project.",
    [
      ["projectId", "Project"],
      ["teamId", "Team"],
    ],
  ),
  "kestrel_one.vercel_deployment_events": presenter(
    "Read Vercel deployment events",
    "Read events for the selected deployment.",
    [
      ["deploymentId", "Deployment"],
      ["teamId", "Team"],
    ],
  ),
  "workspace.preview.publish": presenter(
    "Publish a workspace preview",
    "Publish the selected local service as a preview.",
    [
      ["port", "Port"],
      ["name", "Name"],
      ["ttlMinutes", "Lifetime (minutes)"],
    ],
  ),
  "workspace.files.share": presenter(
    "Share Workspace files",
    "Publish an immutable file or ZIP through a temporary preview link.",
    [
      ["mode", "Mode"],
      ["paths", "Selected files", "json_string_list"],
      ["downloadName", "Download name"],
      ["ttlMinutes", "Lifetime (minutes)"],
    ],
    ["Anyone with the temporary link can download the selected payload."],
  ),
  "workspace.preview.renew": presenter(
    "Renew a workspace preview",
    "Extend the selected preview lease.",
    [
      ["previewId", "Preview"],
      ["ttlMinutes", "Lifetime (minutes)"],
    ],
  ),
  "workspace.preview.close": presenter(
    "Close a workspace preview",
    "Stop publishing the selected preview.",
    [["previewId", "Preview"]],
  ),
});

export function buildToolApprovalPresentation(input: {
  toolName: string;
  effectiveInput: unknown;
  inputAdapters?: readonly PreparedToolInputAdapterV1[] | undefined;
  disposition?: ToolApprovalDispositionV1 | undefined;
  hostedApprovalScope?: {
    requestingActorId: string;
    environmentId: string;
  } | undefined;
}): ToolApprovalPresentationV1 {
  const presenterDefinition = PRESENTERS[input.toolName];
  const record = readRecord(input.effectiveInput);
  const disposition = input.disposition ?? {
    mode: "ask" as const,
    reasonCode: "tool_minimum" as const,
    authority: {
      kind: "runtime_policy" as const,
      revision: "legacy-external-confirm",
    },
  };
  if (input.toolName === "browser.request_grant") {
    const sessionId = readNonEmptyString(record?.sessionId, "sessionId");
    const destination = readNonEmptyString(record?.destination, "destination");
    const authority = canonicalizePublicBrowserDestination(destination);
    const browserDomainGrant: BrowserDomainGrantApprovalPresentationV1 = {
      version: "browser_domain_grant_approval_v1",
      sessionId,
      sessionMode: "operator",
      canonicalDomain: authority.canonicalDomain,
      scheme: authority.scheme,
      scope: "apex_and_subdomains",
      includeSubdomains: authority.includeSubdomains,
      port: authority.port,
      ownerEffect: "requesting_person",
      environmentEffect: "future_eligible_projects_in_environment",
      sessionEffect: "immediate",
      actionLabel: "Allow and remember",
      ...(input.hostedApprovalScope === undefined
        ? {}
        : {
            requestingActorId: input.hostedApprovalScope.requestingActorId,
            environmentId: input.hostedApprovalScope.environmentId,
            approvalAuthorityRevision: disposition.authority.revision,
          }),
    };
    return {
      title: "Allow this Browser domain",
      summary:
        "Allow this HTTPS apex and its subdomains now and remember it for your eligible Projects in this Environment.",
      fields: [
        { label: "Domain", value: authority.canonicalDomain },
        { label: "Scope", value: "Apex and subdomains" },
        { label: "Port", value: "443 (HTTPS)" },
        ...(input.hostedApprovalScope === undefined
          ? [{ label: "Applies to", value: "You in this Environment" }]
          : [
              {
                label: "Person",
                value: input.hostedApprovalScope.requestingActorId,
              },
              {
                label: "Environment",
                value: input.hostedApprovalScope.environmentId,
              },
            ]),
      ],
      warnings: [
        "This takes effect in the current Browser Session and future eligible Projects in this Environment.",
      ],
      policy: {
        mode: "ask",
        reasonCode: disposition.reasonCode,
        explanation: approvalReasonExplanation(disposition.reasonCode),
        authorityKind: disposition.authority.kind,
        authorityRevision: disposition.authority.revision,
        rememberApprovalEligible: false,
      },
      browserDomainGrant,
    };
  }
  if (input.toolName === "browser.upload") {
    const matches = (input.inputAdapters ?? []).filter(
      (adapter) => adapter.adapterId === "kestrel.browser-upload-effect:v1",
    );
    if (matches.length !== 1) {
      throw new Error("Browser upload approval is missing exact prepared effect authority.");
    }
    const effect = parseBrowserUploadPreparedEffectV1(matches[0]!.metadata);
    return {
      title: "Upload attachment",
      summary: "Upload this active-turn attachment to the selected Browser file input.",
      fields: [
        { label: "File", value: effect.filename },
        {
          label: "Measured size",
          value: `${effect.sizeBytes} bytes (${CONVERSATION_ATTACHMENT_MAX_FILE_BYTES / (1024 * 1024)} MiB maximum)`,
        },
        { label: "Declared media type", value: `${effect.declaredMediaType} (untrusted metadata)` },
        { label: "Browser target", value: effect.targetLabel },
      ],
      warnings: [
        "Only this approved attachment is transferred to this exact current file input.",
      ],
      policy: {
        mode: "ask",
        reasonCode: disposition.reasonCode,
        explanation: approvalReasonExplanation(disposition.reasonCode),
        authorityKind: disposition.authority.kind,
        authorityRevision: disposition.authority.revision,
        rememberApprovalEligible: false,
      },
    };
  }
  if (input.toolName === "browser.download") {
    const matches = (input.inputAdapters ?? []).filter(
      (adapter) => adapter.adapterId === "kestrel.browser-download-effect:v1",
    );
    if (matches.length !== 1) {
      throw new Error("Browser download approval is missing exact prepared effect authority.");
    }
    const effect = parseBrowserDownloadPreparedEffectV1(matches[0]!.metadata);
    return {
      title: "Promote browser download",
      summary: "Publish this quarantined Browser download as one file in the current Thread.",
      fields: [
        { label: "File", value: effect.filename },
        {
          label: "Measured size",
          value: `${effect.measuredBytes} bytes (${CONVERSATION_ATTACHMENT_MAX_FILE_BYTES / (1024 * 1024)} MiB maximum)`,
        },
        { label: "Declared media type", value: `${effect.declaredMediaType} (untrusted metadata)` },
        { label: "Source origin", value: effect.normalizedSourceOrigin },
        { label: "Result", value: "One file in the current Thread" },
      ],
      warnings: [
        "Only this exact completed quarantine item is published. Browser paths and storage locations remain hidden.",
      ],
      policy: {
        mode: "ask",
        reasonCode: disposition.reasonCode,
        explanation: approvalReasonExplanation(disposition.reasonCode),
        authorityKind: disposition.authority.kind,
        authorityRevision: disposition.authority.revision,
        rememberApprovalEligible: false,
      },
    };
  }
  const fields =
    presenterDefinition === undefined || record === null
      ? []
      : presenterDefinition.fields.flatMap(({ path, label, format }) => {
          const value = readPath(record, path);
          return value === undefined
            ? []
            : [{ label, value: displayValue(value, format) }];
        });
  return {
    title: presenterDefinition?.title ?? "Approve tool operation",
    summary:
      presenterDefinition?.summary ??
      "This tool does not provide a detailed approval preview. Sensitive request data is hidden.",
    fields,
    warnings: [
      ...(presenterDefinition?.warnings ??
        (presenterDefinition === undefined
          ? ["Review the operation name and approval policy before continuing."]
          : [])),
    ],
    policy: {
      mode: "ask",
      reasonCode: disposition.reasonCode,
      explanation: approvalReasonExplanation(disposition.reasonCode),
      authorityKind: disposition.authority.kind,
      authorityRevision: disposition.authority.revision,
      rememberApprovalEligible: isRememberApprovalEligibleV1({ disposition }),
    },
  };
}

export function approvalReasonExplanation(
  reasonCode: ToolApprovalReasonCode,
): string {
  switch (reasonCode) {
    case "tool_minimum":
      return "This capability requires approval for every invocation.";
    case "environment_policy":
      return "Environment Apps is configured to ask before this capability runs.";
    case "project_restriction":
      return "This Project narrows the Environment policy to Ask first.";
    case "subject_restriction":
      return "A user or agent restriction requires approval for this invocation.";
    case "runtime_strict":
      return "The current runtime mode requires approval for every tool call.";
    case "remembered_thread":
      return "This tool was approved for the rest of this thread.";
  }
}

function presenter(
  title: string,
  summary: string,
  fields: ReadonlyArray<
    readonly [
      string,
      string,
      (
        | "default"
        | "event_time"
        | "attendees"
        | "string_list"
        | "json_string_list"
      )?,
    ]
  >,
  warnings?: readonly string[],
): Presenter {
  return {
    title,
    summary,
    fields: fields.map(([path, label, format]) => ({
      path,
      label,
      ...(format === undefined ? {} : { format }),
    })),
    ...(warnings === undefined ? {} : { warnings }),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`browser.request_grant ${field} is required.`);
  }
  return value.trim();
}

function readPath(record: Record<string, unknown>, path: string): unknown {
  let value: unknown = record;
  for (const segment of path.split(".")) {
    const current = readRecord(value);
    if (current === null) return undefined;
    value = current[segment];
  }
  return value;
}

function displayValue(
  value: unknown,
  format:
    | "default"
    | "event_time"
    | "attendees"
    | "string_list"
    | "json_string_list" = "default",
): string {
  if (format === "event_time") {
    const time = readRecord(value);
    const date = time?.dateTime ?? time?.date;
    const timeZone = time?.timeZone;
    return typeof date === "string"
      ? `${date}${typeof timeZone === "string" ? ` (${timeZone})` : ""}`
      : "Configured time";
  }
  if (format === "attendees") {
    return Array.isArray(value)
      ? value
          .flatMap((attendee) => {
            const email = readRecord(attendee)?.email;
            return typeof email === "string" ? [email] : [];
          })
          .join(", ") || "Configured attendees"
      : "Configured attendees";
  }
  if (format === "string_list") {
    return Array.isArray(value) &&
      value.every((item): item is string => typeof item === "string")
      ? value.join(", ") || "None"
      : "Configured selection";
  }
  if (format === "json_string_list") {
    return Array.isArray(value) ? JSON.stringify(value) : "Configured selection";
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null) return "None";
  if (Array.isArray(value)) {
    return value.map((item) => displayValue(item)).join(", ");
  }
  return "Configured value";
}
