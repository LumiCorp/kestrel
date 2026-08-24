# Bind cancellation claim to tenant authority

Status: repair required

The atomic cancellation claim accepts tenant identity but does not validate it before reading completed state or mutating a pending effect.

Completion: validate the exact capability lease/result tenant under the same store lock and prove wrong-tenant claims leave state unchanged in memory and PostgreSQL.

## Required decision evidence

The existing hosted and Local Core stores are not tenant-partitioned by construction. The `sessions`, `runs`, `effects`, and `effect_results` tables also have no durable tenant owner. Therefore a no-lease fallback based only on deployment scoping is not an enforceable tenant boundary.

Recommended completion: add trusted tenant ownership to the durable run/effect authority and bind generic cancellation claims to it. This requires an additive migration and contract propagation; capability-bearing effects must continue to validate the exact lease tenant as defense in depth.
