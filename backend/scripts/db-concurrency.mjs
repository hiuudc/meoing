#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("Missing required environment variable DATABASE_URL");
}

const runId = randomBytes(8).toString("hex");
const ownerId = randomUUID();
const firstMemberId = randomUUID();
const secondMemberId = randomUUID();
const userIds = [ownerId, firstMemberId, secondMemberId];
const inviteTokenHash = createHash("sha256")
  .update(randomBytes(32))
  .digest("hex");

let collectionId;
let inviteId;

function clientConfig(label) {
  return {
    connectionString: databaseUrl,
    application_name: `meoing-db-concurrency-${label}-${runId}`,
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  };
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
  const firstClient = new Client(clientConfig("member-a"));
  const secondClient = new Client(clientConfig("member-b"));

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
  let connected = false;
  let primaryError;
  let summary;

  try {
    await setupClient.connect();
    connected = true;
    await seedUsers(setupClient);
    await createMaxUseInvite(setupClient);
    const attempts = await exerciseInviteRace();
    summary = await verifyRaceResult(setupClient, attempts);
  } catch (error) {
    primaryError = error;
  } finally {
    if (connected) {
      try {
        await cleanup(setupClient);
      } catch (cleanupError) {
        if (primaryError) {
          primaryError.cleanupError = errorSummary(cleanupError);
        } else {
          primaryError = cleanupError;
        }
      } finally {
        await setupClient.end();
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
      cleanupError:
        error && typeof error === "object" && "cleanupError" in error
          ? error.cleanupError
          : undefined,
    }),
  );
  process.exitCode = 1;
});
