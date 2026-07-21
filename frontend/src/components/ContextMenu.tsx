import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";

export const CONTEXT_MENU_WIDTH = 184;

const CONTEXT_MENU_MARGIN = 8;
const CONTEXT_MENU_PADDING = 12;
const CONTEXT_MENU_ITEM_HEIGHT = 36;
const CONTEXT_MENU_GAP = 2;

export interface ContextMenuItem {
  label: string;
  icon: LucideIcon;
  destructive?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  ariaLabel: string;
  top: number;
  left: number;
  items: ContextMenuItem[];
  returnFocus?: HTMLElement | null;
  onClose: () => void;
}

export function ContextMenu({
  ariaLabel,
  top,
  left,
  items,
  returnFocus,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuHeight = CONTEXT_MENU_PADDING
    + items.length * CONTEXT_MENU_ITEM_HEIGHT
    + Math.max(0, items.length - 1) * CONTEXT_MENU_GAP;
  const position = {
    top: Math.max(CONTEXT_MENU_MARGIN, Math.min(top, window.innerHeight - menuHeight - CONTEXT_MENU_MARGIN)),
    left: Math.max(CONTEXT_MENU_MARGIN, Math.min(left, window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN)),
  };

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => itemRefs.current[0]?.focus());

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  function closeAndRestoreFocus() {
    onClose();
    returnFocus?.focus();
  }

  function navigateMenu(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    if (event.key === "Tab") {
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const availableItems = itemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    if (!availableItems.length) return;
    const activeIndex = availableItems.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === "Home" ? 0 :
      event.key === "End" ? availableItems.length - 1 :
      event.key === "ArrowUp" ? (activeIndex - 1 + availableItems.length) % availableItems.length :
      (activeIndex + 1) % availableItems.length;
    event.preventDefault();
    availableItems[nextIndex].focus();
  }

  return createPortal(
    <div
      className="context-menu"
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      style={position}
      onKeyDown={navigateMenu}
    >
      {items.map(({ destructive, icon: Icon, label, onSelect }, index) => (
        <button
          className={destructive ? "is-destructive" : ""}
          type="button"
          role="menuitem"
          key={label}
          ref={(node) => {
            itemRefs.current[index] = node;
          }}
          onClick={() => {
            onClose();
            onSelect();
          }}
        >
          <Icon size={15} />
          <span>{label}</span>
        </button>
      ))}
    </div>,
    document.querySelector(".app-shell") ?? document.body,
  );
}
