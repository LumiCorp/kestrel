export interface ShellExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  execMs: number;
}
