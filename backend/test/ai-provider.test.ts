import { describe, expect, it, vi } from "vitest";
import { AiOperationService } from "../src/ai/provider";
import type { DomainRepository } from "../src/db/repository";
import type { Actor, JsonObject } from "../src/types";

const actor: Actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "learner@example.test",
  tokenId: null,
  sessionId: null,
};

const request = {
  contractVersion: 1,
  operationId: "22222222-2222-4222-8222-222222222222",
  kind: "evaluate_answer" as const,
  collectionId: "33333333-3333-4333-8333-333333333333",
  unitId: "44444444-4444-4444-8444-444444444444",
  input: {
    lesson: { id: "55555555-5555-4555-8555-555555555555" },
    questionId: "question-1",
    answer: { value: "answer" },
  },
};

function env(): ApiEnv {
  return {
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "test-model",
    OPENAI_DAILY_BUDGET_UNITS: "1000",
    OPENAI_LESSON_RESERVATION_UNITS: "10",
    OPENAI_ASSISTANCE_RESERVATION_UNITS: "2",
  } as unknown as ApiEnv;
}

function repository(call: DomainRepository["call"]): DomainRepository {
  return { call, checkHealth: vi.fn() };
}

describe("AiOperationService", () => {
  it("returns a retained idempotent result without calling OpenAI", async () => {
    const retained = {
      contractVersion: 1,
      operationId: request.operationId,
      kind: request.kind,
      outcome: "completed",
      result: { evaluation: { status: "correct" } },
    } as JsonObject;
    const call = vi.fn().mockResolvedValue({ status: "completed", result: retained });
    const fetcher = vi.fn();
    const service = new AiOperationService(repository(call), env(), fetcher);

    await expect(service.run(actor, request)).resolves.toEqual(retained);
    expect(fetcher).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledOnce();
  });

  it("fails closed before reserving when the global budget is absent or invalid", async () => {
    const call = vi.fn();
    const invalidEnv = { ...env(), OPENAI_DAILY_BUDGET_UNITS: "0" } as unknown as ApiEnv;
    const service = new AiOperationService(repository(call), invalidEnv, vi.fn());

    await expect(service.run(actor, request)).rejects.toMatchObject({
      code: "AI_UNAVAILABLE",
      status: 503,
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("reserves canonical context, sends a storage-disabled structured request, and settles usage", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ status: "reserved", context: { unit: { id: request.unitId } } })
      .mockResolvedValueOnce({ settled: true });
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify({ result: { evaluation: {
        status: "correct",
        score: 1,
        correctParts: [],
        errors: [],
        correction: "Correct.",
        explanation: "The answer matches.",
        nextHint: "Continue.",
      } } }),
      usage: { input_tokens: 10, output_tokens: 6 },
    }), { status: 200 }));
    const service = new AiOperationService(repository(call), env(), fetcher);

    await expect(service.run(actor, request)).resolves.toMatchObject({
      outcome: "completed",
      result: { evaluation: { status: "correct" } },
    });
    expect(call.mock.calls[0]?.[2]).toMatchObject({
      lessonId: request.input.lesson.id,
      operationId: request.operationId,
      reservationUnits: 2,
    });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: expect.stringContaining('"store":false'),
    });
    expect(call.mock.calls[1]?.[2]).toMatchObject({
      outcome: "completed",
      inputTokens: 10,
      outputTokens: 6,
    });
  });
});
