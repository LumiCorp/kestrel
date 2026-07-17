export function sanitizeJsonValue<T>(value: T): T {
  return sanitizeValue(value, new Set<object>()) as T;
}

export function stringifySanitizedJson(value: unknown): string {
  return JSON.stringify(sanitizeJsonValue(value)) ?? "null";
}

export function sanitizeUtf16String(value: string): string {
  let next = "";
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x00_00) {
      next += "\uFFFD";
      continue;
    }
    if (codeUnit >= 0xd8_00 && codeUnit <= 0xdb_ff) {
      const nextCodeUnit = index + 1 < value.length ? value.charCodeAt(index + 1) : undefined;
      if (nextCodeUnit !== undefined && nextCodeUnit >= 0xdc_00 && nextCodeUnit <= 0xdf_ff) {
        next += value[index] ?? "";
        next += value[index + 1] ?? "";
        index += 1;
        continue;
      }
      next += "\uFFFD";
      continue;
    }
    if (codeUnit >= 0xdc_00 && codeUnit <= 0xdf_ff) {
      next += "\uFFFD";
      continue;
    }
    next += value[index] ?? "";
  }
  return next;
}

function sanitizeValue(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "string") {
    return sanitizeUtf16String(value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (ancestors.has(value)) {
    return "[Circular]";
  }

  if (Array.isArray(value)) {
    const sanitized: unknown[] = [];
    ancestors.add(value);
    for (const entry of value) {
      sanitized.push(sanitizeValue(entry, ancestors));
    }
    ancestors.delete(value);
    return sanitized;
  }

  const toJson = readToJson(value);
  if (toJson !== undefined) {
    if (toJson === value) {
      return "[Circular]";
    }
    ancestors.add(value);
    const sanitized = sanitizeValue(toJson, ancestors);
    ancestors.delete(value);
    return sanitized;
  }

  const sanitized: Record<string, unknown> = {};
  ancestors.add(value);
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = sanitizeValue(entry, ancestors);
  }
  ancestors.delete(value);
  return sanitized;
}

function readToJson(value: object): unknown {
  const candidate = value as { toJSON?: (() => unknown) | undefined };
  if (typeof candidate.toJSON !== "function") {
    return ;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    return ;
  }
  return candidate.toJSON();
}
