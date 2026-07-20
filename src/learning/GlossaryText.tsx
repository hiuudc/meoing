import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { segmentGlossaryText } from "./glossary";
import type { GlossaryEntry } from "./types";

interface GlossaryTextProps {
  text: string;
  glossary: GlossaryEntry[];
}

interface OpenGlossary {
  entry: GlossaryEntry;
  index: number;
  anchor: HTMLElement;
}

const TOOLTIP_MARGIN = 8;

export function GlossaryText({ text, glossary }: GlossaryTextProps) {
  const segments = segmentGlossaryText(text, glossary);
  const [openGlossary, setOpenGlossary] = useState<OpenGlossary | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const baseId = useId().replace(/:/g, "");
  const tooltipId = openGlossary ? `glossary-${baseId}-${openGlossary.index}` : undefined;

  useEffect(() => {
    if (!openGlossary) return;
    const frame = window.requestAnimationFrame(() => {
      const rect = openGlossary.anchor.getBoundingClientRect();
      const tooltip = tooltipRef.current;
      const width = tooltip?.offsetWidth ?? Math.min(280, window.innerWidth - TOOLTIP_MARGIN * 2);
      const height = tooltip?.offsetHeight ?? 100;
      const above = rect.top - height - 7;
      const top = above >= TOOLTIP_MARGIN ? above : rect.bottom + 7;
      setPosition({
        top: Math.max(TOOLTIP_MARGIN, Math.min(top, window.innerHeight - height - TOOLTIP_MARGIN)),
        left: Math.max(TOOLTIP_MARGIN, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - TOOLTIP_MARGIN)),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [openGlossary]);

  useEffect(() => {
    if (!openGlossary) return;
    const activeGlossary = openGlossary;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (activeGlossary.anchor.contains(event.target as Node) || tooltipRef.current?.contains(event.target as Node)) return;
      setOpenGlossary(null);
    }
    function closeOnKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpenGlossary(null);
    }
    function closeOnViewportChange() {
      setOpenGlossary(null);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    window.addEventListener("keydown", closeOnKey, true);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      window.removeEventListener("keydown", closeOnKey, true);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [openGlossary]);

  function open(entry: GlossaryEntry, index: number, anchor: HTMLElement) {
    setOpenGlossary({ entry, index, anchor });
  }

  const portalTarget = document.querySelector<HTMLElement>(".app-shell") ?? document.body;
  return (
    <>
      {segments.map((segment, index) => segment.entry ? (
        <span
          key={`${index}-${segment.text}`}
          className="glossary-term"
          role="button"
          tabIndex={0}
          aria-describedby={openGlossary?.index === index ? tooltipId : undefined}
          onMouseEnter={(event) => open(segment.entry!, index, event.currentTarget)}
          onMouseLeave={() => setOpenGlossary((current) => current?.index === index ? null : current)}
          onFocus={(event) => open(segment.entry!, index, event.currentTarget)}
          onBlur={() => setOpenGlossary((current) => current?.index === index ? null : current)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            open(segment.entry!, index, event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            open(segment.entry!, index, event.currentTarget);
          }}
        >
          {segment.text}
        </span>
      ) : <span key={`${index}-${segment.text}`}>{segment.text}</span>)}
      {openGlossary && tooltipId ? createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          className="glossary-tooltip"
          role="tooltip"
          style={position}
        >
          <strong>{openGlossary.entry.term}</strong>
          <p>{openGlossary.entry.meaning}</p>
          {openGlossary.entry.example ? <small>{openGlossary.entry.example}</small> : null}
        </div>,
        portalTarget,
      ) : null}
    </>
  );
}
