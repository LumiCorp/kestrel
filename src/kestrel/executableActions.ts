import type {
  ExecutableActionDescriptor,
  ExecutableActionId,
} from "./contracts/execution.js";

const EXECUTABLE_ACTION_DESCRIPTORS: ExecutableActionDescriptor[] = [
  {
    actionId: "send_message",
    category: "runtime_message",
    modelVisible: true,
    description: "Dispatch a runtime message to the user-facing outbox.",
  },
  {
    actionId: "assistant.respond",
    category: "runtime_message",
    modelVisible: true,
    description: "Dispatch an assistant response through the runtime outbox.",
  },
  {
    actionId: "execute_tool_call",
    category: "tool_execution",
    modelVisible: true,
    description: "Execute a validated tool call through the runtime tool gateway.",
  },
  {
    actionId: "tool.execute",
    category: "tool_execution",
    modelVisible: true,
    description: "Execute a validated tool call through the runtime tool gateway.",
  },
  {
    actionId: "test_noop",
    category: "internal_test",
    modelVisible: false,
    description: "Internal test-only no-op runtime action.",
  },
  {
    actionId: "test.noop",
    category: "internal_test",
    modelVisible: false,
    description: "Internal test-only no-op runtime action.",
  },
];

const EXECUTABLE_ACTION_DESCRIPTOR_BY_ID = new Map(
  EXECUTABLE_ACTION_DESCRIPTORS.map((descriptor) => [descriptor.actionId, descriptor] as const),
);

export function listExecutableActionDescriptors(input?: {
  modelVisibleOnly?: boolean | undefined;
}): ExecutableActionDescriptor[] {
  if (input?.modelVisibleOnly === true) {
    return EXECUTABLE_ACTION_DESCRIPTORS.filter((descriptor) => descriptor.modelVisible);
  }
  return [...EXECUTABLE_ACTION_DESCRIPTORS];
}

export function getExecutableActionDescriptor(
  actionId: string,
): ExecutableActionDescriptor | undefined {
  return EXECUTABLE_ACTION_DESCRIPTOR_BY_ID.get(actionId as ExecutableActionId);
}

export function isExecutableActionId(actionId: string): actionId is ExecutableActionId {
  return EXECUTABLE_ACTION_DESCRIPTOR_BY_ID.has(actionId as ExecutableActionId);
}

export function isModelVisibleExecutableActionId(actionId: string): actionId is ExecutableActionId {
  return getExecutableActionDescriptor(actionId)?.modelVisible === true;
}
