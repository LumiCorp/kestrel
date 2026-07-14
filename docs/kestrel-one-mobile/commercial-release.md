---
id: kestrel-one-mobile-commercial-release
domain: product
status: in-progress
owner: kestrel-one
last_verified_at: 2026-07-13
depends_on:
  - SECURITY.md
  - apps/web/openapi/mobile-v1.json
---

# Kestrel One Mobile commercial release record

Kestrel One Mobile is a proprietary, login-only companion to the paid hosted Kestrel One service. The mobile client belongs in a private LumiCorp repository and must not add signup, purchasing, billing, administration, Project mutation, model or agent configuration, uploads, artifact editing, or runner-management surfaces.

## Reserved product coordinates

- Product name: Kestrel One
- Apple bundle identifier: `com.lumicorp.kestrelone`
- Android application ID: `com.lumicorp.kestrelone`
- Native URL scheme: `kestrelone://`
- Expo project slug: `kestrel-one`
- API base path: `/api/mobile/v1`
- Minimum launch targets: iOS 16.4 and Android 10 (API 29)
- Initial language: English, with all client strings localization-ready

These values are the canonical engineering coordinates. They are not proof of an Apple, Google, Expo, domain, or trademark reservation. The release owner must record the account, reservation date, legal owner, renewal contact, and evidence link for each external registration in the private mobile repository.

## External reservations and commercial evidence

- Create the private LumiCorp source repository and apply branch protection, secret scanning, dependency updates, and least-privilege CI credentials.
- Reserve the bundle identifier and application record in App Store Connect under LumiCorp.
- Reserve the package name and application record in Google Play Console under LumiCorp.
- Create the Expo/EAS project under the LumiCorp organization and bind the production project ID without changing the identifiers above.
- Complete a trademark and marketplace-conflict review for “Kestrel One” before public marketing or store submission.
- Publish HTTPS privacy, terms, support, and hosted account-deletion URLs owned by LumiCorp; link them from both store records and the in-app Account sheet.
- Record encryption/export-compliance answers, data-safety disclosures, age rating, content rights, support contact, and incident contact.

## Release gates

- The versioned mobile API passes authorization, organization-isolation, idempotency, queue-concurrency, context-revision, resumable-event, cancellation, and interaction tests.
- The dedicated turn worker is deployed separately from Next.js and proves that backgrounding, network loss, and client termination do not cancel or duplicate a response.
- iOS and Android pass the same scripted acceptance suite on physical phones and tablets, including rotation, dynamic text, screen reader, keyboard, pointer, reconnect, push deep link, and offline draft cases.
- Cached Threads and drafts are encrypted at rest; drafts are never transmitted without an explicit send action.
- Push payloads contain identifiers and generic state only, never transcript text, prompts, answers, credentials, or Project content.
- Diagnostics exclude prompts, responses, access tokens, push tokens, email addresses, Project names, and session replay.
- Invited iOS and Android betas complete before paired public store submission; material parity failures block both platforms.
