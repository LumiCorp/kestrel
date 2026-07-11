# Models Slice

This directory contains the provider-specific env loaders, request mappers, transport error normalization, and gateway factories for Kestrel model access.

## Supported Providers

- OpenRouter via `createOpenRouterModelGatewayFromEnv`
- OpenAI via `createOpenAiModelGatewayFromEnv`
- Anthropic via `createAnthropicModelGatewayFromEnv`

The public exports are collected in [models/index.ts](https://github.com/LumiCorp/kestrel/blob/main/models/index.ts).

## Environment Contracts

### OpenRouter

- Required: `OPENROUTER_API_KEY`
- Optional: `OPENROUTER_MODEL`, `OPENROUTER_BASE_URL`, `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME`
- Defaults: base URL `https://openrouter.ai`, model `z-ai/glm-5.2`

### OpenAI

- Required: `OPENAI_API_KEY`
- Optional: `OPENAI_MODEL`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`
- Defaults: base URL `https://api.openai.com`, model `gpt-5.4-2026-03-05`

### Anthropic

- Required: `ANTHROPIC_API_KEY`
- Optional: `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_VERSION`
- Defaults: base URL `https://api.anthropic.com`, model `claude-3-5-haiku-latest`, version `2023-06-01`

## Canonical Behavior

- Env parsing lives in provider-specific `*Env.ts` files.
- Request building and response mapping live in provider-specific `*Mapper.ts` files.
- Transport and provider errors are normalized by provider-specific `*Errors.ts` files.
- Gateway factories are the canonical integration surface for runtime code.

## OpenRouter Endpoint Notes

OpenRouter supports endpoint selection per request:

- default endpoint: `chat/completions`
- override: `providerOptions.openrouter.endpoint = "responses"`

The runtime still expects a normalized response shape after provider mapping. Provider-specific wire differences should not leak into higher layers.

## Read Next

- Runtime IO docs: [apps/docs/content/runtime/io-and-tools.mdx](https://github.com/LumiCorp/kestrel/blob/main/apps/docs/content/runtime/io-and-tools.mdx)
- SDK package: [packages/sdk/README.md](https://github.com/LumiCorp/kestrel/blob/main/packages/sdk/README.md)
