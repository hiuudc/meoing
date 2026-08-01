import type { ApiClient } from "./client";

interface UploadInitialization {
  assetId: string;
  uploadUrl: string;
  headers?: Record<string, string>;
}

interface DownloadAuthorization {
  url?: string;
  downloadUrl?: string;
}

const DATA_IMAGE = /^data:(image\/(?:png|jpeg|webp|gif));base64,/i;
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

async function uploadDataImage(
  api: ApiClient,
  source: string,
  collectionId: string,
  onUploaded?: (assetId: string) => void,
): Promise<string> {
  const match = DATA_IMAGE.exec(source);
  if (!match) throw new Error("Only PNG, JPEG, WebP and GIF data images can be uploaded.");
  const blob = await fetch(source).then((response) => response.blob());
  const mimeType = match[1].toLowerCase();
  const extension = mimeType.split("/")[1].replace("jpeg", "jpg");
  return uploadBlob(
    api,
    blob,
    `embedded-image.${extension}`,
    mimeType,
    collectionId,
    onUploaded,
  );
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
  api: ApiClient,
  value: unknown,
  collectionId: string,
  onUploaded?: (assetId: string) => void,
): Promise<unknown> {
  if (Array.isArray(value)) {
    const prepared: unknown[] = [];
    for (const item of value) {
      prepared.push(await prepareNodeForStorage(api, item, collectionId, onUploaded));
    }
    return prepared;
  }
  if (!isRecord(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = await prepareNodeForStorage(api, child, collectionId, onUploaded);
  }
  if (value.type === "meoi-image") {
    const assetId = typeof value.assetId === "string" ? value.assetId : "";
    const source = typeof value.src === "string" ? value.src : "";
    if (assetId) {
      next.assetId = assetId;
      next.src = "";
    } else if (DATA_IMAGE.test(source)) {
      next.assetId = await uploadDataImage(api, source, collectionId, onUploaded);
      next.src = "";
    } else {
      throw new Error("Document images must be uploaded before they can be saved.");
    }
  }
  return next;
}

export async function prepareLexicalDocumentForStorage(
  api: ApiClient,
  serializedContent: string,
  collectionId: string,
  onUploaded?: (assetId: string) => void,
): Promise<string> {
  if (!serializedContent.trim()) return serializedContent;
  const parsed = JSON.parse(serializedContent) as unknown;
  const prepared = await prepareNodeForStorage(api, parsed, collectionId, onUploaded);
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
    next.src = "";
    if (typeof value.assetId === "string" && value.assetId) {
      let url = cache.get(value.assetId);
      if (!url) {
        const response = await api.post<DownloadAuthorization>(
          `/v1/files/${encodeURIComponent(value.assetId)}/download`,
        );
        url = response.data.downloadUrl ?? response.data.url;
        if (!url) throw new Error("The API did not return an authorized asset URL.");
        cache.set(value.assetId, url);
      }
      next.src = url;
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
