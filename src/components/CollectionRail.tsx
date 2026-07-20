import { Compass, FolderPlus, LibraryBig, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { contrastTextColor } from "../theme";
import type { Collection } from "../types";
import { ContextMenu } from "./ContextMenu";

interface CollectionRailProps {
  collections: Collection[];
  activeId: string;
  accentPreview?: {
    collectionId: string;
    accent: string;
  };
  onSelect: (id: string) => void;
  onCreate: () => void;
  onEdit: (collection: Collection) => void;
  onDelete: (collection: Collection) => void;
}

interface CollectionMenuState {
  collection: Collection;
  top: number;
  left: number;
  returnFocus?: HTMLButtonElement | null;
}

interface CollectionLongPress {
  collection: Collection;
  pointerId: number;
  x: number;
  y: number;
  timer: number;
  target: HTMLButtonElement;
  activated: boolean;
}

const COLLECTION_LONG_PRESS_MS = 500;
const COLLECTION_LONG_PRESS_MOVEMENT = 8;

export function CollectionRail({
  collections,
  activeId,
  accentPreview,
  onSelect,
  onCreate,
  onEdit,
  onDelete,
}: CollectionRailProps) {
  const [collectionMenu, setCollectionMenu] = useState<CollectionMenuState | null>(null);
  const longPressRef = useRef<CollectionLongPress | null>(null);
  const suppressCollectionClickRef = useRef("");

  useEffect(() => () => {
    if (longPressRef.current) window.clearTimeout(longPressRef.current.timer);
  }, []);

  function openCollectionMenu(
    collection: Collection,
    left: number,
    top: number,
    returnFocus?: HTMLButtonElement | null,
  ) {
    setCollectionMenu({ collection, left, top, returnFocus });
  }

  function openCollectionMenuFromKeyboard(event: React.KeyboardEvent<HTMLButtonElement>, collection: Collection) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    openCollectionMenu(collection, rect.right + 4, rect.top, event.currentTarget);
  }

  function clearLongPress(event?: React.PointerEvent<HTMLButtonElement>) {
    const press = longPressRef.current;
    if (!press) return;
    window.clearTimeout(press.timer);
    if (event && press.target.hasPointerCapture(event.pointerId)) {
      press.target.releasePointerCapture(event.pointerId);
    }
    longPressRef.current = null;
  }

  function startLongPress(event: React.PointerEvent<HTMLButtonElement>, collection: Collection) {
    if (event.pointerType === "mouse") return;
    clearLongPress();
    event.currentTarget.setPointerCapture(event.pointerId);
    const press: CollectionLongPress = {
      collection,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      target: event.currentTarget,
      activated: false,
      timer: 0,
    };
    press.timer = window.setTimeout(() => {
      press.activated = true;
      suppressCollectionClickRef.current = collection.id;
      openCollectionMenu(collection, press.x, press.y, press.target);
    }, COLLECTION_LONG_PRESS_MS);
    longPressRef.current = press;
  }

  function updateLongPress(event: React.PointerEvent<HTMLButtonElement>) {
    const press = longPressRef.current;
    if (!press || press.pointerId !== event.pointerId || press.activated) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > COLLECTION_LONG_PRESS_MOVEMENT) {
      clearLongPress(event);
    }
  }

  return (
    <aside className="collection-rail" aria-label="Collections">
      <button className="brand-mark" type="button" aria-label="Meoi home">
        <LibraryBig size={21} strokeWidth={2.4} />
      </button>
      <span className="rail-divider" />
      <div className="collection-stack">
        {collections.map((collection) => {
          const accent = accentPreview?.collectionId === collection.id
            ? accentPreview.accent
            : collection.accent;
          return <div className="rail-item-wrap" key={collection.id}>
            <button
              className={`collection-button ${activeId === collection.id ? "is-active" : ""}`}
              style={{
                "--collection-color": accent,
                "--collection-contrast": contrastTextColor(accent),
              } as React.CSSProperties}
              type="button"
              onClick={() => {
                if (suppressCollectionClickRef.current === collection.id) {
                  suppressCollectionClickRef.current = "";
                  return;
                }
                onSelect(collection.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                openCollectionMenu(collection, event.clientX, event.clientY, event.currentTarget);
              }}
              onKeyDown={(event) => openCollectionMenuFromKeyboard(event, collection)}
              onPointerDown={(event) => startLongPress(event, collection)}
              onPointerMove={updateLongPress}
              onPointerUp={clearLongPress}
              onPointerCancel={clearLongPress}
              aria-label={collection.name}
              aria-haspopup="menu"
              aria-expanded={collectionMenu?.collection.id === collection.id}
            >
              <span>{collection.icon}</span>
            </button>
          </div>;
        })}
      </div>
      <div className="rail-bottom-actions">
        <button className="rail-action" type="button" aria-label="Add collection" onClick={onCreate}>
          <Plus size={20} />
        </button>
        <button className="rail-action" type="button" aria-label="Explore collections">
          <Compass size={19} />
        </button>
        <button className="rail-action mobile-only" type="button" aria-label="Create collection" onClick={onCreate}>
          <FolderPlus size={18} />
        </button>
      </div>
      {collectionMenu ? (
        <ContextMenu
          ariaLabel={`Actions for ${collectionMenu.collection.name}`}
          top={collectionMenu.top}
          left={collectionMenu.left}
          returnFocus={collectionMenu.returnFocus}
          onClose={() => setCollectionMenu(null)}
          items={[
            { label: "Edit collection", icon: Pencil, onSelect: () => onEdit(collectionMenu.collection) },
            { label: "Delete collection", icon: Trash2, destructive: true, onSelect: () => onDelete(collectionMenu.collection) },
          ]}
        />
      ) : null}
    </aside>
  );
}
