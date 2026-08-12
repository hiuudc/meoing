import { AiOperationRequestSchema } from "@meoing/ai-operation-contract";
import { z, type OpenAPIHono } from "@hono/zod-openapi";
import { AiOperationService } from "../ai/provider";
import type { AppBindings } from "../app-types";
import { ApiError } from "../http/errors";
import { successSchema } from "../http/schemas";

const AiOperationRequestHttpSchema = z.object({
  contractVersion: z.literal(1),
  operationId: z.uuid(),
  kind: z.enum(["create_lesson", "evaluate_answer", "coaching"]),
  collectionId: z.uuid(),
  unitId: z.uuid(),
  input: z.record(z.string(), z.unknown()),
}).strict();

const AiOperationResultHttpSchema = z.object({
  contractVersion: z.literal(1),
  operationId: z.uuid(),
  kind: z.enum(["create_lesson", "evaluate_answer", "coaching"]),
  outcome: z.enum(["completed", "needs_source", "failed"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
}).strict();

export function registerAiRoutes(app: OpenAPIHono<AppBindings>): void {
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/ai/operations",
    operationId: "runAiOperation",
    summary: "Run an authorized AI learning operation",
    tags: ["AI"],
    security: [{ BearerAuth: [] }],
    request: {
      body: { required: true, content: { "application/json": { schema: AiOperationRequestHttpSchema } } },
    },
    responses: {
      200: { description: "Validated operation result", content: { "application/json": { schema: successSchema(AiOperationResultHttpSchema) } } },
      400: { description: "Invalid operation" },
      403: { description: "Consent or permission missing" },
      429: { description: "AI quota exhausted" },
    },
  });

  app.post("/v1/ai/operations", async (context) => {
    const currentActor = context.get("requestState").actor;
    if (!currentActor) throw new ApiError(401, "AUTH_REQUIRED", "Authentication is required");
    if (!context.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ApiError(400, "INVALID_REQUEST", "Content-Type must be application/json");
    }
    const body = AiOperationRequestSchema.parse(await context.req.json());
    if (context.req.header("idempotency-key") !== body.operationId) {
      throw new ApiError(400, "INVALID_REQUEST", "Idempotency-Key must equal operationId");
    }
    const result = await new AiOperationService(context.get("repository"), context.env).run(currentActor, body);
    return context.json({ data: result, meta: { requestId: context.get("requestState").requestId } });
  });
}
