# Serialize generic code results with cancellation

Status: repair required

Generic `code.execute` DONE persistence bypasses the exact capability result lock, allowing cancellation to mark the effect FAILED while a generic result commits DONE.

Completion: make generic DONE persistence and DONE status transition contend on the same effect row and add in-memory/PostgreSQL winner-order tests.
