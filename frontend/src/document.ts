const MAX_DOCUMENT_CONTENT_LENGTH = 2_000_000;

interface SerializedDocumentRoot {
  type: "root";
  version: number;
  children: unknown[];
}

interface SerializedDocumentState {
  root: SerializedDocumentRoot;
}

function hasSerializedNodeShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as { children?: unknown; type?: unknown; version?: unknown };
  if (typeof node.type !== "string" || typeof node.version !== "number") return false;
  return node.children === undefined
    || (Array.isArray(node.children) && node.children.every(hasSerializedNodeShape));
}

function isSerializedDocumentState(value: unknown): value is SerializedDocumentState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const root = (value as { root?: unknown }).root;
  if (!root || typeof root !== "object" || Array.isArray(root)) return false;
  const candidate = root as Partial<SerializedDocumentRoot>;
  return candidate.type === "root"
    && typeof candidate.version === "number"
    && Array.isArray(candidate.children)
    && candidate.children.length > 0
    && candidate.children.every(hasSerializedNodeShape);
}

export function normalizeDocumentContent(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > MAX_DOCUMENT_CONTENT_LENGTH) {
    return undefined;
  }
  try {
    return isSerializedDocumentState(JSON.parse(value)) ? value : undefined;
  } catch {
    return undefined;
  }
}
