import {
  BookOpenText,
  ChevronRight,
  FileText,
  Menu,
  MessageSquareQuote,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Type,
} from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import type { ContentKind, Document, StudyItem, Unit } from "../types";
import { cleanUnitName } from "../unit";
import { WorkspaceModeSwitch, type WorkspaceMode } from "./WorkspaceModeSwitch";

const tabs: { kind: ContentKind; label: string; icon: typeof FileText }[] = [
  { kind: "document", label: "Documents", icon: FileText },
  { kind: "word", label: "Words", icon: Type },
  { kind: "phrase", label: "Phrases", icon: MessageSquareQuote },
  { kind: "sentence", label: "Sentences", icon: BookOpenText },
];

const pluralLabel: Record<ContentKind, string> = {
  document: "documents",
  word: "words",
  phrase: "phrases",
  sentence: "sentences",
};

interface ContentWorkspaceProps {
  collectionName: string;
  unit?: Unit;
  activeKind: ContentKind;
  documents: Document[];
  studyItems: StudyItem[];
  onOpenMobileNavigation: () => void;
  onSelectKind: (kind: ContentKind) => void;
  onCreate: () => void;
  onEditDocument: (document: Document) => void;
  onDeleteDocument: (document: Document) => void;
  onEditStudyItem: (item: StudyItem) => void;
  onDeleteStudyItem: (item: StudyItem) => void;
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
}

export function ContentWorkspace({
  collectionName,
  unit,
  activeKind,
  documents,
  studyItems,
  onOpenMobileNavigation,
  onSelectKind,
  onCreate,
  onEditDocument,
  onDeleteDocument,
  onEditStudyItem,
  onDeleteStudyItem,
  mode,
  onModeChange,
}: ContentWorkspaceProps) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

  const visibleDocuments = useMemo(
    () =>
      documents.filter((document) =>
        `${document.title} ${document.type} ${document.body}`.toLowerCase().includes(deferredSearch),
      ),
    [deferredSearch, documents],
  );

  const visibleItems = useMemo(
    () =>
      studyItems.filter((item) =>
        `${item.text} ${item.translation} ${item.notes ?? ""}`.toLowerCase().includes(deferredSearch),
      ),
    [deferredSearch, studyItems],
  );

  const itemCount = activeKind === "document" ? visibleDocuments.length : visibleItems.length;
  const activeLabel = pluralLabel[activeKind];

  return (
    <main className="workspace-main">
      <header className="main-topbar">
        <button className="mobile-nav-trigger" type="button" onClick={onOpenMobileNavigation} aria-label="Open navigation">
          <Menu size={19} />
        </button>
        <WorkspaceModeSwitch mode={mode} onChange={onModeChange} />
        <div className="breadcrumb">
          <span>{collectionName}</span>
          <ChevronRight size={14} />
          <strong>{unit ? cleanUnitName(unit.name) : "No unit selected"}</strong>
        </div>
        <div className="topbar-actions">
          <button className="topbar-icon" type="button" aria-label="Search">
            <Search size={17} />
          </button>
          <button className="topbar-icon" type="button" aria-label="More options">
            <MoreHorizontal size={18} />
          </button>
        </div>
      </header>

      <div className="content-scroll">
        <section className="workspace-content">
          <div className="content-intro">
            <div>
              <p className="section-kicker">Unit workspace</p>
              <h1>{unit ? cleanUnitName(unit.name) : "Choose a unit"}</h1>
              <p>{unit?.description ?? "Select or create a unit to start collecting your study material."}</p>
            </div>
            <button className="primary-button" type="button" onClick={onCreate} disabled={!unit}>
              <Plus size={16} />
              <span>New {activeKind}</span>
            </button>
          </div>

          <div className="content-toolbar">
            <div className="content-tabs" role="tablist" aria-label="Content type">
              {tabs.map(({ kind, label, icon: Icon }) => (
                <button
                  className={kind === activeKind ? "is-active" : ""}
                  type="button"
                  role="tab"
                  aria-selected={kind === activeKind}
                  key={kind}
                  onClick={() => onSelectKind(kind)}
                >
                  <Icon size={15} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <label className="table-search">
              <Search size={15} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label={`Search ${activeLabel}`}
                placeholder={`Search ${activeLabel}`}
              />
            </label>
          </div>

          <div className="list-heading-row">
            <span>{itemCount} {activeLabel}</span>
            <span>Recently updated</span>
          </div>

          {activeKind === "document" ? (
            <DocumentTable documents={visibleDocuments} onEdit={onEditDocument} onDelete={onDeleteDocument} />
          ) : (
            <StudyItemTable items={visibleItems} onEdit={onEditStudyItem} onDelete={onDeleteStudyItem} />
          )}
        </section>
      </div>
    </main>
  );
}

interface DocumentTableProps {
  documents: Document[];
  onEdit: (document: Document) => void;
  onDelete: (document: Document) => void;
}

function DocumentTable({ documents, onEdit, onDelete }: DocumentTableProps) {
  const seededItemCounts: Record<string, number> = {
    "morning-notes": 24,
    "at-cafe": 18,
    "weekday-schedule": 31,
    "useful-verbs": 16,
  };
  if (!documents.length) return <EmptyList label="documents" />;
  return (
    <div className="content-table" role="table" aria-label="Documents">
      <div className="table-header table-document-grid" role="row">
        <span>Document</span>
        <span>Type</span>
        <span>Items</span>
        <span>Updated</span>
        <span />
      </div>
      {documents.map((document, index) => (
        <div className="table-row table-document-grid" role="row" key={document.id}>
          <div className="document-title">
            <span className={`document-icon icon-tone-${index % 4}`}><FileText size={17} /></span>
            <span>
              <strong>{document.title}</strong>
              <small>{document.body}</small>
            </span>
          </div>
          <span className="type-chip">{document.type}</span>
          <span>{seededItemCounts[document.id] ?? 0} items</span>
          <span>{document.updatedAt}</span>
          <RowActions label={document.title} onEdit={() => onEdit(document)} onDelete={() => onDelete(document)} />
        </div>
      ))}
    </div>
  );
}

interface StudyItemTableProps {
  items: StudyItem[];
  onEdit: (item: StudyItem) => void;
  onDelete: (item: StudyItem) => void;
}

function StudyItemTable({ items, onEdit, onDelete }: StudyItemTableProps) {
  if (!items.length) return <EmptyList label="study items" />;
  return (
    <div className="content-table" role="table" aria-label="Study items">
      <div className="table-header table-study-grid" role="row">
        <span>Study item</span>
        <span>Translation</span>
        <span>Notes</span>
        <span>Updated</span>
        <span />
      </div>
      {items.map((item, index) => (
        <div className="table-row table-study-grid" role="row" key={item.id}>
          <div className="document-title">
            <span className={`document-icon icon-tone-${index % 4}`}><Type size={17} /></span>
            <strong>{item.text}</strong>
          </div>
          <span>{item.translation}</span>
          <span className="notes-cell">{item.notes || "No notes yet"}</span>
          <span>{item.updatedAt}</span>
          <RowActions label={item.text} onEdit={() => onEdit(item)} onDelete={() => onDelete(item)} />
        </div>
      ))}
    </div>
  );
}

function RowActions({ label, onEdit, onDelete }: { label: string; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="row-actions">
      <button type="button" aria-label={`Edit ${label}`} onClick={onEdit}><Pencil size={14} /></button>
      <button type="button" aria-label={`Delete ${label}`} onClick={onDelete}><Trash2 size={14} /></button>
    </div>
  );
}

function EmptyList({ label }: { label: string }) {
  return (
    <div className="content-empty">
      <FileText size={22} />
      <h2>No {label} yet</h2>
      <p>Create the first one to begin shaping this unit.</p>
    </div>
  );
}
