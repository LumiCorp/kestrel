---
id: design-root
domain: agent
status: active
owner: kestrel-agents
last_verified_at: 2026-06-16
depends_on: [ARCHITECTURE.md, docs/PLANS.md]
---

# Kestrel Design Principles

- Optimize for agent legibility and deterministic behavior.
- Encode constraints mechanically where possible.
- Favor small composable contracts and typed boundaries.
- Prefer prompt and contract hardening before heuristic behavior patches.
- Keep replay, diagnostics, and quality artifacts versioned in-repo.

## Design Inputs

- [Plans Index](https://github.com/LumiCorp/kestrel/blob/main/docs/PLANS.md)
- [Quality Score](https://github.com/LumiCorp/kestrel/blob/main/QUALITY_SCORE.md)
