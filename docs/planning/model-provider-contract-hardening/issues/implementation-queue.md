# Model Provider Contract Hardening Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

- [Correct OpenAI Chat and Responses codecs](03-correct-openai-codecs.md)
- [Make OpenRouter codecs and routing contract-safe](04-correct-openrouter-codecs-and-routing.md)
- [Use native Anthropic Messages contracts](05-correct-anthropic-codec.md)
- [Bind runtime routes to exact model evidence](07-bind-exact-runtime-routes.md)

## Blocked

- [Qualify exact model capabilities through real codecs](06-qualify-exact-model-capabilities.md) — depends on issues 02, 03, 04, and 05.
- [Persist exact hosted model registrations](08-persist-exact-hosted-registrations.md) — depends on issues 03, 04, 05, and 06.
- [Admit effective model contracts before provider spend](09-admit-effective-model-contracts.md) — depends on issues 02, 06, and 07.
- [Persist exact admission and response proof](10-persist-model-call-proof.md) — depends on issue 09.
- [Show truthful hosted model readiness by role](11-show-truthful-hosted-model-readiness.md) — depends on issues 08, 09, and 10.
- [Publish exact Local Core and Desktop model readiness](12-publish-local-core-model-readiness.md) — depends on issues 06, 09, and 10.

## Done

- [Establish exact model and request contracts](01-establish-exact-model-contracts.md)
- [Prove structured output and tool calls before success](02-prove-model-responses.md)
