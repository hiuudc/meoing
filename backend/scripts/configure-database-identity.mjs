import { requiredEnvironment } from "./acceptance-helpers.mjs";
import { configureHostedDatabaseIdentity } from "./database-identity.mjs";

await configureHostedDatabaseIdentity({
  accessToken: requiredEnvironment("SUPABASE_ACCESS_TOKEN"),
  environment: requiredEnvironment("MEOING_DATABASE_ENVIRONMENT"),
  expectedProjectRef: requiredEnvironment(
    "MEOING_EXPECTED_SUPABASE_PROJECT_REF",
  ),
  projectRef: requiredEnvironment("SUPABASE_PROJECT_REF"),
});

console.log("Hosted database deployment identity confirmed");
