import { useRef, useState, type ReactNode } from "react";
import { ImagePlus, Link2, Trash2, Upload } from "lucide-react";
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
  readImageFileAsDataUrl,
  sanitizeImageSource,
} from "../editorUtils";

export type SerializedImageNode = Spread<{
  assetId?: string;
  altText: string;
  caption: string;
  height: number;
  src: string;
  width: number;
}, SerializedLexicalNode>;

interface ImageEditorProps {
  altText: string;
  caption: string;
  height: number;
  nodeKey: NodeKey;
  src: string;
  width: number;
}

function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1600, Math.round(value)));
}

function ImageEditor({
  altText,
  caption,
  height,
  nodeKey,
  src,
  width,
}: ImageEditorProps) {
  const [editor] = useLexicalComposerContext();
  const [sourceInput, setSourceInput] = useState(src);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function updateNode(update: (node: ImageNode) => void) {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isImageNode(node)) update(node);
    });
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    try {
      const nextSource = await readImageFileAsDataUrl(file);
      updateNode((node) => node.setSource(nextSource));
      setSourceInput(nextSource);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The image could not be loaded.");
    }
  }

  function applyUrl() {
    const nextSource = sanitizeImageSource(sourceInput);
    if (!nextSource) {
      setError("Enter an HTTPS image URL, or upload a PNG, JPEG, WebP, or GIF.");
      return;
    }
    updateNode((node) => node.setSource(nextSource));
    setSourceInput(nextSource);
    setError("");
  }

  return (
    <figure className="document-image-node" contentEditable={false}>
      {src ? (
        <img
          src={src}
          alt={altText}
          style={{
            width: `${width}px`,
            ...(height > 0 ? { height: `${height}px` } : {}),
          }}
        />
      ) : (
        <div className="document-image-placeholder">
          <ImagePlus size={28} />
          <span>Add an image from your device or a URL</span>
        </div>
      )}
      <div className="document-node-controls document-image-controls">
        <div className="document-image-source-row">
          <label>
            <span>Image URL</span>
            <input
              type="url"
              value={sourceInput}
              onChange={(event) => setSourceInput(event.target.value)}
              onBlur={() => {
                if (!sourceInput.trim()) setSourceInput(src);
              }}
              placeholder="https://..."
            />
          </label>
          <button type="button" onClick={applyUrl} aria-label="Use image URL" title="Use image URL">
            <Link2 size={16} />
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Upload image"
            title="Upload image"
          >
            <Upload size={16} />
          </button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={(event) => void loadFile(event.target.files?.[0])}
          />
        </div>
        <div className="document-image-fields">
          <label>
            <span>Alt text</span>
            <input
              value={altText}
              onChange={(event) => updateNode((node) => node.setAltText(event.target.value))}
              placeholder="Describe the image"
            />
          </label>
          <label>
            <span>Caption</span>
            <input
              value={caption}
              onChange={(event) => updateNode((node) => node.setCaption(event.target.value))}
              placeholder="Optional caption"
            />
          </label>
          <label>
            <span>Width</span>
            <input
              type="number"
              min={120}
              max={1600}
              value={width}
              onChange={(event) => updateNode((node) => node.setWidth(Number(event.target.value)))}
            />
          </label>
          <label>
            <span>Height</span>
            <input
              type="number"
              min={0}
              max={1600}
              value={height}
              onChange={(event) => updateNode((node) => node.setHeight(Number(event.target.value)))}
            />
          </label>
          <button
            className="document-node-remove"
            type="button"
            aria-label="Remove image"
            title="Remove image"
            onClick={() => {
              editor.update(() => {
                const node = $getNodeByKey(nodeKey);
                if (!$isImageNode(node)) return;
                const paragraph = $createParagraphNode();
                node.replace(paragraph);
                paragraph.select();
              });
            }}
          >
            <Trash2 size={16} />
          </button>
        </div>
        {error ? <p className="document-node-error" role="alert">{error}</p> : null}
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

export class ImageNode extends DecoratorNode<ReactNode> {
  __assetId: string;
  __altText: string;
  __caption: string;
  __height: number;
  __src: string;
  __width: number;

  static getType(): string {
    return "meoi-image";
  }

  static clone(node: ImageNode): ImageNode {
    return new ImageNode(
      node.__src,
      node.__altText,
      node.__caption,
      node.__width,
      node.__height,
      node.__key,
      node.__assetId,
    );
  }

  static importJSON(serializedNode: SerializedImageNode): ImageNode {
    return new ImageNode(
      sanitizeImageSource(serializedNode.src) ?? "",
      serializedNode.altText,
      serializedNode.caption,
      serializedNode.width,
      serializedNode.height,
      undefined,
      serializedNode.assetId,
    );
  }

  constructor(
    src = "",
    altText = "",
    caption = "",
    width = 640,
    height = 0,
    key?: NodeKey,
    assetId = "",
  ) {
    super(key);
    this.__assetId = assetId;
    this.__src = sanitizeImageSource(src) ?? "";
    this.__altText = altText;
    this.__caption = caption;
    this.__width = clampDimension(width, 640);
    this.__height = clampDimension(height, 0);
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement("div");
    element.className = "document-image-shell";
    return element;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): ReactNode {
    return (
      <ImageEditor
        altText={this.getAltText()}
        caption={this.getCaption()}
        height={this.getHeight()}
        nodeKey={this.getKey()}
        src={this.getSource()}
        width={this.getWidth()}
      />
    );
  }

  exportDOM(): DOMExportOutput {
    const figure = document.createElement("figure");
    const image = document.createElement("img");
    image.src = this.getSource();
    image.alt = this.getAltText();
    image.width = this.getWidth();
    if (this.getHeight() > 0) image.height = this.getHeight();
    figure.append(image);
    if (this.getCaption()) {
      const caption = document.createElement("figcaption");
      caption.textContent = this.getCaption();
      figure.append(caption);
    }
    return { element: figure };
  }

  exportJSON(): SerializedImageNode {
    return {
      ...super.exportJSON(),
      ...(this.getAssetId() ? { assetId: this.getAssetId() } : {}),
      altText: this.getAltText(),
      caption: this.getCaption(),
      height: this.getHeight(),
      src: this.getSource(),
      width: this.getWidth(),
    };
  }

  getTextContent(): string {
    return [this.getAltText(), this.getCaption()].filter(Boolean).join("\n");
  }

  getSource(): string {
    return this.getLatest().__src;
  }

  getAssetId(): string {
    return this.getLatest().__assetId;
  }

  getAltText(): string {
    return this.getLatest().__altText;
  }

  getCaption(): string {
    return this.getLatest().__caption;
  }

  getWidth(): number {
    return this.getLatest().__width;
  }

  getHeight(): number {
    return this.getLatest().__height;
  }

  setSource(value: string): this {
    const writable = this.getWritable();
    writable.__src = sanitizeImageSource(value) ?? "";
    writable.__assetId = "";
    return this;
  }

  setAssetId(value: string): this {
    this.getWritable().__assetId = value;
    return this;
  }

  setAltText(value: string): this {
    this.getWritable().__altText = value;
    return this;
  }

  setCaption(value: string): this {
    this.getWritable().__caption = value;
    return this;
  }

  setWidth(value: number): this {
    this.getWritable().__width = clampDimension(value, 640);
    return this;
  }

  setHeight(value: number): this {
    this.getWritable().__height = clampDimension(value, 0);
    return this;
  }

  isInline(): false {
    return false;
  }

  isKeyboardSelectable(): true {
    return true;
  }
}

export function $createImageNode(
  src = "",
  altText = "",
  caption = "",
  width = 640,
  height = 0,
): ImageNode {
  return $applyNodeReplacement(new ImageNode(src, altText, caption, width, height));
}

export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
  return node instanceof ImageNode;
}
