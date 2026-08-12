import { History, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { apiErrorMessage, type ApiClient } from "../api/client";
import {
  listUnitRevisions,
  restoreUnitRevision,
  type UnitRevisionSummary,
} from "../api/unitRevisions";
import type { Unit } from "../types";
import { AnimatedModal } from "./AnimatedModal";

interface UnitRevisionsModalProps {
  api: ApiClient;
  unit: Unit;
  canRestore: boolean;
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

function actionLabel(action: UnitRevisionSummary["action"]): string {
  return {
    created: "Created",
    updated: "Updated",
    restored: "Restored",
    deleted: "Deleted",
    undeleted: "Restored from deletion",
  }[action];
}

export function UnitRevisionsModal({
  api,
  unit,
  canRestore,
  onClose,
  onRestored,
}: UnitRevisionsModalProps) {
  const [items, setItems] = useState<UnitRevisionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [restoringRevision, setRestoringRevision] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listUnitRevisions(api, unit.id, null, controller.signal)
      .then((response) => {
        setItems(response.data.items);
        setNextCursor(response.data.nextCursor);
      })
      .catch((loadError) => {
        if (!(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setError(apiErrorMessage(loadError));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, unit.id]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await listUnitRevisions(api, unit.id, nextCursor);
      setItems((current) => [...current, ...response.data.items]);
      setNextCursor(response.data.nextCursor);
    } catch (loadError) {
      setError(apiErrorMessage(loadError));
    } finally {
      setLoadingMore(false);
    }
  }

  async function restore(revision: number) {
    if (!canRestore || restoringRevision !== null) return;
    if (!window.confirm(
      `Restore revision ${revision}? A new revision will be created; current content remains in history.`,
    )) return;
    setRestoringRevision(revision);
    setError(null);
    try {
      await restoreUnitRevision(api, unit.id, revision, unit.revision ?? 1);
      await onRestored();
      onClose();
    } catch (restoreError) {
      setError(apiErrorMessage(restoreError));
    } finally {
      setRestoringRevision(null);
    }
  }

  return (
    <AnimatedModal
      open
      onClose={onClose}
      labelledBy="unit-revisions-title"
      backdropClassName="modal-backdrop unit-revisions-backdrop"
      panelClassName="unit-revisions-modal"
    >
      <header className="unit-revisions-header">
        <div>
          <p>Retained snapshots</p>
          <h2 id="unit-revisions-title">Revision history · {unit.name}</h2>
        </div>
        <button className="icon-button" type="button" aria-label="Close revision history" onClick={onClose}>
          <X size={20} />
        </button>
      </header>

      <div className="unit-revisions-body">
        {error ? <p className="collection-admin-inline-error" role="alert">{error}</p> : null}
        {loading ? (
          <div className="collection-admin-loading" role="status">
            <LoaderCircle className="spin" size={18} />
            Loading revision history…
          </div>
        ) : null}
        {!loading && !items.length ? (
          <p className="collection-admin-empty">No retained revisions were returned.</p>
        ) : null}
        <ol className="unit-revisions-list">
          {items.map((revision) => (
            <li key={revision.id}>
              <span className="unit-revision-icon" aria-hidden="true"><History size={16} /></span>
              <div>
                <strong>Revision {revision.revision}</strong>
                <span>{actionLabel(revision.action)} · {DATE_FORMATTER.format(new Date(revision.createdAt))}</span>
              </div>
              {canRestore && revision.revision !== unit.revision ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={restoringRevision !== null}
                  onClick={() => void restore(revision.revision)}
                >
                  {restoringRevision === revision.revision
                    ? <LoaderCircle className="spin" size={15} />
                    : <RotateCcw size={15} />}
                  Restore
                </button>
              ) : (
                <small>{revision.revision === unit.revision ? "Current" : "View only"}</small>
              )}
            </li>
          ))}
        </ol>
        {nextCursor ? (
          <button
            className="secondary-button unit-revisions-more"
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? <LoaderCircle className="spin" size={15} /> : null}
            Load older revisions
          </button>
        ) : null}
      </div>
    </AnimatedModal>
  );
}
