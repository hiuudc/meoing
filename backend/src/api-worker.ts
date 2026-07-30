import { createApiApp } from "./app";
import { PostgresDomainRepository } from "./db/repository";

const app = createApiApp({
  repositoryFactory: (env) => new PostgresDomainRepository(env.HYPERDRIVE.connectionString),
});

export default {
  fetch(request: Request, env: ApiEnv, ctx: ExecutionContext): Promise<Response> {
    return Promise.resolve(app.fetch(request, env, ctx));
  },
} satisfies ExportedHandler<ApiEnv>;
