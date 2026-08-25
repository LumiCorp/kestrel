export const MOBILE_INTERACTION_LIFECYCLE_HEADER =
  "x-kestrel-mobile-interaction-lifecycle";
export const MOBILE_INTERACTION_LIFECYCLE_VERSION = "1";

export function mobileInteractionLifecycleRequested(request: Request) {
  return request.headers.get(MOBILE_INTERACTION_LIFECYCLE_HEADER)?.trim() ===
    MOBILE_INTERACTION_LIFECYCLE_VERSION;
}
