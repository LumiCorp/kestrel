# `@kestrel-agents/conversation`

Framework-neutral conversation projection, live presentation accumulation, queue and composer policy for Kestrel clients.

The package contains no React, Electron, Next.js, or AI SDK dependency. Products adapt their transport and register host renderers for the typed presentation parts.

The projector uses durable identities to establish turn ownership. After that
step, the host message array supplies the durable transcript preference. The
projector preserves that source order unless a turn input or linked interaction
proves a causal message order. Roles, timestamps, text, and UUIDs do not infer
ownership or chronology.
