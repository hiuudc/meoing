import {
  integerEnvironment,
  normalizedBaseUrl,
  optionalEnvironment,
  requiredEnvironment,
} from "./acceptance-helpers.mjs";
import {
  cleanupStagingAcceptanceUsers,
  parseAcceptanceCleanupSelection,
} from "./acceptance-cleanup.mjs";
import { createStagingAcceptanceDataCleaner } from "./acceptance-cleanup-data.mjs";

const HELP = `
Meoing staging acceptance user cleanup

This command hard-deletes only explicitly selected reserved staging identities whose
app_metadata.meoing_acceptance object exactly matches the expected staging project
and username. It verifies the application profile and globally revokes sessions
before any user is deleted. Missing selected users are successful no-ops.

Required:
  MEOING_CLEANUP_API_URL
  MEOING_CLEANUP_SUPABASE_URL
  MEOING_CLEANUP_EXPECTED_SUPABASE_PROJECT_REF
  MEOING_CLEANUP_SUPABASE_SECRET_KEY
    Temporary staging-only sb_secret_* key.
  MEOING_CLEANUP_SUPABASE_PUBLISHABLE_KEY
  MEOING_CLEANUP_USERNAMES_JSON
    Non-empty JSON array containing only acceptance.owner, acceptance.member, or
    load001 through load100. No account is selected implicitly.
  MEOING_CLEANUP_OWNER_PASSWORD
  MEOING_CLEANUP_MEMBER_PASSWORD
  MEOING_CLEANUP_LOAD_PASSWORD
  MEOING_CLEANUP_DATABASE_URL
    Temporary TLS connection URL for the staging postgres operations role.
  MEOING_CLEANUP_R2_ACCOUNT_ID
  MEOING_CLEANUP_R2_BUCKET_NAME
    Must be exactly meoing-files-staging.
  MEOING_CLEANUP_R2_ACCESS_KEY_ID
  MEOING_CLEANUP_R2_SECRET_ACCESS_KEY
    Temporary bucket-scoped Object Read & Write credentials.

Auth pacing (optional):
  MEOING_CLEANUP_EXPECTED_API_ORIGIN=https://api-staging.meoing.com
    Must be HTTPS and exactly match API_URL.
  MEOING_ACCEPTANCE_AUTH_INTERVAL_MS=2100
  MEOING_ACCEPTANCE_AUTH_MAX_ATTEMPTS=8

The command never prints credentials, access tokens, or account email addresses.
Revoke every temporary credential immediately after the command finishes.
`;

if (process.argv.includes("--help")) {
  console.log(HELP.trim());
  process.exit(0);
}

const selectedUsernames = parseAcceptanceCleanupSelection(
  requiredEnvironment("MEOING_CLEANUP_USERNAMES_JSON"),
);
const applicationDataCleaner = createStagingAcceptanceDataCleaner({
  databaseUrl: requiredEnvironment("MEOING_CLEANUP_DATABASE_URL"),
  r2AccessKeyId: requiredEnvironment("MEOING_CLEANUP_R2_ACCESS_KEY_ID"),
  r2AccountId: requiredEnvironment("MEOING_CLEANUP_R2_ACCOUNT_ID"),
  r2BucketName: requiredEnvironment("MEOING_CLEANUP_R2_BUCKET_NAME"),
  r2SecretAccessKey: requiredEnvironment("MEOING_CLEANUP_R2_SECRET_ACCESS_KEY"),
});
const apiUrl = normalizedBaseUrl(
  requiredEnvironment("MEOING_CLEANUP_API_URL"),
  "MEOING_CLEANUP_API_URL",
);
const expectedApiOrigin = normalizedBaseUrl(
  optionalEnvironment("MEOING_CLEANUP_EXPECTED_API_ORIGIN") ??
    "https://api-staging.meoing.com",
  "MEOING_CLEANUP_EXPECTED_API_ORIGIN",
);

let summary;
try {
  summary = await cleanupStagingAcceptanceUsers({
    applicationDataCleaner,
    apiUrl,
    expectedApiOrigin,
    expectedProjectRef: requiredEnvironment(
      "MEOING_CLEANUP_EXPECTED_SUPABASE_PROJECT_REF",
    ),
    loadPassword: requiredEnvironment("MEOING_CLEANUP_LOAD_PASSWORD"),
    maximumAuthAttempts: integerEnvironment(
      "MEOING_ACCEPTANCE_AUTH_MAX_ATTEMPTS",
      8,
      1,
      20,
    ),
    memberPassword: requiredEnvironment("MEOING_CLEANUP_MEMBER_PASSWORD"),
    onAuthenticationProgress: ({ completed, total }) => {
      if (completed % 10 === 0 || completed === total) {
        console.log(`Cleanup authentication: ${completed}/${total}`);
      }
    },
    onAuthenticationRetry: ({ attempt, delayMilliseconds, maximumAttempts }) => {
      console.warn(
        "Supabase Auth rate-limited cleanup authentication; " +
          `retrying in ${Math.ceil(delayMilliseconds / 1_000)}s ` +
          `(attempt ${attempt + 1}/${maximumAttempts})`,
      );
    },
    ownerPassword: requiredEnvironment("MEOING_CLEANUP_OWNER_PASSWORD"),
    publishableKey: requiredEnvironment(
      "MEOING_CLEANUP_SUPABASE_PUBLISHABLE_KEY",
    ),
    requestIntervalMilliseconds: integerEnvironment(
      "MEOING_ACCEPTANCE_AUTH_INTERVAL_MS",
      2_100,
      250,
      60_000,
    ),
    secretKey: requiredEnvironment("MEOING_CLEANUP_SUPABASE_SECRET_KEY"),
    selectedUsernames,
    supabaseUrl: normalizedBaseUrl(
      requiredEnvironment("MEOING_CLEANUP_SUPABASE_URL"),
      "MEOING_CLEANUP_SUPABASE_URL",
    ),
  });
} finally {
  await applicationDataCleaner.close();
}

console.log(
  `Cleanup complete: ${summary.selected} explicitly selected, ` +
    `${summary.deleted} deleted, ${summary.absent} already absent.`,
);
console.log(
  "Revoke the temporary Supabase and R2 credentials now, and rotate the temporary database credential.",
);
