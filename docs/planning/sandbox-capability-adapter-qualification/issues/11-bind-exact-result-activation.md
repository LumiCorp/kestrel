# Bind Exact Result Activation

Status: open

The exact-result reader joins the prepared call and result by call ID but does not require the result's tool and activation identity to equal the persisted prepared call.

Completion: compare canonical tool/activation identity and prepared input evidence, returning conflict for any mismatch.
