export {
  createWebRunnerAdapter,
  clampHistoryWindow,
  type CreateWebRunnerAdapterOptions,
  type WebRunnerAdapter,
} from "./adapter.js";
export { createWebDemoProfile } from "./profile.js";
export type {
  WebControlCommand,
  WebHistoryLine,
  WebRunnerRequestContext,
  WebRunnerEvent,
  WebRunTurnRequest,
  WebRunTurnStreamOptions,
  ThreadRunCheckIn,
  ThreadRunStartAccepted,
} from "./contracts.js";
export type { RunTurnAttachment } from "../kestrel/contracts/orchestration.js";
