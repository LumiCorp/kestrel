# Define the hosted passkey boundary

## Settled product boundary

The hosted viewer forwards screenshots plus pointer and keyboard events. That
supports passwords, typed one-time codes, and page-rendered SSO/MFA, but it does
not forward a passkey assertion from the person's local authenticator to remote
Chromium. Hosted v1 therefore makes no real-passkey promise. Real platform
passkeys remain a signed Desktop v1 capability and may be added later only
through a privileged hosted client that owns the local ceremony.

## Affected flow

Passkeys are scoped to the target relying-party origin and cannot be recreated
by typing, copied from the web client, or synthesized with a DevTools virtual
authenticator. Chromium's remote-desktop Web Authentication proxy is the owning
browser surface for a genuine remote authenticator ceremony; any implementation
must preserve relying-party origin checks and user verification.

## Boundary requirements

- Remove passkeys from the hosted v1 useful outcome, acceptance evidence, and
  user-facing capability claims while preserving passwords, typed one-time
  codes, and page-rendered SSO/MFA.
- Do not add a CDP virtual authenticator, export credential private material, or
  describe a synthetic assertion as a user passkey.
- Keep the future contract explicit: any hosted passkey implementation needs a
  privileged local client, relying-party origin preservation, local user
  verification and consent, exact ceremony binding, cancellation, and
  secret-safe transient transport.
- Preserve Issue 04/04c as the real signed Desktop platform-authenticator proof.

## Done when

- The Product Brief and Issue 06 promise only password, one-time-code, and
  page-rendered SSO/MFA takeover for hosted v1.
- No hosted virtual or local-platform-passkey proxy is introduced.
- Issue 04/04c retain the signed Desktop passkey acceptance proof.

## Decision evidence

The product owner approved this boundary on 2026-08-31. The Product Brief and
Issue 06 now state it directly; no runtime implementation is required for this
policy-only closure.

## Depends on

[Carry full-size hosted viewer frames](06d-carry-full-size-hosted-viewer-frames.md).
