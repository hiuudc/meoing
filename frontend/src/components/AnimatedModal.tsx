import { useEffect, useRef, type ReactNode } from "react";
import { useExitPresence } from "./useExitPresence";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

let bodyScrollLocks = 0;
let previousBodyOverflow = "";

interface AnimatedModalProps {
  open: boolean;
  onClose: () => void;
  onExited?: () => void;
  labelledBy: string;
  backdropClassName: string;
  panelClassName: string;
  children: ReactNode;
}

export function AnimatedModal({
  open,
  onClose,
  onExited,
  labelledBy,
  backdropClassName,
  panelClassName,
  children,
}: AnimatedModalProps) {
  const { isMounted, presenceState, onAnimationEnd } = useExitPresence(open, {
    exitDuration: 180,
    onExited,
  });
  const panelRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    if (!isMounted) return;
    if (bodyScrollLocks === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    bodyScrollLocks += 1;
    return () => {
      bodyScrollLocks -= 1;
      if (bodyScrollLocks === 0) document.body.style.overflow = previousBodyOverflow;
    };
  }, [isMounted]);

  useEffect(() => {
    if (!isMounted || !open) return;
    if (document.activeElement instanceof HTMLElement && !panelRef.current?.contains(document.activeElement)) {
      previousFocus.current = document.activeElement;
    }
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const target = panel.querySelector<HTMLElement>("[data-modal-autofocus], [autofocus]")
        ?? getFocusableElements(panel)[0]
        ?? panel;
      target.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isMounted, open]);

  useEffect(() => {
    if (open || isMounted) return;
    function rememberFocus(event: FocusEvent) {
      if (event.target instanceof HTMLElement) previousFocus.current = event.target;
    }
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, [isMounted, open]);

  useEffect(() => {
    if (isMounted || !previousFocus.current) return;
    previousFocus.current.focus();
    previousFocus.current = null;
  }, [isMounted]);

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!isMounted) return null;

  function trapFocus(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusableElements = getFocusableElements(panel);
    if (!focusableElements.length) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className={`animated-modal-backdrop ${backdropClassName}`}
      data-state={presenceState}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className={`animated-modal-panel ${panelClassName}`}
        data-state={presenceState}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onAnimationEnd={onAnimationEnd}
        onKeyDown={trapFocus}
      >
        {children}
      </section>
    </div>
  );
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}
