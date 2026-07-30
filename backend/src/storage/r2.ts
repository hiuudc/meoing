import { AwsClient } from "aws4fetch";
import type { DomainRepository } from "../db/repository";
import { ApiError } from "../http/errors";
import { asJsonObject, type Actor, type JsonValue } from "../types";

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

export const ALLOWED_FILE_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/html",
  "text/markdown",
  "text/plain",
] as const;

export type AllowedFileType = (typeof ALLOWED_FILE_TYPES)[number];

export interface InitializeUploadInput {
  readonly collectionId?: string;
  readonly fileName: string;
  readonly contentType: AllowedFileType;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly idempotencyKey: string;
}

interface AssetMetadata {
  readonly id: string;
  readonly key: string;
  readonly contentType: AllowedFileType;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly fileName?: string;
  readonly status?: "pending" | "ready";
}

function ttl(value: string, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function objectUrl(env: ApiEnv, key: string): URL {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(env.R2_BUCKET_NAME)}/${encodedKey}`,
  );
}

function bytesFromHex(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new ApiError(400, "INVALID_REQUEST", "sha256 must be a 64-character hexadecimal digest");
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const a = left.toLowerCase().padEnd(64, "0").slice(0, 64);
  const b = right.toLowerCase().padEnd(64, "0").slice(0, 64);
  let difference = left.length === right.length ? 0 : 1;
  for (let index = 0; index < 64; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function hasPrefix(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function validMagicBytes(contentType: AllowedFileType, bytes: Uint8Array): boolean {
  switch (contentType) {
    case "image/png":
      return hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return hasPrefix(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a" ||
        new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a";
    case "image/webp":
      return (
        new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
        new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
      );
    case "application/pdf":
      return new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
    case "text/html":
    case "text/markdown":
    case "text/plain":
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
        return !decoded.includes("\u0000");
      } catch {
        return false;
      }
  }
}

function assetMetadata(value: JsonValue): AssetMetadata {
  const object = asJsonObject(value);
  const { id, key, contentType, sizeBytes, sha256, fileName, status } = object;
  if (
    typeof id !== "string" ||
    typeof key !== "string" ||
    !ALLOWED_FILE_TYPES.includes(contentType as AllowedFileType) ||
    typeof sizeBytes !== "number" ||
    typeof sha256 !== "string" ||
    (fileName !== undefined && typeof fileName !== "string") ||
    (status !== undefined && status !== "pending" && status !== "ready")
  ) {
    throw new ApiError(500, "INTERNAL_ERROR", "The file repository returned invalid metadata");
  }
  return {
    id,
    key,
    contentType: contentType as AllowedFileType,
    sizeBytes,
    sha256,
    fileName,
    status,
  };
}

async function sign(
  env: ApiEnv,
  key: string,
  method: "GET" | "PUT",
  expiresIn: number,
  headers?: HeadersInit,
  query?: Readonly<Record<string, string>>,
): Promise<string> {
  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: "auto",
    service: "s3",
    retries: 0,
  });
  const url = objectUrl(env, key);
  url.searchParams.set("X-Amz-Expires", String(expiresIn));
  for (const [name, value] of Object.entries(query ?? {})) {
    url.searchParams.set(name, value);
  }
  const request = await aws.sign(url, {
    method,
    headers,
    aws: {
      allHeaders: true,
      signQuery: true,
    },
  });
  return request.url;
}

export class FileService {
  readonly #repository: DomainRepository;
  readonly #env: ApiEnv;

  constructor(repository: DomainRepository, env: ApiEnv) {
    this.#repository = repository;
    this.#env = env;
  }

  async initialize(actor: Actor, input: InitializeUploadInput): Promise<JsonValue> {
    if (input.sizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new ApiError(413, "BODY_TOO_LARGE", "Files may not exceed 25 MiB");
    }

    const assetId = crypto.randomUUID();
    const key = input.collectionId
      ? `collections/${input.collectionId}/${actor.userId}/${assetId}`
      : `users/${actor.userId}/${assetId}`;
    bytesFromHex(input.sha256);
    const dbResult = await this.#repository.call("fileInitialize", actor.userId, {
      assetId,
      key,
      ...(input.collectionId ? { collectionId: input.collectionId } : {}),
      fileName: input.fileName,
      contentType: input.contentType,
      idempotencyKey: input.idempotencyKey,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256.toLowerCase(),
    });
    const stored = assetMetadata(dbResult);
    const expiresIn = ttl(this.#env.PRESIGNED_UPLOAD_TTL_SECONDS, 900, 3_600);
    const headers = {
      "content-length": String(stored.sizeBytes),
      "content-type": stored.contentType,
      "x-amz-checksum-sha256": base64(bytesFromHex(stored.sha256)),
    };
    const uploadUrl = await sign(this.#env, stored.key, "PUT", expiresIn, headers);

    return {
      assetId: stored.id,
      uploadUrl,
      headers,
      method: "PUT",
      expiresIn,
      asset: dbResult,
      upload: {
        expiresIn,
        headers,
        method: "PUT",
        url: uploadUrl,
      },
    };
  }

  async finalize(actor: Actor, assetId: string): Promise<JsonValue> {
    const prepared = await this.#repository.call("fileDownload", actor.userId, {
      assetId,
      purpose: "finalize",
    });
    const expected = assetMetadata(prepared);
    if (expected.status === "ready") {
      return prepared;
    }
    const object = await this.#env.FILES.head(expected.key);
    if (!object || object.size !== expected.sizeBytes) {
      throw new ApiError(409, "FILE_NOT_READY", "The uploaded object is missing or has the wrong size");
    }

    const actualChecksum = object.checksums.sha256 ? hex(object.checksums.sha256) : null;
    if (!actualChecksum || !constantTimeHexEqual(actualChecksum, expected.sha256)) {
      await this.#env.FILES.delete(expected.key);
      throw new ApiError(409, "FILE_CHECKSUM_MISMATCH", "The uploaded object failed checksum validation");
    }

    const prefix = await this.#env.FILES.get(expected.key, {
      range: { length: Math.min(expected.sizeBytes, 512), offset: 0 },
    });
    if (!prefix || !("body" in prefix)) {
      throw new ApiError(409, "FILE_NOT_READY", "The uploaded object cannot be inspected");
    }
    const bytes = new Uint8Array(await prefix.arrayBuffer());
    if (!validMagicBytes(expected.contentType, bytes)) {
      await this.#env.FILES.delete(expected.key);
      throw new ApiError(415, "FILE_INVALID_TYPE", "The file contents do not match its declared type");
    }

    return this.#repository.call("fileFinalize", actor.userId, {
      assetId,
      etag: object.etag,
      uploadedAt: object.uploaded.toISOString(),
    });
  }

  async download(actor: Actor, assetId: string): Promise<JsonValue> {
    const authorized = await this.#repository.call("fileDownload", actor.userId, {
      assetId,
      purpose: "download",
    });
    const metadata = assetMetadata(authorized);
    const expiresIn = ttl(this.#env.PRESIGNED_DOWNLOAD_TTL_SECONDS, 300, 3_600);
    const responseOverrides =
      metadata.contentType === "text/html"
        ? {
            "response-content-disposition": "attachment",
            "response-content-type": "application/octet-stream",
          }
        : undefined;
    const url = await sign(
      this.#env,
      metadata.key,
      "GET",
      expiresIn,
      undefined,
      responseOverrides,
    );
    return {
      assetId: metadata.id,
      contentType: metadata.contentType,
      expiresIn,
      fileName: metadata.fileName ?? null,
      url,
    };
  }

  async delete(actor: Actor, assetId: string): Promise<JsonValue> {
    const deleted = await this.#repository.call("fileDelete", actor.userId, { assetId });
    const object = asJsonObject(deleted);
    if (typeof object.key !== "string") {
      throw new ApiError(500, "INTERNAL_ERROR", "The file repository returned no object key");
    }
    await this.#env.FILES.delete(object.key);
    return deleted;
  }
}
