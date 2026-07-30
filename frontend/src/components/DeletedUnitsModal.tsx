import { ArchiveRestore, LoaderCircle, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { apiErrorMessage, type ApiClient } from "../api/client";
import { loadDeletedUnits, restoreDeletedUnit } from "../api/workspace";
import type { Collection, Unit } from "../types";
import { cleanUnitName } from "../unit";
import { AnimatedModal } from "./AnimatedModal";

interface DeletedUnitsModalProps {
  api: ApiClient;
  collection: Collection;
  onClose: () => void;
  onRestored: (unit: Unit) => void | Promise<void>;
}

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function DeletedUnitsModal({
  api,
  collection,
  onClose,
  onRestored,
}: DeletedUnitsModalProps) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setUnits([]);
    setLoading(true);
    setError(null);
    void loadDeletedUnits(api, collection.id, controller.signal)
      .then((deletedUnits) => {
        if (!controller.signal.aborted) setUnits(deletedUnits);
      })
      .catch((loadError) => {
        if (!controller.signal.aborted) setError(apiErrorMessage(loadError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, collection.id]);

  async function restore(unit: Unit) {
    if (restoringId) return;
    if (!window.confirm(`Restore "${cleanUnitName(unit.name)}" and its retained content?`)) return;
    setRestoringId(unit.id);
    setError(null);
    try {
      await restoreDeletedUnit(api, unit);
      await onRestored(unit);
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
      labelledBy="deleted-units-title"
      backdropClassName="modal-backdrop unit-revisions-backdrop"
      panelClassName="unit-revisions-modal"
    >
      <header className="unit-revisions-header">
        <div>
          <p>30-day recovery window</p>
          <h2 id="deleted-units-title">Recently deleted units</h2>
          <span>{collection.name}</span>
        </div>
        <button className="icon-button" type="button" aria-label="Close deleted units" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="unit-revisions-body">
        {error ? <p className="collection-admin-inline-error" role="alert">{error}</p> : null}
        {loading ? (
          <div className="collection-admin-loading" role="status">
            <LoaderCircle className="spin" size={18} />
            Loading deleted units…
          </div>
        ) : !units.length ? (
          <div className="deleted-collections-empty">
            <Trash2 size={22} aria-hidden="true" />
            <p>No restorable units in this collection.</p>
          </div>
        ) : (
          <ol className="unit-revisions-list">
            {units.map((unit) => (
              <li key={unit.id}>
                <span className="unit-revision-icon" aria-hidden="true"><Trash2 size={16} /></span>
                <div>
                  <strong>{cleanUnitName(unit.name)}</strong>
                  <span>
                    Deleted {unit.deletedAt
                      ? DATE_FORMATTER.format(new Date(unit.deletedAt))
                      : "recently"}
                  </span>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={restoringId !== null}
                  onClick={() => void restore(unit)}
                >
                  {restoringId === unit.id
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
