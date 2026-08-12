const DATETIME_LOCAL_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function isoInstantToLocalDateTimeInput(value: string | null) {
  if (!value) {
    return "";
  }

  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new Error("Expiration must be a valid instant.");
  }

  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(
    instant.getDate(),
  )}T${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
}

export function localDateTimeInputToIsoInstant(value: string) {
  if (!value) {
    return null;
  }

  const match = DATETIME_LOCAL_PATTERN.exec(value);
  if (!match) {
    throw new Error("Expiration must be a valid local date and time.");
  }

  const [, year, month, day, hour, minute] = match;
  const instant = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  if (
    instant.getFullYear() !== Number(year) ||
    instant.getMonth() !== Number(month) - 1 ||
    instant.getDate() !== Number(day) ||
    instant.getHours() !== Number(hour) ||
    instant.getMinutes() !== Number(minute)
  ) {
    throw new Error("Expiration must be a valid local date and time.");
  }

  return instant.toISOString();
}
