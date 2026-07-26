import { ExtensionBridgeError } from "./extensionBridge";

export async function runWithUnitChatRecovery<T>(
  initialOperation: () => Promise<T>,
  resetAndRetry: () => Promise<T>,
): Promise<T> {
  try {
    return await initialOperation();
  } catch (caught) {
    if (!(caught instanceof ExtensionBridgeError) || caught.code !== "CHATGPT_TAB_CHANGED") {
      throw caught;
    }
    return resetAndRetry();
  }
}
