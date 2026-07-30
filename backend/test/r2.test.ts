import { AwsClient } from "aws4fetch";
import { describe, expect, it, vi } from "vitest";
import type { DomainRepository, RpcOperation } from "../src/db/repository";
import { FileService } from "../src/storage/r2";
import { asJsonObject, type Actor, type JsonObject, type JsonValue } from "../src/types";

const ACTOR: Actor = {
  userId: "101ed68b-c50b-4b35-b44c-45a0ef227f6e",
  email: "cat@example.com",
  sessionId: "session-id",
  tokenId: "token-id",
};

describe("R2 file lifecycle", () => {
  it("returns an already-ready asset without re-reading R2 on finalize retry", async () => {
    const readyAsset: JsonValue = {
      id: "1b26fe98-1f4d-4306-a620-454059304cf5",
      key: "users/owner/asset",
      contentType: "image/png",
      sizeBytes: 8,
      sha256: "a".repeat(64),
      status: "ready",
    };
    const call = vi.fn(async (
      operation: RpcOperation,
      _actorId: string,
      _input?: JsonObject,
    ) => {
      expect(operation).toBe("fileDownload");
      return readyAsset;
    });
    const repository: DomainRepository = {
      call,
      checkHealth: async () => undefined,
    };
    const head = vi.fn();
    const service = new FileService(repository, {
      FILES: { head },
    } as unknown as ApiEnv);

    await expect(service.finalize(ACTOR, String(readyAsset.id))).resolves.toEqual(readyAsset);
    expect(call).toHaveBeenCalledOnce();
    expect(head).not.toHaveBeenCalled();
  });

  it("binds the exact upload byte length into the R2 PUT signature", async () => {
    const accessKeyId = "test-access-key";
    const secretAccessKey = "test-secret-key";
    const sha256 = "a".repeat(64);
    const call = vi.fn(async (
      operation: RpcOperation,
      _actorId: string,
      input: JsonObject = {},
    ): Promise<JsonValue> => {
      expect(operation).toBe("fileInitialize");
      return {
        id: String(input.assetId),
        key: String(input.key),
        contentType: String(input.contentType),
        sizeBytes: Number(input.sizeBytes),
        sha256: String(input.sha256),
        status: "pending",
      };
    });
    const repository: DomainRepository = {
      call,
      checkHealth: async () => undefined,
    };
    const service = new FileService(repository, {
      R2_ACCESS_KEY_ID: accessKeyId,
      R2_ACCOUNT_ID: "account-id",
      R2_BUCKET_NAME: "files",
      R2_SECRET_ACCESS_KEY: secretAccessKey,
      PRESIGNED_UPLOAD_TTL_SECONDS: "900",
    } as unknown as ApiEnv);

    const initialized = asJsonObject(await service.initialize(ACTOR, {
      contentType: "image/png",
      fileName: "tiny.png",
      idempotencyKey: "upload-size-test-0001",
      sha256,
      sizeBytes: 8,
    }));
    const headers = asJsonObject(initialized.headers);
    const uploadUrl = new URL(String(initialized.uploadUrl));
    const signedHeaders = uploadUrl.searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];

    expect(headers["content-length"]).toBe("8");
    expect(signedHeaders).toContain("content-length");

    const originalSignature = uploadUrl.searchParams.get("X-Amz-Signature");
    uploadUrl.searchParams.delete("X-Amz-Signature");
    const tamperedHeaders = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name, String(value)]),
    );
    tamperedHeaders["content-length"] = "9";
    const tampered = await new AwsClient({
      accessKeyId,
      secretAccessKey,
      region: "auto",
      retries: 0,
      service: "s3",
    }).sign(uploadUrl, {
      method: "PUT",
      headers: tamperedHeaders,
      aws: {
        allHeaders: true,
        signQuery: true,
      },
    });

    expect(new URL(tampered.url).searchParams.get("X-Amz-Signature")).not.toBe(
      originalSignature,
    );
  });
});
