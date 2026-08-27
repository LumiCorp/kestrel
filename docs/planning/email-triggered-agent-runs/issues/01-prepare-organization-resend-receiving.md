# Configure Organization Resend receiving in One and Desktop

## Useful outcome

An Organization Admin can prepare inbound Resend receiving from Kestrel One or Kestrel Desktop without disturbing outbound email. Both surfaces manage one hosted Organization connection. The Admin can supply a write-only Full access credential, select a verified receiving subdomain, and see the same inbound health as a separate capability.

Production delivery remains disabled until the complete email-to-agent path is ready. This issue delivers the full receiving-setup UX and provider connection behind both management surfaces; it does not accept email or create agent runs.

## What changes

- Add the Organization-scoped Receiving Connection schema and additive production migration. Store the receiving domain, credential-sufficiency evidence, inbound enabled state, health evidence, opaque route locator, and nullable provider webhook identity and encrypted signing secret for the later ingress slice. Enforce at most one active Receiving Connection per Organization under concurrent updates.
- Add an **Inbound receiving** section to the existing Kestrel One Organization Email settings page. Do not add it to the shared platform Email settings surface.
- Add the equivalent surface at Kestrel Desktop **Settings → Connections → Inbound receiving**. Show an Organization selector sourced from the signed-in Kestrel One account, auto-select a sole Organization, require a choice when there are several, and bind every read and mutation to that Organization ID. It must read and mutate the same hosted Receiving Connection rather than add a Desktop-owned connection.
- Define one redacted hosted projection and consistent status vocabulary for credential sufficiency, receiving subdomain and MX health, staged or active webhook state, inbound enabled state, last validation or test evidence, and stable failure reason. Kestrel One and Desktop must render that server truth rather than infer readiness independently.
- In both surfaces, make the Resend Full access key write-only. Show a blank replacement field after save and never return the key or signing secret. Desktop must clear the renderer field after submission and must not store receiving secrets, route locators, provider IDs, or a Receiving Connection copy in `DesktopSettings`, preferences, logs, analytics, or support bundles.
- Carry Desktop reads and mutations through explicit typed renderer/preload/main/local-core contracts using the signed-in Kestrel One account. Refresh the hosted projection after mutations; do not treat hiding or disabling controls as authorization.
- Show a signed-out Desktop state that directs the user to sign in to Kestrel One, a non-Admin read-only state with a clear role explanation, pending and validation states, actionable redacted errors, and a note that Kestrel One hosts receiving so Desktop does not need to remain open.
- Explain that inbound management requires a Resend Full access API key. A Sending access key must produce a safe, specific readiness failure without affecting outbound sending.
- Let an Organization Admin select a verified receiving subdomain and inspect its receiving capability and MX health.
- Add the provider adapter operations needed to inspect receiving domains and later create, retrieve, update, disable, and remove one `email.received` webhook. Do not register a provider webhook in this issue; the signed-ingress issue owns registration after its route and durable receipt exist.
- Prepare encrypted storage for the signing secret and preserve the existing encrypted Resend API key boundary. Public APIs and UI state must never return either secret.
- Generate an opaque, unguessable route locator independently of the Organization ID, domain, and webhook ID.
- Record inbound configuration, credential sufficiency, domain health, webhook identity, last test or health evidence, stable error code, and enabled state separately from outbound readiness.
- Keep provider delivery inactive until the route, durable receipt worker, materializer, attachment tool, and maintenance checks are all available. Intermediate deployments must not accept mail they cannot finish.
- Register the Receiving Connection migration through the current migration journal and history lock. New connections must begin disabled, and no backfill is required.
- Preserve the existing Organization Email save, outbound test, Email App synchronization, sender resource, and `email.send` behavior.

## Requirements and delivery context

Organization ownership currently lives in `apps/web/app/(workspace)/organization/email/page.tsx`, the Organization Email API routes, `apps/web/lib/email/organization-config.ts`, and `apps/web/components/settings/email-client.tsx`. Keep `requireOrganizationAdmin` as the authority. A platform administrator without Organization authority must not manage this connection.

Desktop Settings already loads the signed-in Kestrel One account through `apps/desktop/renderer/src/SettingsWorkspace.tsx`, `apps/desktop/src/contracts.ts`, `apps/desktop/src/preload.ts`, `apps/desktop/src/main.ts`, and the Local Core account client. Extend that typed boundary with the smallest receiving projection and commands. Do not send Desktop directly to Resend and do not place provider credentials in its local settings store.

Use the existing encrypted credential service rather than adding plaintext environment variables or a second general-purpose secret store. Keep inbound provider code beside the current Organization Email service, but do not turn receiving into an Email App capability. Receiving creates a run; it is not a tool used by a running agent.

Provider errors and health evidence must use stable codes and redacted identifiers. Do not log the private route locator, webhook secret, API key, or complete receiving address.

The canonical requirements are in the [Email-Triggered Agent Runs Product Brief](../../email-triggered-agent-runs-product-brief.md).

## Done when

- An Organization Admin can save a write-only key and receiving subdomain, validate Full access, and see inbound status from Kestrel One or Kestrel Desktop without changing a working outbound configuration.
- A mutation from either surface is visible from the other after refresh because both use one hosted connection; neither surface has a divergent local readiness decision.
- Signed-out Desktop gives a sign-in path, Organization selection remains explicit, non-Admin Desktop is read-only, and server authorization rejects unauthorized and cross-Organization reads or writes regardless of UI state.
- Desktop retains no receiving credential or configuration copy after save, and closing or disconnecting Desktop does not change the hosted Receiving Connection or its readiness.
- A Sending-only key fails inbound readiness while outbound sending remains usable.
- Provider adapter tests prove one Organization-owned webhook can later be managed, while this issue registers no live webhook and discloses no signing secret.
- Another Organization, ordinary member, Project editor, or unauthenticated caller cannot read or change receiving configuration.
- Disabling inbound state does not disable outbound email or remove the existing `email.send` App resource.
- Database and service concurrency tests prove that one Organization cannot enable two Receiving Connections or own two active inbound webhooks.
- Migration, provider, hosted API, Kestrel One UI, Desktop UI and bridge, authorization, encryption, redaction, support-bundle, and outbound regression tests pass.
- `pnpm validate`, `pnpm validate:postgres`, and `pnpm validate:process` pass.
