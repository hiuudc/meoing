import { runCostGuard, type CostGuardDependencies } from "./cost-guard/service";

export function createCostGuardHandler(
  dependencies: Partial<CostGuardDependencies> = {},
): ExportedHandler<CostGuardEnv> {
  return {
    async scheduled(
      _controller: ScheduledController,
      env: CostGuardEnv,
      _ctx: ExecutionContext,
    ): Promise<void> {
      const startedAt = Date.now();
      try {
        const state = await runCostGuard(env, dependencies);
        console.log(
          JSON.stringify({
            level: "info",
            event: "cost_guard_complete",
            environment: env.APP_ENV,
            status: state.status,
            durationMs: Date.now() - startedAt,
          }),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "cost_guard_failed",
            environment: env.APP_ENV,
            errorName: error instanceof Error ? error.name : "UnknownError",
            durationMs: Date.now() - startedAt,
          }),
        );
        throw new Error("Cost Guard failed");
      }
    },
  };
}

// Intentionally no fetch handler: this Worker is reachable only by its Cron trigger.
export default createCostGuardHandler();
