# Kestrel public docs editorial model

The public docs are written for people trying Kestrel, adopting it in a product, or operating an installed system. Start from the reader's goal and the evidence they can see. Define Kestrel-specific terms on first use, prefer concrete outcomes over implementation history, and keep repository contributor setup out of consumer onboarding.

## Content archetypes

- **Gateway:** helps a reader choose a product, task, or next step without teaching every concept.
- **Product journey:** follows a Desktop or Kestrel One outcome through the product UI, with real screenshots and a clear success state.
- **Build tutorial:** produces a working integration in a tested sequence and keeps examples runnable on the documented Beta version.
- **Task recipe:** solves one bounded job for a reader who already has the prerequisites.
- **Explainer:** builds a mental model and answers why a boundary or behavior exists.
- **Operational playbook:** starts from an observable state, assigns ownership, takes a safe action, and verifies recovery.
- **Troubleshooting:** starts from a symptom and narrows to the first unhealthy owner without destructive reset advice.
- **Reference:** states exact fields, names, commands, defaults, compatibility, and constraints without a tutorial narrative.
- **Migration:** names what changed, who is affected, the required action, and how to verify the new behavior.

## Voice and evidence

- Address the reader as “you” when describing an action or choice.
- Explain the user benefit before internal architecture.
- Keep Desktop, Kestrel One, Build, and Operate stories distinct; do not force them into the same heading template.
- Label Beta behavior and feature-gated capabilities explicitly.
- Separate human-facing `assistantText`, structured finalized data, runtime status, and waiting or cancellation outcomes.
- Use product screenshots only when the visible state supports the surrounding claim. Every screenshot needs descriptive alt text and a caption that adds meaning.
- Pin install examples to the release metadata version and validate contract claims against exported code.

## Public boundary

Only pages registered by the public content registry may enter routes, navigation, search, related links, or static generation. Archives, maintainer-only material, contributor setup, private analysis, and stale release claims stay outside that boundary.
