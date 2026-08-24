# Reconcile legacy pending effect ownership with its run

When trusted validation reconciles a legacy prestarted PostgreSQL run from null tenant ownership, existing null-owned effects for that exact run must be reconciled in the same locked transaction without overwriting any non-null owner.
