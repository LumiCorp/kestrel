const CALENDAR_OPERATIONS = new Map<string, string>([
  ["google_workspace.list_events", "events.list"],
  ["kestrel_one.google_calendar_list_events", "events.list"],
  ["google_workspace.create_event", "events.create"],
  ["kestrel_one.google_calendar_create_event", "events.create"],
  ["google_workspace.update_event", "events.update"],
  ["kestrel_one.google_calendar_update_event", "events.update"],
  ["google_workspace.delete_event", "events.delete"],
  ["kestrel_one.google_calendar_delete_event", "events.delete"],
  ["kestrel_one.google_calendar_list_availability_subjects", "availability.subjects"],
  ["kestrel_one.google_calendar_check_availability", "availability.query"],
]);

/** Calendar event content stays model-visible only for the active turn. */
export function projectGoogleCalendarAuditInput(
  toolName: string,
  toolInput: unknown,
): Record<string, unknown> | undefined {
  const operation = CALENDAR_OPERATIONS.get(toolName);
  if (operation === undefined) return;
  const input = asRecord(toolInput);
  if (operation === "events.list") {
    return compact({
      operation,
      timeMin: asString(input?.timeMin),
      timeMax: asString(input?.timeMax),
      maxResults: asSafeInteger(input?.maxResults),
      cursorState: asString(input?.cursor) === undefined ? "initial" : "continued",
    });
  }
  if (operation === "events.create") {
    return compact({
      operation,
      attendeeCount: attendeeCount(asRecord(input?.event)?.attendees),
      notifyAttendees: input?.notifyAttendees === true,
    });
  }
  if (operation === "events.update") {
    return compact({
      operation,
      providerEventId: asString(input?.eventId),
      attendeeCount: attendeeCount(asRecord(input?.patch)?.attendees),
      notifyAttendees: input?.notifyAttendees === true,
    });
  }
  if (operation === "events.delete") {
    return compact({
      operation,
      providerEventId: asString(input?.eventId),
      notifyAttendees: input?.notifyAttendees === true,
    });
  }
  if (operation === "availability.query") {
    return compact({
      operation,
      subjectCount: Array.isArray(input?.subjectIds) ? input.subjectIds.length : 0,
      timeMin: asString(input?.timeMin),
      timeMax: asString(input?.timeMax),
    });
  }
  return { operation };
}

/** Durable Calendar evidence carries identities and page state, never event content. */
export function projectGoogleCalendarAuditOutput(
  toolName: string,
  toolInput: unknown,
  toolOutput: unknown,
): Record<string, unknown> | undefined {
  const expectedOperation = CALENDAR_OPERATIONS.get(toolName);
  if (expectedOperation === undefined) return;
  const candidateInput = asRecord(toolInput);
  const input = candidateInput?.operation === expectedOperation
    ? candidateInput
    : projectGoogleCalendarAuditInput(toolName, toolInput);
  if (input === undefined) return;
  const wrapper = asRecord(toolOutput) ?? {};
  const output = asRecord(wrapper.result) ?? wrapper;
  const operation = input.operation;
  if (operation === "events.list") {
    const events = Array.isArray(output.events) ? output.events : [];
    return {
      operation,
      resultCount: events.length,
      providerEventIds: providerIds(events),
      cursorState: input.cursorState,
      nextPage: typeof output.nextCursor === "string",
    };
  }
  if (operation === "events.create" || operation === "events.update") {
    const failureCode = asString(output.errorCode);
    return compact({
      operation,
      providerEventId: asString(output.id) ?? asString(input.providerEventId),
      updatedAt: asString(output.updatedAt),
      attendeeCount: Array.isArray(output.attendees)
        ? output.attendees.length
        : input.attendeeCount,
      notifyAttendees: input.notifyAttendees,
      mutationOutcome: failureCode === "GOOGLE_CALENDAR_OUTCOME_UNKNOWN"
        ? "outcome_unknown"
        : output.status === "FAILED" ? "rejected" : "confirmed",
      providerErrorCode: failureCode,
    });
  }
  if (operation === "events.delete") {
    const failureCode = asString(output.errorCode);
    return compact({
      operation,
      providerEventId: input.providerEventId,
      deleted: output.deleted === true,
      notifyAttendees: input.notifyAttendees,
      mutationOutcome: failureCode === "GOOGLE_CALENDAR_OUTCOME_UNKNOWN"
        ? "outcome_unknown"
        : output.status === "FAILED" ? "rejected" : "confirmed",
      providerErrorCode: failureCode,
    });
  }
  if (operation === "availability.query") {
    const subjects = Array.isArray(output.subjects) ? output.subjects : [];
    return {
      operation,
      subjectCount: subjects.length,
    };
  }
  return {
    operation,
    subjectCount: Array.isArray(output.subjects) ? output.subjects.length : 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asSafeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function attendeeCount(value: unknown) {
  return Array.isArray(value) ? value.length : undefined;
}

function providerIds(values: unknown[]) {
  return values.flatMap((value) => {
    const id = asString(asRecord(value)?.id);
    return id === undefined ? [] : [id];
  });
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, candidate]) => candidate !== undefined),
  );
}
