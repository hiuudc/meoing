import { LEARNING_STORAGE_KEY } from "./learningStorage";
import { PENDING_LEARNING_OPERATIONS_KEY } from "./pendingLearningOperations";
import { LETTERS_STORAGE_KEY } from "../learning/letters";
import { LESSON_PLAYER_PREFERENCE_KEY } from "../learning/playerPreferences";
import { SPEECH_PREFERENCE_KEY } from "../learning/speech";
import { STORAGE_KEY } from "../store";

const LEGACY_APPLICATION_KEYS = [
  STORAGE_KEY,
  LEARNING_STORAGE_KEY,
  PENDING_LEARNING_OPERATIONS_KEY,
  LETTERS_STORAGE_KEY,
  LESSON_PLAYER_PREFERENCE_KEY,
  SPEECH_PREFERENCE_KEY,
] as const;

export function removeLegacyApplicationData(storage?: Pick<Storage, "removeItem">): void {
  if (!storage) return;
  for (const key of LEGACY_APPLICATION_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Authentication can still render when a browser blocks legacy storage access.
    }
  }
}
