// A waiting turn is durably quiescent. Its current assistant message is complete,
// and the exact interaction response opens a new replay stream for the same turn.
const REPLAY_COMPLETE_STATUSES = new Set([
  "waiting_for_input",
  "completed",
  "failed",
  "cancelled",
]);

export function isDurableTurnReplayComplete(status: string) {
  return REPLAY_COMPLETE_STATUSES.has(status);
}
