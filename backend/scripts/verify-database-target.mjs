import { requiredEnvironment } from "./acceptance-helpers.mjs";
import { assertPinnedHostedDatabaseTarget } from "./database-identity.mjs";

assertPinnedHostedDatabaseTarget({
  environment: requiredEnvironment("MEOING_DATABASE_ENVIRONMENT"),
  expectedProjectRef: requiredEnvironment(
    "MEOING_EXPECTED_SUPABASE_PROJECT_REF",
  ),
  projectRef: requiredEnvironment("SUPABASE_PROJECT_REF"),
});

console.log("Hosted database deployment target confirmed");
