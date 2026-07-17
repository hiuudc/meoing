import { isTerminalPhase } from "./operation-state";
import { STORAGE_KEYS, type OperationStateMap, type QueueMap, type UnitChatMap } from "./shared";

async function render() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get([STORAGE_KEYS.unitChats]),
    chrome.storage.session.get([
    STORAGE_KEYS.queues,
    STORAGE_KEYS.operationStates,
    STORAGE_KEYS.paused,
    ]),
  ]);
  const chats = (local[STORAGE_KEYS.unitChats] as UnitChatMap | undefined) ?? {};
  const queues = (session[STORAGE_KEYS.queues] as QueueMap | undefined) ?? {};
  const operationStates = (session[STORAGE_KEYS.operationStates] as OperationStateMap | undefined) ?? {};
  const paused = Boolean(session[STORAGE_KEYS.paused]);
  const queueLength = Object.values(queues).reduce((total, queue) => total + queue.length, 0);
  const states = Object.values(operationStates);
  const active = states.filter((state) => !isTerminalPhase(state.phase));
  const completed = states.filter((state) => state.phase === "completed").length;
  const repairing = active.find((state) => state.phase === "repairing_response");
  const status = document.querySelector<HTMLElement>("#status")!;
  status.textContent = paused
    ? "Đang dừng vì quota ChatGPT"
    : repairing
      ? `Đang sửa kết quả JSON ${repairing.repairAttempt}/3`
      : active.length
        ? "Đang chờ phản hồi ChatGPT"
        : "Sẵn sàng nhận lệnh từ Meoi";
  status.dataset.state = paused ? "paused" : "ready";
  document.querySelector<HTMLElement>("#details")!.textContent = `${Object.keys(chats).length} unit đã liên kết · ${queueLength} đang chờ · ${completed} kết quả tạm chưa ACK`;
}

document.querySelector<HTMLButtonElement>("#open-meoi")?.addEventListener("click", () => void chrome.tabs.create({ url: "http://127.0.0.1:5173/" }));
chrome.storage.onChanged.addListener(() => void render());
void render();
