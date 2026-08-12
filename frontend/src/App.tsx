import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { ApiError, apiErrorMessage } from "./api/client";
import { prepareLexicalDocumentForStorage } from "./api/files";
import { upsertSetting } from "./api/settings";
import { loadCloudWorkspace, loadDeletedCollections, serializeUnitContent } from "./api/workspace";
import { useAuth } from "./auth/AuthProvider";
import { AccountMenu } from "./auth/AccountMenu";
import { CollectionAdminModal, type AdminTab, type CollectionDetailsDraft } from "./components/CollectionAdminModal";
import { CollectionRail } from "./components/CollectionRail";
import { ContentWorkspace } from "./components/ContentWorkspace";
import { DeletedCollectionsModal } from "./components/DeletedCollectionsModal";
import { EntityEditorModal, type EditorState } from "./components/EntityEditorModal";
import { InviteAcceptanceModal } from "./components/InviteAcceptanceModal";
import { OverviewPanel } from "./components/OverviewPanel";
import { LearningWorkspace } from "./components/LearningWorkspace";
import { LettersWorkspace } from "./components/LettersWorkspace";
import { ThemeCustomizerDrawer } from "./components/ThemeCustomizerDrawer";
import { UnitSettingsModal } from "./components/UnitSettingsModal";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { WorkspacePlaceholderSidebar } from "./components/WorkspacePlaceholderSidebar";
import { WorkspaceStatusContent } from "./components/WorkspaceStatusContent";
import { WorkspaceStatusShell } from "./components/WorkspaceStatusShell";
import { normalizeLearningProfile } from "./learning/profile";
import { getSupportedLanguage } from "./learning/languages";
import { createEmptyWorkspaceState, makeId, workspaceReducer } from "./store";
import { accentStyle, cloneTheme, reconcileThemeSelection, themeStyle } from "./theme";
import type {
  Collection,
  CollectionPermission,
  Document,
  StudyItem,
  StudyKind,
  Unit,
  WorkspaceAction,
} from "./types";
import { cleanUnitName } from "./unit";
import type { WorkspaceMode } from "./components/WorkspaceModeSwitch";

export function App() {
  const auth = useAuth();
  const api = auth.api;
  const [state, dispatch] = useReducer(workspaceReducer, undefined, createEmptyWorkspaceState);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorExpectedRevision, setEditorExpectedRevision] = useState<number | null>(null);
  const [collectionAccentPreview, setCollectionAccentPreview] = useState<string | null>(null);
  const [appearanceDraft, setAppearanceDraft] = useState<ReturnType<typeof cloneTheme> | null>(null);
  const [themeDraft, setThemeDraft] = useState<ReturnType<typeof cloneTheme> | null>(null);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [sidebarWidthDraft, setSidebarWidthDraft] = useState<number | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("library");
  const [collectionAdminState, setCollectionAdminState] = useState<{ collectionId: string; tab: AdminTab } | null>(null);
  const [deletedCollections, setDeletedCollections] = useState<Collection[]>([]);
  const [deletedCollectionsOpen, setDeletedCollectionsOpen] = useState(false);
  const [unitSettingsUnit, setUnitSettingsUnit] = useState<Unit | null>(null);
  const [pendingInviteToken, setPendingInviteToken] = useState<string | null>(() => (
    new URLSearchParams(window.location.search).get("invite")
  ));

  const refreshWorkspace = useCallback(async () => {
    if (!api) return;
    setWorkspaceLoading(true);
    try {
      const [nextState, nextDeletedCollections] = await Promise.all([
        loadCloudWorkspace(api),
        loadDeletedCollections(api).catch(() => []),
      ]);
      dispatch({ type: "hydrate", state: nextState });
      setDeletedCollections(nextDeletedCollections);
      setWorkspaceError(null);
    } catch (error) {
      setWorkspaceError(apiErrorMessage(error));
    } finally {
      setWorkspaceLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  useEffect(() => {
    if (!pendingInviteToken) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("invite")) return;
    url.searchParams.delete("invite");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [pendingInviteToken]);

  useEffect(() => {
    if (
      !mobileNavigationOpen
      || editor
      || collectionAdminState
      || deletedCollectionsOpen
      || unitSettingsUnit
      || pendingInviteToken
      || appearanceDraft
      || themeDraft
    ) return;
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileNavigationOpen(false);
    }
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [
    appearanceDraft,
    collectionAdminState,
    deletedCollectionsOpen,
    editor,
    mobileNavigationOpen,
    pendingInviteToken,
    themeDraft,
    unitSettingsUnit,
  ]);

  const collections = useMemo(
    () => state.collectionOrder.map((id) => state.collections[id]).filter(Boolean),
    [state.collectionOrder, state.collections],
  );
  const activeCollection = state.collections[state.activeCollectionId] ?? collections[0];
  const collectionAdminCollection = collectionAdminState
    ? state.collections[collectionAdminState.collectionId]
    : activeCollection;
  const activeLearningProfile = useMemo(
    () => normalizeLearningProfile(activeCollection?.learningProfile),
    [activeCollection?.learningProfile],
  );
  const units = useMemo(
    () => state.unitOrder.map((id) => state.units[id]).filter((unit) => unit?.collectionId === activeCollection?.id),
    [activeCollection?.id, state.unitOrder, state.units],
  );
  const activeUnit = state.units[state.activeUnitId];
  const documents = useMemo(
    () => state.documentOrder.map((id) => state.documents[id]).filter((document) => document?.unitId === activeUnit?.id),
    [activeUnit?.id, state.documentOrder, state.documents],
  );
  const unitStudyItems = useMemo(
    () => state.studyItemOrder.map((id) => state.studyItems[id]).filter((item) => item?.unitId === activeUnit?.id),
    [activeUnit?.id, state.studyItemOrder, state.studyItems],
  );
  const collectionUnitIds = useMemo(() => new Set(units.map((unit) => unit.id)), [units]);
  const collectionStudyItems = useMemo(
    () => state.studyItemOrder
      .map((id) => state.studyItems[id])
      .filter((item) => item && collectionUnitIds.has(item.unitId)),
    [collectionUnitIds, state.studyItemOrder, state.studyItems],
  );
  const visibleStudyItems = useMemo(
    () => unitStudyItems.filter((item) => item.kind === state.activeKind),
    [state.activeKind, unitStudyItems],
  );
  const recentWords = useMemo(
    () => unitStudyItems.filter((item) => item.kind === "word"),
    [unitStudyItems],
  );
  const hasPermission = useCallback((
    collection: Collection | undefined,
    permission: CollectionPermission,
  ) => Boolean(collection?.effectivePermissions?.includes(permission)), []);
  const canManageCollection = hasPermission(activeCollection, "manage_collection");
  const canCreateContent = hasPermission(activeCollection, "create_content");
  const canEditContent = hasPermission(activeCollection, "edit_content");
  const canDeleteContent = hasPermission(activeCollection, "delete_content");
  const canCreateLessons = hasPermission(activeCollection, "create_lessons");

  function confirmDelete(label: string, callback: () => void | Promise<void>) {
    if (window.confirm(`Delete "${label}"? It can be restored for 30 days.`)) void callback();
  }

  function createContent() {
    if (!activeUnit) return;
    if (state.activeKind === "document") openEditor({ type: "document", unitId: activeUnit.id });
    else openEditor({ type: "studyItem", unitId: activeUnit.id, kind: state.activeKind });
  }

  function openEditor(nextEditor: EditorState) {
    setCollectionAccentPreview(null);
    if (nextEditor.type === "collection" || nextEditor.type === "unit") {
      setEditorExpectedRevision(nextEditor.value?.revision ?? null);
    } else {
      setEditorExpectedRevision(state.units[nextEditor.unitId]?.revision ?? null);
    }
    setEditor(nextEditor);
  }

  function closeEditor() {
    setCollectionAccentPreview(null);
    setEditorExpectedRevision(null);
    setEditor(null);
  }

  async function saveCollectionSetting(collectionId: string, key: string, value: unknown) {
    if (!api) throw new Error("The API is not available.");
    await upsertSetting(api, { scope: "collection", collectionId }, key, value);
  }

  async function saveUserSetting(key: string, value: unknown) {
    if (!api) throw new Error("The API is not available.");
    await upsertSetting(api, { scope: "user" }, key, value);
  }

  function openCollectionAdministration(collectionId: string, tab: AdminTab = "details") {
    setCollectionAdminState({ collectionId, tab });
    closeMobileNavigation();
  }

  async function saveCollectionDetails(collection: Collection, details: CollectionDetailsDraft) {
    if (!api) throw new Error("The API is not available.");
    const currentProfile = normalizeLearningProfile(collection.learningProfile);
    const learningProfile = normalizeLearningProfile({
      ...currentProfile,
      targetLanguage: details.targetLanguage,
      sourceLanguage: getSupportedLanguage(details.sourceLanguage)?.name ?? currentProfile.sourceLanguage,
    });
    await api.patch(`/v1/collections/${encodeURIComponent(collection.id)}`, {
      name: details.name,
      description: collection.description ?? "",
      expectedRevision: collection.revision ?? 1,
    });
    await Promise.all([
      saveCollectionSetting(collection.id, "appearance", { icon: details.icon, accent: details.accent }),
      saveCollectionSetting(collection.id, "learningProfile", learningProfile),
    ]);
    await refreshWorkspace();
  }

  async function saveUnitDetails(
    unit: Unit,
    fields: { name: string; description: string; instructionOverride: string },
  ) {
    if (!api) throw new Error("The API is not available.");
    await api.patch(`/v1/units/${encodeURIComponent(unit.id)}`, {
      name: fields.name,
      description: fields.description,
      instructionOverride: fields.instructionOverride,
      languageCode: unit.languageCode ?? "und",
      expectedRevision: unit.revision ?? 1,
      ...serializeUnitContent(state, unit.id),
    });
    await refreshWorkspace();
  }

  async function submitEditor(fields: Record<string, string>): Promise<string | null> {
    if (!editor) return "The editor is no longer available.";
    if (!api) return "The API is not available.";
    try {
      if (editor.type === "collection") {
        const currentProfile = normalizeLearningProfile(editor.value?.learningProfile);
        const learningProfile = normalizeLearningProfile({
          ...currentProfile,
          targetLanguage: fields.targetLanguage,
          sourceLanguage: getSupportedLanguage(fields.sourceLanguage)?.name ?? currentProfile.sourceLanguage,
        });
        if (editor.value) {
          await api.patch(`/v1/collections/${encodeURIComponent(editor.value.id)}`, {
            name: fields.name.trim(),
            description: editor.value.description ?? "",
            expectedRevision: editorExpectedRevision ?? editor.value.revision ?? 1,
          });
          await Promise.all([
            saveCollectionSetting(editor.value.id, "appearance", {
              icon: fields.icon.trim(),
              accent: fields.accent,
            }),
            saveCollectionSetting(editor.value.id, "learningProfile", learningProfile),
          ]);
        } else {
          await api.post<{ id: string }>("/v1/collections", {
            name: fields.name.trim(),
            description: "",
            appearance: {
              icon: fields.icon.trim(),
              accent: fields.accent,
            },
            learningProfile,
          }, crypto.randomUUID());
        }
      } else if (editor.type === "unit") {
        const collectionId = editor.value?.collectionId ?? editor.collectionId;
        const collection = state.collections[collectionId];
        const targetLanguage = normalizeLearningProfile(collection?.learningProfile).targetLanguage;
        const languageCode = getSupportedLanguage(targetLanguage)?.locale.split("-")[0] ?? "und";
        if (editor.value) {
          await api.patch(`/v1/units/${encodeURIComponent(editor.value.id)}`, {
            name: fields.name.trim(),
            description: fields.description.trim(),
            instructionOverride: fields.instructionOverride.trim(),
            languageCode,
            expectedRevision: editorExpectedRevision ?? editor.value.revision ?? 1,
            ...serializeUnitContent(state, editor.value.id),
          });
        } else {
          await api.post(`/v1/collections/${encodeURIComponent(collectionId)}/units`, {
            name: fields.name.trim(),
            description: fields.description.trim(),
            instructionOverride: fields.instructionOverride.trim(),
            languageCode,
            words: [],
            phrases: [],
            sentences: [],
            documents: [],
          }, crypto.randomUUID());
        }
      } else {
        let action: WorkspaceAction;
        const unitId = editor.value?.unitId ?? editor.unitId;
        if (editor.type === "document") {
          const rawContent = fields.content.trim();
          const content = rawContent
            ? await prepareLexicalDocumentForStorage(rawContent)
            : "";
          const document: Document = {
            id: editor.value?.id ?? makeId("document"),
            unitId,
            sourceIndex: editor.value?.sourceIndex,
            title: fields.title.trim(),
            type: fields.documentType.trim(),
            body: fields.body.trim(),
            ...(content ? { content } : {}),
            updatedAt: "Just now",
          };
          action = { type: editor.value ? "updateDocument" : "createDocument", document };
        } else {
          const item: StudyItem = {
            id: editor.value?.id ?? makeId(editor.kind),
            unitId,
            sourceIndex: editor.value?.sourceIndex,
            kind: editor.value?.kind ?? editor.kind,
            text: fields.text.trim(),
            translation: fields.translation.trim(),
            notes: fields.notes.trim(),
            updatedAt: "Just now",
          };
          action = { type: editor.value ? "updateStudyItem" : "createStudyItem", item };
        }
        const nextState = workspaceReducer(state, action);
        const unit = state.units[unitId];
        await api.patch(`/v1/units/${encodeURIComponent(unitId)}`, {
          name: unit.name,
          description: unit.description,
          instructionOverride: unit.instructionOverride ?? "",
          languageCode: unit.languageCode ?? "und",
          expectedRevision: editorExpectedRevision ?? unit.revision ?? 1,
          ...serializeUnitContent(nextState, unitId),
        });
      }
      await refreshWorkspace();
      closeEditor();
      return null;
    } catch (error) {
      if (error instanceof ApiError && error.code === "REVISION_CONFLICT") {
        await refreshWorkspace();
        return "Another teacher changed this resource. Saving this stale draft is blocked so it cannot overwrite a different JSON item. Copy your entered changes, close the editor, reopen the latest item, and merge them there.";
      }
      return apiErrorMessage(error);
    }
  }

  async function deleteCollection(collection: Collection) {
    if (!api) return;
    try {
      await api.delete(`/v1/collections/${encodeURIComponent(collection.id)}`, {
        expectedRevision: collection.revision ?? 1,
      });
      await refreshWorkspace();
    } catch (error) {
      setWorkspaceError(apiErrorMessage(error));
    }
  }

  async function deleteUnit(unit: Unit) {
    if (!api) return;
    try {
      await api.delete(`/v1/units/${encodeURIComponent(unit.id)}`, {
        expectedRevision: unit.revision ?? 1,
      });
      await refreshWorkspace();
    } catch (error) {
      setWorkspaceError(apiErrorMessage(error));
    }
  }

  async function updateUnitContent(action: WorkspaceAction, unitId: string) {
    if (!api) return;
    const unit = state.units[unitId];
    if (!unit) return;
    try {
      const nextState = workspaceReducer(state, action);
      await api.patch(`/v1/units/${encodeURIComponent(unitId)}`, {
        name: unit.name,
        description: unit.description,
        instructionOverride: unit.instructionOverride ?? "",
        languageCode: unit.languageCode ?? "und",
        expectedRevision: unit.revision ?? 1,
        ...serializeUnitContent(nextState, unitId),
      });
      await refreshWorkspace();
    } catch (error) {
      if (error instanceof ApiError && error.code === "REVISION_CONFLICT") {
        await refreshWorkspace();
        setWorkspaceError("This unit changed on another device. The latest revision has been loaded.");
      } else {
        setWorkspaceError(apiErrorMessage(error));
      }
    }
  }

  async function updateCollectionProfile(collection: Collection, learningProfile: Collection["learningProfile"]) {
    dispatch({ type: "updateCollection", collection: { ...collection, learningProfile } });
    try {
      await saveCollectionSetting(collection.id, "learningProfile", learningProfile);
    } catch (error) {
      setWorkspaceError(apiErrorMessage(error));
      await refreshWorkspace();
    }
  }

  async function persistTheme(theme: typeof state.theme): Promise<boolean> {
    const normalized = reconcileThemeSelection(theme);
    try {
      await saveUserSetting("theme", normalized);
      dispatch({ type: "applyTheme", theme: normalized });
      return true;
    } catch (error) {
      setWorkspaceError(apiErrorMessage(error));
      return false;
    }
  }

  async function persistUnitOrder(id: string, targetId: string, placement: "before" | "after") {
    const action = { type: "moveUnit", id, targetId, placement } as const;
    const nextState = workspaceReducer(state, action);
    dispatch(action);
    if (!activeCollection) return;
    try {
      const order = nextState.unitOrder.filter((unitId) => nextState.units[unitId]?.collectionId === activeCollection.id);
      if (api) {
        await upsertSetting(
          api,
          { scope: "collection_user", collectionId: activeCollection.id },
          "unitOrder",
          order,
        );
      }
    } catch (error) {
      setWorkspaceError(apiErrorMessage(error));
      await refreshWorkspace();
    }
  }

  function closeMobileNavigation() {
    setMobileNavigationOpen(false);
  }

  function openThemeCustomizer(theme = state.theme) {
    setThemeDraft(cloneTheme(theme));
  }

  function closeThemeCustomizer() {
    setThemeDraft(null);
  }

  function returnThemeCustomizerToAppearance() {
    if (!themeDraft) return;
    setAppearanceDraft(cloneTheme(reconcileThemeSelection(themeDraft)));
    setThemeDraft(null);
  }

  const inviteAcceptanceModal = pendingInviteToken && api ? (
    <InviteAcceptanceModal
      key={pendingInviteToken}
      api={api}
      token={pendingInviteToken}
      turnstileSiteKey={auth.turnstileSiteKey}
      onClose={() => setPendingInviteToken(null)}
      onAccepted={async (collection) => {
        await refreshWorkspace();
        dispatch({ type: "selectCollection", id: collection.id });
        setPendingInviteToken(null);
      }}
    />
  ) : null;

  const sidebarWidth = sidebarWidthDraft ?? state.sidebarWidth;
  const activeTheme = themeDraft ?? appearanceDraft ?? state.theme;
  const accountAppearance = {
    draft: appearanceDraft ?? state.theme,
    onOpen: () => setAppearanceDraft((current) => current ?? cloneTheme(state.theme)),
    onChange: setAppearanceDraft,
    onApply: async (theme: typeof state.theme) => {
      if (await persistTheme(theme)) setAppearanceDraft(null);
    },
    onDiscard: () => {
      setAppearanceDraft(null);
      setThemeDraft(null);
    },
    onOpenCustomizer: openThemeCustomizer,
  };

  if (!activeCollection) {
    return (
      <WorkspaceStatusShell theme={activeTheme} sidebarWidth={sidebarWidth}>
        <CollectionRail
          collections={collections}
          activeId=""
          onSelect={(id) => dispatch({ type: "selectCollection", id })}
          onCreate={() => openEditor({ type: "collection" })}
          createDisabled={workspaceLoading}
          canEdit={(collection) => hasPermission(collection, "manage_collection")}
          canDelete={(collection) => hasPermission(collection, "manage_collection")}
          onEdit={(collection) => openEditor({ type: "collection", value: collection })}
          onDelete={(collection) => confirmDelete(collection.name, () => deleteCollection(collection))}
          deletedCollectionCount={deletedCollections.length}
          onOpenDeletedCollections={() => setDeletedCollectionsOpen(true)}
        />
        <WorkspacePlaceholderSidebar
          loading={workspaceLoading}
          openOnMobile={mobileNavigationOpen}
          onCloseMobile={closeMobileNavigation}
          accountMenu={<AccountMenu appearance={accountAppearance} />}
        />
        <button
          className="mobile-drawer-backdrop"
          data-state={mobileNavigationOpen ? "open" : "closed"}
          type="button"
          aria-label="Close navigation"
          aria-hidden={!mobileNavigationOpen}
          tabIndex={mobileNavigationOpen ? 0 : -1}
          onClick={closeMobileNavigation}
        />
        <WorkspaceStatusContent
          loading={workspaceLoading}
          error={workspaceError}
          onRetry={() => void refreshWorkspace()}
          onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
        />
        {!workspaceLoading ? <EntityEditorModal
            editor={editor}
            onClose={closeEditor}
            onSubmit={submitEditor}
            onAccentPreview={setCollectionAccentPreview}
            targetLanguage="English"
          /> : null}
        {deletedCollectionsOpen && api ? (
          <DeletedCollectionsModal
            api={api}
            collections={deletedCollections}
            onClose={() => setDeletedCollectionsOpen(false)}
            onRestored={refreshWorkspace}
          />
        ) : null}
        {inviteAcceptanceModal}
      </WorkspaceStatusShell>
    );
  }

  const shellStyle = {
    ...themeStyle(activeTheme, activeCollection.accent),
    ...(collectionAccentPreview ? accentStyle(activeTheme, collectionAccentPreview) : {}),
    "--sidebar-width": `${sidebarWidth}px`,
  } as React.CSSProperties;

  return (
    <div className="app-shell" style={shellStyle}>
      {workspaceError ? (
        <div className="workspace-sync-error" role="alert">
          <span>{workspaceError}</span>
          <button type="button" onClick={() => setWorkspaceError(null)}>Dismiss</button>
        </div>
      ) : null}
      <CollectionRail
        collections={collections}
        activeId={activeCollection.id}
        accentPreview={collectionAccentPreview && editor?.type === "collection" && editor.value ? {
          collectionId: editor.value.id,
          accent: collectionAccentPreview,
        } : undefined}
        onSelect={(id) => {
          dispatch({ type: "selectCollection", id });
          closeMobileNavigation();
        }}
        onCreate={() => openEditor({ type: "collection" })}
        canEdit={(collection) => hasPermission(collection, "manage_collection")}
        canDelete={(collection) => hasPermission(collection, "manage_collection")}
        onEdit={(collection) => openCollectionAdministration(collection.id, "details")}
        onDelete={(collection) => confirmDelete(collection.name, () => deleteCollection(collection))}
        deletedCollectionCount={deletedCollections.length}
        onOpenDeletedCollections={() => setDeletedCollectionsOpen(true)}
      />
      <WorkspaceSidebar
        collection={activeCollection}
        units={units}
        activeUnitId={state.activeUnitId}
        activeKind={state.activeKind}
        mode={workspaceMode}
        sidebarWidth={sidebarWidth}
        openOnMobile={mobileNavigationOpen}
        onCloseMobile={closeMobileNavigation}
        onSelectKind={(kind) => {
          dispatch({ type: "selectKind", kind });
          setWorkspaceMode("library");
          closeMobileNavigation();
        }}
        onSelectUnit={(id) => {
          dispatch({ type: "selectUnit", id });
          closeMobileNavigation();
        }}
        onOpenLessons={(unitId) => {
          dispatch({ type: "selectUnit", id: unitId });
          setWorkspaceMode("learn");
          closeMobileNavigation();
        }}
        onCreateUnit={() => openEditor({ type: "unit", collectionId: activeCollection.id })}
        onOpenUnitSettings={(unit) => {
          setUnitSettingsUnit(unit);
          closeMobileNavigation();
        }}
        onDeleteUnit={(unit) => confirmDelete(cleanUnitName(unit.name), () => deleteUnit(unit))}
        onMoveUnit={(id, targetId, placement) => void persistUnitOrder(id, targetId, placement)}
        onOpenCollectionAdmin={() => openCollectionAdministration(activeCollection.id, "details")}
        accountMenu={<AccountMenu appearance={accountAppearance} />}
        canCreateUnit={canCreateContent}
        canEditUnit={canEditContent}
        canDeleteUnit={canDeleteContent}
        canManageCollection={canManageCollection}
        onSidebarResize={setSidebarWidthDraft}
        onSidebarResizeEnd={(width) => {
          dispatch({ type: "setSidebarWidth", width });
          setSidebarWidthDraft(null);
          void saveUserSetting("sidebarWidth", width).catch((error) => setWorkspaceError(apiErrorMessage(error)));
        }}
      />
      <button
        className="mobile-drawer-backdrop"
        data-state={mobileNavigationOpen ? "open" : "closed"}
        type="button"
        aria-label="Close navigation"
        aria-hidden={!mobileNavigationOpen}
        tabIndex={mobileNavigationOpen ? 0 : -1}
        onClick={closeMobileNavigation}
      />
      {workspaceMode === "library" ? <>
      <ContentWorkspace
        collectionName={activeCollection.name}
        unit={activeUnit}
        activeKind={state.activeKind}
        documents={documents}
        studyItems={visibleStudyItems}
        onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
        onSelectKind={(kind) => dispatch({ type: "selectKind", kind })}
        onCreate={createContent}
        onCreateUnit={() => openEditor({ type: "unit", collectionId: activeCollection.id })}
        canCreate={canCreateContent}
        canCreateUnit={canCreateContent}
        canEdit={canEditContent}
        canDelete={canDeleteContent}
        onEditDocument={(document) => openEditor({ type: "document", value: document, unitId: document.unitId })}
        onDeleteDocument={(document) => confirmDelete(
          document.title,
          () => updateUnitContent({ type: "deleteDocument", id: document.id }, document.unitId),
        )}
        onEditStudyItem={(item) => openEditor({ type: "studyItem", value: item, unitId: item.unitId, kind: item.kind as StudyKind })}
        onDeleteStudyItem={(item) => confirmDelete(
          item.text,
          () => updateUnitContent({ type: "deleteStudyItem", id: item.id }, item.unitId),
        )}
        mode={workspaceMode}
        onModeChange={setWorkspaceMode}
      />
      <OverviewPanel unit={activeUnit} recentWords={recentWords} />
      </> : workspaceMode === "learn" ? (
        <LearningWorkspace
          collection={activeCollection}
          unit={activeUnit}
          documents={documents}
          studyItems={unitStudyItems}
          api={api ?? undefined}
          userId={auth.currentUser?.profile.id}
          mode={workspaceMode}
          onModeChange={setWorkspaceMode}
          onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
          onUpdateProfile={(learningProfile) => void updateCollectionProfile(activeCollection, learningProfile)}
          canCreateLessons={canCreateLessons}
          canDeleteContent={canDeleteContent}
          canManageCollectionProfile={canManageCollection}
        />
      ) : (
        <LettersWorkspace
          collection={activeCollection}
          units={units}
          studyItems={collectionStudyItems}
          api={api ?? undefined}
          userId={auth.currentUser?.profile.id}
          mode={workspaceMode}
          onModeChange={setWorkspaceMode}
          onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
        />
      )}
      <EntityEditorModal
        editor={editor}
        onClose={closeEditor}
        onSubmit={submitEditor}
        onAccentPreview={setCollectionAccentPreview}
        targetLanguage={activeLearningProfile.targetLanguage}
      />
      {collectionAdminState && collectionAdminCollection && api ? (
        <CollectionAdminModal
          collection={collectionAdminCollection}
          api={api}
          currentUserId={auth.currentUser?.profile.id ?? ""}
          effectivePermissions={collectionAdminCollection.effectivePermissions ?? []}
          learningProfile={normalizeLearningProfile(collectionAdminCollection.learningProfile)}
          questionSettings={collectionAdminCollection.questionSettings}
          initialTab={collectionAdminState.tab}
          onSaveDetails={(details) => saveCollectionDetails(collectionAdminCollection, details)}
          onSaveQuestionSettings={async (questionSettings) => {
            await saveCollectionSetting(collectionAdminCollection.id, "questionSettings", questionSettings);
            const currentCollection = state.collections[collectionAdminCollection.id];
            if (currentCollection) {
              dispatch({
                type: "updateCollection",
                collection: { ...currentCollection, questionSettings },
              });
            }
          }}
          onRestoreDeletedUnit={async (unitId) => {
            await refreshWorkspace();
            dispatch({ type: "selectCollection", id: collectionAdminCollection.id });
            dispatch({ type: "selectUnit", id: unitId });
            setWorkspaceMode("library");
          }}
          onClose={() => setCollectionAdminState(null)}
          onChanged={refreshWorkspace}
        />
      ) : null}
      {unitSettingsUnit && api ? (
        <UnitSettingsModal
          api={api}
          unit={unitSettingsUnit}
          canEdit={canEditContent}
          canDelete={canDeleteContent}
          onClose={() => setUnitSettingsUnit(null)}
          onSaveDetails={(fields) => saveUnitDetails(unitSettingsUnit, fields)}
          onDelete={async () => {
            if (!window.confirm(`Delete "${cleanUnitName(unitSettingsUnit.name)}"? It can be restored for 30 days.`)) return;
            await deleteUnit(unitSettingsUnit);
            setUnitSettingsUnit(null);
          }}
          onChanged={refreshWorkspace}
        />
      ) : null}
      {deletedCollectionsOpen && api ? (
        <DeletedCollectionsModal
          api={api}
          collections={deletedCollections}
          onClose={() => setDeletedCollectionsOpen(false)}
          onRestored={refreshWorkspace}
        />
      ) : null}
      {inviteAcceptanceModal}
      <ThemeCustomizerDrawer
        savedTheme={state.theme}
        open={Boolean(themeDraft)}
        draft={themeDraft}
        onChange={setThemeDraft}
        onClose={closeThemeCustomizer}
        onExited={() => undefined}
        onBack={returnThemeCustomizerToAppearance}
        onApply={() => {
          if (!themeDraft) return;
          const draft = themeDraft;
          void persistTheme(draft).then((saved) => {
            if (!saved) return;
            setAppearanceDraft(null);
            setThemeDraft(null);
          });
        }}
      />
    </div>
  );
}
