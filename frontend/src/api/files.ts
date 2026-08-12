import type { ApiClient } from "./client";
import { sanitizeExternalImageUrl } from "../components/document-editor/editorUtils";

interface UploadInitialization {
  assetId: string;
  uploadUrl: string;
  headers?: Record<string, string>;
}

interface DownloadAuthorization {
  url?: string;
  downloadUrl?: string;
}

export async function authorizeFileDownload(api: ApiClient, assetId: string): Promise<string> {
  const response = await api.post<DownloadAuthorization>(
    `/v1/files/${encodeURIComponent(assetId)}/download`,
  );
  const url = response.data.downloadUrl ?? response.data.url;
  if (!url) throw new Error("The API did not return an authorized asset URL.");
  return url;
}

const PROFILE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function uploadBlob(
  api: ApiClient,
  blob: Blob,
  filename: string,
  mimeType: string,
  collectionId: string | null,
  onUploaded?: (assetId: string) => void,
): Promise<string> {
  if (blob.size > MAX_FILE_BYTES) throw new Error("Files must be 25 MiB or smaller.");
  const sha256 = await sha256Hex(blob);
  const initialized = await api.post<UploadInitialization>("/v1/files/uploads", {
    collectionId,
    filename,
    mimeType,
    size: blob.size,
    sha256,
  }, crypto.randomUUID());
  const uploadHeaders = new Headers(initialized.data.headers);
  if (!uploadHeaders.has("Content-Type")) uploadHeaders.set("Content-Type", mimeType);
  const upload = await fetch(initialized.data.uploadUrl, {
    method: "PUT",
    headers: uploadHeaders,
    body: blob,
  });
  if (!upload.ok) throw new Error("The image upload to R2 failed.");
  await api.post(
    `/v1/files/${encodeURIComponent(initialized.data.assetId)}/finalize`,
    { sha256 },
    crypto.randomUUID(),
  );
  onUploaded?.(initialized.data.assetId);
  return initialized.data.assetId;
}

export async function uploadProfileImage(
  api: ApiClient,
  file: File,
  collectionId: string | null,
  onUploaded?: (assetId: string) => void,
): Promise<string> {
  const mimeType = file.type.toLowerCase();
  if (!PROFILE_IMAGE_TYPES.has(mimeType)) {
    throw new Error("Avatar images must be PNG, JPEG, WebP or GIF.");
  }
  return uploadBlob(api, file, file.name || "profile-image", mimeType, collectionId, onUploaded);
}

async function prepareNodeForStorage(
  value: unknown,
): Promise<unknown> {
  if (Array.isArray(value)) {
    const prepared: unknown[] = [];
    for (const item of value) {
      prepared.push(await prepareNodeForStorage(item));
    }
    return prepared;
  }
  if (!isRecord(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = await prepareNodeForStorage(child);
  }
  if (value.type === "meoi-image") {
    const assetId = typeof value.assetId === "string" ? value.assetId : "";
    const source = typeof value.src === "string" ? value.src : "";
    if (assetId) {
      next.assetId = assetId;
      next.src = "";
    } else {
      const externalSource = sanitizeExternalImageUrl(source);
      if (!externalSource) {
        throw new Error("Document images must use a valid HTTPS image URL.");
      }
      delete next.assetId;
      next.src = externalSource;
    }
  }
  return next;
}

export async function prepareLexicalDocumentForStorage(
  serializedContent: string,
): Promise<string> {
  if (!serializedContent.trim()) return serializedContent;
  const parsed = JSON.parse(serializedContent) as unknown;
  const prepared = await prepareNodeForStorage(parsed);
  return JSON.stringify(prepared);
}

async function hydrateNodeForEditing(
  api: ApiClient,
  value: unknown,
  cache: Map<string, string>,
): Promise<unknown> {
  if (Array.isArray(value)) {
    const hydrated: unknown[] = [];
    for (const item of value) {
      hydrated.push(await hydrateNodeForEditing(api, item, cache));
    }
    return hydrated;
  }
  if (!isRecord(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = await hydrateNodeForEditing(api, child, cache);
  }
  if (value.type === "meoi-image") {
    if (typeof value.assetId === "string" && value.assetId) {
      next.src = "";
      let url = cache.get(value.assetId);
      if (!url) {
        url = await authorizeFileDownload(api, value.assetId);
        cache.set(value.assetId, url);
      }
      next.src = url;
    } else if (typeof value.src === "string") {
      next.src = sanitizeExternalImageUrl(value.src) ?? "";
    } else {
      next.src = "";
    }
  }
  return next;
}

export async function hydrateLexicalDocumentForEditing(
  api: ApiClient,
  content: unknown,
  cache = new Map<string, string>(),
): Promise<string> {
  if (!content || typeof content !== "object") return "";
  return JSON.stringify(await hydrateNodeForEditing(api, content, cache));
}
