# Parse Exact Result Wire Contract

Status: open

The public `effect.result.loaded` payload types and parser accept any object for `result`, despite the command promising an exact `AgentToolResultV2`.

Completion: define and enforce the canonical wire result contract and reject malformed remote events.
