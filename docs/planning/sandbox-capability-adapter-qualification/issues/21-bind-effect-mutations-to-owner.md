# Bind effect result and status mutations to durable ownership

## Wrong behavior

Generic result persistence, DONE status promotion, and capability-result persistence lock an effect but do not consistently verify its run, session, and tenant against the store-owned authority.

## Repair owner

The in-memory and PostgreSQL effect stores own these mutations and must validate the locked effect before writing.

## Completion

- Generic and capability result writes require exact run/session and trusted tenant ownership.
- DONE status promotion observes the same owner contract.
- Legacy generic null ownership fails closed; exact capability lease compatibility remains bounded.
- Wrong tenant, run, and session tests prove effect and result remain unchanged.
