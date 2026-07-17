import type {
  ChatOperationKind,
  ChatOperationPhase,
  ChatOperationResult,
  ChatOperationState,
  ExtensionError,
  ExtensionErrorCode,
} from "../src/integration/protocol";

export const STORAGE_KEYS = {
  unitChats: "meoi.unitChats.v1",
  queues: "meoi.queues.v3.session",
  operationStates: "meoi.operationStates.v3.session",
  paused: "meoi.pausedForQuota.v3.session",
  lastError: "meoi.lastError.v3.session",
} as const;

export interface QueuedOperation {
  id: string;
  command: "SEND_OPERATION";
  unitId: string;
  operationId: string;
  kind: ChatOperationKind;
  prompt: string;
  queuedAt: string;
}

export interface PersistedOperationState extends ChatOperationState {
  operation: QueuedOperation;
  tabId?: number;
  deadlineAt?: number;
}

export type QueueMap = Record<string, QueuedOperation[]>;
export type UnitChatMap = Record<string, string>;
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
  currentUrl?: string;
}

export function extensionError(code: ExtensionErrorCode, message: string): ExtensionError {
  return { code, message };
}
