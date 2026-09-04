# Connected local Browser tests

## Local Web preparation for the Fly check

Run `node scripts/browser-fly-local.mjs --check` to create a disposable database,
migrate and seed it, start the existing candidate Web build, verify the restricted
proxy, and tear it down. Run without `--check` to leave Web on loopback port 3000
and the restricted proxy on loopback port 3001. Requires a current Web build,
Docker, free ports, and no Web `.env` files. No inherited application credentials
or production configuration are loaded. This command never calls Fly.

After `READY`, the operator can run `ngrok http 3001 --inspect=false` and open
`<ngrok HTTPS URL>/fixture`. The public proxy exposes only the exact seeded
Environment's Gateway configuration, Browser runtime control routes (still
authorized by Web), and a bounded synthetic transfer fixture. Other routes return
404. No credentials are printed. Private generated state is stored with mode
0600 in the reported run directory; do not share it.

This is phase 1, not a Fly-ready Environment: seeded Machine identities are
explicit placeholders, no Fly provider credentials are installed, and no Browser
worker image is selected. They must be replaced with the exact isolated Fly
resources before a hosted test. The real Web Gateway configuration and missing-
authorization rejection are exercised; successful Browser invocation is not yet
claimed. The ngrok endpoint must be checked independently before Fly creation.

Run `node apps/web/tests/browser/fly-fixture-check.mjs <https-origin>` for the
credential-free real Chromium fixture check. It acknowledges ngrok's warning
with an ordinary click in its own fresh profile, verifies the receiver's upload
byte count and SHA-256 receipt, and verifies downloaded bytes. It does not prove
hosted Browser approvals or Fly behavior. This check passed through the supplied
ngrok endpoint on 2026-09-04. Missing/wrong Gateway tokens were rejected, a valid
test Gateway token returned the expected configuration, and unrelated routes
were blocked. Signed execution-ticket testing awaits separate transmission
approval. No Fly resource was created.

Ctrl-C stops the local servers and removes only the run's Docker container,
disposable volume, generated credentials, and file storage. Logs and non-secret
IDs remain for diagnosis. After an ungraceful kill, use the exact container name
in the private state file to recover cleanup; never prune Docker.

Run from the repository root with Docker running:

```sh
pnpm validate:browser
pnpm validate:browser --case grant
```

The second command runs only the remembered-domain regression. Other case names
are `browse`, `takeover`, `upload`, `transfers`, and `cleanup`. No production credentials,
logged-in browser, model calls, cloud resources, or manual approval clicks are
needed. The first build downloads dependencies and the pinned Linux Browser
executables; subsequent runs reuse build layers. Leave disk space for the image.

## What the cases prove

| Case        | Actual behavior checked                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grant`     | Open Chrome, connect the viewer, resolve the real “Allow and remember” interaction, persist the domain, adopt the Gateway revision, navigate twice in the same session without another approval, and continue receiving viewer frames.              |
| `browse`    | Inspect, click, fill and submit a form; check the fixture received the submitted value; capture a screenshot and read its stored PNG bytes.                                                                                                         |
| `takeover`  | Enter synthetic text through the viewer protocol, prove the page received it using hashes, block agent navigation during takeover, return control, resume agent navigation, and receive viewer frames again. |
| `upload` | Decline an actual prepared upload, immediately snapshot without replacing the session/generation/worker, then approve a fresh upload and verify the exact received bytes. |
| `transfers` | Prepare actual Thread-file uploads and quarantined downloads, resolve approved and declined interactions, run the real decline/release gate, verify denied transfers have no effect, and compare approved stored/received bytes exactly.            |
| `cleanup`   | Close normally and kill an accepted worker before invocation. Run reconciliation directly twice; require terminal state, confirmed removal, no worker/profile, rejected old proxy credentials and prepared calls, and cleared viewer cleanup state. |

## Real components and intentional test boundaries

### Signed Web-route qualification

The isolated local launcher now exercises real signed requests through the Next
App runtime route, its provider target validator, and actor/capability access.
It enables the Browser capabilities only in its disposable test organization.
With no Fly provider configured, these probes must reach Browser composition
and return `BROWSER_SERVICE_UNAVAILABLE`; this is authorization-path evidence,
not a successful Browser session.

The September 4 repair closes the authorization-ordering gaps:

- The Web provider target validator rejected `upload/prepare-upload`,
  `download/prepare-download`, and `download/release-download`. Its exact route
  list is repaired and three regression tests demonstrated failure before the
  repair and success afterward.
- App authorization defers approval only for those three exact capability/action
  pairs. Identity, capability access, and session ownership remain enforced.
- The Browser client keeps preparation and release on `auto`, but uses
  `confirmed` throughout transfer execution after the runtime policy gate.
  Artifact authorization is confirmed only within that active execution.
  Minimum transfer approval remains `ask`.

All six connected cases now enter the real App runtime handler with a signed
execution ticket. Approval replay also goes through the runtime policy gate.
This exposed and corrected two fixture mistakes: preparation supplied the wrong
runtime policy revision, and approval replay supplied a derived revision where
the gate expects the upstream authority revision. Product policy was unchanged.

Local qualification for the authorization-ordering repair:

- Provider adapter regression: 8 passed (3 new tests failed before the repair).
- Browser client regressions: 10 passed, including confirmed follow-up calls,
  no confirmation from a prepared approval ID, and artifact execution scope.
- Connected Browser: all 6 cases and cleanup passed through the signed Web path;
  test image `sha256:ccee64ba270f604bacb1686ebb10df66c0ba580028308efd56b3ea009a2adaf1`.
- `pnpm validate`: passed (72.0s).
- `pnpm validate:postgres`: passed (71.6s).
- `pnpm validate:chromium`: passed (254.1s, 32 browser tests).
- `pnpm validate:process`: passed (613.6s).
- Browser harness typecheck and compiled signed-Web preflight passed. The
  preflight reached all three exact preparation/release routes before the
  deliberately unconfigured provider returned `BROWSER_SERVICE_UNAVAILABLE`.
- Owned Browser test containers, networks, and listeners: none remaining. No
  Fly resources were created and no production changes were made.

The suite uses migrated PostgreSQL, Redis viewer tickets, Web Browser services,
the actual approval producer and Web decision handler, managed-file storage,
the Environment Gateway relay and egress registry, signed worker capabilities,
the real worker server, and the pinned agent-browser/Chrome executables.
Completed tool outputs are persisted with Web's durable message writer.

The selected entry point is the **signed Web App runtime handler**.
A test-only provider replaces Fly Machines with owned child processes and
translates their private hostnames to local listener ports. Runtime identity is
seeded; there is no model or durable turn-worker. After Web approval, the test
requires the runtime policy gate to permit the prepared operation before
execution. Viewer checks use the actual
WebSocket protocol and service, not a mounted React viewer.

An internal Docker network prevents public Internet access during execution.
Only two fixture hostnames resolve through the Gateway's existing DNS/dial
injection points. The fixture CA is trusted only inside disposable Chrome
profiles; certificate validation is not disabled.

This is **not** Fly provisioning, Vercel hosting, the production container
entrypoint/firewall, or full Thread UI proof. Keep the existing exact-image
smoke and isolated Fly qualification before a hosted rollout. The printed
image ID identifies this local test image, not a published production digest.

## Failure and cleanup

Each case fails on its first broken assertion; the suite still runs the other
cases and returns nonzero if any failed. Operations are not retried to hide
failures. Readiness assertions poll for an event, without fixed multi-minute
sleeps. Every run creates uniquely named containers and an internal network,
then removes only those resources and their disposable volumes. No Docker
prune, user-volume deletion, repository `.env` loading, or production mutation
occurs. Console output identifies the case and failing boundary without logging
capabilities, proxy passwords, or viewer input.

## Scope and recovered fixes

The source was recovered from the previously tested immutable image into a
durable worktree. Earlier test results are historical, not qualification of
the recovered files.

Completed downloads are discovered through fresh snapshot `pendingDownloads`.
The fixture deliberately holds a download incomplete until the test confirms
it is not offered for promotion. Approval then verifies the promoted bytes;
decline and consumption remove the exact item from discovery. The ready-before
database predicate uses an ISO timestamp with an explicit timestamp cast, and
the PostgreSQL test covers first-time promotion as well as expiry rejection.

The historical session loss after upload decline remains a diagnosis target,
not an assumed timeout defect. The `upload` case provides the focused reproduction;
operational failures are never retried by readiness polling.

## Recovery verification — 2026-09-04

The recovered source was freshly built and tested locally. Three independent
upload diagnostic sessions passed (12.9s, 12.8s, and 12.9s), including immediate
post-decline snapshots, same-session approved uploads, exact received bytes,
and cleanup. The historical intermittent session loss was **not reproduced**;
its cause remains unknown and is not claimed fixed. Temporary lifecycle
diagnostics were removed. No liveness timeout, retry, or restart behavior changed.

After removing those diagnostics, one complete connected run passed all six
cases: grant, browse, functional takeover, upload, transfers, and normal/crash
cleanup. Every case confirmed cleanup, and no test containers or network remained.
The exact local test image was
`sha256:47a1aac3cc32490398dae3a36b4a715fe0cf3274a50dd326b196ca54177cfa0f`.
This is local connected evidence only; no Fly or production qualification was run.

Additional qualification:

- `pnpm validate`: passed (69.2s); the unchanged recovered base also passed before restoration.
- `pnpm validate:postgres`: passed (66.5s), including fresh Browser promotion and expiry rejection.
- `pnpm validate:process`: passed (586.9s), including the previously reported queued-run assertion. It did not recur, so no unrelated repair was made.
- `pnpm validate:chromium`: passed (266.6s including build/setup; 32 product tests passed).
- The newly restored Router test was run explicitly: three tests passed. It is now registered with Git for subsequent gate discovery.
- The process lane skipped its opt-in live Tavily spend test and opt-in standalone CDP probe. The connected suite above independently exercised real Chrome.

Expanded takeover redaction and screenshot masking were explicitly removed from
this release's requirements. This suite tests functional takeover, not secrecy
of human-entered values in later agent observations. Runtime privacy behavior
is unchanged.

A nonzero result means Browser is not qualified for deployment, even when the
portable gate and the other workflows pass. Fix the owning Browser behavior and
rerun these same assertions; do not replace Chrome or transfer results with mocks.

Run `pnpm validate` and the applicable `validate:process`, `validate:postgres`,
and `validate:chromium` lanes alongside this explicit Docker-backed gate. Do not
report unit-test or image-smoke success as a substitute for the connected workflows.
