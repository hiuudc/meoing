#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

const { Client, escapeIdentifier, escapeLiteral } = pg;

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("Missing required environment variable DATABASE_URL");
}

const runId = randomBytes(8).toString("hex");
const runtimeLoginRole = `meoing_concurrency_${runId}`;
const runtimeLoginPassword = randomBytes(32).toString("hex");
const runtimeLoginRoleSql = escapeIdentifier(runtimeLoginRole);
const runtimeLoginPasswordSql = escapeLiteral(runtimeLoginPassword);
const ownerId = randomUUID();
const firstMemberId = randomUUID();
const secondMemberId = randomUUID();
const userIds = [ownerId, firstMemberId, secondMemberId];
const storageAssetIds = [randomUUID(), randomUUID()];
const storagePrefix = `concurrency/${runId}`;
const usernamePolicyLockTarget = `lock.${runId}`;
const inviteTokenHash = createHash("sha256")
  .update(randomBytes(32))
  .digest("hex");

let collectionId;
let inviteId;

function runtimeDatabaseUrl() {
  const url = new URL(databaseUrl);
  url.username = runtimeLoginRole;
  url.password = runtimeLoginPassword;
  return url.toString();
}

function clientConfig(label, { runtime = false } = {}) {
  return {
    connectionString: runtime ? runtimeDatabaseUrl() : databaseUrl,
    application_name: `meoing-db-concurrency-${label}-${runId}`,
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  };
}

async function assertLocalDatabase(client) {
  const identity = await client.query(
    "select environment from private.deployment_identity where singleton",
  );
  assert.equal(
    identity.rows[0]?.environment,
    "local",
    "database concurrency acceptance is intentionally local-only",
  );
}

async function createRuntimeLogin(client) {
  await client.query(`
    create role ${runtimeLoginRoleSql}
      login
      nosuperuser
      noinherit
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls
      connection limit 4
      password ${runtimeLoginPasswordSql}
  `);
}

async function grantRuntimeLogin(client) {
  await client.query(`
    grant meoing_runtime to ${runtimeLoginRoleSql}
      with admin false, inherit false, set true
  `);
}

async function dropRuntimeLogin(client) {
  await client.query(`drop role if exists ${runtimeLoginRoleSql}`);
}

function errorSummary(error) {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
    code:
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined,
  };
}

async function rollbackQuietly(client) {
  try {
    await client.query("rollback");
  } catch {
    // Preserve the original database error.
  }
}

async function runAsRuntime(client, userId, queryText, values) {
  await client.query("begin");
  try {
    await client.query("set local role meoing_runtime");
    await client.query(
      "select pg_catalog.set_config('app.user_id', $1, true)",
      [userId],
    );
    const result = await client.query(queryText, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

async function prepareInviteAcceptance(client, userId) {
  await client.query("begin");
  try {
    await client.query("set local role meoing_runtime");
    await client.query(
      "select pg_catalog.set_config('app.user_id', $1, true)",
      [userId],
    );
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

async function acceptPreparedInvite(client, idempotencyKey) {
  try {
    const result = await client.query(
      `
        select private.api_invite_accept(
          jsonb_build_object(
            'tokenHash', $1::text,
            'idempotencyKey', $2::text
          )
        ) as value
      `,
      [inviteTokenHash, idempotencyKey],
    );
    await client.query("commit");
    return result.rows[0]?.value;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

async function seedUsers(client) {
  await client.query("begin");
  try {
    await client.query(
      `
        insert into auth.users (
          id,
          aud,
          role,
          email,
          encrypted_password,
          email_confirmed_at,
          raw_app_meta_data,
          raw_user_meta_data,
          created_at,
          updated_at
        )
        values
          ($1::uuid, 'authenticated', 'authenticated', $2::text, '', now(), '{}', '{}', now(), now()),
          ($3::uuid, 'authenticated', 'authenticated', $4::text, '', now(), '{}', '{}', now(), now()),
          ($5::uuid, 'authenticated', 'authenticated', $6::text, '', now(), '{}', '{}', now(), now())
      `,
      [
        ownerId,
        `db-concurrency-owner-${runId}@example.test`,
        firstMemberId,
        `db-concurrency-member-a-${runId}@example.test`,
        secondMemberId,
        `db-concurrency-member-b-${runId}@example.test`,
      ],
    );

    await client.query(
      `
        update app.profiles as profile
        set username = candidate.username
        from (
          values
            ($1::uuid, $2::text),
            ($3::uuid, $4::text),
            ($5::uuid, $6::text)
        ) as candidate(user_id, username)
        where profile.user_id = candidate.user_id
      `,
      [
        ownerId,
        `dbo${runId}`,
        firstMemberId,
        `dba${runId}`,
        secondMemberId,
        `dbb${runId}`,
      ],
    );
    await client.query("commit");
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

async function waitForUsernameMutationLock(client, applicationName) {
  let lastObservation = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.query(
      `
        select state, wait_event_type, wait_event
        from pg_catalog.pg_stat_activity
        where application_name = $1::text
      `,
      [applicationName],
    );
    lastObservation = result.rows;
    if (result.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `username mutation ${JSON.stringify(applicationName)} did not wait for the migration table lock: ${JSON.stringify(lastObservation)}`,
  );
}

async function exercisePermanentUsernamePolicyLock(client) {
  const runtimeClient = new Client(
    clientConfig("username-lock", { runtime: true }),
  );
  let policyTransactionOpen = false;
  let usernameAttempt;

  try {
    await runtimeClient.connect();
    const applicationNameResult = await runtimeClient.query(
      "select current_setting('application_name') as application_name",
    );
    const applicationName = applicationNameResult.rows[0]?.application_name;
    assert.equal(
      applicationName,
      `meoing-db-concurrency-username-lock-${runId}`,
      "username race client must keep its unique application name",
    );
    await client.query("begin");
    policyTransactionOpen = true;
    await client.query("lock table app.profiles in access exclusive mode");
    await client.query(
      "delete from app.username_reservations where username = $1::text",
      [usernamePolicyLockTarget],
    );

    usernameAttempt = runAsRuntime(
      runtimeClient,
      firstMemberId,
      "select private.api_change_username(jsonb_build_object('username', $1::text)) as value",
      [usernamePolicyLockTarget],
    );
    await waitForUsernameMutationLock(client, applicationName);

    await client.query(
      `
        insert into app.username_reservations (
          username,
          reservation_type,
          user_id,
          expires_at,
          reason
        ) values ($1::text, 'permanent', null, null, 'concurrency_test')
      `,
      [usernamePolicyLockTarget],
    );
    await client.query("commit");
    policyTransactionOpen = false;

    const settled = await Promise.allSettled([usernameAttempt]);
    assert.equal(
      settled[0]?.status,
      "rejected",
      "a username mutation released after the policy lock must see the new reservation",
    );
    assert.equal(
      settled[0]?.reason?.message,
      "USERNAME_UNAVAILABLE",
      "the blocked username mutation must fail with USERNAME_UNAVAILABLE",
    );
    return { usernamePolicyLock: "enforced" };
  } finally {
    if (policyTransactionOpen) await rollbackQuietly(client);
    if (usernameAttempt) await Promise.allSettled([usernameAttempt]);
    await runtimeClient.end();
  }
}

async function createMaxUseInvite(client) {
  const collectionResult = await runAsRuntime(
    client,
    ownerId,
    `
      select private.api_collection_create(
        jsonb_build_object(
          'name', $1::text,
          'idempotencyKey', $2::text
        )
      ) as value
    `,
    [`DB concurrency ${runId}`, `db-concurrency-collection-${runId}`],
  );
  collectionId = collectionResult.rows[0]?.value?.id;
  assert.match(
    collectionId ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "collection RPC must return a UUID",
  );

  const inviteResult = await runAsRuntime(
    client,
    ownerId,
    `
      select private.api_invite_create(
        jsonb_build_object(
          'collectionId', $1::uuid,
          'tokenHash', $2::text,
          'tokenHint', $3::text,
          'maxUses', 1,
          'roleIds', '[]'::jsonb,
          'idempotencyKey', $4::text
        )
      ) as value
    `,
    [
      collectionId,
      inviteTokenHash,
      inviteTokenHash.slice(0, 4),
      `db-concurrency-invite-${runId}`,
    ],
  );
  inviteId = inviteResult.rows[0]?.value?.id;
  assert.match(
    inviteId ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "invite RPC must return a UUID",
  );
}

async function exerciseInviteRace() {
  const firstClient = new Client(clientConfig("member-a", { runtime: true }));
  const secondClient = new Client(clientConfig("member-b", { runtime: true }));

  try {
    await Promise.all([firstClient.connect(), secondClient.connect()]);

    // Both transactions reach the starting line before either attempts the row lock.
    await Promise.all([
      prepareInviteAcceptance(firstClient, firstMemberId),
      prepareInviteAcceptance(secondClient, secondMemberId),
    ]);

    return await Promise.allSettled([
      acceptPreparedInvite(
        firstClient,
        `db-concurrency-accept-a-${runId}`,
      ),
      acceptPreparedInvite(
        secondClient,
        `db-concurrency-accept-b-${runId}`,
      ),
    ]);
  } finally {
    await Promise.allSettled([firstClient.end(), secondClient.end()]);
  }
}

async function verifyRaceResult(client, attempts) {
  const successes = attempts.filter((attempt) => attempt.status === "fulfilled");
  const failures = attempts.filter((attempt) => attempt.status === "rejected");

  assert.equal(
    successes.length,
    1,
    `expected exactly one successful redemption; got ${successes.length}`,
  );
  assert.equal(
    failures.length,
    1,
    `expected exactly one rejected redemption; got ${failures.length}`,
  );
  assert.equal(
    failures[0].reason?.message,
    "INVITE_INVALID",
    `losing redemption must fail with INVITE_INVALID; got ${failures[0].reason?.message}`,
  );

  const inviteResult = await client.query(
    `
      select uses_count
      from app.collection_invites
      where id = $1::uuid
    `,
    [inviteId],
  );
  assert.equal(inviteResult.rowCount, 1, "test invite must still exist");
  assert.equal(
    Number(inviteResult.rows[0].uses_count),
    1,
    "max-use invite must be consumed exactly once",
  );

  const memberResult = await client.query(
    `
      select user_id
      from app.collection_members
      where collection_id = $1::uuid
        and accepted_invite_id = $2::uuid
      order by user_id
    `,
    [collectionId, inviteId],
  );
  assert.equal(
    memberResult.rowCount,
    1,
    "exactly one competing user must become a member",
  );
  assert.ok(
    [firstMemberId, secondMemberId].includes(memberResult.rows[0].user_id),
    "accepted member must be one of the two competing users",
  );

  return {
    successCount: successes.length,
    rejectedCount: failures.length,
    rejectionCode: failures[0].reason?.message,
    usesCount: Number(inviteResult.rows[0].uses_count),
    acceptedMemberCount: memberResult.rowCount,
  };
}

async function seedStorageBudget(client) {
  await assertLocalDatabase(client);

  await client.query(
    `
      insert into app.file_assets (
        id,
        owner_id,
        r2_key,
        original_filename,
        mime_type,
        expected_size_bytes,
        expected_sha256
      )
      select
        gen_random_uuid(),
        $1::uuid,
        $2::text || '/filler-' || item::text,
        'budget.bin',
        'application/pdf',
        26214400,
        decode(repeat('00', 32), 'hex')
      from generate_series(1, 20) as item
    `,
    [ownerId, storagePrefix],
  );
}

async function reservePreparedStorage(client, userId, assetId, suffix) {
  try {
    const key = `users/${userId}/${assetId}`;
    const result = await client.query(
      `
        select private.api_file_create_pending(
          jsonb_build_object(
            'assetId', $1::uuid,
            'key', $2::text,
            'fileName', 'budget.pdf',
            'contentType', 'application/pdf',
            'idempotencyKey', $3::text,
            'sizeBytes', 12582912,
            'sha256', repeat('00', 32)
          )
        ) as value
      `,
      [assetId, key, `db-concurrency-storage-${suffix}-${runId}`],
    );
    await client.query("commit");
    return result.rows[0]?.value;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

async function exerciseStorageRace() {
  const firstClient = new Client(clientConfig("storage-a", { runtime: true }));
  const secondClient = new Client(clientConfig("storage-b", { runtime: true }));

  try {
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    await Promise.all([
      prepareInviteAcceptance(firstClient, firstMemberId),
      prepareInviteAcceptance(secondClient, secondMemberId),
    ]);

    return await Promise.allSettled([
      reservePreparedStorage(firstClient, firstMemberId, storageAssetIds[0], "a"),
      reservePreparedStorage(secondClient, secondMemberId, storageAssetIds[1], "b"),
    ]);
  } finally {
    await Promise.allSettled([firstClient.end(), secondClient.end()]);
  }
}

async function verifyStorageRace(client, attempts) {
  const successes = attempts.filter((attempt) => attempt.status === "fulfilled");
  const failures = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(successes.length, 1, "exactly one concurrent 12 MiB reservation must succeed");
  assert.equal(failures.length, 1, "exactly one concurrent 12 MiB reservation must fail");
  assert.equal(
    failures[0].reason?.message,
    "STORAGE_BUDGET_REACHED",
    "the losing storage reservation must fail with STORAGE_BUDGET_REACHED",
  );

  const result = await client.query(
    `
      select
        count(*) filter (where id = any($1::uuid[]))::integer as winner_count,
        coalesce(sum(expected_size_bytes), 0)::bigint as reserved_bytes
      from app.file_assets
      where r2_key like $2::text || '/%'
         or id = any($1::uuid[])
    `,
    [storageAssetIds, storagePrefix],
  );
  assert.equal(result.rows[0]?.winner_count, 1, "only one racing asset may be reserved");
  assert.equal(
    Number(result.rows[0]?.reserved_bytes),
    536870912,
    "concurrent reservations must stop exactly at the 0.5 GiB local budget",
  );

  return {
    storageRejectedCount: failures.length,
    storageReservedBytes: Number(result.rows[0]?.reserved_bytes),
    storageWinnerCount: result.rows[0]?.winner_count,
  };
}

async function cleanup(client) {
  await client.query("begin");
  try {
    await client.query(
      "select pg_catalog.set_config('app.maintenance_cleanup', 'on', true)",
    );
    if (collectionId) {
      await client.query(
        "delete from app.collections where id = $1::uuid",
        [collectionId],
      );
      await client.query(
        "delete from app.collection_audit_logs where collection_id = $1::uuid",
        [collectionId],
      );
    }
    await client.query(
      "delete from app.file_assets where r2_key like $1::text || '/%' or id = any($2::uuid[])",
      [storagePrefix, storageAssetIds],
    );
    await client.query(
      "delete from app.username_reservations where username = $1::text",
      [usernamePolicyLockTarget],
    );
    await client.query(
      "delete from auth.users where id = any($1::uuid[])",
      [userIds],
    );
    await client.query("commit");
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

async function main() {
  const setupClient = new Client(clientConfig("setup"));
  const runtimeSetupClient = new Client(
    clientConfig("runtime-setup", { runtime: true }),
  );
  let setupConnected = false;
  let localDatabaseVerified = false;
  let runtimeSetupConnected = false;
  let runtimeLoginCreated = false;
  let primaryError;
  let summary;

  function recordTeardownError(stage, error) {
    const teardownError = { stage, ...errorSummary(error) };
    if (!primaryError) {
      primaryError = error instanceof Error ? error : new Error(String(error));
    }
    if (primaryError && typeof primaryError === "object") {
      primaryError.teardownErrors = [
        ...(Array.isArray(primaryError.teardownErrors)
          ? primaryError.teardownErrors
          : []),
        teardownError,
      ];
    }
  }

  try {
    await setupClient.connect();
    setupConnected = true;
    await assertLocalDatabase(setupClient);
    localDatabaseVerified = true;
    await createRuntimeLogin(setupClient);
    runtimeLoginCreated = true;
    await grantRuntimeLogin(setupClient);
    await seedUsers(setupClient);
    const usernameSummary = await exercisePermanentUsernamePolicyLock(setupClient);
    await runtimeSetupClient.connect();
    runtimeSetupConnected = true;
    await createMaxUseInvite(runtimeSetupClient);
    const attempts = await exerciseInviteRace();
    const inviteSummary = await verifyRaceResult(setupClient, attempts);
    await seedStorageBudget(setupClient);
    const storageAttempts = await exerciseStorageRace();
    const storageSummary = await verifyStorageRace(setupClient, storageAttempts);
    summary = { ...usernameSummary, ...inviteSummary, ...storageSummary };
  } catch (error) {
    primaryError = error;
  } finally {
    if (runtimeSetupConnected) {
      try {
        await runtimeSetupClient.end();
      } catch (error) {
        recordTeardownError("runtime_client_end", error);
      }
    }

    if (localDatabaseVerified) {
      try {
        await cleanup(setupClient);
      } catch (error) {
        recordTeardownError("data_cleanup", error);
      }

      if (runtimeLoginCreated) {
        try {
          await dropRuntimeLogin(setupClient);
        } catch (error) {
          recordTeardownError("runtime_role_cleanup", error);
        }
      }
    }

    if (setupConnected) {
      try {
        await setupClient.end();
      } catch (error) {
        recordTeardownError("setup_client_end", error);
      }
    }
  }

  if (primaryError) {
    throw primaryError;
  }

  console.log(
    JSON.stringify({
      event: "db_concurrency_complete",
      ...summary,
      cleanup: "complete",
    }),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      event: "db_concurrency_failed",
      error: errorSummary(error),
      teardownErrors:
        error && typeof error === "object" && "teardownErrors" in error
          ? error.teardownErrors
          : undefined,
    }),
  );
  process.exitCode = 1;
});
