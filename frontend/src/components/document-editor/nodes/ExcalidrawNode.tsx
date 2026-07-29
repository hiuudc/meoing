import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { PenTool, Trash2, X } from "lucide-react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $getNodeByKey,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";

interface DrawingPayload {
  appState?: {
    gridSize?: number | null;
    viewBackgroundColor?: string;
  };
  elements: unknown[];
  files?: Record<string, unknown>;
}

interface ExcalidrawCanvasProps {
  initialData?: DrawingPayload;
  onChange?: (
    elements: readonly unknown[],
    appState: Record<string, unknown>,
    files: Record<string, unknown>,
  ) => void;
  theme?: "dark" | "light";
}

const ExcalidrawCanvas = lazy(async () => {
  await import("@excalidraw/excalidraw/index.css");
  const module = await import("@excalidraw/excalidraw");
  return {
    default: module.Excalidraw as ComponentType<ExcalidrawCanvasProps>,
  };
});

export type SerializedExcalidrawNode = Spread<{
  data: string;
}, SerializedLexicalNode>;

export function normalizeDrawingData(value: unknown): string {
  if (typeof value !== "string" || !value) return JSON.stringify({ elements: [] });
  try {
    const parsed = JSON.parse(value) as Partial<DrawingPayload>;
    if (!Array.isArray(parsed.elements)) return JSON.stringify({ elements: [] });
    return JSON.stringify({
      appState: parsed.appState && typeof parsed.appState === "object"
        ? {
          gridSize: parsed.appState.gridSize ?? null,
          viewBackgroundColor: parsed.appState.viewBackgroundColor,
        }
        : undefined,
      elements: parsed.elements,
      files: parsed.files && typeof parsed.files === "object" ? parsed.files : undefined,
    });
  } catch {
    return JSON.stringify({ elements: [] });
  }
}

function parseDrawingData(value: string): DrawingPayload {
  return JSON.parse(normalizeDrawingData(value)) as DrawingPayload;
}

interface ExcalidrawEditorProps {
  data: string;
  nodeKey: NodeKey;
}

function ExcalidrawEditor({ data, nodeKey }: ExcalidrawEditorProps) {
  const [editor] = useLexicalComposerContext();
  const [open, setOpen] = useState(false);
  const updateTimerRef = useRef<number | null>(null);
  const initialData = useMemo(() => parseDrawingData(data), [data]);

  useEffect(() => () => {
    if (updateTimerRef.current !== null) window.clearTimeout(updateTimerRef.current);
  }, []);

  function queueUpdate(
    elements: readonly unknown[],
    appState: Record<string, unknown>,
    files: Record<string, unknown>,
  ) {
    if (updateTimerRef.current !== null) window.clearTimeout(updateTimerRef.current);
    updateTimerRef.current = window.setTimeout(() => {
      const nextData = normalizeDrawingData(JSON.stringify({
        appState: {
          gridSize: typeof appState.gridSize === "number" ? appState.gridSize : null,
          viewBackgroundColor: typeof appState.viewBackgroundColor === "string"
            ? appState.viewBackgroundColor
            : undefined,
        },
        elements,
        files,
      }));
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isExcalidrawNode(node)) node.setData(nextData);
      });
    }, 250);
  }

  function removeNode() {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isExcalidrawNode(node)) return;
      const paragraph = $createParagraphNode();
      node.replace(paragraph);
      paragraph.select();
    });
  }

  return (
    <section className="document-excalidraw-node" contentEditable={false}>
      <div className="document-node-heading">
        <span><PenTool size={17} /> Excalidraw</span>
        <button className="document-node-remove" type="button" onClick={removeNode} aria-label="Remove drawing">
          <Trash2 size={16} />
        </button>
      </div>
      <button className="document-drawing-preview" type="button" onClick={() => setOpen(true)}>
        <PenTool size={26} />
        <span>{initialData.elements.length ? "Edit drawing" : "Create drawing"}</span>
        <small>{initialData.elements.length} elements</small>
      </button>
      {open ? (
        <div className="document-drawing-dialog" role="dialog" aria-modal="true" aria-label="Excalidraw canvas">
          <button className="document-drawing-close" type="button" onClick={() => setOpen(false)} aria-label="Close drawing">
            <X size={20} />
          </button>
          <Suspense fallback={<div className="document-heavy-loading">Loading Excalidraw...</div>}>
            <ExcalidrawCanvas
              initialData={initialData}
              onChange={queueUpdate}
              theme="dark"
            />
          </Suspense>
        </div>
      ) : null}
    </section>
  );
}

export class ExcalidrawNode extends DecoratorNode<ReactNode> {
  __data: string;

  static getType(): string {
    return "meoi-excalidraw";
  }

  static clone(node: ExcalidrawNode): ExcalidrawNode {
    return new ExcalidrawNode(node.__data, node.__key);
  }

  static importJSON(serializedNode: SerializedExcalidrawNode): ExcalidrawNode {
    return new ExcalidrawNode(serializedNode.data);
  }

  constructor(data = JSON.stringify({ elements: [] }), key?: NodeKey) {
    super(key);
    this.__data = normalizeDrawingData(data);
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement("div");
    element.className = "document-excalidraw-shell";
    return element;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): ReactNode {
    return <ExcalidrawEditor data={this.getData()} nodeKey={this.getKey()} />;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("div");
    element.dataset.excalidraw = this.getData();
    element.textContent = "Excalidraw drawing";
    return { element };
  }

  exportJSON(): SerializedExcalidrawNode {
    return {
      ...super.exportJSON(),
      data: this.getData(),
    };
  }

  getTextContent(): string {
    return "Excalidraw drawing";
  }

  getData(): string {
    return this.getLatest().__data;
  }

  setData(value: string): this {
    this.getWritable().__data = normalizeDrawingData(value);
    return this;
  }

  isInline(): false {
    return false;
  }

  isKeyboardSelectable(): true {
    return true;
  }
}

export function $createExcalidrawNode(data?: string): ExcalidrawNode {
  return $applyNodeReplacement(new ExcalidrawNode(data));
}

export function $isExcalidrawNode(
  node: LexicalNode | null | undefined,
): node is ExcalidrawNode {
  return node instanceof ExcalidrawNode;
}
