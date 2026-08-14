import { CronExpressionParser } from "cron-parser";

export class ProjectPromptScheduleCronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectPromptScheduleCronError";
  }
}

function normalizeFiveFieldCron(cronExpression: string) {
  const normalized = cronExpression.trim().replace(/\s+/gu, " ");
  if (normalized.split(" ").length !== 5) {
    throw new ProjectPromptScheduleCronError(
      "Enter a standard five-field cron expression.",
    );
  }
  return normalized;
}

function normalizeTimeZone(timeZone: string) {
  const normalized = timeZone.trim();
  if (!normalized) {
    throw new ProjectPromptScheduleCronError("Choose a timezone.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format();
  } catch {
    throw new ProjectPromptScheduleCronError(
      "Choose a valid IANA timezone.",
    );
  }
  return normalized;
}

export function validateProjectPromptSchedule(input: {
  cronExpression: string;
  timeZone: string;
  currentDate?: Date;
}) {
  const cronExpression = normalizeFiveFieldCron(input.cronExpression);
  const timeZone = normalizeTimeZone(input.timeZone);
  try {
    CronExpressionParser.parse(cronExpression, {
      currentDate: input.currentDate,
      tz: timeZone,
    });
  } catch (error) {
    if (error instanceof ProjectPromptScheduleCronError) throw error;
    throw new ProjectPromptScheduleCronError(
      "Enter a valid five-field cron expression.",
    );
  }
  return { cronExpression, timeZone };
}

export function nextProjectPromptScheduleOccurrence(input: {
  cronExpression: string;
  timeZone: string;
  after?: Date;
}) {
  const validated = validateProjectPromptSchedule({
    cronExpression: input.cronExpression,
    timeZone: input.timeZone,
    currentDate: input.after,
  });
  return CronExpressionParser.parse(validated.cronExpression, {
    currentDate: input.after,
    tz: validated.timeZone,
  })
    .next()
    .toDate();
}

export function latestDueProjectPromptScheduleOccurrence(input: {
  cronExpression: string;
  timeZone: string;
  firstDueAt: Date;
  now: Date;
}) {
  if (input.firstDueAt.getTime() > input.now.getTime()) return null;
  const validated = validateProjectPromptSchedule(input);
  const latest = CronExpressionParser.parse(validated.cronExpression, {
    currentDate: new Date(input.now.getTime() + 1000),
    tz: validated.timeZone,
  })
    .prev()
    .toDate();
  const scheduledFor =
    latest.getTime() < input.firstDueAt.getTime() ? input.firstDueAt : latest;
  const nextRunAt = CronExpressionParser.parse(validated.cronExpression, {
    currentDate: new Date(scheduledFor.getTime() + 1000),
    tz: validated.timeZone,
  })
    .next()
    .toDate();
  return {
    scheduledFor,
    nextRunAt,
    catchUpFrom:
      scheduledFor.getTime() > input.firstDueAt.getTime()
        ? input.firstDueAt
        : null,
  };
}
