import type { ReadonlyURLSearchParams } from "next/navigation";
import { isInvitationCallbackURL } from "./invitation-shared";

const allowedCallbackSet: ReadonlySet<string> = new Set(["/", "/dashboard"]);

export const getCallbackURL = (
  queryParams: ReadonlyURLSearchParams,
): string => {
  const callbackUrl = queryParams.get("callbackUrl");
  if (callbackUrl) {
    if (
      allowedCallbackSet.has(callbackUrl) ||
      isInvitationCallbackURL(callbackUrl)
    ) {
      return callbackUrl;
    }
    return "/dashboard";
  }
  return "/dashboard";
};
