# Serialize cancellation with exact-result commit

Status: repair required

Runner-side read/abort/read arbitration is not atomic with PostgreSQL exact-result persistence. A transaction can pass its abort check, remain invisible during the second read, and commit DONE after cancellation is reported.

Completion: add a store-owned cancellation claim serialized on the existing exact effect row with exact-result persistence. Exactly one outcome may win: committed DONE or cancellation. Cover in-memory and PostgreSQL interleavings, including a transaction paused before commit.
