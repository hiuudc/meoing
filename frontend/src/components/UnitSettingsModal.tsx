import { AlertTriangle, FileClock, LoaderCircle, RotateCcw, Settings, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { apiErrorMessage, type ApiClient } from "../api/client";
import { listUnitRevisions, restoreUnitRevision, type UnitRevisionSummary } from "../api/unitRevisions";
import type { Unit } from "../types";
import { cleanUnitName } from "../unit";
import { AnimatedModal } from "./AnimatedModal";

type UnitSettingsTab = "details" | "revisions" | "danger";

interface UnitSettingsModalProps {
  api: ApiClient;
  unit: Unit;
  canEdit: boolean;
  canDelete: boolean;
  onClose: () => void;
  onSaveDetails: (fields: { name: string; description: string; instructionOverride: string }) => Promise<void>;
  onDelete: () => void | Promise<void>;
  onChanged: () => void | Promise<void>;
}

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function actionLabel(action: UnitRevisionSummary["action"]): string {
  return {
    created: "Created",
    updated: "Updated",
    restored: "Restored",
    deleted: "Deleted",
    undeleted: "Restored from deletion",
  }[action];
}

export function UnitSettingsModal({
  api,
  unit,
  canEdit,
  canDelete,
  onClose,
  onSaveDetails,
  onDelete,
  onChanged,
}: UnitSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<UnitSettingsTab>("details");
  const [name, setName] = useState(cleanUnitName(unit.name));
  const [description, setDescription] = useState(unit.description);
  const [instructionOverride, setInstructionOverride] = useState(unit.instructionOverride ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<UnitRevisionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [restoringRevision, setRestoringRevision] = useState<number | null>(null);

  useEffect(() => {
    setName(cleanUnitName(unit.name));
    setDescription(unit.description);
    setInstructionOverride(unit.instructionOverride ?? "");
    setActiveTab("details");
    setError(null);
    setRevisions([]);
    setNextCursor(null);
  }, [unit]);

  useEffect(() => {
    if (activeTab !== "revisions") return;
    const controller = new AbortController();
    setRevisionsLoading(true);
    setError(null);
    void listUnitRevisions(api, unit.id, null, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setRevisions(response.data.items);
        setNextCursor(response.data.nextCursor);
      })
      .catch((loadError) => {
        if (!(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setError(apiErrorMessage(loadError));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setRevisionsLoading(false);
      });
    return () => controller.abort();
  }, [activeTab, api, unit.id]);

  async function saveDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || saving) return;
    if (!name.trim()) {
      setError("A unit name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSaveDetails({
        name: name.trim(),
        description: description.trim(),
        instructionOverride: instructionOverride.trim(),
      });
    } catch (saveError) {
      setError(apiErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function restoreRevision(revision: number) {
    if (!canEdit || restoringRevision !== null) return;
    if (!window.confirm(`Restore revision ${revision}? The current unit will remain in revision history.`)) return;
    setRestoringRevision(revision);
    setError(null);
    try {
      await restoreUnitRevision(api, unit.id, revision, unit.revision ?? 1);
      await onChanged();
      onClose();
    } catch (restoreError) {
      setError(apiErrorMessage(restoreError));
    } finally {
      setRestoringRevision(null);
    }
  }

  async function loadMoreRevisions() {
    if (!nextCursor || revisionsLoading) return;
    setRevisionsLoading(true);
    setError(null);
    try {
      const response = await listUnitRevisions(api, unit.id, nextCursor);
      setRevisions((current) => [...current, ...response.data.items]);
      setNextCursor(response.data.nextCursor);
    } catch (loadError) {
      setError(apiErrorMessage(loadError));
    } finally {
      setRevisionsLoading(false);
    }
  }

  return (
    <AnimatedModal
      open
      onClose={onClose}
      labelledBy="unit-settings-title"
      backdropClassName="modal-backdrop collection-admin-backdrop"
      panelClassName="collection-admin-modal unit-settings-modal"
    >
      <div className="collection-admin-shell">
        <header className="collection-admin-header">
          <div>
            <p>Unit settings</p>
            <h2 id="unit-settings-title">{cleanUnitName(unit.name)}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close unit settings" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="collection-admin-layout">
          <nav className="collection-admin-tabs" aria-label="Unit settings" role="tablist">
            <button type="button" role="tab" aria-selected={activeTab === "details"} className={activeTab === "details" ? "is-active" : undefined} onClick={() => setActiveTab("details")}>
              <Settings size={17} /><span>Details</span>
            </button>
            <button type="button" role="tab" aria-selected={activeTab === "revisions"} className={activeTab === "revisions" ? "is-active" : undefined} onClick={() => setActiveTab("revisions")}>
              <FileClock size={17} /><span>Revision history</span>
            </button>
            {canDelete ? <button type="button" role="tab" aria-selected={activeTab === "danger"} className={activeTab === "danger" ? "is-active" : undefined} onClick={() => setActiveTab("danger")}>
              <AlertTriangle size={17} /><span>Danger zone</span>
            </button> : null}
          </nav>

          <main className="collection-admin-content" role="tabpanel">
            {error ? <p className="collection-admin-message is-error" role="alert">{error}</p> : null}
            {activeTab === "details" ? (
              <section className="collection-admin-section">
                <div className="collection-admin-section-heading">
                  <div><h3>Unit details</h3><p>Update the title and learning instructions for this unit.</p></div>
                </div>
                <form className="collection-admin-card collection-admin-form-grid" onSubmit={(event) => void saveDetails(event)}>
                  <label className="collection-admin-form-wide">Unit name
                    <input value={name} onChange={(event) => setName(event.target.value)} disabled={!canEdit || saving} autoFocus />
                  </label>
                  <label className="collection-admin-form-wide">Description
                    <textarea value={description} onChange={(event) => setDescription(event.target.value)} disabled={!canEdit || saving} rows={4} />
                  </label>
                  <label className="collection-admin-form-wide">Unit-specific learning request
                    <textarea value={instructionOverride} onChange={(event) => setInstructionOverride(event.target.value)} disabled={!canEdit || saving} rows={4} />
                  </label>
                  {canEdit ? <div className="collection-admin-actions collection-admin-form-wide"><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving..." : "Save changes"}</button></div> : <p className="collection-admin-readonly-note collection-admin-form-wide">You can view these details, but editing is not enabled for your profile.</p>}
                </form>
              </section>
            ) : null}
            {activeTab === "revisions" ? (
              <section className="collection-admin-section">
                <div className="collection-admin-section-heading"><div><h3>Revision history</h3><p>Restore a retained snapshot without removing later history.</p></div></div>
                {revisionsLoading && !revisions.length ? <div className="collection-admin-loading" role="status"><LoaderCircle className="spin" size={18} /> Loading revision history...</div> : null}
                {!revisionsLoading && !revisions.length ? <p className="collection-admin-empty">No retained revisions were returned.</p> : null}
                <ol className="unit-revisions-list">
                  {revisions.map((revision) => <li key={revision.id}>
                    <span className="unit-revision-icon" aria-hidden="true"><FileClock size={16} /></span>
                    <div><strong>Revision {revision.revision}</strong><span>{actionLabel(revision.action)} · {DATE_FORMATTER.format(new Date(revision.createdAt))}</span></div>
                    {canEdit && revision.revision !== unit.revision ? <button className="secondary-button" type="button" disabled={restoringRevision !== null} onClick={() => void restoreRevision(revision.revision)}>{restoringRevision === revision.revision ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}Restore</button> : <small>{revision.revision === unit.revision ? "Current" : "View only"}</small>}
                  </li>)}
                </ol>
                {nextCursor ? <button className="secondary-button unit-revisions-more" type="button" disabled={revisionsLoading} onClick={() => void loadMoreRevisions()}>{revisionsLoading ? "Loading..." : "Load older revisions"}</button> : null}
              </section>
            ) : null}
            {activeTab === "danger" && canDelete ? (
              <section className="collection-admin-section">
                <div className="collection-admin-section-heading"><div><h3>Danger zone</h3><p>Deleting a unit removes it from the collection but retains it for 30 days.</p></div></div>
                <div className="collection-admin-card collection-admin-danger-zone"><div><h4>Delete unit</h4><p>Its documents, study material, and saved lessons are retained for restoration.</p></div><button className="collection-admin-danger" type="button" onClick={() => void onDelete()}><Trash2 size={16} />Delete unit</button></div>
              </section>
            ) : null}
          </main>
        </div>
      </div>
    </AnimatedModal>
  );
}
