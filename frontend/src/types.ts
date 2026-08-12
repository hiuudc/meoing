import type { CollectionQuestionSettings, LearningProfile } from "./learning/types";
import type { components } from "./api/generated";

export type ContentKind = "document" | "word" | "phrase" | "sentence";
export type StudyKind = Exclude<ContentKind, "document">;
export type CollectionPermission =
  components["schemas"]["Collection"]["effectivePermissions"][number];
export type BaseTheme = "light" | "dusk" | "midnight" | "black";
export type ColorThemeId =
  | "orchid"
  | "spring"
  | "sunset"
  | "lagoon"
  | "lavender"
  | "meadow"
  | "ember"
  | "cobalt"
  | "forest"
  | "berry"
  | "ocean"
  | "golden";
export type ThemeSelection =
  | { kind: "base"; id: BaseTheme }
  | { kind: "palette"; id: ColorThemeId }
  | { kind: "custom" };

export interface Collection {
  id: string;
  name: string;
  icon: string;
  accent: string;
  description?: string;
  ownerId?: string;
  revision?: number;
  effectivePermissions?: CollectionPermission[];
  deletedAt?: string | null;
  learningProfile?: LearningProfile;
  questionSettings?: CollectionQuestionSettings;
}

export interface Unit {
  id: string;
  collectionId: string;
  name: string;
  description: string;
  instructionOverride?: string;
  languageCode?: string;
  revision?: number;
  deletedAt?: string | null;
}

export interface Document {
  id: string;
  unitId: string;
  sourceIndex?: number;
  title: string;
  type: string;
  body: string;
  content?: string;
  updatedAt: string;
}

export interface StudyItem {
  id: string;
  unitId: string;
  sourceIndex?: number;
  kind: StudyKind;
  text: string;
  translation: string;
  notes?: string;
  updatedAt: string;
}

export interface ThemeConfig {
  selection: ThemeSelection;
  base: BaseTheme;
  colorStops: string[];
  gradientDirection: number;
  intensity: number;
  syncAcrossDevices: boolean;
  useCollectionAccents: boolean;
}

export interface WorkspaceState {
  version: number;
  collections: Record<string, Collection>;
  collectionOrder: string[];
  units: Record<string, Unit>;
  unitOrder: string[];
  documents: Record<string, Document>;
  documentOrder: string[];
  studyItems: Record<string, StudyItem>;
  studyItemOrder: string[];
  activeCollectionId: string;
  activeUnitId: string;
  activeKind: ContentKind;
  sidebarWidth: number;
  theme: ThemeConfig;
}

export type WorkspaceAction =
  | { type: "hydrate"; state: WorkspaceState }
  | { type: "selectCollection"; id: string }
  | { type: "selectUnit"; id: string }
  | { type: "selectKind"; kind: ContentKind }
  | { type: "createCollection"; collection: Collection }
  | { type: "updateCollection"; collection: Collection }
  | { type: "deleteCollection"; id: string }
  | { type: "createUnit"; unit: Unit }
  | { type: "updateUnit"; unit: Unit }
  | { type: "deleteUnit"; id: string }
  | { type: "moveUnit"; id: string; targetId: string; placement: "before" | "after" }
  | { type: "createDocument"; document: Document }
  | { type: "updateDocument"; document: Document }
  | { type: "deleteDocument"; id: string }
  | { type: "createStudyItem"; item: StudyItem }
  | { type: "updateStudyItem"; item: StudyItem }
  | { type: "deleteStudyItem"; id: string }
  | { type: "setSidebarWidth"; width: number }
  | { type: "applyTheme"; theme: ThemeConfig };
