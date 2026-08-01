import { assert } from "./acceptance-helpers.mjs";

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const HOSTED_ENVIRONMENTS = new Set(["staging", "production"]);

export function assertHostedDatabaseIdentity({ environment, projectRef }) {
  assert(
    HOSTED_ENVIRONMENTS.has(environment),
    "MEOING_DATABASE_ENVIRONMENT must be staging or production",
  );
  assert(
    PROJECT_REF_PATTERN.test(projectRef),
    "SUPABASE_PROJECT_REF must be a 20-character lowercase alphanumeric project ref",
  );
}

export function assertPinnedHostedDatabaseTarget({
  environment,
  expectedProjectRef,
  projectRef,
}) {
  assertHostedDatabaseIdentity({ environment, projectRef });
  assertHostedDatabaseIdentity({
    environment,
    projectRef: expectedProjectRef,
  });
  assert(
    projectRef === expectedProjectRef,
    "SUPABASE_PROJECT_REF does not match the independently pinned MEOING_EXPECTED_SUPABASE_PROJECT_REF",
  );
}

function collectIdentities(value, identities = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectIdentities(item, identities);
    return identities;
  }
  if (!value || typeof value !== "object") return identities;

  if (
    Object.hasOwn(value, "environment") &&
    (Object.hasOwn(value, "supabaseProjectRef") ||
      Object.hasOwn(value, "supabase_project_ref"))
  ) {
    identities.push(value);
  }
  for (const item of Object.values(value)) collectIdentities(item, identities);
  return identities;
}

function containsExactlyOneIdentity(value, environment, projectRef) {
  const identities = collectIdentities(value);
  return (
    identities.length === 1 &&
    identities[0].environment === environment &&
    (identities[0].supabaseProjectRef === projectRef ||
      identities[0].supabase_project_ref === projectRef)
  );
}

async function executeDatabaseQuery({
  accessToken,
  fetchImplementation,
  parameters,
  projectRef,
  query,
  readOnly,
  requestTimeoutMilliseconds,
}) {
  const response = await fetchImplementation(
    `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        parameters,
        query,
        read_only: readOnly,
      }),
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Supabase database identity configuration failed (HTTP ${response.status})`,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new Error("Supabase database identity configuration returned invalid JSON");
  }
}

export async function configureHostedDatabaseIdentity({
  accessToken,
  environment,
  expectedProjectRef,
  fetchImplementation = fetch,
  projectRef,
  requestTimeoutMilliseconds = 30_000,
}) {
  assertPinnedHostedDatabaseTarget({
    environment,
    expectedProjectRef,
    projectRef,
  });
  assert(
    typeof accessToken === "string" && accessToken.length >= 20,
    "SUPABASE_ACCESS_TOKEN is required",
  );

  const parameters = [environment, projectRef];
  const configuredPayload = await executeDatabaseQuery({
    accessToken,
    fetchImplementation,
    parameters,
    projectRef,
    query: `
      insert into private.deployment_identity as identity (
        singleton,
        environment,
        supabase_project_ref
      )
      values (true, $1::text, $2::text)
      on conflict (singleton) do update
      set configured_at = identity.configured_at
      where identity.environment = excluded.environment
        and identity.supabase_project_ref = excluded.supabase_project_ref
      returning jsonb_build_object(
        'environment', environment,
        'supabaseProjectRef', supabase_project_ref
      ) as identity
    `,
    readOnly: false,
    requestTimeoutMilliseconds,
  });
  assert(
    containsExactlyOneIdentity(configuredPayload, environment, projectRef),
    "The linked database refused to insert or confirm the expected deployment identity",
  );

  // Use a second statement so a freshly inserted marker is visible to the
  // STABLE assertion function. A data-modifying CTE and its outer query share
  // one PostgreSQL snapshot and cannot safely perform this verification.
  const verifiedPayload = await executeDatabaseQuery({
    accessToken,
    fetchImplementation,
    parameters,
    projectRef,
    query: `
      select private.assert_database_identity(
        $1::text,
        $2::text
      ) as identity
    `,
    readOnly: true,
    requestTimeoutMilliseconds,
  });
  assert(
    containsExactlyOneIdentity(verifiedPayload, environment, projectRef),
    "The linked database failed to verify the expected deployment identity",
  );
}
