import { createApiApp } from "./app";
import { PostgresDomainRepository } from "./db/repository";

function expectedDatabaseProjectRef(env: ApiEnv): string {
  if (env.APP_ENV === "local") return "local";
  return new URL(env.SUPABASE_URL).hostname.split(".")[0] ?? "";
}

const app = createApiApp({
  repositoryFactory: (env) =>
    new PostgresDomainRepository(
      env.HYPERDRIVE.connectionString,
      {
        environment: env.APP_ENV,
        supabaseProjectRef: expectedDatabaseProjectRef(env),
      },
    ),
});

export default {
  fetch(request: Request, env: ApiEnv, ctx: ExecutionContext): Promise<Response> {
    return Promise.resolve(app.fetch(request, env, ctx));
  },
} satisfies ExportedHandler<ApiEnv>;
