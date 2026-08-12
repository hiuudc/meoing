import { OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { verifyTurnstile } from "./abuse/turnstile";
import type { AppBindings } from "./app-types";
import { verifySupabaseJwt } from "./auth/jwt";
import type { DatabaseIdentity, RepositoryFactory } from "./db/repository";
import { ApiError, errorResponse } from "./http/errors";
import {
  ErrorSchema,
  LiveHealthSchema,
  ReadyHealthSchema,
  successSchema,
} from "./http/schemas";
import { log } from "./observability";
import { registerAiRoutes } from "./routes/ai-routes";
import { registerFileRoutes, registerRpcRoutes } from "./routes/rpc-routes";
import type { Actor, RequestState } from "./types";

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

export interface ApiDependencies {
  readonly repositoryFactory: RepositoryFactory;
  readonly jwtVerifier?: (request: Request, env: ApiEnv) => Promise<Actor>;
  readonly rateLimiter?: (
    env: ApiEnv,
    actor: Actor,
    method: string,
    path: string,
  ) => Promise<boolean>;
  readonly turnstileVerifier?: (
    token: string,
    remoteIp: string | null,
    secret: string,
  ) => Promise<void>;
}

function origins(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export type RateLimitClass = "ai" | "progress" | "read" | "write";

export function rateLimitClass(method: string, path: string): RateLimitClass {
  if (path.startsWith("/v1/ai/")) return "ai";
  if (path.includes("/progress") || path.includes("/batches")) {
    return "progress";
  }
  return method === "GET" || method === "HEAD" ? "read" : "write";
}

export function rateLimitKey(actorId: string, method: string, path: string): string {
  return `${actorId}:${rateLimitClass(method, path)}`;
}

function pathRateLimit(env: ApiEnv, method: string, path: string): RateLimit {
  switch (rateLimitClass(method, path)) {
    case "ai":
      return env.AI_RATE_LIMIT;
    case "progress":
      return env.PROGRESS_RATE_LIMIT;
    case "read":
      return env.READ_RATE_LIMIT;
    case "write":
      return env.WRITE_RATE_LIMIT;
  }
}

export function createApiApp(dependencies: ApiDependencies): OpenAPIHono<AppBindings> {
  const repositoryFactory = dependencies.repositoryFactory;
  const jwtVerifier =
    dependencies.jwtVerifier ??
    ((request: Request, env: ApiEnv) =>
      verifySupabaseJwt(request, {
        audience: env.SUPABASE_JWT_AUDIENCE,
        supabaseUrl: env.SUPABASE_URL,
      }));
  const rateLimiter =
    dependencies.rateLimiter ??
    (async (env: ApiEnv, currentActor: Actor, method: string, path: string) => {
      const limiter = pathRateLimit(env, method, path);
      const result = await limiter.limit({
        key: rateLimitKey(currentActor.userId, method, path),
      });
      return result.success;
    });
  const turnstileVerifier = dependencies.turnstileVerifier ?? verifyTurnstile;

  const app = new OpenAPIHono<AppBindings>({
    defaultHook: (result, _c) => {
      if (!result.success) {
        throw new ApiError(400, "INVALID_REQUEST", "Request validation failed");
      }
    },
  });

  app.use("*", async (c, next) => {
    const requestState: RequestState = {
      actor: null,
      databaseDurationMs: 0,
      queryCount: 0,
      requestId: crypto.randomUUID(),
      startedAt: Date.now(),
    };
    c.set("requestState", requestState);
    c.header("x-request-id", requestState.requestId);
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");

    try {
      await next();
    } finally {
      log(c.res.status >= 500 ? "error" : c.res.status >= 400 ? "warn" : "info", {
        durationMs: Date.now() - requestState.startedAt,
        databaseDurationMs: requestState.databaseDurationMs,
        environment: c.env.APP_ENV,
        event: "http_request",
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        requestId: requestState.requestId,
        queryCount: requestState.queryCount,
        status: c.res.status,
      });
    }
  });

  app.use(
    "*",
    cors({
      allowHeaders: [
        "authorization",
        "content-type",
        "idempotency-key",
        "if-match",
        "x-turnstile-token",
      ],
      allowMethods: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
      credentials: false,
      exposeHeaders: ["x-request-id"],
      maxAge: 3_600,
      origin: (origin, c) => (origins(c.env.CORS_ORIGINS).has(origin) ? origin : null),
    }),
  );

  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: MAX_JSON_BODY_BYTES,
      onError: () => {
        throw new ApiError(413, "BODY_TOO_LARGE", "JSON request bodies may not exceed 2 MiB");
      },
    }),
  );

  app.use("/v1/*", async (c, next) => {
    const repository = repositoryFactory(c.env);
    const requestState = c.get("requestState");
    c.set("repository", {
      checkHealth: () => repository.checkHealth(),
      call: async (...arguments_) => {
        requestState.queryCount += 1;
        const startedAt = performance.now();
        try {
          return await repository.call(...arguments_);
        } finally {
          requestState.databaseDurationMs += performance.now() - startedAt;
        }
      },
    });
    const currentActor = await jwtVerifier(c.req.raw, c.env);
    c.get("requestState").actor = currentActor;

    const path = new URL(c.req.url).pathname;
    if (!(await rateLimiter(c.env, currentActor, c.req.method, path))) {
      throw new ApiError(429, "RATE_LIMITED", "Too many requests; retry shortly");
    }
    await next();
  });

  app.use("/v1/invites/*", async (c, next) => {
    await turnstileVerifier(
      c.req.header("x-turnstile-token") ?? "",
      c.req.header("cf-connecting-ip") ?? null,
      c.env.TURNSTILE_SECRET_KEY,
    );
    await next();
  });

  app.get("/health/live", (c) =>
    c.json({
      data: {
        environment: c.env.APP_ENV,
        supabaseProjectRef: new URL(c.env.SUPABASE_URL).hostname.split(".")[0] ?? "",
        status: "ok",
      },
      meta: { requestId: c.get("requestState").requestId },
    }),
  );
  app.get("/health/ready", async (c) => {
    const repository = repositoryFactory(c.env);
    const requestState = c.get("requestState");
    requestState.queryCount += 1;
    const startedAt = performance.now();
    let databaseIdentity: DatabaseIdentity;
    try {
      databaseIdentity = await repository.checkHealth();
    } finally {
      requestState.databaseDurationMs += performance.now() - startedAt;
    }
    const expectedProjectRef = c.env.APP_ENV === "local"
      ? "local"
      : new URL(c.env.SUPABASE_URL).hostname.split(".")[0] ?? "";
    if (
      databaseIdentity.environment !== c.env.APP_ENV ||
      databaseIdentity.supabaseProjectRef !== expectedProjectRef
    ) {
      throw new ApiError(
        503,
        "INTERNAL_ERROR",
        "The database identity does not match the Worker environment",
      );
    }
    return c.json({
      data: {
        databaseEnvironment: databaseIdentity.environment,
        databaseProjectRef: databaseIdentity.supabaseProjectRef,
        status: "ready",
      },
      meta: { requestId: c.get("requestState").requestId },
    });
  });

  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/health/live",
    operationId: "live",
    summary: "Worker liveness check",
    tags: ["Health"],
    responses: {
      200: {
        description: "The Worker is running",
        content: {
          "application/json": {
            schema: successSchema(LiveHealthSchema),
          },
        },
      },
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/health/ready",
    operationId: "ready",
    summary: "Database readiness check",
    tags: ["Health"],
    responses: {
      200: {
        description: "The Worker can reach PostgreSQL",
        content: {
          "application/json": {
            schema: successSchema(ReadyHealthSchema),
          },
        },
      },
      503: {
        description: "The database is unavailable",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  registerAiRoutes(app);
  registerRpcRoutes(app);
  registerFileRoutes(app);

  app.openAPIRegistry.registerComponent("securitySchemes", "BearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "Supabase JWT",
  });
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Meoing API",
      version: "1.0.0",
      description: "Cloud API shared by the Meoing website, mobile clients and future apps.",
    },
    servers: [{ url: "/" }],
  });

  app.notFound((c) =>
    errorResponse(c, new ApiError(404, "NOT_FOUND", "The requested endpoint does not exist")),
  );
  app.onError((error, c) => {
    let apiError: ApiError;
    if (error instanceof ApiError) {
      apiError = error;
    } else if (error instanceof z.ZodError) {
      apiError = new ApiError(400, "INVALID_REQUEST", "Request validation failed", {
        issues: error.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          path: issue.path.join("."),
        })),
      });
    } else {
      apiError = new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred");
    }

    log(apiError.status >= 500 ? "error" : "warn", {
      databaseCode: apiError.internalCode,
      environment: c.env.APP_ENV,
      errorCode: apiError.code,
      errorMessage:
        apiError.status >= 500 && error instanceof Error ? error.message.slice(0, 500) : undefined,
      errorName: error instanceof Error ? error.name : "UnknownError",
      event: "http_error",
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      requestId: c.get("requestState")?.requestId,
      status: apiError.status,
    });
    return errorResponse(c, apiError);
  });

  return app;
}
