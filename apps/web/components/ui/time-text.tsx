"use client";

import { formatDistanceToNow } from "date-fns";
import { useEffect, useState } from "react";

export type TimeTextMode = "relative" | "datetime" | "date" | "time";

type TimeValue = Date | number | string | null | undefined;

type FormatTimeOptions = {
  empty?: string;
  mode?: TimeTextMode;
};

const STABLE_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const STABLE_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

const STABLE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeStyle: "medium",
  timeZone: "UTC",
});

function parseTimeValue(value: TimeValue) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

export function formatStableTime(
  value: TimeValue,
  options: FormatTimeOptions = {}
) {
  const { empty = "Never", mode = "datetime" } = options;
  const date = parseTimeValue(value);

  if (!date) {
    return empty;
  }

  if (mode === "relative") {
    return `${STABLE_DATE_TIME_FORMATTER.format(date)} UTC`;
  }

  if (mode === "date") {
    return STABLE_DATE_FORMATTER.format(date);
  }

  if (mode === "time") {
    return `${STABLE_TIME_FORMATTER.format(date)} UTC`;
  }

  return `${STABLE_DATE_TIME_FORMATTER.format(date)} UTC`;
}

function formatHydratedTime(value: TimeValue, options: FormatTimeOptions = {}) {
  const { empty = "Never", mode = "datetime" } = options;
  const date = parseTimeValue(value);

  if (!date) {
    return empty;
  }

  if (mode === "relative") {
    return formatDistanceToNow(date, { addSuffix: true });
  }

  if (mode === "date") {
    return date.toLocaleDateString();
  }

  if (mode === "time") {
    return date.toLocaleTimeString();
  }

  return date.toLocaleString();
}

export function TimeText({
  empty = "Never",
  mode = "datetime",
  value,
}: {
  empty?: string;
  mode?: TimeTextMode;
  value: TimeValue;
}) {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  return hydrated
    ? formatHydratedTime(value, { empty, mode })
    : formatStableTime(value, { empty, mode });
}
