# Preserve distinct timeout classification

Status: repair required

Provider deadline before lease expiry currently becomes generic `provider_invocation_failed` and the deployment proof asserts only `adapter_failed`. Timeout must remain distinguishable from provider failure and expiry in durable lifecycle and public evidence.

Completion: persist a stable timeout reason, retain the secret-free public failure contract, and assert timeout plus provider abort evidence in Local Core and hosted deployment proofs.
