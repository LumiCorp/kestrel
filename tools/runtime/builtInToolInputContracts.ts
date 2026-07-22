import { createToolInputError } from "../helpers.js";
import { isTavilySearchCountry } from "../internet/countries.js";
import { isTavilyDateString } from "../internet/dates.js";

type BuiltInToolInputContract =
  | { mode: "schema-only" }
  | {
      mode: "validated";
      validate: (toolName: string, input: unknown) => void;
    };

export const BUILT_IN_TOOL_INPUT_CONTRACTS = {
  "free.weather.current": { mode: "schema-only" },
  "free.weather.forecast": { mode: "schema-only" },
  "free.time.current": { mode: "schema-only" },
  "free.geocode.lookup": { mode: "schema-only" },
  "free.exchange.rate": { mode: "schema-only" },
  "free.hn.top": { mode: "schema-only" },
  "internet.search": { mode: "schema-only" },
  "internet.search_advanced": { mode: "validated", validate: validateAdvancedSearchInput },
  "internet.news": { mode: "schema-only" },
  "internet.images": { mode: "schema-only" },
  "internet.extract": { mode: "validated", validate: validateInternetExtractInput },
  "internet.crawl": { mode: "validated", validate: validateInternetUrlInput },
  "internet.map": { mode: "validated", validate: validateInternetUrlInput },
  "internet.research": { mode: "schema-only" },
  "internet.research_status": { mode: "schema-only" },
  "internet.usage": { mode: "schema-only" },
  "evidence.extract": { mode: "schema-only" },
  "fs.list": { mode: "schema-only" },
  "fs.read_text": { mode: "schema-only" },
  "fs.create_text": { mode: "schema-only" },
  "fs.edit_text": { mode: "schema-only" },
  "fs.apply_patch": { mode: "schema-only" },
  "artifact.read": { mode: "schema-only" },
  "fs.verify_json": { mode: "schema-only" },
  "fs.search_text": { mode: "schema-only" },
  "repo.trace": { mode: "schema-only" },
  "fs.write_text": { mode: "schema-only" },
  "fs.replace_text": { mode: "schema-only" },
  "fs.mkdir": { mode: "validated", validate: validateFilesystemMutationPathInput },
  "fs.copy": { mode: "schema-only" },
  "fs.move": { mode: "schema-only" },
  "fs.delete": { mode: "validated", validate: validateFilesystemMutationPathInput },
  "planning.write_document": { mode: "schema-only" },
  "code.execute": { mode: "schema-only" },
  "dev.shell.run": { mode: "schema-only" },
  "dev.process.start": { mode: "schema-only" },
  "dev.process.write": { mode: "schema-only" },
  "dev.process.write_and_read": { mode: "schema-only" },
  "dev.process.read": { mode: "schema-only" },
  "dev.process.stop": { mode: "schema-only" },
  exec_command: { mode: "schema-only" },
  "desktop.host.open": { mode: "schema-only" },
  effect_result_lookup: { mode: "schema-only" },
  FinalizeAnswer: { mode: "schema-only" },
  "agent.spawn": { mode: "schema-only" },
  "dialog.open": { mode: "schema-only" },
  "dialog.send": { mode: "schema-only" },
  "dialog.close": { mode: "schema-only" },
  "delegate.spawn_child": { mode: "schema-only" },
  "delegate.list_children": { mode: "schema-only" },
  "delegate.get_child_result": { mode: "schema-only" },
  "task.propose": { mode: "schema-only" },
  "kestrel_one.search_knowledge_documents": { mode: "schema-only" },
  "kestrel_one.github_repository_read": { mode: "schema-only" },
  "kestrel_one.github_push_agent_branch": { mode: "schema-only" },
  "workspace.preview.publish": { mode: "schema-only" },
  "workspace.preview.list": { mode: "schema-only" },
  "workspace.preview.renew": { mode: "schema-only" },
  "workspace.preview.close": { mode: "schema-only" },
  "kestrel_one.github_issue_create": { mode: "schema-only" },
  "kestrel_one.github_pull_request_create": { mode: "schema-only" },
  "kestrel_one.github_pull_request_merge": { mode: "schema-only" },
  "kestrel_one.github_release_create": { mode: "schema-only" },
  "kestrel_one.github_workflow_dispatch": { mode: "schema-only" },
  "kestrel_one.google_calendar_list_events": { mode: "schema-only" },
  "kestrel_one.google_calendar_create_event": { mode: "schema-only" },
  "kestrel_one.google_calendar_update_event": { mode: "schema-only" },
  "kestrel_one.google_calendar_delete_event": { mode: "schema-only" },
  "kestrel_one.google_calendar_list_availability_subjects": { mode: "schema-only" },
  "kestrel_one.google_calendar_check_availability": { mode: "schema-only" },
  "kestrel_one.email_send": { mode: "schema-only" },
} satisfies Record<string, BuiltInToolInputContract>;

export function validateBuiltInToolInputContract(name: string, input: unknown): void {
  const contract = readBuiltInToolInputContract(name);
  if (contract?.mode !== "validated") {
    return;
  }

  contract.validate(name, input);
}

function readBuiltInToolInputContract(name: string): BuiltInToolInputContract | undefined {
  return  Object.hasOwn(BUILT_IN_TOOL_INPUT_CONTRACTS, name)
    ? BUILT_IN_TOOL_INPUT_CONTRACTS[name as keyof typeof BUILT_IN_TOOL_INPUT_CONTRACTS]
    : undefined;
}

function validateInternetUrlInput(toolName: string, input: unknown): void {
  const record = asRecord(input);
  if (record === undefined || typeof record.url !== "string") {
    return;
  }

  if (isPublicInternetHttpUrl(record.url)) {
    return;
  }

  throw createContractError(toolName, "url", "a public absolute http or https URL", [record.url]);
}

function validateInternetExtractInput(toolName: string, input: unknown): void {
  const record = asRecord(input);
  if (record === undefined) {
    return;
  }
  const urls = Array.isArray(record.urls)
    ? record.urls.filter((value): value is string => typeof value === "string")
    : typeof record.url === "string"
      ? [record.url]
      : [];
  const invalidValues = urls.filter((url) => isPublicInternetHttpUrl(url) === false);
  if (invalidValues.length > 0) {
    throw createContractError(toolName, Array.isArray(record.urls) ? "urls" : "url", "public absolute http or https URLs", invalidValues);
  }
}

function validateFilesystemMutationPathInput(toolName: string, input: unknown): void {
  const record = asRecord(input);
  const path = typeof record?.path === "string" ? normalizeFilesystemMutationPath(record.path) : undefined;
  if (path === undefined) {
    return;
  }
  if (path !== ".") {
    return;
  }
  throw createContractError(toolName, "path", "an explicit path other than the workspace root '.'", [
    typeof record?.path === "string" ? record.path : ".",
  ]);
}

function validateAdvancedSearchInput(toolName: string, input: unknown): void {
  const record = asRecord(input);
  if (record === undefined) {
    return;
  }
  for (const field of ["domainAllow", "domainDeny"] as const) {
    const values = Array.isArray(record[field])
      ? record[field].filter((value): value is string => typeof value === "string")
      : [];
    const invalidValues = values.filter((value) => isHostname(value) === false);
    if (invalidValues.length > 0) {
      throw createContractError(toolName, field, "hostnames only, without schemes, paths, or content categories", invalidValues);
    }
  }
  const country = typeof record.country === "string" ? record.country.trim() : undefined;
  if (country !== undefined && country.length > 0) {
    const topic = typeof record.topic === "string" ? record.topic.trim() : undefined;
    if ((topic === undefined || topic === "general") && isTavilySearchCountry(country) === false) {
      throw createContractError(toolName, "country", "one of Tavily's supported lowercase country names", [country]);
    }
  }
  for (const field of ["startDate", "endDate"] as const) {
    const value = typeof record[field] === "string" ? record[field].trim() : undefined;
    if (value !== undefined && value.length > 0 && isTavilyDateString(value) === false) {
      throw createContractError(toolName, field, "a YYYY-MM-DD date", [value]);
    }
  }
}

function createContractError(
  toolName: string,
  field: string,
  expected: string,
  invalidValues: string[],
) {
  return createToolInputError(
    toolName,
    `Invalid ${toolName} input.${field}. Expected ${expected}.`,
    {
      field,
      expected,
      invalidValues,
    },
  );
}

export function isPublicInternetHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname.trim().length === 0) {
      return false;
    }
    const hostname = normalizeUrlHostname(url.hostname);
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
      return false;
    }
    if (hostname === "host.docker.internal") {
      return false;
    }
    if (hostname.includes(".") === false && hostname.includes(":") === false) {
      return false;
    }
    if (isPrivateIpv4Hostname(hostname) || isPrivateIpv6Hostname(hostname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeUrlHostname(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

function isPrivateIpv4Hostname(hostname: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(hostname) === false) {
    return false;
  }
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isInteger(part) === false || part < 0 || part > 255)) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6Hostname(hostname: string): boolean {
  if (hostname.includes(":") === false) {
    return false;
  }
  return (
    hostname === "::1" ||
    hostname === "0:0:0:0:0:0:0:1" ||
    hostname.startsWith("fe80:") ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd")
  );
}

function isHostname(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes("/") || trimmed.includes(":")) {
    return false;
  }
  if (trimmed.includes(".") === false) {
    return false;
  }
  try {
    const normalized = trimmed.toLowerCase();
    const parsed = new URL(`https://${trimmed}`);
    return parsed.hostname === normalized && parsed.hostname.includes(".");
  } catch {
    return false;
  }
}

function normalizeFilesystemMutationPath(value: string): string | undefined {
  const trimmed = value.trim().replace(/\\/gu, "/");
  if (trimmed.length === 0) {
    return ;
  }
  const withoutPrefix = trimmed.replace(/^(?:\.\/)+/u, "");
  const collapsed = withoutPrefix.replace(/\/+/gu, "/").replace(/\/$/u, "");
  return collapsed.length === 0 ? "." : collapsed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}
