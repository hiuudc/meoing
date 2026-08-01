import {
  $createParagraphNode,
  $getRoot,
  type EditorState,
  type LexicalEditor,
} from "lexical";
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOM,
} from "@lexical/html";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
} from "@lexical/markdown";

export type DocumentTransferFormat = "json" | "html" | "markdown";
export type EmbedProvider = "youtube" | "twitter" | "figma";

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const SAFE_MEDIA_PROTOCOLS = new Set(["http:", "https:"]);
const ASSET_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function deriveDocumentPlainText(editorState: EditorState): string {
  let plainText = "";
  editorState.read(() => {
    plainText = $getRoot().getTextContent().replace(/\n{3,}/g, "\n\n").trim();
  });
  return plainText;
}

function parseAbsoluteUrl(value: string): URL | null {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

export function sanitizeLinkUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = parseAbsoluteUrl(withProtocol);
  return url && SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.toString() : null;
}

export function sanitizeImageDataSource(value: string): string | null {
  const trimmed = value.trim();
  return IMAGE_DATA_URL.test(trimmed) ? trimmed.replace(/\s+/g, "") : null;
}

export function resolveAuthorizedImageSource(value: string, assetId: string): string {
  const dataSource = sanitizeImageDataSource(value);
  if (dataSource) return dataSource;
  if (!ASSET_UUID.test(assetId)) return "";
  const trimmed = value.trim();
  const url = parseAbsoluteUrl(trimmed);
  return url && SAFE_MEDIA_PROTOCOLS.has(url.protocol) ? url.toString() : "";
}

export function isSupportedImageFile(file: Pick<File, "type">): boolean {
  return IMAGE_MIME_TYPES.has(file.type.toLowerCase());
}

export function readImageFileAsDataUrl(file: File): Promise<string> {
  if (!isSupportedImageFile(file)) {
    return Promise.reject(new Error("Choose a PNG, JPEG, WebP, or GIF image."));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The image could not be read."));
    reader.onload = () => {
      const source = typeof reader.result === "string"
        ? sanitizeImageDataSource(reader.result)
        : null;
      if (!source) reject(new Error("The selected file is not a supported image."));
      else resolve(source);
    };
    reader.readAsDataURL(file);
  });
}

export function detectEmbedProvider(value: string): EmbedProvider | null {
  const url = parseAbsoluteUrl(value);
  if (!url || !SAFE_MEDIA_PROTOCOLS.has(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) {
    return "youtube";
  }
  if (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com")) {
    return "twitter";
  }
  if (host === "figma.com" || host.endsWith(".figma.com")) return "figma";
  return null;
}

function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let value = "";
  if (host === "youtu.be") value = url.pathname.split("/").filter(Boolean)[0] ?? "";
  else if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
    value = url.pathname.split("/").filter(Boolean)[1] ?? "";
  } else {
    value = url.searchParams.get("v") ?? "";
  }
  return /^[\w-]{6,20}$/.test(value) ? value : null;
}

function twitterStatusId(url: URL): string | null {
  const match = url.pathname.match(/\/status\/(\d+)/);
  return match?.[1] ?? null;
}

export function resolveEmbedUrl(
  value: string,
  expectedProvider?: EmbedProvider,
): { provider: EmbedProvider; sourceUrl: string; embedUrl: string } | null {
  const sourceUrl = parseAbsoluteUrl(value);
  if (!sourceUrl || !SAFE_MEDIA_PROTOCOLS.has(sourceUrl.protocol)) return null;
  const provider = detectEmbedProvider(sourceUrl.toString());
  if (!provider || (expectedProvider && provider !== expectedProvider)) return null;

  if (provider === "youtube") {
    const id = youtubeVideoId(sourceUrl);
    if (!id) return null;
    return {
      provider,
      sourceUrl: sourceUrl.toString(),
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
    };
  }
  if (provider === "twitter") {
    const id = twitterStatusId(sourceUrl);
    if (!id) return null;
    return {
      provider,
      sourceUrl: sourceUrl.toString(),
      embedUrl: `https://platform.twitter.com/embed/Tweet.html?id=${id}`,
    };
  }
  return {
    provider,
    sourceUrl: sourceUrl.toString(),
    embedUrl: `https://www.figma.com/embed?embed_host=meoi&url=${encodeURIComponent(sourceUrl.toString())}`,
  };
}

export function exportEditorContent(
  editor: LexicalEditor,
  format: DocumentTransferFormat,
): string {
  if (format === "json") return JSON.stringify(editor.getEditorState().toJSON(), null, 2);
  let output = "";
  editor.read(() => {
    output = format === "html"
      ? $generateHtmlFromNodes(editor)
      : $convertToMarkdownString(TRANSFORMERS);
  });
  return output;
}

export function importEditorContent(
  editor: LexicalEditor,
  format: DocumentTransferFormat,
  source: string,
): void {
  if (format === "json") {
    const sanitizeImportedImages = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sanitizeImportedImages);
      if (!value || typeof value !== "object") return value;
      const record = value as Record<string, unknown>;
      const sanitized = Object.fromEntries(
        Object.entries(record).map(([key, child]) => [key, sanitizeImportedImages(child)]),
      );
      if (record.type === "meoi-image") {
        sanitized.src = typeof record.src === "string"
          ? sanitizeImageDataSource(record.src) ?? ""
          : "";
      }
      return sanitized;
    };
    const editorState = editor.parseEditorState(JSON.stringify(
      sanitizeImportedImages(JSON.parse(source) as unknown),
    ));
    editor.setEditorState(editorState);
    return;
  }
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    if (format === "html") {
      const parsed = new DOMParser().parseFromString(source, "text/html");
      const nodes = $generateNodesFromDOM(editor, parsed);
      root.append(...nodes);
    } else {
      $convertFromMarkdownString(source, TRANSFORMERS, root, true);
    }
    if (root.isEmpty()) root.append($createParagraphNode());
  }, { discrete: true });
}

export function downloadTextFile(
  filename: string,
  content: string,
  contentType: string,
): void {
  const blobUrl = URL.createObjectURL(new Blob([content], { type: contentType }));
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(blobUrl);
}
