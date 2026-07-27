import type { ReadonlyURLSearchParams } from "next/navigation";
import { isInvitationCallbackURL } from "./invitation-shared";

const allowedCallbackSet: ReadonlySet<string> = new Set(["/", "/dashboard"]);

function isDesktopAuthorizationCallback(value: string) {
  try {
    const url = new URL(value, "https://kestrel.invalid");
    return (
      url.origin === "https://kestrel.invalid" &&
      url.pathname === "/desktop/auth/authorize" &&
      url.searchParams.get("response_type") === "code"
    );
  } catch {
    return false;
  }
}

export const getCallbackURL = (
  queryParams: ReadonlyURLSearchParams,
): string => {
  const callbackUrl = queryParams.get("callbackUrl");
  if (callbackUrl) {
    if (
      allowedCallbackSet.has(callbackUrl) ||
      isInvitationCallbackURL(callbackUrl) ||
      isDesktopAuthorizationCallback(callbackUrl)
    ) {
      return callbackUrl;
    }
    return "/dashboard";
  }
  return "/dashboard";
};
