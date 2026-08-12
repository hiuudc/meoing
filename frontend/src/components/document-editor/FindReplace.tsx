import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Replace, X } from "lucide-react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getNodeByKey,
  $getRoot,
  $isTextNode,
  type NodeKey,
} from "lexical";

interface TextMatch {
  end: number;
  key: NodeKey;
  start: number;
}

interface FindReplaceProps {
  open: boolean;
  onClose: () => void;
}

export function findTextOffsets(
  text: string,
  query: string,
  matchCase: boolean,
): Array<{ start: number; end: number }> {
  if (!query) return [];
  const haystack = matchCase ? text : text.toLocaleLowerCase();
  const needle = matchCase ? query : query.toLocaleLowerCase();
  const matches: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, offset);
    if (start < 0) break;
    matches.push({ end: start + needle.length, start });
    offset = start + Math.max(needle.length, 1);
  }
  return matches;
}

function collectMatches(query: string, matchCase: boolean): TextMatch[] {
  const matches: TextMatch[] = [];
  for (const node of $getRoot().getAllTextNodes()) {
    for (const match of findTextOffsets(node.getTextContent(), query, matchCase)) {
      matches.push({ ...match, key: node.getKey() });
    }
  }
  return matches;
}

export function FindReplace({ open, onClose }: FindReplaceProps) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [matches, setMatches] = useState<TextMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    function refresh() {
      editor.getEditorState().read(() => {
        setMatches(collectMatches(query, matchCase));
      });
    }
    refresh();
    return editor.registerUpdateListener(refresh);
  }, [editor, matchCase, open, query]);

  const boundedIndex = useMemo(
    () => matches.length ? activeIndex % matches.length : 0,
    [activeIndex, matches.length],
  );

  if (!open) return null;

  function selectMatch(index: number) {
    if (!matches.length) return;
    const nextIndex = (index + matches.length) % matches.length;
    const match = matches[nextIndex];
    editor.update(() => {
      const node = $getNodeByKey(match.key);
      if ($isTextNode(node)) node.select(match.start, match.end);
    });
    editor.focus();
    setActiveIndex(nextIndex);
  }

  function replaceCurrent() {
    const match = matches[boundedIndex];
    if (!match) return;
    editor.update(() => {
      const node = $getNodeByKey(match.key);
      if (!$isTextNode(node)) return;
      const text = node.getTextContent();
      node.setTextContent(`${text.slice(0, match.start)}${replacement}${text.slice(match.end)}`);
    });
  }

  function replaceAll() {
    if (!query) return;
    editor.update(() => {
      for (const node of $getRoot().getAllTextNodes()) {
        const offsets = findTextOffsets(node.getTextContent(), query, matchCase);
        if (!offsets.length) continue;
        let nextText = node.getTextContent();
        for (let index = offsets.length - 1; index >= 0; index -= 1) {
          const match = offsets[index];
          nextText = `${nextText.slice(0, match.start)}${replacement}${nextText.slice(match.end)}`;
        }
        node.setTextContent(nextText);
      }
    });
  }

  return (
    <div className="document-find-replace" role="search" aria-label="Find and replace">
      <div className="document-find-row">
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          placeholder="Find in document"
          aria-label="Find"
        />
        <span>{matches.length ? `${boundedIndex + 1}/${matches.length}` : "0/0"}</span>
        <button type="button" onClick={() => selectMatch(boundedIndex - 1)} aria-label="Previous match">
          <ChevronUp size={16} />
        </button>
        <button type="button" onClick={() => selectMatch(boundedIndex + 1)} aria-label="Next match">
          <ChevronDown size={16} />
        </button>
        <button type="button" onClick={onClose} aria-label="Close find and replace">
          <X size={16} />
        </button>
      </div>
      <div className="document-find-row">
        <input
          value={replacement}
          onChange={(event) => setReplacement(event.target.value)}
          placeholder="Replace with"
          aria-label="Replace with"
        />
        <button type="button" onClick={replaceCurrent}><Replace size={15} /> Replace</button>
        <button type="button" onClick={replaceAll}>Replace all</button>
        <label>
          <input
            type="checkbox"
            checked={matchCase}
            onChange={(event) => setMatchCase(event.target.checked)}
          />
          Match case
        </label>
      </div>
    </div>
  );
}
