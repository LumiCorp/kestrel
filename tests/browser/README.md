# Connected local Browser tests

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

The suite uses migrated PostgreSQL, Redis viewer tickets, Web Browser services,
the actual approval producer and Web decision handler, managed-file storage,
the Environment Gateway relay and egress registry, signed worker capabilities,
the real worker server, and the pinned agent-browser/Chrome executables.
Completed tool outputs are persisted with Web's durable message writer.

The selected entry point is the authenticated **Browser-service boundary**.
A test-only provider replaces Fly Machines with owned child processes and
translates their private hostnames to local listener ports. Runtime identity is
seeded; there is no model or durable turn-worker. After Web approval, the test
continues the prepared Browser operation directly. Viewer checks use the actual
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
