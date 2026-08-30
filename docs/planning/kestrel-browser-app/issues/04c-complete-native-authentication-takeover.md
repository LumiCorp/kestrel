# Complete native authentication takeover

## Failed behavior

The Issue 04 viewer renders page screenshots and sends page-target CDP pointer and keyboard input. That path cannot display or operate Chrome or macOS native authentication UI, so the promised passkey and native SSO chooser flow is not implemented. Fake engine-adapter tests cannot prove this outcome.

## Affected flow

The packaged Desktop Browser runtime and authorized main-frame viewer own human takeover. The repair must add a trusted native authentication handoff without exposing a raw CDP, debugging, engine, or proxy endpoint to the renderer and without placing authentication material in model-visible or durable surfaces.

## Repair requirements

- Detect and present native Chrome/macOS authentication UI through a packaged, viewer-authorized Desktop path.
- Bind the native handoff to the exact current renderer principal, Thread, Project, Browser Session, generation, and active human-control lease.
- Do not expose general browser chrome, CDP, engine, proxy, or debugging authority to renderer JavaScript.
- Close or revoke the native handoff on lease expiry, viewer disconnect, authority loss, Session close, generation change, or engine loss.
- Keep passkey, SSO, and MFA values and chooser contents out of model IO, transcripts, events, logs, metrics, crash metadata, and returned failures.

## Done when

- A signed packaged Desktop canary completes a real native passkey or equivalent platform-authenticator flow in the existing Browser Session.
- Wrong renderer, Thread, Project, account, Session, generation, and expired-lease attempts fail closed.
- Human control persists through native authentication and only explicit viewer return resumes the agent.
- Sentinel and durable-surface checks prove native authentication data is not recorded.
- Focused packaged Chromium, Desktop process, authority-loss, and secret-redaction coverage passes.

## Depends on

None.
