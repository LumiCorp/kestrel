# Workspace File Sharing Mobile Device Validation Operator Runbook

## Outcome

Validate the Kestrel One Mobile Download card on physical iOS and Android devices. The exact mobile revision must pass `pnpm verify` before either device result is accepted.

## Authority Boundary

- Agent may: prepare and verify local code, inspect connected-device state, rerun automated checks, and assess nonsensitive evidence.
- Human must: authorize any dependency-baseline change, provide physical devices and device tooling, sign in to Kestrel One, operate each device, and assess native download behavior.
- Separately authorized external effects: a scoped Expo SDK patch-alignment change, native development builds, authenticated test access, opening an expiring bearer link, and downloading then deleting test files. This runbook does not authorize those effects.

## Current State

Verified on August 24, 2026:

- Mobile implementation commit: `b04673d46f35e7bef9e03c78b7e58b4e9f3455cb`.
- Hosted file-sharing Issue 01 and repair Issues 03 through 10 are Done.
- Mobile API generation, boundary, parity, lint, typecheck, production audit, 19 Jest suites, and 175 tests passed.
- `pnpm verify` stops at Expo Doctor because eight installed SDK packages are one patch behind its current expected versions. The file-sharing checks pass before that stop.
- `xcrun xctrace list devices` reported `No devices available for the recording`.
- `adb` was not installed on the validation machine.

Recheck every item after an interruption. Do not rely on this snapshot as current evidence.

## Prerequisites

- [ ] Check out mobile commit `b04673d46f35e7bef9e03c78b7e58b4e9f3455cb`, or a reviewed descendant containing only approved follow-up changes.
- [ ] Obtain explicit approval before changing Expo dependency versions or the lockfile.
- [ ] Make `CI=true pnpm verify` pass on the exact device-build commit.
- [ ] Provide one supported physical iOS device with a native development or release build. Expo Go is not accepted.
- [ ] Provide one supported physical Android device with a native development or release build. Expo Go is not accepted.
- [ ] Provide authorized Kestrel One test access and a test Thread containing an active `file-share` artifact.
- [ ] Prepare a known test payload whose filename, byte count, file count, and SHA-256 digest are recorded without recording its bearer URL.
- [ ] Ensure the active share can be closed after testing.

## Sensitive Inputs

List names and authorized destinations only. Never record values.

| Input name | Obtained from | Entered into | Persisted |
| --- | --- | --- | --- |
| Kestrel One test account session | Authorized Kestrel One sign-in | Native Kestrel One Mobile app | App-managed encrypted session |
| Active preview bearer URL | Hosted test Thread | Native OS browser or download handler through the Download action | Existing encrypted message cache and OS download history |
| Apple development signing identity | Authorized Apple developer account | Xcode or approved build service | Tool-managed |
| Android development signing identity | Authorized Android build setup | Android build tooling | Tool-managed |

Do not paste the bearer URL, session data, or signing material into the runbook, terminal log, screenshots, issue, or chat.

## Stages

### 1. Restore a green automated baseline

- Preconditions: the mobile worktree is clean at the target commit; dependency changes have separate explicit approval.
- Actor: human authorizes dependency scope; agent or human applies and verifies the approved change.
- Action: align only the Expo SDK patch versions required by Expo Doctor, regenerate the lockfile, and run `CI=true pnpm verify`.
- Confirmation gate: stop before editing `package.json` or `pnpm-lock.yaml` until the exact dependency list is approved.
- Expected result: every `pnpm verify` stage passes on the exact commit intended for devices.
- Evidence: final commit SHA, dependency-only diff, complete green `pnpm verify` result, and Expo Doctor result. Do not retain registry credentials.
- Stop condition: any major or minor upgrade, native configuration change, failed audit, new warning, or unrelated source change is required.
- Recovery or rollback: restore the reviewed mobile commit in a separate clean worktree and reassess the dependency plan. Do not discard uncommitted work.
- Resume checkpoint: recheck the commit SHA, clean worktree, dependency diff, and complete verify result.

### 2. Validate the physical iOS journey

- Preconditions: Stage 1 passed; a supported physical iOS device is connected; the exact native build is installed; the active share and expected payload evidence exist.
- Actor: human operator.
- Action: open the test Thread. Confirm the Download card shows the exact filename, readable size, file count, expiry, and anonymous-link warning. Activate the accessible Download action. Confirm native handoff downloads the expected file. Close the share, refresh the Thread, and confirm the expired or closed link is not actionable.
- Confirmation gate: confirm the Thread and payload contain no customer or production data before activating Download.
- Expected result: the active link downloads the exact known payload; the closed or expired link remains visible without an actionable Download control; the app does not expose an internal error.
- Evidence: device model, iOS version, build SHA, UTC test time, redacted card screenshot, accessibility-control result, downloaded filename, byte count, file count, and SHA-256 digest. Do not capture the bearer URL.
- Stop condition: the device is a simulator, the build uses Expo Go, metadata differs, the action opens an unsafe or different URL, the app crashes, or the bearer URL appears in logs or screenshots.
- Recovery or rollback: close the share, delete the downloaded test file, remove any unsafe screenshot or log, and stop testing until the cause is reviewed.
- Resume checkpoint: recheck device identity, build SHA, active-share state, and expected payload digest.

### 3. Validate the physical Android journey

- Preconditions: Stage 1 passed; a supported physical Android device and platform tools are available; the exact native build is installed; the active share and expected payload evidence exist.
- Actor: human operator.
- Action: repeat the card, accessibility, native download, payload-integrity, close, and expired-link checks from Stage 2 on Android.
- Confirmation gate: confirm the Thread and payload contain no customer or production data before activating Download.
- Expected result: Android downloads the exact known payload through the safe HTTPS action, and a closed or expired link is not actionable.
- Evidence: device model, Android version, build SHA, UTC test time, redacted card screenshot, accessibility-control result, downloaded filename, byte count, file count, and SHA-256 digest. Do not capture the bearer URL.
- Stop condition: the device is an emulator, the build uses Expo Go, metadata differs, the action opens an unsafe or different URL, the app crashes, or the bearer URL appears in logs or screenshots.
- Recovery or rollback: close the share, delete the downloaded test file, remove any unsafe screenshot or log, and stop testing until the cause is reviewed.
- Resume checkpoint: recheck device identity, build SHA, active-share state, and expected payload digest.

### 4. Return evidence to Goal Mode

- Preconditions: Stages 1 through 3 passed and all temporary shares are closed.
- Actor: human supplies nonsensitive evidence; agent rechecks the repository and evidence.
- Action: provide the green verify result and both physical-device evidence records to the owning workflow.
- Confirmation gate: confirm that no bearer URL, session data, signing material, customer data, or downloaded payload is attached.
- Expected result: the owning issue can move from Blocked to Implemented and enter independent Review Work.
- Evidence: exact commit SHA, green verify result, iOS record, Android record, and confirmation that test shares and downloaded files were removed.
- Stop condition: evidence is incomplete, refers to different commits, includes sensitive values, or cannot distinguish physical devices from simulators or emulators.
- Recovery or rollback: remove sensitive evidence, close remaining shares, delete test downloads, and repeat only the incomplete stage.
- Resume checkpoint: recheck current commit, worktree state, verification result, device records, and share closure.

## Completion Criteria

- [ ] `CI=true pnpm verify` passes on the exact device-build commit.
- [ ] A physical iOS device passes the active, closed, and expired Download-card journey.
- [ ] A physical Android device passes the active, closed, and expired Download-card journey.
- [ ] Both downloaded files match the expected filename, byte count, file count, and SHA-256 digest.
- [ ] Evidence contains no bearer URL or other sensitive value.
- [ ] Test shares are closed and downloaded test files are removed.

## Owning Workflow Resume Condition

Resume Issue 02 only after receiving a current green `CI=true pnpm verify` result and complete physical iOS and Android evidence for the same reviewed commit. Goal Mode must recheck the commit, clean worktree, device records, payload digests, safe-link outcomes, and share closure before moving the issue to Implemented or Review Work.
