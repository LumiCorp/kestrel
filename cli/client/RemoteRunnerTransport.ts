// The CLI and public SDK intentionally share one remote transport so transport
// classification, renewable authorization, and durable cursor reattachment do
// not drift between callers.
export {
  RemoteRunnerTransport,
  type RemoteRunnerTransportOptions,
} from "@kestrel-agents/sdk/runner";
