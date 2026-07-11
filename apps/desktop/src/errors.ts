export interface DesktopError extends Error {
  code: string;
  details?: string | undefined;
}

export function createDesktopError(input: {
  code: string;
  message: string;
  details?: string | undefined;
}): DesktopError {
  const error = new Error(input.message) as DesktopError;
  error.name = "DesktopError";
  error.code = input.code;
  if (input.details !== undefined) {
    error.details = input.details;
  }
  return error;
}
