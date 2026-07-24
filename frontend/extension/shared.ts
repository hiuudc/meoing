import type {
  ChatOperationKind,
  ChatOperationPhase,
  ChatOperationResult,
  ChatOperationState,
  ExtensionError,
  ExtensionErrorCode,
  OperationExpectation,
} from "../src/integration/protocol";

export const STORAGE_KEYS = {
  unitChats: "meoi.unitChats.v1",
  queues: "meoi.queues.v6.session",
  operationStates: "meoi.operationStates.v6.session",
  provisionalTabs: "meoi.provisionalUnitTabs.v6.session",
  paused: "meoi.pausedForQuota.v6.session",
  lastError: "meoi.lastError.v6.session",
} as const;

export interface QueuedOperation {
  unitId: string;
  operationId: string;
  kind: ChatOperationKind;
  prompt: string;
  expectation: OperationExpectation;
  queuedAt: string;
  deadlineAt?: number;
}

export interface PersistedOperationState extends ChatOperationState {
  operation: QueuedOperation;
  tabId?: number;
  deadlineAt?: number;
}

export type QueueMap = Record<string, string[]>;
export type UnitChatMap = Record<string, string>;
export type UnitTabMap = Record<string, number>;
export type OperationStateMap = Record<string, PersistedOperationState>;

export interface ChatCommandResponse {
  ok: boolean;
  accepted?: boolean;
  currentUrl?: string;
  error?: ExtensionError;
}

export interface ChatOperationEvent {
  kind: "MEOI_CHAT_OPERATION_EVENT";
  operationId: string;
  unitId: string;
  phase: Extract<ChatOperationPhase, "sending" | "awaiting_response" | "repairing_response" | "completed" | "failed">;
  repairAttempt?: number;
  result?: ChatOperationResult;
  error?: ExtensionError;
  projectWarning?: ExtensionError;
  currentUrl?: string;
}

export function extensionError(code: ExtensionErrorCode, message: string): ExtensionError {
  return { code, message };
}
