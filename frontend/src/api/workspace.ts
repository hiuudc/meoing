import { normalizeLearningProfile } from "../learning/profile";
import { normalizeCollectionQuestionSettings } from "../learning/questionSettings";
import { createEmptyWorkspaceState, normalizeSidebarWidth, normalizeThemeConfig } from "../store";
import type {
  Collection,
  CollectionPermission,
  Document,
  StudyItem,
  StudyKind,
  ThemeConfig,
  Unit,
  WorkspaceState,
} from "../types";
import type { ApiClient, ApiSuccess } from "./client";
import { hydrateLexicalDocumentForEditing } from "./files";
import { readSettings, settingsValues } from "./settings";

interface CursorPage<T> {
  items: T[];
  nextCursor?: string | null;
}

interface WireCollection {
  id: string;
  name: string;
  description?: string | null;
  ownerId?: string;
  revision?: number;
  deletedAt?: string | null;
  effectivePermissions?: CollectionPermission[];
  settings?: Record<string, unknown>;
}

export interface WireUnit {
  id: string;
  collectionId: string;
  name: string;
  description?: string | null;
  instructionOverride?: string | null;
  languageCode?: string | null;
  words?: unknown[];
  phrases?: unknown[];
  sentences?: unknown[];
  documents?: unknown[];
  revision?: number;
  deletedAt?: string | null;
}

interface WireUserSettings {
  theme?: Partial<ThemeConfig>;
  sidebarWidth?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function languageName(code: unknown): string | undefined {
  if (typeof code !== "string") return undefined;
  const normalized = code.trim().toLowerCase().split("-")[0];
  return {
    en: "English",
    vi: "Vietnamese",
    ja: "Japanese",
    es: "Spanish",
    zh: "Chinese",
    ko: "Korean",
    fr: "French",
    de: "German",
  }[normalized];
}

function collectionFromWire(
  value: WireCollection,
  index: number,
  cloudSettings: Record<string, unknown>,
): Collection {
  const settings = { ...asRecord(value.settings), ...cloudSettings };
  const appearance = asRecord(settings.appearance);
  const learning = asRecord(settings.learningProfile);
  const questions = asRecord(settings.questionSettings);
  return {
    id: value.id,
    name: value.name,
    description: value.description ?? "",
    ownerId: value.ownerId,
    revision: value.revision,
    deletedAt: value.deletedAt ?? null,
    effectivePermissions: value.effectivePermissions ?? [],
    icon: stringValue(appearance.icon, value.name.trim().slice(0, 2).toUpperCase() || `${index + 1}`),
    accent: stringValue(appearance.accent, "#8B7CF6"),
    learningProfile: normalizeLearningProfile(learning),
    ...(Object.keys(questions).length ? { questionSettings: normalizeCollectionQuestionSettings(questions) } : {}),
  };
}

function unitFromWire(value: WireUnit): Unit {
  return {
    id: value.id,
    collectionId: value.collectionId,
    name: value.name,
    description: value.description ?? "",
    instructionOverride: value.instructionOverride ?? "",
    languageCode: value.languageCode ?? undefined,
    revision: value.revision ?? 1,
    deletedAt: value.deletedAt ?? null,
  };
}

async function documentFromWire(
  api: ApiClient,
  unitId: string,
  value: unknown,
  index: number,
  assetUrlCache: Map<string, string>,
): Promise<Document> {
  const document = asRecord(value);
  const rawContent = document.content;
  const content = rawContent === undefined
    ? undefined
    : typeof rawContent === "string"
      ? rawContent
      : await hydrateLexicalDocumentForEditing(api, rawContent, assetUrlCache)
        .catch(() => JSON.stringify(stripPersistedImageSources(rawContent)));
  return {
    id: `${unitId}:document:${index}`,
    unitId,
    sourceIndex: index,
    title: stringValue(document.title, `Document ${index + 1}`),
    type: stringValue(document.type, "Notes"),
    body: stringValue(document.body),
    ...(content === undefined ? {} : { content }),
    updatedAt: stringValue(document.updatedAt, "Synced"),
  };
}

function studyItemFromWire(unitId: string, kind: StudyKind, value: unknown, index: number): StudyItem {
  const item = asRecord(value);
  const text = typeof value === "string" ? value : stringValue(item.text, stringValue(item.surface));
  return {
    id: `${unitId}:${kind}:${index}`,
    unitId,
    sourceIndex: index,
    kind,
    text,
    translation: stringValue(item.translation, stringValue(item.meaning)),
    notes: stringValue(item.notes),
    updatedAt: stringValue(item.updatedAt, "Synced"),
  };
}

async function readAllPages<T>(api: ApiClient, path: string, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null | undefined;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const pagePath = cursor ? `${path}${separator}cursor=${encodeURIComponent(cursor)}` : path;
    const response = signal
      ? await api.get<CursorPage<T>>(pagePath, signal)
      : await api.get<CursorPage<T>>(pagePath);
    items.push(...response.data.items);
    cursor = response.data.nextCursor;
  } while (cursor);
  return items;
}

async function loadUserSettings(api: ApiClient): Promise<WireUserSettings> {
  try {
    const response = await api.get<WireUserSettings>("/v1/settings/user");
    return response.data;
  } catch {
    return {};
  }
}

export async function loadCloudWorkspace(api: ApiClient): Promise<WorkspaceState> {
  const [wireCollections, userSettings] = await Promise.all([
    readAllPages<WireCollection>(api, "/v1/collections"),
    loadUserSettings(api),
  ]);
  const scopedSettings = await Promise.all(wireCollections.map(async (collection) => {
    const [collectionSettings, collectionUserSettings] = await Promise.all([
      readSettings(api, { scope: "collection", collectionId: collection.id }),
      readSettings(api, { scope: "collection_user", collectionId: collection.id }),
    ]);
    return {
      collectionId: collection.id,
      collection: settingsValues(collectionSettings),
      collectionUser: settingsValues(collectionUserSettings),
    };
  }));
  const settingsByCollection = new Map(
    scopedSettings.map((settings) => [settings.collectionId, settings]),
  );
  const collections = wireCollections.map((collection, index) => collectionFromWire(
    collection,
    index,
    settingsByCollection.get(collection.id)?.collection ?? {},
  ));
  const unitSummaries = (await Promise.all(
    collections.map((collection) => readAllPages<WireUnit>(
      api,
      `/v1/collections/${encodeURIComponent(collection.id)}/units`,
    )),
  )).flat();
  const fullUnits = await Promise.all(unitSummaries.map(async (summary) => {
    if (summary.words && summary.phrases && summary.sentences && summary.documents) return summary;
    const response = await api.get<WireUnit>(`/v1/units/${encodeURIComponent(summary.id)}`);
    return response.data;
  }));

  const state = createEmptyWorkspaceState();
  state.collections = Object.fromEntries(collections.map((collection) => [collection.id, collection]));
  state.collectionOrder = collections.map((collection) => collection.id);
  state.activeCollectionId = collections[0]?.id ?? "";
  state.units = Object.fromEntries(fullUnits.map((unit) => [unit.id, unitFromWire(unit)]));
  state.unitOrder = collections.flatMap((collection) => {
    const collectionUnitIds = fullUnits
      .filter((unit) => unit.collectionId === collection.id)
      .map((unit) => unit.id);
    const savedOrder = settingsByCollection.get(collection.id)?.collectionUser.unitOrder;
    const ordered = Array.isArray(savedOrder)
      ? savedOrder.filter((id): id is string => (
        typeof id === "string" && collectionUnitIds.includes(id)
      ))
      : [];
    return [...ordered, ...collectionUnitIds.filter((id) => !ordered.includes(id))];
  });
  state.activeUnitId = fullUnits.find((unit) => unit.collectionId === state.activeCollectionId)?.id ?? "";

  for (const wireUnit of fullUnits) {
    for (const kind of ["word", "phrase", "sentence"] as const) {
      const plural = `${kind}s` as "words" | "phrases" | "sentences";
      for (const [index, rawItem] of (wireUnit[plural] ?? []).entries()) {
        const item = studyItemFromWire(wireUnit.id, kind, rawItem, index);
        state.studyItems[item.id] = item;
        state.studyItemOrder.push(item.id);
      }
    }
  }

  state.sidebarWidth = normalizeSidebarWidth(userSettings.sidebarWidth);
  state.theme = normalizeThemeConfig(userSettings.theme);
  const assetUrlCache = new Map<string, string>();
  const documents: Document[] = [];
  for (const wireUnit of fullUnits) {
    for (const [index, rawDocument] of (wireUnit.documents ?? []).entries()) {
      documents.push(await documentFromWire(api, wireUnit.id, rawDocument, index, assetUrlCache));
    }
  }
  state.documents = Object.fromEntries(documents.map((document) => [document.id, document]));
  state.documentOrder = documents.map((document) => document.id);
  return state;
}

export async function loadDeletedCollections(api: ApiClient): Promise<Collection[]> {
  const collections = await readAllPages<WireCollection>(
    api,
    "/v1/collections?includeDeleted=true",
  );
  return collections
    .filter((collection) => Boolean(collection.deletedAt))
    .map((collection, index) => collectionFromWire(collection, index, {}));
}

export async function loadDeletedUnits(
  api: ApiClient,
  collectionId: string,
  signal?: AbortSignal,
): Promise<Unit[]> {
  const units = await readAllPages<WireUnit>(
    api,
    `/v1/collections/${encodeURIComponent(collectionId)}/units?includeDeleted=true`,
    signal,
  );
  return units
    .filter((unit) => Boolean(unit.deletedAt))
    .map(unitFromWire);
}

export function restoreDeletedUnit(
  api: ApiClient,
  unit: Pick<Unit, "id" | "revision">,
): Promise<ApiSuccess<WireUnit>> {
  return api.post(
    `/v1/units/${encodeURIComponent(unit.id)}/restore`,
    { expectedRevision: unit.revision ?? 1 },
  );
}

function stripPersistedImageSources(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPersistedImageSources);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const next = Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, stripPersistedImageSources(child)]),
  );
  if (record.type === "meoi-image") next.src = "";
  return next;
}

function parseLexicalContent(content: string | undefined): unknown {
  if (!content) return {};
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? stripPersistedImageSources(parsed)
      : {};
  } catch {
    return {};
  }
}

export function serializeUnitContent(state: WorkspaceState, unitId: string) {
  const itemsFor = (kind: StudyKind) => state.studyItemOrder
    .map((id) => state.studyItems[id])
    .filter((item): item is StudyItem => Boolean(item && item.unitId === unitId && item.kind === kind))
    .map((item) => ({
      text: item.text,
      translation: item.translation,
      ...(item.notes ? { notes: item.notes } : {}),
    }));
  return {
    words: itemsFor("word"),
    phrases: itemsFor("phrase"),
    sentences: itemsFor("sentence"),
    documents: state.documentOrder
      .map((id) => state.documents[id])
      .filter((document): document is Document => Boolean(document && document.unitId === unitId))
      .map((document) => ({
        title: document.title,
        type: document.type,
        body: document.body,
        content: parseLexicalContent(document.content),
      })),
  };
}
