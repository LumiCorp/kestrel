# Revalidate current policy and approval authority

## Failed behavior

Lease currentness does not compare the bound policy revision with an authoritative current policy decision. Approval validation can accept absent, consumed, or expired authority.

## Affected work

GitHub issue #414, commit `b974371d8`, and `validateSandboxCapabilityLeaseCurrent` in `KestrelChatRuntime`.

## Repair requirements

Resolve the authoritative policy and approval decision for the exact call. Recheck its revision, disposition, input binding, status, and expiry before issuance, provider invocation, result delivery, and recovery.

## Done when

- Stale or replaced policy fails closed before provider contact.
- Only exact active and unexpired approval authority is accepted when required.
- Tests change each authority at every lifecycle boundary.

## Depends on

None.

