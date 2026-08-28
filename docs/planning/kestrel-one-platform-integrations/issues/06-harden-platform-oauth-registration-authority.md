# Harden Platform OAuth registration authority

## Useful outcome

Platform OAuth registration changes are conflict-safe, auditable as part of the same durable commit, provider-valid, and still derive their offered packs and scopes from the shared operation descriptors. A stale administrator cannot silently overwrite a newer registration, and Kestrel One cannot claim a successful change without its required redacted administrative evidence.

## What changes

Repair the implementation delivered in issue 01 before any hosted authorization broker consumes it. Add revision-aware conditional writes and expose a safe conflict result so the Platform UI reloads rather than overwriting a newer save. Persist the registration mutation and its redacted `admin_event_logs` entry in one database transaction; a failure must roll back both and return a safe error. Reject Google tenant or issuer input, and apply provider-specific validation to the Microsoft tenant setting.

Replace the duplicated hard-coded pack/scope derivation with derivation from the canonical Google Workspace and Microsoft 365 operation descriptors. Keep the explicit release allowlist: Google Gmail and Calendar, Microsoft Outlook and Teams. Add persistence-backed tests covering encrypted secret creation and rotation, every revision-changing field, conflict behavior, audit atomicity, provider validation, descriptor-derived scopes, Outlook support, and SharePoint exclusion.

## Requirements and delivery context

- This repairs issue 01; no personal authorization flow, provider callback, Better Auth behavior, or Desktop path may change.
- The Platform registration itself is the concurrency authority. A caller must present the revision it loaded; stale save attempts must be rejected, never last-write-wins.
- Audit evidence must remain redacted and be durable with the configuration mutation. Do not fall back to an asynchronous best-effort log.
- Capability names and scopes must be derived from the operation descriptor authority in `src/apps/googleWorkspace.ts` and `src/apps/microsoft365.ts`; no second manual pack-to-scope table may become authoritative.
- Google must not persist a tenant/issuer setting. Microsoft validation must accept only the documented tenant selectors needed by Kestrel One; do not invent heuristic parsing.
- Continue to keep provider-specific environment values and `app_credentials` out of this authority.

## Done when

- A stale revision produces a safe conflict response and cannot overwrite a newer registration.
- Each successful registration mutation and its redacted audit event commit together; either both persist or neither does.
- Google rejects tenant/issuer input and Microsoft accepts only the documented supported setting values.
- Provider packs and scopes come from the shared operation descriptors while retaining the Gmail, Calendar, and Teams-only release boundary.
- Postgres-backed tests prove encrypted secret storage/rotation, all revision increments, conflicts, atomic audit behavior, redaction, and provider/scope validation.

## Depends on

- [01 — Add Platform-owned Google and Microsoft registration management](01-add-platform-oauth-registration-management.md)
