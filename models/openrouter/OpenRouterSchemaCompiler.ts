import { createOpenRouterProviderSchemaError } from "./OpenRouterErrors.js";

export interface OpenRouterCompiledSchema {
  responseFormat: {
    type: "json_schema";
    json_schema: {
      name: string;
      schema: Record<string, unknown>;
    };
  };
  diagnostics: {
    schemaName: string;
    objectNodeCount: number;
    requiredPropertyExpansions: number;
    nullablePropertyWraps: number;
    openObjectStringFallbacks: number;
    unsupportedStringFormatRemovals: number;
  };
}

interface CompileState {
  schemaName: string;
  objectNodeCount: number;
  requiredPropertyExpansions: number;
  nullablePropertyWraps: number;
  openObjectStringFallbacks: number;
  unsupportedStringFormatRemovals: number;
}

const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedProperties",
  "propertyNames",
  "patternProperties",
  "contains",
  "prefixItems",
]);

const OPENROUTER_SUPPORTED_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "uuid",
  "uri-template",
  "json-pointer",
  "relative-json-pointer",
  "regex",
]);

export function compileOpenRouterResponseSchema(input: {
  schema: Record<string, unknown>;
  schemaName: string;
}): OpenRouterCompiledSchema {
  if (isRecord(input.schema) === false) {
    throw createOpenRouterProviderSchemaError(
      "OpenRouter schema compilation failed: responseSchema must be a JSON object.",
      {
        schemaName: input.schemaName,
        category: "provider_schema",
      },
    );
  }

  const state: CompileState = {
    schemaName: input.schemaName,
    objectNodeCount: 0,
    requiredPropertyExpansions: 0,
    nullablePropertyWraps: 0,
    openObjectStringFallbacks: 0,
    unsupportedStringFormatRemovals: 0,
  };
  const compiled = compileSchemaNode(input.schema, "$", state);

  return {
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: input.schemaName,
        schema: compiled,
      },
    },
    diagnostics: {
      schemaName: input.schemaName,
      objectNodeCount: state.objectNodeCount,
      requiredPropertyExpansions: state.requiredPropertyExpansions,
      nullablePropertyWraps: state.nullablePropertyWraps,
      openObjectStringFallbacks: state.openObjectStringFallbacks,
      unsupportedStringFormatRemovals: state.unsupportedStringFormatRemovals,
    },
  };
}

function compileSchemaNode(
  schema: Record<string, unknown>,
  path: string,
  state: CompileState,
): Record<string, unknown> {
  assertNoUnsupportedKeywords(schema, path, state.schemaName);

  const next: Record<string, unknown> = { ...schema };

  if (Array.isArray(schema.anyOf)) {
    next.anyOf = schema.anyOf.map((entry, index) =>
      normalizeUnknownSchema(entry, `${path}.anyOf[${index}]`, state),
    );
  }
  if (Array.isArray(schema.oneOf)) {
    next.oneOf = schema.oneOf.map((entry, index) =>
      normalizeUnknownSchema(entry, `${path}.oneOf[${index}]`, state),
    );
  }
  if (Array.isArray(schema.allOf)) {
    next.allOf = schema.allOf.map((entry, index) =>
      normalizeUnknownSchema(entry, `${path}.allOf[${index}]`, state),
    );
  }
  if (schema.items !== undefined) {
    next.items = normalizeUnknownSchema(schema.items, `${path}.items`, state);
  }

  const hasObjectType = schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object"));
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  const hasOpenAdditionalProperties = schema.additionalProperties === true ||
    isRecord(schema.additionalProperties);

  if (hasObjectType || properties !== undefined) {
    state.objectNodeCount += 1;
    const propertyEntries = Object.entries(properties ?? {});
    const required = readRequired(schema.required, `${path}.required`, state.schemaName);
    const normalizedProperties: Record<string, unknown> = {};

    for (const [key, rawProperty] of propertyEntries) {
      const compiledProperty = normalizeUnknownSchema(
        rawProperty,
        `${path}.properties.${key}`,
        state,
      );
      if (required.has(key)) {
        normalizedProperties[key] = compiledProperty;
      } else {
        normalizedProperties[key] = wrapNullable(compiledProperty);
        state.nullablePropertyWraps += 1;
      }
      if (required.has(key) === false) {
        state.requiredPropertyExpansions += 1;
      }
      required.add(key);
    }

    next.properties = normalizedProperties;
    next.required = [...required];
    next.additionalProperties = false;

    if (hasOpenAdditionalProperties) {
      state.openObjectStringFallbacks += 1;
      return {
        anyOf: [
          next,
          {
            type: "string",
            minLength: 2,
          },
        ],
      };
    }
  }

  maybeNormalizeStringFormat(next, state);

  return next;
}

function maybeNormalizeStringFormat(
  schema: Record<string, unknown>,
  state: CompileState,
): void {
  const format = schema.format;
  if (typeof format !== "string") {
    return;
  }
  const schemaType = schema.type;
  const isStringSchema = schemaType === "string" ||
    (Array.isArray(schemaType) && schemaType.includes("string"));
  if (isStringSchema === false) {
    return;
  }
  if (OPENROUTER_SUPPORTED_STRING_FORMATS.has(format)) {
    return;
  }
  delete schema.format;
  state.unsupportedStringFormatRemovals += 1;
}

function normalizeUnknownSchema(
  value: unknown,
  path: string,
  state: CompileState,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeUnknownSchema(entry, `${path}[${index}]`, state));
  }
  if (isRecord(value)) {
    return compileSchemaNode(value, path, state);
  }
  return value;
}

function wrapNullable(schema: unknown): unknown {
  if (allowsNull(schema)) {
    return schema;
  }
  if (isRecord(schema)) {
    return {
      anyOf: [schema, { type: "null" }],
    };
  }
  return {
    anyOf: [schema, { type: "null" }],
  };
}

function allowsNull(value: unknown): boolean {
  if (isRecord(value) === false) {
    return false;
  }
  const type = value.type;
  if (type === "null") {
    return true;
  }
  if (Array.isArray(type)) {
    return type.includes("null");
  }
  if (Array.isArray(value.anyOf)) {
    return value.anyOf.some((entry) => allowsNull(entry));
  }
  if (Array.isArray(value.oneOf)) {
    return value.oneOf.some((entry) => allowsNull(entry));
  }
  if (Array.isArray(value.allOf)) {
    return value.allOf.some((entry) => allowsNull(entry));
  }
  return false;
}

function assertNoUnsupportedKeywords(
  schema: Record<string, unknown>,
  path: string,
  schemaName: string,
): void {
  for (const keyword of Object.keys(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      throw createOpenRouterProviderSchemaError(
        `OpenRouter schema compilation failed: unsupported keyword '${keyword}' at ${path}.`,
        {
          category: "provider_schema",
          schemaName,
          schemaPath: path,
          keyword,
        },
      );
    }
  }
}

function readRequired(
  value: unknown,
  path: string,
  schemaName: string,
): Set<string> {
  if (value === undefined) {
    return new Set<string>();
  }
  if (Array.isArray(value) === false) {
    throw createOpenRouterProviderSchemaError(
      `OpenRouter schema compilation failed: ${path} must be an array of strings.`,
      {
        category: "provider_schema",
        schemaName,
        schemaPath: path,
      },
    );
  }
  const required = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw createOpenRouterProviderSchemaError(
        `OpenRouter schema compilation failed: ${path}[${index}] must be a non-empty string.`,
        {
          category: "provider_schema",
          schemaName,
          schemaPath: `${path}[${index}]`,
        },
      );
    }
    required.add(entry);
  }
  return required;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}
