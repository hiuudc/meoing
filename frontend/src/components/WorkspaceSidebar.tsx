import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  FileText,
  GraduationCap,
  MessageSquareQuote,
  MoreHorizontal,
  Palette,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, normalizeSidebarWidth } from "../store";
import type { Collection, ContentKind, Unit } from "../types";
import { cleanUnitName } from "../unit";
import { CONTEXT_MENU_WIDTH, ContextMenu } from "./ContextMenu";
import type { WorkspaceMode } from "./WorkspaceModeSwitch";

const libraryItems: { kind: ContentKind; label: string; icon: typeof FileText }[] = [
  { kind: "document", label: "Documents", icon: FileText },
  { kind: "word", label: "Words", icon: Type },
  { kind: "phrase", label: "Phrases", icon: MessageSquareQuote },
  { kind: "sentence", label: "Sentences", icon: BookOpenText },
];

interface WorkspaceSidebarProps {
  collection: Collection;
  units: Unit[];
  activeUnitId: string;
  activeKind: ContentKind;
  mode: WorkspaceMode;
  sidebarWidth: number;
  openOnMobile: boolean;
  onCloseMobile: () => void;
  onSelectKind: (kind: ContentKind) => void;
  onSelectUnit: (id: string) => void;
  onOpenLessons: (unitId: string) => void;
  onCreateUnit: () => void;
  onEditUnit: (unit: Unit) => void;
  onOpenCollectionQuestions: () => void;
  onDeleteUnit: (unit: Unit) => void;
  onMoveUnit: (id: string, targetId: string, placement: "before" | "after") => void;
  onOpenAppearance: () => void;
  onSidebarResize: (width: number) => void;
  onSidebarResizeEnd: (width: number) => void;
}

interface UnitDragState {
  id: string;
  targetId?: string;
  placement?: "before" | "after";
}

interface UnitDragStart {
  id: string;
  pointerId: number;
  x: number;
  y: number;
  activated: boolean;
}

interface UnitMenuState {
  unit: Unit;
  top: number;
  left: number;
  returnFocus?: HTMLButtonElement | null;
}

export function WorkspaceSidebar({
  collection,
  units,
  activeUnitId,
  activeKind,
  mode,
  sidebarWidth,
  openOnMobile,
  onCloseMobile,
  onSelectKind,
  onSelectUnit,
  onOpenLessons,
  onCreateUnit,
  onEditUnit,
  onOpenCollectionQuestions,
  onDeleteUnit,
  onMoveUnit,
  onOpenAppearance,
  onSidebarResize,
  onSidebarResizeEnd,
}: WorkspaceSidebarProps) {
  const [dragState, setDragState] = useState<UnitDragState | null>(null);
  const [expandedUnitIds, setExpandedUnitIds] = useState(() => new Set(activeUnitId ? [activeUnitId] : []));
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const [unitMenu, setUnitMenu] = useState<UnitMenuState | null>(null);
  const dragStateRef = useRef<UnitDragState | null>(null);
  const dragStartRef = useRef<UnitDragStart | null>(null);
  const suppressUnitClickRef = useRef("");
  const suppressAutoExpandRef = useRef("");
  const resizeStart = useRef<{ pointerId: number; x: number; width: number; nextWidth: number } | null>(null);

  useEffect(() => {
    suppressAutoExpandRef.current = "";
    setUnitMenu(null);
    setExpandedUnitIds(new Set(activeUnitId ? [activeUnitId] : []));
  }, [collection.id]);

  useEffect(() => {
    if (!activeUnitId) return;
    if (suppressAutoExpandRef.current === activeUnitId) {
      suppressAutoExpandRef.current = "";
      return;
    }
    setExpandedUnitIds((current) => {
      if (current.has(activeUnitId)) return current;
      return new Set([...current, activeUnitId]);
    });
  }, [activeUnitId]);

  function updateDragState(next: UnitDragState | null) {
    dragStateRef.current = next;
    setDragState(next);
  }

  function announceMove(id: string, targetId: string, placement: "before" | "after") {
    const unit = units.find((item) => item.id === id);
    const target = units.find((item) => item.id === targetId);
    if (!unit || !target) return;
    setReorderAnnouncement(`Moved ${cleanUnitName(unit.name)} ${placement} ${cleanUnitName(target.name)}.`);
  }

  function moveUnit(id: string, targetId: string, placement: "before" | "after") {
    onMoveUnit(id, targetId, placement);
    announceMove(id, targetId, placement);
  }

  function startUnitDrag(event: React.PointerEvent<HTMLButtonElement>, id: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = {
      id,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      activated: false,
    };
  }

  function updateUnitDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const start = dragStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if (!start.activated) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
      start.activated = true;
      updateDragState({ id: start.id });
    }
    event.preventDefault();
    const current = dragStateRef.current;
    if (!current) return;
    const targetRow = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-unit-id]");
    const targetId = targetRow?.dataset.unitId;
    if (!targetRow || !targetId || targetId === current.id) {
      updateDragState({ id: current.id });
      return;
    }
    const bounds = targetRow.getBoundingClientRect();
    updateDragState({
      id: current.id,
      targetId,
      placement: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    });
  }

  function finishUnitDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const current = dragStateRef.current;
    const start = dragStartRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStartRef.current = null;
    updateDragState(null);
    if (!start?.activated) return;
    suppressUnitClickRef.current = start.id;
    if (current?.targetId && current.placement) moveUnit(current.id, current.targetId, current.placement);
  }

  function cancelUnitDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStartRef.current = null;
    updateDragState(null);
  }

  function moveUnitWithKeyboard(event: React.KeyboardEvent<HTMLButtonElement>, unit: Unit, index: number) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const target = units[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    moveUnit(unit.id, target.id, event.key === "ArrowUp" ? "before" : "after");
  }

  function startSidebarResize(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = { pointerId: event.pointerId, x: event.clientX, width: sidebarWidth, nextWidth: sidebarWidth };
  }

  function updateSidebarResize(event: React.PointerEvent<HTMLButtonElement>) {
    const current = resizeStart.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const nextWidth = normalizeSidebarWidth(current.width + event.clientX - current.x);
    current.nextWidth = nextWidth;
    onSidebarResize(nextWidth);
  }

  function finishSidebarResize(event: React.PointerEvent<HTMLButtonElement>) {
    const current = resizeStart.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeStart.current = null;
    onSidebarResizeEnd(current.nextWidth);
  }

  function resizeSidebarWithKeyboard(event: React.KeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? 32 : 16;
    const nextWidth =
      event.key === "ArrowLeft"
        ? sidebarWidth - step
        : event.key === "ArrowRight"
          ? sidebarWidth + step
          : event.key === "Home"
            ? MIN_SIDEBAR_WIDTH
            : event.key === "End"
              ? MAX_SIDEBAR_WIDTH
              : null;
    if (nextWidth === null) return;
    event.preventDefault();
    onSidebarResizeEnd(normalizeSidebarWidth(nextWidth));
  }

  function openUnitMenu(unit: Unit, left: number, top: number, returnFocus?: HTMLButtonElement | null) {
    setUnitMenu({
      unit,
      top,
      left,
      returnFocus,
    });
  }

  function openUnitMenuFromKeyboard(event: React.KeyboardEvent<HTMLButtonElement>, unit: Unit) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    openUnitMenu(unit, rect.left + 12, rect.bottom + 4, event.currentTarget);
  }

  function toggleUnitExpanded(id: string) {
    setExpandedUnitIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <aside className={`workspace-sidebar ${openOnMobile ? "is-mobile-open" : ""}`} aria-label="Workspace navigation">
      <div className="sidebar-heading">
        <span>{collection.name}</span>
        <ChevronDown size={16} />
        <button
          className="collection-question-settings-button"
          type="button"
          aria-label={`Open question settings for ${collection.name}`}
          onClick={onOpenCollectionQuestions}
        >
          <Settings size={15} />
        </button>
        <button className="mobile-sidebar-close" type="button" onClick={onCloseMobile} aria-label="Close navigation">
          <X size={18} />
        </button>
      </div>
      <label className="sidebar-search">
        <Search size={14} />
        <input aria-label="Find anything" placeholder="Find anything" />
        <kbd>Ctrl K</kbd>
      </label>

      <nav className="sidebar-scroll">
        <p className="sidebar-section-label">Library</p>
        <div className="sidebar-nav-list">
          {libraryItems.map(({ kind, label, icon: Icon }) => (
            <button
              className={`sidebar-nav-row ${mode === "library" && activeKind === kind ? "is-current" : ""}`}
              type="button"
              key={kind}
              onClick={() => onSelectKind(kind)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-section-heading">
          <p className="sidebar-section-label">Units</p>
          <button type="button" aria-label="Add unit" onClick={onCreateUnit}>
            <Plus size={15} />
          </button>
        </div>
        <div className="unit-list">
          {units.length ? (
            units.map((unit, index) => {
              const cleanName = cleanUnitName(unit.name);
              const expanded = expandedUnitIds.has(unit.id);
              const subnavId = `unit-subnav-${encodeURIComponent(unit.id)}`;
              const dropClass =
                dragState?.targetId === unit.id && dragState.placement
                  ? ` is-drop-${dragState.placement}`
                  : "";
              return (
                <div
                  className={`unit-group${dragState?.id === unit.id ? " is-dragging" : ""}${dropClass}`}
                  data-unit-id={unit.id}
                  key={unit.id}
                >
                  <div
                    className={`unit-row-wrap ${activeUnitId === unit.id ? "is-current" : ""}${expanded ? " is-expanded" : ""}${unitMenu?.unit.id === unit.id ? " is-menu-open" : ""}`}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openUnitMenu(unit, event.clientX, event.clientY, event.currentTarget.querySelector<HTMLButtonElement>(".unit-row"));
                    }}
                  >
                    <button
                      className="unit-disclosure-button"
                      type="button"
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${cleanName}`}
                      aria-expanded={expanded}
                      aria-controls={subnavId}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleUnitExpanded(unit.id);
                      }}
                    >
                      <ChevronRight size={14} />
                    </button>
                    <button
                      className="unit-row"
                      type="button"
                      aria-describedby="unit-reorder-instructions"
                      aria-expanded={expanded}
                      aria-controls={subnavId}
                      onClick={() => {
                        if (suppressUnitClickRef.current === unit.id) {
                          suppressUnitClickRef.current = "";
                          return;
                        }
                        suppressAutoExpandRef.current = expanded && activeUnitId !== unit.id ? unit.id : "";
                        toggleUnitExpanded(unit.id);
                        onSelectUnit(unit.id);
                      }}
                      onKeyDown={(event) => {
                        moveUnitWithKeyboard(event, unit, index);
                        openUnitMenuFromKeyboard(event, unit);
                      }}
                      onPointerDown={(event) => startUnitDrag(event, unit.id)}
                      onPointerMove={updateUnitDrag}
                      onPointerUp={finishUnitDrag}
                      onPointerCancel={cancelUnitDrag}
                    >
                      <span>{cleanName}</span>
                    </button>
                    <button
                      className="unit-overflow-button"
                      type="button"
                      aria-label={`Open actions for ${cleanName}`}
                      aria-haspopup="menu"
                      aria-expanded={unitMenu?.unit.id === unit.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect = event.currentTarget.getBoundingClientRect();
                        openUnitMenu(unit, rect.right - CONTEXT_MENU_WIDTH, rect.bottom + 4, event.currentTarget);
                      }}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </div>
                  {expanded ? (
                    <div className="unit-subnav" id={subnavId}>
                      {libraryItems.map(({ kind, label, icon: Icon }) => (
                        <button
                          className={mode === "library" && activeUnitId === unit.id && activeKind === kind ? "is-current" : ""}
                          type="button"
                          key={kind}
                          onClick={() => {
                            onSelectUnit(unit.id);
                            onSelectKind(kind);
                          }}
                        >
                          <Icon size={13} />
                          <span>{label}</span>
                        </button>
                      ))}
                      <button
                        className={mode === "learn" && activeUnitId === unit.id ? "is-current" : ""}
                        type="button"
                        onClick={() => onOpenLessons(unit.id)}
                      >
                        <GraduationCap size={13} />
                        <span>Lessons</span>
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <p className="sidebar-empty">Add a unit to begin.</p>
          )}
        </div>
      </nav>

      <div className="sidebar-footer">
        <button className="sidebar-nav-row" type="button" onClick={onOpenAppearance}>
          <Palette size={16} />
          <span>Appearance</span>
        </button>
        <div className="profile-row">
          <span className="profile-avatar">M</span>
          <span>
            <strong>Mina</strong>
            <small>Focused learner</small>
          </span>
        </div>
      </div>
      <p className="sr-only" id="unit-reorder-instructions">Drag unit names or use the up and down arrow keys while focused to reorder.</p>
      <p className="sr-only" aria-live="polite">{reorderAnnouncement}</p>
      <button
        className="sidebar-resize-handle"
        type="button"
        role="separator"
        aria-label="Resize workspace sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        onKeyDown={resizeSidebarWithKeyboard}
        onPointerDown={startSidebarResize}
        onPointerMove={updateSidebarResize}
        onPointerUp={finishSidebarResize}
        onPointerCancel={finishSidebarResize}
      />
      </aside>
      {unitMenu ? (
        <ContextMenu
          ariaLabel={`Actions for ${cleanUnitName(unitMenu.unit.name)}`}
          top={unitMenu.top}
          left={unitMenu.left}
          returnFocus={unitMenu.returnFocus}
          onClose={() => setUnitMenu(null)}
          items={[
            { label: "Edit unit", icon: Pencil, onSelect: () => onEditUnit(unitMenu.unit) },
            { label: "Delete unit", icon: Trash2, destructive: true, onSelect: () => onDeleteUnit(unitMenu.unit) },
          ]}
        />
      ) : null}
    </>
  );
}
