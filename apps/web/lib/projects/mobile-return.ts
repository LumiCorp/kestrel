const MOBILE_PROJECT_RETURN = "kestrelone://new-thread";

export function resolveMobileProjectReturn(input: {
  source?: string;
  returnTo?: string;
}) {
  return input.source === "mobile" && input.returnTo === MOBILE_PROJECT_RETURN
    ? MOBILE_PROJECT_RETURN
    : null;
}

export function buildMobileProjectCallback(
  returnTo: string,
  projectId: string
) {
  if (returnTo !== MOBILE_PROJECT_RETURN) {
    throw new Error("Unsupported mobile Project return URL.");
  }
  const callback = new URL(returnTo);
  callback.searchParams.set("projectId", projectId);
  return callback.toString();
}
