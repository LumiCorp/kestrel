# Bind failed effect status to durable ownership

`markEffectStatus(..., "FAILED")` must validate the same locked run, session, and tenant owner as DONE. A wrong owner must not mutate status; the matching owner may still record failure after cancellation.
