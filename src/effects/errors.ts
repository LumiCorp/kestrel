import type { RuntimeError } from "../kestrel/contracts/base.js";
import { asRuntimeError, createRuntimeFailure } from "../runtime/RuntimeFailure.js";

export function createEffectRegistrationError(
  code: "EFFECT_REGISTRATION_INVALID" | "EFFECT_REGISTRATION_DUPLICATE",
  message: string,
  details?: Record<string, unknown>,
) {
  return createRuntimeFailure(code, message, {
    subsystem: "runtime",
    classification: "configuration",
    recoverable: false,
    ...(details ?? {}),
  });
}

export function createEffectLookupError(type: string) {
  return createRuntimeFailure(
    "EFFECT_LOOKUP_FAILED",
    `No effect handler registered for '${type}'.`,
    {
      subsystem: "runtime",
      effectType: type,
      classification: "configuration",
      recoverable: false,
    },
  );
}

export function createEffectPayloadError(
  effectType: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return createRuntimeFailure("EFFECT_PAYLOAD_INVALID", message, {
    subsystem: "runtime",
    effectType,
    classification: "schema",
    recoverable: true,
    ...(details ?? {}),
  });
}

export function createEffectExecutionError(
  effectType: string,
  idempotencyKey: string,
  error: unknown,
): RuntimeError {
  const runtimeError = asRuntimeError(error);
  return asRuntimeError(createRuntimeFailure(
    runtimeError.code.startsWith("EFFECT_") ? runtimeError.code : "EFFECT_EXECUTION_FAILED",
    runtimeError.message,
    {
      subsystem: "runtime",
      effectType,
      idempotencyKey,
      classification: "runtime",
      recoverable: true,
      ...(runtimeError.details ?? {}),
    },
  ));
}
