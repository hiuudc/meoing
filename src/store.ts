import type {
  Collection,
  Document,
  StudyItem,
  ThemeSelection,
  ThemeConfig,
  Unit,
  WorkspaceAction,
  WorkspaceState,
} from "./types";
import { normalizeLearningProfile } from "./learning/profile";

export const STORAGE_KEY = "meoi.workspace.v1";
export const STORAGE_VERSION = 1;
export const DEFAULT_SIDEBAR_WIDTH = 248;
export const MIN_SIDEBAR_WIDTH = 248;
export const MAX_SIDEBAR_WIDTH = 420;

export const DEFAULT_THEME: ThemeConfig = {
  selection: { kind: "custom" },
  base: "dusk",
  colorStops: ["#655BF5", "#8B5CF6", "#A855F7", "#BE58F2"],
  gradientDirection: 0,
  intensity: 74,
  syncAcrossDevices: true,
  useCollectionAccents: false,
};

function isThemeSelection(value: unknown): value is ThemeSelection {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const selection = value as Partial<ThemeSelection>;
  if (selection.kind === "custom") return true;
  if (selection.kind === "base") return ["light", "dusk", "midnight", "black"].includes(selection.id ?? "");
  if (selection.kind === "palette") {
    return ["orchid", "spring", "sunset", "lagoon", "lavender", "meadow", "ember", "cobalt", "forest", "berry", "ocean", "golden"].includes(selection.id ?? "");
  }
  return false;
}

export function normalizeThemeConfig(theme?: Partial<ThemeConfig>): ThemeConfig {
  return {
    ...DEFAULT_THEME,
    ...theme,
    selection: isThemeSelection(theme?.selection) ? { ...theme.selection } : { kind: "custom" },
    colorStops: Array.isArray(theme?.colorStops) ? [...theme.colorStops] : [...DEFAULT_THEME.colorStops],
  };
}

export function normalizeSidebarWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

const collections: Collection[] = [
  { id: "japanese", name: "Japanese Foundations", icon: "日", accent: "#8B7CF6", learningProfile: normalizeLearningProfile() },
  { id: "spanish", name: "Spanish Notes", icon: "Ñ", accent: "#E7AD67", learningProfile: normalizeLearningProfile({ targetLanguage: "Spanish" }) },
  { id: "research", name: "Linguistics Research", icon: "R", accent: "#72BDA3", learningProfile: normalizeLearningProfile({ targetLanguage: "English", speakingEnabled: false }) },
];

const units: Unit[] = [
  {
    id: "jp-first",
    collectionId: "japanese",
    name: "Unit 01 · First Encounters",
    description: "Greetings, introductions, and the small phrases that start a conversation.",
  },
  {
    id: "jp-rhythm",
    collectionId: "japanese",
    name: "Unit 02 · Daily Rhythm",
    description: "Build a natural vocabulary for everyday routines.",
  },
  {
    id: "jp-town",
    collectionId: "japanese",
    name: "Unit 03 · Around Town",
    description: "Places, directions, and useful exchanges for getting around.",
  },
  {
    id: "jp-small-talk",
    collectionId: "japanese",
    name: "Unit 04 · Small Talk",
    description: "Keep a casual conversation moving with confidence.",
  },
  {
    id: "es-starters",
    collectionId: "spanish",
    name: "Unit 01 · Everyday Starters",
    description: "Useful building blocks for short daily conversations.",
  },
  {
    id: "research-notes",
    collectionId: "research",
    name: "Unit 01 · Reading Notes",
    description: "A collection of references and language observations.",
  },
];

const documents: Document[] = [
  {
    id: "morning-notes",
    unitId: "jp-rhythm",
    title: "Morning routine notes",
    type: "Notes",
    body: "A short collection of verbs and time phrases for describing the start of a weekday.",
    updatedAt: "Today",
  },
  {
    id: "at-cafe",
    unitId: "jp-rhythm",
    title: "At the cafe",
    type: "Dialogue",
    body: "Ordering coffee, asking for a recommendation, and closing a friendly exchange.",
    updatedAt: "Yesterday",
  },
  {
    id: "weekday-schedule",
    unitId: "jp-rhythm",
    title: "A weekday schedule",
    type: "Reading",
    body: "A simple reading exercise built around a typical workday.",
    updatedAt: "May 28",
  },
  {
    id: "useful-verbs",
    unitId: "jp-rhythm",
    title: "Useful verbs",
    type: "Vocabulary",
    body: "Core verbs for getting up, commuting, working, eating, and going home.",
    updatedAt: "May 25",
  },
];

const studyItems: StudyItem[] = [
  {
    id: "word-ohayou",
    unitId: "jp-rhythm",
    kind: "word",
    text: "おはよう",
    translation: "Good morning",
    notes: "Casual greeting used with friends and family.",
    updatedAt: "Today",
  },
  {
    id: "word-coffee",
    unitId: "jp-rhythm",
    kind: "word",
    text: "コーヒー",
    translation: "Coffee",
    notes: "Katakana loanword.",
    updatedAt: "Today",
  },
  {
    id: "word-work",
    unitId: "jp-rhythm",
    kind: "word",
    text: "仕事",
    translation: "Work",
    notes: "Read as しごと.",
    updatedAt: "Yesterday",
  },
  {
    id: "word-return",
    unitId: "jp-rhythm",
    kind: "word",
    text: "帰る",
    translation: "To return home",
    notes: "Read as かえる.",
    updatedAt: "Yesterday",
  },
  {
    id: "phrase-breakfast",
    unitId: "jp-rhythm",
    kind: "phrase",
    text: "朝ごはんを食べる",
    translation: "Eat breakfast",
    notes: "Use this phrase when listing morning routines.",
    updatedAt: "May 28",
  },
  {
    id: "phrase-station",
    unitId: "jp-rhythm",
    kind: "phrase",
    text: "駅まで歩く",
    translation: "Walk to the station",
    notes: "まで marks an endpoint.",
    updatedAt: "May 27",
  },
  {
    id: "sentence-work",
    unitId: "jp-rhythm",
    kind: "sentence",
    text: "九時から仕事をします。",
    translation: "I work from nine o'clock.",
    notes: "から marks the starting time.",
    updatedAt: "May 26",
  },
  {
    id: "sentence-home",
    unitId: "jp-rhythm",
    kind: "sentence",
    text: "六時ごろ家に帰ります。",
    translation: "I return home around six.",
    notes: "ごろ expresses an approximate time.",
    updatedAt: "May 25",
  },
];

function toRecord<T extends { id: string }>(values: T[]): Record<string, T> {
  return Object.fromEntries(values.map((value) => [value.id, value]));
}

export function createSeedState(): WorkspaceState {
  return {
    version: STORAGE_VERSION,
    collections: toRecord(collections),
    collectionOrder: collections.map(({ id }) => id),
    units: toRecord(units),
    unitOrder: units.map(({ id }) => id),
    documents: toRecord(documents),
    documentOrder: documents.map(({ id }) => id),
    studyItems: toRecord(studyItems),
    studyItemOrder: studyItems.map(({ id }) => id),
    activeCollectionId: "japanese",
    activeUnitId: "jp-rhythm",
    activeKind: "document",
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    theme: normalizeThemeConfig(DEFAULT_THEME),
  };
}

function firstUnitId(state: WorkspaceState, collectionId: string): string {
  return state.unitOrder.find((id) => state.units[id]?.collectionId === collectionId) ?? "";
}

function pruneUnitContent(state: WorkspaceState, unitIds: Set<string>): WorkspaceState {
  const documents = { ...state.documents };
  const studyItems = { ...state.studyItems };
  const documentOrder = state.documentOrder.filter((id) => {
    const shouldKeep = !unitIds.has(documents[id]?.unitId);
    if (!shouldKeep) delete documents[id];
    return shouldKeep;
  });
  const studyItemOrder = state.studyItemOrder.filter((id) => {
    const shouldKeep = !unitIds.has(studyItems[id]?.unitId);
    if (!shouldKeep) delete studyItems[id];
    return shouldKeep;
  });
  return { ...state, documents, documentOrder, studyItems, studyItemOrder };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "selectCollection": {
      if (!state.collections[action.id]) return state;
      const unitId = firstUnitId(state, action.id);
      return { ...state, activeCollectionId: action.id, activeUnitId: unitId };
    }
    case "selectUnit": {
      const unit = state.units[action.id];
      if (!unit) return state;
      return { ...state, activeCollectionId: unit.collectionId, activeUnitId: action.id };
    }
    case "selectKind":
      return { ...state, activeKind: action.kind };
    case "createCollection":
      return {
        ...state,
        collections: { ...state.collections, [action.collection.id]: action.collection },
        collectionOrder: [...state.collectionOrder, action.collection.id],
        activeCollectionId: action.collection.id,
        activeUnitId: "",
      };
    case "updateCollection":
      if (!state.collections[action.collection.id]) return state;
      return {
        ...state,
        collections: { ...state.collections, [action.collection.id]: action.collection },
      };
    case "deleteCollection": {
      if (!state.collections[action.id] || state.collectionOrder.length === 1) return state;
      const collectionsCopy = { ...state.collections };
      delete collectionsCopy[action.id];
      const collectionOrder = state.collectionOrder.filter((id) => id !== action.id);
      const unitIds = new Set(
        state.unitOrder.filter((id) => state.units[id]?.collectionId === action.id),
      );
      const unitsCopy = { ...state.units };
      unitIds.forEach((id) => delete unitsCopy[id]);
      let nextState = pruneUnitContent(
        { ...state, collections: collectionsCopy, collectionOrder, units: unitsCopy },
        unitIds,
      );
      nextState = {
        ...nextState,
        unitOrder: state.unitOrder.filter((id) => !unitIds.has(id)),
      };
      if (state.activeCollectionId !== action.id) return nextState;
      const activeCollectionId = collectionOrder[0];
      return {
        ...nextState,
        activeCollectionId,
        activeUnitId: firstUnitId(nextState, activeCollectionId),
      };
    }
    case "createUnit":
      return {
        ...state,
        units: { ...state.units, [action.unit.id]: action.unit },
        unitOrder: [...state.unitOrder, action.unit.id],
        activeCollectionId: action.unit.collectionId,
        activeUnitId: action.unit.id,
      };
    case "updateUnit":
      if (!state.units[action.unit.id]) return state;
      return { ...state, units: { ...state.units, [action.unit.id]: action.unit } };
    case "deleteUnit": {
      if (!state.units[action.id]) return state;
      const unitsCopy = { ...state.units };
      delete unitsCopy[action.id];
      let nextState = pruneUnitContent(state, new Set([action.id]));
      nextState = {
        ...nextState,
        units: unitsCopy,
        unitOrder: state.unitOrder.filter((id) => id !== action.id),
      };
      if (state.activeUnitId !== action.id) return nextState;
      return {
        ...nextState,
        activeUnitId: firstUnitId(nextState, state.activeCollectionId),
      };
    }
    case "moveUnit": {
      const unit = state.units[action.id];
      const target = state.units[action.targetId];
      if (!unit || !target || unit.id === target.id || unit.collectionId !== target.collectionId) return state;
      const unitOrder = state.unitOrder.filter((id) => id !== unit.id);
      const targetIndex = unitOrder.indexOf(target.id);
      if (targetIndex === -1) return state;
      unitOrder.splice(targetIndex + (action.placement === "after" ? 1 : 0), 0, unit.id);
      if (unitOrder.every((id, index) => id === state.unitOrder[index])) return state;
      return { ...state, unitOrder };
    }
    case "createDocument":
      return {
        ...state,
        documents: { ...state.documents, [action.document.id]: action.document },
        documentOrder: [action.document.id, ...state.documentOrder],
      };
    case "updateDocument":
      if (!state.documents[action.document.id]) return state;
      return { ...state, documents: { ...state.documents, [action.document.id]: action.document } };
    case "deleteDocument": {
      const documentsCopy = { ...state.documents };
      delete documentsCopy[action.id];
      return {
        ...state,
        documents: documentsCopy,
        documentOrder: state.documentOrder.filter((id) => id !== action.id),
      };
    }
    case "createStudyItem":
      return {
        ...state,
        studyItems: { ...state.studyItems, [action.item.id]: action.item },
        studyItemOrder: [action.item.id, ...state.studyItemOrder],
      };
    case "updateStudyItem":
      if (!state.studyItems[action.item.id]) return state;
      return { ...state, studyItems: { ...state.studyItems, [action.item.id]: action.item } };
    case "deleteStudyItem": {
      const studyItemsCopy = { ...state.studyItems };
      delete studyItemsCopy[action.id];
      return {
        ...state,
        studyItems: studyItemsCopy,
        studyItemOrder: state.studyItemOrder.filter((id) => id !== action.id),
      };
    }
    case "setSidebarWidth":
      return { ...state, sidebarWidth: normalizeSidebarWidth(action.width) };
    case "applyTheme":
      return { ...state, theme: normalizeThemeConfig(action.theme) };
  }
}

export function loadWorkspace(storage?: Pick<Storage, "getItem">): WorkspaceState {
  if (!storage) return createSeedState();
  try {
    const saved = storage.getItem(STORAGE_KEY);
    if (!saved) return createSeedState();
    const parsed = JSON.parse(saved) as WorkspaceState;
    if (parsed.version !== STORAGE_VERSION) return createSeedState();
    const normalizedCollections = Object.fromEntries(
      Object.entries(parsed.collections ?? {}).map(([id, collection]) => [
        id,
        { ...collection, learningProfile: normalizeLearningProfile(collection?.learningProfile) },
      ]),
    );
    const normalizedUnits = Object.fromEntries(
      Object.entries(parsed.units ?? {}).map(([id, unit]) => [
        id,
        (() => {
          const { instructionOverride, ...rest } = unit ?? {};
          return {
            ...rest,
            ...(typeof instructionOverride === "string" ? { instructionOverride } : {}),
          };
        })(),
      ]),
    );
    return {
      ...parsed,
      collections: normalizedCollections,
      units: normalizedUnits,
      sidebarWidth: normalizeSidebarWidth(parsed.sidebarWidth),
      theme: normalizeThemeConfig(parsed.theme),
    };
  } catch {
    return createSeedState();
  }
}

export function saveWorkspace(state: WorkspaceState, storage?: Pick<Storage, "setItem">): void {
  storage?.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
