import { getEffectiveUnitQuestionSettings } from "../learning/questionSettings";
import type { LearningProfile, LessonProgressSnapshot, QuestionFormat } from "../learning/types";
import type { Collection, Document, StudyItem, Unit } from "../types";

export interface UnitContextPayload {
  schemaVersion: 1;
  unit: Pick<Unit, "id" | "name" | "description" | "instructionOverride"> & {
    questionBlueprints: Array<{ id: string; name: string; baseFormat: QuestionFormat; guidance: string }>;
  };
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
  const questionSettings = getEffectiveUnitQuestionSettings(unit.questionSettings, profile);
  return {
    schemaVersion: 1,
    unit: {
      id: unit.id,
      name: unit.name,
      description: unit.description,
      instructionOverride: unit.instructionOverride,
      questionBlueprints: questionSettings.customTemplates
        .filter((template) => template.enabled)
        .map(({ id, name, baseFormat, guidance }) => ({ id, name, baseFormat, guidance })),
    },
    collection: { id: collection.id, name: collection.name, learningProfile: profile },
    documents: documents.map(({ id, title, type, body, updatedAt }) => ({ id, title, type, body, updatedAt })),
    studyItems: studyItems.map(({ id, kind, text, translation, notes, updatedAt }) => ({ id, kind, text, translation, notes, updatedAt })),
    learningState: { progress, commonErrors: commonErrors.slice(0, 50) },
  };
}
