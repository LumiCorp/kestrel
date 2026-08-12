export function normalizeMobileRuntimeAnswers(
  content: Record<string, string | number | boolean | string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!content || Object.keys(content).length === 0) return;
  return Object.fromEntries(
    Object.entries(content).map(([questionId, value]) => [
      questionId,
      Array.isArray(value) ? value : [String(value)],
    ]),
  );
}
