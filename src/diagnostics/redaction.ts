export interface RedactionSummary {
  count: number;
  kinds: string[];
}

export interface RedactionResult {
  value: string;
  summary: RedactionSummary;
}

const KEY_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|sk-or-v1-[A-Za-z0-9_-]+|tvly-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_]{20,})\b/gu;
const ENV_SECRET_PATTERN = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)=([^\s]+)/gu;

export function redactDiagnosticValue(value: unknown): string {
  return redactDiagnosticText(String(value)).value;
}

export function redactDiagnosticText(text: string): RedactionResult {
  const kinds = new Set<string>();
  let redacted = redactUrls(text, kinds);
  redacted = redacted.replace(ENV_SECRET_PATTERN, (_match, name: string) => {
    kinds.add("env");
    return `${name}=[redacted:env]`;
  });
  redacted = redacted.replace(KEY_PATTERN, () => {
    kinds.add("key");
    return "[redacted:key]";
  });
  return {
    value: redacted,
    summary: {
      count: countRedactions(redacted),
      kinds: [...kinds].sort(),
    },
  };
}

export function mergeRedactionSummaries(summaries: RedactionSummary[]): RedactionSummary {
  const kinds = new Set<string>();
  let count = 0;
  for (const summary of summaries) {
    count += summary.count;
    for (const kind of summary.kinds) {
      kinds.add(kind);
    }
  }
  return {
    count,
    kinds: [...kinds].sort(),
  };
}

function redactUrls(text: string, kinds: Set<string>): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@([^\s]+)/giu, (_match, protocol: string, _user: string, _password: string, hostAndPath: string) => {
    kinds.add("url");
    return `${protocol}[redacted]@${hostAndPath}`;
  });
}

function countRedactions(text: string): number {
  return (text.match(/\[redacted:/gu) ?? []).length;
}
