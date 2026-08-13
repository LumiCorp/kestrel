export interface ValidationMeasurement {
  kind: string;
  name: string;
  phase?: string;
  durationMs?: number;
}

export interface ValidationReport {
  status?: string;
  durationMs?: number;
  telemetry?: { managedProcessLaunches?: number };
  measurements?: ValidationMeasurement[];
  slowestTasks?: ValidationMeasurement[];
  error?: unknown;
}

export function renderValidationSummary(report: ValidationReport): string;
