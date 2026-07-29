import { useEffect, useMemo, useReducer, useState } from "react";
import { AppearanceModal } from "./components/AppearanceModal";
import { CollectionRail } from "./components/CollectionRail";
import { CollectionQuestionSettingsModal } from "./components/CollectionQuestionSettingsModal";
import { ContentWorkspace } from "./components/ContentWorkspace";
import { EntityEditorModal, type EditorState } from "./components/EntityEditorModal";
import { OverviewPanel } from "./components/OverviewPanel";
import { LearningWorkspace } from "./components/LearningWorkspace";
import { LettersWorkspace } from "./components/LettersWorkspace";
import { pruneStoredLessonsFromStorage } from "./integration/learningStorage";
import { ThemeCustomizerDrawer } from "./components/ThemeCustomizerDrawer";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { normalizeLearningProfile } from "./learning/profile";
import { getSupportedLanguage } from "./learning/languages";
import { loadWorkspace, makeId, saveWorkspace, workspaceReducer } from "./store";
import { accentStyle, cloneTheme, reconcileThemeSelection, themeStyle } from "./theme";
import type {
  Collection,
  Document,
  StudyItem,
  StudyKind,
  Unit,
  WorkspaceAction,
} from "./types";
import { cleanUnitName } from "./unit";
import type { WorkspaceMode } from "./components/WorkspaceModeSwitch";

export function App() {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, () => loadWorkspace(window.localStorage));
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [collectionAccentPreview, setCollectionAccentPreview] = useState<string | null>(null);
  const [appearanceDraft, setAppearanceDraft] = useState<ReturnType<typeof cloneTheme> | null>(null);
  const [themeDraft, setThemeDraft] = useState<ReturnType<typeof cloneTheme> | null>(null);
  const [pendingAppearanceDraft, setPendingAppearanceDraft] = useState<ReturnType<typeof cloneTheme> | null>(null);
  const [pendingThemeDraft, setPendingThemeDraft] = useState<ReturnType<typeof cloneTheme> | null>(null);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [sidebarWidthDraft, setSidebarWidthDraft] = useState<number | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("library");
  const [questionSettingsCollection, setQuestionSettingsCollection] = useState<Collection | null>(null);

  useEffect(() => {
    saveWorkspace(state, window.localStorage);
  }, [state]);

  useEffect(() => {
    pruneStoredLessonsFromStorage(window.localStorage, new Set(state.unitOrder));
  }, [state.unitOrder]);

  useEffect(() => {
    if (!mobileNavigationOpen || editor || questionSettingsCollection || appearanceDraft || themeDraft || pendingAppearanceDraft || pendingThemeDraft) return;
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileNavigationOpen(false);
    }
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [appearanceDraft, editor, mobileNavigationOpen, pendingAppearanceDraft, pendingThemeDraft, questionSettingsCollection, themeDraft]);

  const collections = useMemo(
    () => state.collectionOrder.map((id) => state.collections[id]).filter(Boolean),
    [state.collectionOrder, state.collections],
  );
  const activeCollection = state.collections[state.activeCollectionId] ?? collections[0];
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

  if (!activeCollection) return null;

  function confirmDelete(label: string, callback: () => void) {
    if (window.confirm(`Delete "${label}"? This cannot be undone.`)) callback();
  }

  function createContent() {
    if (!activeUnit) return;
    if (state.activeKind === "document") openEditor({ type: "document", unitId: activeUnit.id });
    else openEditor({ type: "studyItem", unitId: activeUnit.id, kind: state.activeKind });
  }

  function openEditor(nextEditor: EditorState) {
    setCollectionAccentPreview(null);
    setEditor(nextEditor);
  }

  function closeEditor() {
    setCollectionAccentPreview(null);
    setEditor(null);
  }

  function submitEditor(fields: Record<string, string>): string | null {
    if (!editor) return "The editor is no longer available.";
    let action: WorkspaceAction;
    if (editor.type === "collection") {
      const currentProfile = normalizeLearningProfile(editor.value?.learningProfile);
      const collection: Collection = {
        id: editor.value?.id ?? makeId("collection"),
        name: fields.name.trim(),
        icon: fields.icon.trim(),
        accent: fields.accent,
        learningProfile: normalizeLearningProfile({
          ...currentProfile,
          targetLanguage: fields.targetLanguage,
          sourceLanguage: getSupportedLanguage(fields.sourceLanguage)?.name ?? currentProfile.sourceLanguage,
        }),
        questionSettings: editor.value?.questionSettings,
      };
      action = { type: editor.value ? "updateCollection" : "createCollection", collection };
    } else if (editor.type === "unit") {
      const unit: Unit = {
        id: editor.value?.id ?? makeId("unit"),
        collectionId: editor.value?.collectionId ?? editor.collectionId,
        name: fields.name.trim(),
        description: fields.description.trim(),
        instructionOverride: fields.instructionOverride.trim(),
      };
      action = { type: editor.value ? "updateUnit" : "createUnit", unit };
    } else if (editor.type === "document") {
      const content = fields.content.trim();
      const document: Document = {
        id: editor.value?.id ?? makeId("document"),
        unitId: editor.value?.unitId ?? editor.unitId,
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
        unitId: editor.value?.unitId ?? editor.unitId,
        kind: editor.value?.kind ?? editor.kind,
        text: fields.text.trim(),
        translation: fields.translation.trim(),
        notes: fields.notes.trim(),
        updatedAt: "Just now",
      };
      action = { type: editor.value ? "updateStudyItem" : "createStudyItem", item };
    }
    const saveResult = saveWorkspace(workspaceReducer(state, action), window.localStorage);
    if (!saveResult.ok) return saveResult.message;
    dispatch(action);
    closeEditor();
    return null;
  }

  function closeMobileNavigation() {
    setMobileNavigationOpen(false);
  }

  function closeAppearance() {
    setPendingThemeDraft(null);
    setAppearanceDraft(null);
  }

  function openThemeCustomizer(theme = state.theme) {
    setPendingAppearanceDraft(null);
    setPendingThemeDraft(cloneTheme(theme));
    setAppearanceDraft(null);
  }

  function finishAppearanceExit() {
    if (!pendingThemeDraft) return;
    setThemeDraft(pendingThemeDraft);
    setPendingThemeDraft(null);
  }

  function closeThemeCustomizer() {
    setPendingAppearanceDraft(null);
    setThemeDraft(null);
  }

  function returnThemeCustomizerToAppearance() {
    if (!themeDraft) return;
    setPendingThemeDraft(null);
    setPendingAppearanceDraft(cloneTheme(reconcileThemeSelection(themeDraft)));
    setThemeDraft(null);
  }

  function finishThemeCustomizerExit() {
    if (!pendingAppearanceDraft) return;
    setAppearanceDraft(pendingAppearanceDraft);
    setPendingAppearanceDraft(null);
  }

  const sidebarWidth = sidebarWidthDraft ?? state.sidebarWidth;
  const activeTheme = themeDraft ?? pendingThemeDraft ?? pendingAppearanceDraft ?? appearanceDraft ?? state.theme;
  const shellStyle = {
    ...themeStyle(activeTheme, activeCollection.accent),
    ...(collectionAccentPreview ? accentStyle(activeTheme, collectionAccentPreview) : {}),
    "--sidebar-width": `${sidebarWidth}px`,
  } as React.CSSProperties;

  return (
    <div className="app-shell" style={shellStyle}>
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
        onEdit={(collection) => openEditor({ type: "collection", value: collection })}
        onDelete={(collection) => confirmDelete(collection.name, () => dispatch({ type: "deleteCollection", id: collection.id }))}
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
        onEditUnit={(unit) => openEditor({ type: "unit", value: unit, collectionId: unit.collectionId })}
        onOpenCollectionQuestions={() => {
          setQuestionSettingsCollection(activeCollection);
          closeMobileNavigation();
        }}
        onDeleteUnit={(unit) => confirmDelete(cleanUnitName(unit.name), () => dispatch({ type: "deleteUnit", id: unit.id }))}
        onMoveUnit={(id, targetId, placement) => dispatch({ type: "moveUnit", id, targetId, placement })}
        onOpenAppearance={() => setAppearanceDraft(cloneTheme(state.theme))}
        onSidebarResize={setSidebarWidthDraft}
        onSidebarResizeEnd={(width) => {
          dispatch({ type: "setSidebarWidth", width });
          setSidebarWidthDraft(null);
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
        onEditDocument={(document) => openEditor({ type: "document", value: document, unitId: document.unitId })}
        onDeleteDocument={(document) => confirmDelete(document.title, () => dispatch({ type: "deleteDocument", id: document.id }))}
        onEditStudyItem={(item) => openEditor({ type: "studyItem", value: item, unitId: item.unitId, kind: item.kind as StudyKind })}
        onDeleteStudyItem={(item) => confirmDelete(item.text, () => dispatch({ type: "deleteStudyItem", id: item.id }))}
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
          mode={workspaceMode}
          onModeChange={setWorkspaceMode}
          onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
          onUpdateProfile={(learningProfile) => dispatch({
            type: "updateCollection",
            collection: { ...activeCollection, learningProfile },
          })}
        />
      ) : (
        <LettersWorkspace
          collection={activeCollection}
          units={units}
          studyItems={collectionStudyItems}
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
      <CollectionQuestionSettingsModal
        collection={questionSettingsCollection}
        profile={activeLearningProfile}
        onClose={() => setQuestionSettingsCollection(null)}
        onSave={(questionSettings) => {
          if (!questionSettingsCollection) return;
          const currentCollection = state.collections[questionSettingsCollection.id];
          if (!currentCollection) return;
          dispatch({
            type: "updateCollection",
            collection: { ...currentCollection, questionSettings },
          });
          setQuestionSettingsCollection(null);
        }}
      />
      <AppearanceModal
        open={Boolean(appearanceDraft)}
        draft={appearanceDraft}
        onClose={closeAppearance}
        onExited={finishAppearanceExit}
        onChange={setAppearanceDraft}
        onApply={(theme) => {
          dispatch({ type: "applyTheme", theme: reconcileThemeSelection(theme) });
          setPendingThemeDraft(null);
          setAppearanceDraft(null);
        }}
        onOpenCustomizer={openThemeCustomizer}
      />
      <ThemeCustomizerDrawer
        savedTheme={state.theme}
        open={Boolean(themeDraft)}
        draft={themeDraft}
        onChange={setThemeDraft}
        onClose={closeThemeCustomizer}
        onExited={finishThemeCustomizerExit}
        onBack={returnThemeCustomizerToAppearance}
        onApply={() => {
          if (!themeDraft) return;
          dispatch({ type: "applyTheme", theme: reconcileThemeSelection(themeDraft) });
          setPendingAppearanceDraft(null);
          setThemeDraft(null);
        }}
      />
    </div>
  );
}
