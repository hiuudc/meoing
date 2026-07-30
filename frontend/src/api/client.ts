export interface ApiMeta {
  requestId?: string;
  nextCursor?: string | null;
  [key: string]: unknown;
}

export interface ApiSuccess<T> {
  data: T;
  meta?: ApiMeta;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(status: number, error: ApiErrorBody) {
    super(error.message);
    this.name = "ApiError";
    this.status = status;
    this.code = error.code;
    this.details = error.details;
    this.requestId = error.requestId;
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  idempotencyKey?: string;
}

type AccessTokenProvider = () => Promise<string | null>;

function fallbackError(response: Response): ApiErrorBody {
  return {
    code: response.status === 401 ? "UNAUTHENTICATED" : "REQUEST_FAILED",
    message: response.statusText || "The request could not be completed.",
    requestId: response.headers.get("x-request-id") ?? undefined,
  };
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getAccessToken: AccessTokenProvider,
  ) {}

  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<ApiSuccess<T>> {
    const token = await this.getAccessToken();
    if (!token) {
      throw new ApiError(401, {
        code: "UNAUTHENTICATED",
        message: "Sign in is required.",
      });
    }

    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${token}`);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const candidate = payload && typeof payload === "object" && "error" in payload
        ? (payload as { error?: ApiErrorBody }).error
        : undefined;
      throw new ApiError(response.status, candidate ?? fallbackError(response));
    }

    if (!payload || typeof payload !== "object" || !("data" in payload)) {
      throw new ApiError(502, {
        code: "INVALID_API_RESPONSE",
        message: "The API returned an invalid response envelope.",
        requestId: response.headers.get("x-request-id") ?? undefined,
      });
    }
    return payload as ApiSuccess<T>;
  }

  get<T>(path: string, signal?: AbortSignal): Promise<ApiSuccess<T>> {
    return this.request<T>(path, { method: "GET", signal });
  }

  post<T>(path: string, body?: unknown, idempotencyKey?: string): Promise<ApiSuccess<T>> {
    return this.request<T>(path, { method: "POST", body, idempotencyKey });
  }

  patch<T>(path: string, body?: unknown): Promise<ApiSuccess<T>> {
    return this.request<T>(path, { method: "PATCH", body });
  }

  put<T>(path: string, body?: unknown): Promise<ApiSuccess<T>> {
    return this.request<T>(path, { method: "PUT", body });
  }

  delete<T>(path: string, body?: unknown): Promise<ApiSuccess<T>> {
    return this.request<T>(path, { method: "DELETE", body });
  }
}

export function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId ? `${error.message} (request ${error.requestId})` : error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
