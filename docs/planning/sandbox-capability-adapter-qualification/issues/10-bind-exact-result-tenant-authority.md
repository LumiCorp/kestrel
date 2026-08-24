# Bind Exact Result Tenant Authority

Status: open

`effect.result.get` authenticates the runner bearer but does not bind the requested persisted result to independently trusted tenant authority. An authenticated caller with another run's exact identity could retrieve its full tool result.

Completion: pass trusted command authority into the read boundary, reject tenant mismatches before returning output, and prove cross-tenant retrieval fails without runtime/provider fallback.
