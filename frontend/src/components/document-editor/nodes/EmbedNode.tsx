import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, Link2, Trash2 } from "lucide-react";
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
import {
  resolveEmbedUrl,
  type EmbedProvider,
} from "../editorUtils";

export type SerializedEmbedNode = Spread<{
  provider: EmbedProvider;
  url: string;
}, SerializedLexicalNode>;

interface EmbedEditorProps {
  nodeKey: NodeKey;
  provider: EmbedProvider;
  url: string;
}

const providerLabels: Record<EmbedProvider, string> = {
  figma: "Figma",
  twitter: "Twitter / X",
  youtube: "YouTube",
};

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

function EmbedEditor({ nodeKey, provider, url }: EmbedEditorProps) {
  const [editor] = useLexicalComposerContext();
  const [urlInput, setUrlInput] = useState(url);
  const [error, setError] = useState("");
  const online = useOnlineStatus();
  const resolved = resolveEmbedUrl(url, provider);

  function updateNode(update: (node: EmbedNode) => void) {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isEmbedNode(node)) update(node);
    });
  }

  function applyUrl() {
    const nextEmbed = resolveEmbedUrl(urlInput, provider);
    if (!nextEmbed) {
      setError(`Enter a valid ${providerLabels[provider]} URL.`);
      return;
    }
    updateNode((node) => node.setUrl(nextEmbed.sourceUrl));
    setUrlInput(nextEmbed.sourceUrl);
    setError("");
  }

  return (
    <section className="document-embed-node" contentEditable={false}>
      <div className="document-node-heading">
        <label>
          <span>Embed</span>
          <select
            value={provider}
            onChange={(event) => {
              updateNode((node) => node.setProvider(event.target.value as EmbedProvider).setUrl(""));
              setUrlInput("");
              setError("");
            }}
          >
            <option value="youtube">YouTube</option>
            <option value="twitter">Twitter / X</option>
            <option value="figma">Figma</option>
          </select>
        </label>
        <button
          className="document-node-remove"
          type="button"
          aria-label="Remove embed"
          title="Remove embed"
          onClick={() => {
            editor.update(() => {
              const node = $getNodeByKey(nodeKey);
              if (!$isEmbedNode(node)) return;
              const paragraph = $createParagraphNode();
              node.replace(paragraph);
              paragraph.select();
            });
          }}
        >
          <Trash2 size={16} />
        </button>
      </div>
      {resolved && online ? (
        <iframe
          src={resolved.embedUrl}
          title={`${providerLabels[provider]} embed`}
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-forms allow-popups allow-presentation allow-same-origin allow-scripts"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        />
      ) : resolved ? (
        <a className="document-embed-fallback" href={resolved.sourceUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={18} />
          Open this {providerLabels[provider]} content when you are online
        </a>
      ) : (
        <div className="document-embed-placeholder">
          <Link2 size={22} />
          <span>Paste a {providerLabels[provider]} URL below</span>
        </div>
      )}
      <div className="document-embed-url">
        <input
          type="url"
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          placeholder={`Paste ${providerLabels[provider]} URL`}
          aria-label={`${providerLabels[provider]} URL`}
        />
        <button type="button" onClick={applyUrl}>Embed</button>
      </div>
      {error ? <p className="document-node-error" role="alert">{error}</p> : null}
    </section>
  );
}

export class EmbedNode extends DecoratorNode<ReactNode> {
  __provider: EmbedProvider;
  __url: string;

  static getType(): string {
    return "meoi-embed";
  }

  static clone(node: EmbedNode): EmbedNode {
    return new EmbedNode(node.__provider, node.__url, node.__key);
  }

  static importJSON(serializedNode: SerializedEmbedNode): EmbedNode {
    const resolved = resolveEmbedUrl(serializedNode.url, serializedNode.provider);
    return new EmbedNode(serializedNode.provider, resolved?.sourceUrl ?? "");
  }

  constructor(provider: EmbedProvider = "youtube", url = "", key?: NodeKey) {
    super(key);
    this.__provider = provider;
    this.__url = resolveEmbedUrl(url, provider)?.sourceUrl ?? "";
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement("div");
    element.className = "document-embed-shell";
    return element;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): ReactNode {
    return (
      <EmbedEditor
        nodeKey={this.getKey()}
        provider={this.getProvider()}
        url={this.getUrl()}
      />
    );
  }

  exportDOM(): DOMExportOutput {
    const link = document.createElement("a");
    link.href = this.getUrl();
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `${providerLabels[this.getProvider()]}: ${this.getUrl()}`;
    return { element: link };
  }

  exportJSON(): SerializedEmbedNode {
    return {
      ...super.exportJSON(),
      provider: this.getProvider(),
      url: this.getUrl(),
    };
  }

  getTextContent(): string {
    return `${providerLabels[this.getProvider()]} ${this.getUrl()}`.trim();
  }

  getProvider(): EmbedProvider {
    return this.getLatest().__provider;
  }

  getUrl(): string {
    return this.getLatest().__url;
  }

  setProvider(value: EmbedProvider): this {
    this.getWritable().__provider = value;
    return this;
  }

  setUrl(value: string): this {
    const provider = this.getLatest().__provider;
    this.getWritable().__url = resolveEmbedUrl(value, provider)?.sourceUrl ?? "";
    return this;
  }

  isInline(): false {
    return false;
  }

  isKeyboardSelectable(): true {
    return true;
  }
}

export function $createEmbedNode(provider: EmbedProvider, url = ""): EmbedNode {
  return $applyNodeReplacement(new EmbedNode(provider, url));
}

export function $isEmbedNode(node: LexicalNode | null | undefined): node is EmbedNode {
  return node instanceof EmbedNode;
}
