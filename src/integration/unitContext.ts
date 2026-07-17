import type { LearningProfile, LessonProgressSnapshot } from "../learning/types";
import type { Collection, Document, StudyItem, Unit } from "../types";

export interface UnitContextPayload {
  schemaVersion: 1;
  unit: Pick<Unit, "id" | "name" | "description" | "instructionOverride">;
  collection: Pick<Collection, "id" | "name"> & { learningProfile: LearningProfile };
  documents: Array<Pick<Document, "id" | "title" | "type" | "body" | "updatedAt">>;
  studyItems: Array<Pick<StudyItem, "id" | "kind" | "text" | "translation" | "notes" | "updatedAt">>;
  learningState: {
    progress?: LessonProgressSnapshot;
    commonErrors: string[];
  };
}

export function buildUnitContext(
  collection: Collection,
  unit: Unit,
  documents: Document[],
  studyItems: StudyItem[],
  profile: LearningProfile,
  progress?: LessonProgressSnapshot,
  commonErrors: string[] = [],
): UnitContextPayload {
  return {
    schemaVersion: 1,
    unit: { id: unit.id, name: unit.name, description: unit.description, instructionOverride: unit.instructionOverride },
    collection: { id: collection.id, name: collection.name, learningProfile: profile },
    documents: documents.map(({ id, title, type, body, updatedAt }) => ({ id, title, type, body, updatedAt })),
    studyItems: studyItems.map(({ id, kind, text, translation, notes, updatedAt }) => ({ id, kind, text, translation, notes, updatedAt })),
    learningState: { progress, commonErrors: commonErrors.slice(0, 50) },
  };
}
