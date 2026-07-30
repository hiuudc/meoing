import {
  PostgresMaintenanceRepository,
  type MaintenanceRepository,
} from "./db/maintenance-repository";
import { runMaintenance, type MaintenanceFetch } from "./maintenance";
import { log } from "./observability";

export type MaintenanceRepositoryFactory = (env: MaintenanceEnv) => MaintenanceRepository;

export function createMaintenanceHandler(
  repositoryFactory: MaintenanceRepositoryFactory = (env) =>
    new PostgresMaintenanceRepository(env.HYPERDRIVE.connectionString),
  fetcher: MaintenanceFetch = fetch,
): ExportedHandler<MaintenanceEnv> {
  return {
    async scheduled(
      _controller: ScheduledController,
      env: MaintenanceEnv,
      _ctx: ExecutionContext,
    ): Promise<void> {
      const startedAt = Date.now();
      try {
        await runMaintenance(env, repositoryFactory(env), fetcher);
      } catch (error) {
        log("error", {
          durationMs: Date.now() - startedAt,
          environment: env.APP_ENV,
          errorName: error instanceof Error ? error.name : "UnknownError",
          event: "maintenance_failed",
        });
        throw new Error("Maintenance failed");
      }
    },
  };
}

export default createMaintenanceHandler();
