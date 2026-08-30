# Prove hosted passkey takeover

## Failed behavior

The hosted viewer currently forwards screenshots plus pointer and keyboard
events. That is sufficient for passwords and typed one-time codes, but it does
not forward a passkey assertion from the person's local authenticator to remote
Chromium. The Issue 06 passkey promise is therefore unimplemented and untested.

## Affected flow

Passkeys are scoped to the target relying-party origin and cannot be recreated
by typing, copied from the web client, or synthesized with a DevTools virtual
authenticator. Chromium's remote-desktop Web Authentication proxy is the owning
browser surface for a genuine remote authenticator ceremony; any implementation
must preserve relying-party origin checks and user verification.

## Repair requirements

- Use Chromium's supported remote-desktop Web Authentication proxy contract for
  genuine hosted passkey assertions, or narrow the product promise explicitly
  before implementation. Do not use virtual test credentials as production
  passkeys and do not export private key material.
- Bind each ceremony to the active viewer actor, Thread, Browser Session,
  generation, exact worker connection, target RP ID, challenge, and expiry.
- Require a fresh visible user gesture and local platform-authenticator consent.
  The model, worker, and a second viewer cannot approve the ceremony.
- Keep challenge/response material transient and out of model IO, prepared
  effects, transcripts, events, logs, traces, metrics, audits, analytics, crash
  reports, and errors. Persist only bounded metadata that a ceremony occurred.
- Cancel the ceremony on return, close, disconnect, expiry, authorization loss,
  generation change, or worker loss. Never fall back to a virtual authenticator,
  password capture, or an unrelated local origin.
- Add a real hosted Chromium regression using a platform authenticator or an
  explicitly approved cross-device passkey flow. A CDP virtual-authenticator
  test alone is not acceptance proof.

## Done when

- The originating viewer completes a real passkey ceremony in the existing
  hosted Browser Session without exposing credential secrets to Kestrel.
- Wrong actor, RP ID, challenge, Session, generation, connection, replay, and
  expired ceremony attempts fail closed.
- Cancellation and sentinel scans prove no retained ceremony authority or
  secret-bearing durable/diagnostic data.
- Required hosted Chromium and live combined proofs pass.

## Depends on

[Carry full-size hosted viewer frames](06d-carry-full-size-hosted-viewer-frames.md).
