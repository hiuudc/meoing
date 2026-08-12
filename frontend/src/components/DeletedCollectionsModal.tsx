import { ArchiveRestore, LoaderCircle, Trash2, X } from "lucide-react";
import { useState } from "react";
import { apiErrorMessage, type ApiClient } from "../api/client";
import type { Collection } from "../types";
import { AnimatedModal } from "./AnimatedModal";

interface DeletedCollectionsModalProps {
  api: ApiClient;
  collections: Collection[];
  onClose: () => void;
  onRestored: () => void | Promise<void>;
}

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function DeletedCollectionsModal({
  api,
  collections,
  onClose,
  onRestored,
}: DeletedCollectionsModalProps) {
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function restore(collection: Collection) {
    if (restoringId) return;
    if (!window.confirm(`Restore "${collection.name}" and its retained content?`)) return;
    setRestoringId(collection.id);
    setError(null);
    try {
      await api.post(
        `/v1/collections/${encodeURIComponent(collection.id)}/restore`,
        { expectedRevision: collection.revision ?? 1 },
      );
      await onRestored();
      onClose();
    } catch (restoreError) {
      setError(apiErrorMessage(restoreError));
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <AnimatedModal
      open
      onClose={onClose}
      labelledBy="deleted-collections-title"
      backdropClassName="modal-backdrop unit-revisions-backdrop"
      panelClassName="unit-revisions-modal"
    >
      <header className="unit-revisions-header">
        <div>
          <p>30-day recovery window</p>
          <h2 id="deleted-collections-title">Recently deleted collections</h2>
        </div>
        <button className="icon-button" type="button" aria-label="Close deleted collections" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="unit-revisions-body">
        {error ? <p className="collection-admin-inline-error" role="alert">{error}</p> : null}
        {!collections.length ? (
          <div className="deleted-collections-empty">
            <Trash2 size={22} aria-hidden="true" />
            <p>No restorable collections.</p>
          </div>
        ) : (
          <ol className="unit-revisions-list">
            {collections.map((collection) => (
              <li key={collection.id}>
                <span className="unit-revision-icon" aria-hidden="true"><Trash2 size={16} /></span>
                <div>
                  <strong>{collection.name}</strong>
                  <span>
                    Deleted {collection.deletedAt
                      ? DATE_FORMATTER.format(new Date(collection.deletedAt))
                      : "recently"}
                  </span>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={restoringId !== null}
                  onClick={() => void restore(collection)}
                >
                  {restoringId === collection.id
                    ? <LoaderCircle className="spin" size={15} />
                    : <ArchiveRestore size={15} />}
                  Restore
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </AnimatedModal>
  );
}
