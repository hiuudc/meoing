import { AwsClient } from "aws4fetch";
import pg from "pg";
import { assert } from "./acceptance-helpers.mjs";
import {
  assertOwnedAcceptanceUser,
  reservedAcceptanceEmail,
} from "./provision-staging-guard.mjs";

const { Pool } = pg;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const R2_ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const STAGING_R2_BUCKET = "meoing-files-staging";
const PRE_AUTH_ALLOWED_REFERENCES = new Set([
  "profiles.user_id",
  "username_reservations.user_id",
]);
export const AUDIT_USER_ID_METADATA_KEYS = Object.freeze([
  "userId",
  "oldOwnerId",
  "newOwnerId",
]);

function normalizedUserIdSet(userIds) {
  return new Set(userIds.map((userId) => userId.toLowerCase()));
}

export function scrubAuditMetadataUserIds(metadata, selectedUserIds) {
  assert(
    metadata !== null &&
      typeof metadata === "object" &&
      !Array.isArray(metadata),
    "Audit metadata must be a JSON object",
  );
  const selected = normalizedUserIdSet(selectedUserIds);
  const scrubbed = { ...metadata };
  for (const key of AUDIT_USER_ID_METADATA_KEYS) {
    const value = scrubbed[key];
    if (typeof value === "string" && selected.has(value.toLowerCase())) {
      delete scrubbed[key];
    }
  }
  return scrubbed;
}

function quotedIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function candidateUserIds(candidates) {
  const userIds = candidates.map(({ userId }) => userId);
  assert(
    userIds.length > 0 && userIds.every((userId) => UUID_PATTERN.test(userId)),
    "Acceptance cleanup candidates must contain valid Auth user IDs",
  );
  assert(
    new Set(userIds).size === userIds.length,
    "Acceptance cleanup candidates must not contain duplicate Auth user IDs",
  );
  return userIds;
}

function participantFromRow(row) {
  return {
    app_metadata: row.app_metadata,
    email: row.email,
    id: row.id,
  };
}

function assertParticipant(row, expectedProjectRef) {
  const marker = row?.app_metadata?.meoing_acceptance;
  const username = row?.profile_username;
  assert(
    typeof username === "string" && marker?.username === username,
    "Refusing to purge a collection containing an identity without its matching acceptance profile",
  );
  assertOwnedAcceptanceUser({
    expectedProjectRef,
    user: participantFromRow(row),
    username,
  });
  assert(
    typeof row.email === "string" &&
      row.email.toLowerCase() === reservedAcceptanceEmail(username),
    "Refusing to purge a collection containing a non-reserved acceptance email",
  );
}

export function assertCleanupAssetScope(asset, selectedUserIds) {
  assert(UUID_PATTERN.test(asset.id), "Cleanup asset IDs must be UUIDs");
  assert(typeof asset.r2_key === "string", "Cleanup assets must contain an R2 key");
  const segments = asset.r2_key.split("/");

  if (asset.collection_id === null) {
    assert(
      typeof asset.owner_id === "string" && selectedUserIds.has(asset.owner_id),
      "Refusing to purge a personal asset not owned by a selected acceptance user",
    );
    assert(
      segments.length === 3 &&
        segments[0] === "users" &&
        segments[1] === asset.owner_id &&
        segments[2] === asset.id,
      "Refusing to delete a personal R2 object outside its exact user/asset namespace",
    );
    return;
  }

  assert(
    typeof asset.collection_owner_id === "string" &&
      selectedUserIds.has(asset.collection_owner_id),
    "Refusing to purge an asset outside a selected user's owned collection",
  );
  assert(
    segments.length === 4 &&
      segments[0] === "collections" &&
      segments[1] === asset.collection_id &&
      UUID_PATTERN.test(segments[2]) &&
      segments[3] === asset.id,
    "Refusing to delete a collection R2 object outside its exact collection/asset namespace",
  );
}

async function inBatches(values, size, operation) {
  for (let offset = 0; offset < values.length; offset += size) {
    await Promise.all(values.slice(offset, offset + size).map(operation));
  }
}

export async function purgeStagingAcceptanceData({
  candidates,
  expectedProjectRef,
  objectStore,
  repository,
}) {
  const selectedUserIds = new Set(candidateUserIds(candidates));
  const transaction = await repository.beginPurge({ expectedProjectRef });
  let receipt;

  try {
    const snapshot = await transaction.inspect({
      candidates,
      expectedProjectRef,
    });
    assert(
      snapshot.selectedUsers.length === candidates.length,
      "The staging database no longer contains every selected marked Auth/profile pair",
    );
    const selectedRows = new Set(snapshot.selectedUsers.map(({ id }) => id));
    assert(
      candidates.every(({ userId }) => selectedRows.has(userId)),
      "The staging database selected a different Auth/profile set",
    );
    for (const candidate of candidates) {
      const row = snapshot.selectedUsers.find(({ id }) => id === candidate.userId);
      assert(
        row?.profile_username === candidate.identity.username &&
          typeof row.email === "string" &&
          row.email.toLowerCase() === candidate.identity.email,
        "The staging database candidate no longer matches the explicitly selected reserved identity",
      );
    }
    for (const participant of snapshot.participants) {
      assertParticipant(participant, expectedProjectRef);
    }
    for (const asset of snapshot.assets) {
      assertCleanupAssetScope(asset, selectedUserIds);
    }

    await inBatches(snapshot.assets, 10, async ({ r2_key: key }) => {
      await objectStore.deleteAndVerify(key);
    });

    receipt = await transaction.purge({
      assetIds: snapshot.assets.map(({ id }) => id),
      assetKeys: snapshot.assets.map(({ r2_key: key }) => key),
      candidates,
      collectionIds: snapshot.collectionIds,
      expectedProjectRef,
    });
    await transaction.commit();
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    throw error;
  } finally {
    transaction.release();
  }

  await inBatches(receipt.assetKeys, 10, async (key) => {
    await objectStore.assertAbsent(key);
  });
  await repository.verifyPreAuthPurge({ expectedProjectRef, receipt });
  return receipt;
}

class R2CleanupObjectStore {
  #accountId;
  #aws;
  #bucketName;
  #fetch;
  #requestTimeoutMilliseconds;

  constructor({
    accessKeyId,
    accountId,
    bucketName,
    fetchImplementation,
    requestTimeoutMilliseconds,
    secretAccessKey,
  }) {
    this.#accountId = accountId;
    this.#bucketName = bucketName;
    this.#fetch = fetchImplementation;
    this.#requestTimeoutMilliseconds = requestTimeoutMilliseconds;
    this.#aws = new AwsClient({
      accessKeyId,
      secretAccessKey,
      region: "auto",
      service: "s3",
      retries: 0,
    });
  }

  #url(key) {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    return new URL(
      `https://${this.#accountId}.r2.cloudflarestorage.com/${encodeURIComponent(this.#bucketName)}/${encodedKey}`,
    );
  }

  async #request(key, method) {
    const signed = await this.#aws.sign(this.#url(key), {
      method,
      aws: { allHeaders: true },
    });
    return this.#fetch(signed, {
      redirect: "error",
      signal: AbortSignal.timeout(this.#requestTimeoutMilliseconds),
    });
  }

  async assertAbsent(key) {
    const response = await this.#request(key, "HEAD");
    assert(
      response.status === 404,
      `R2 deletion verification failed with HTTP ${response.status}`,
    );
  }

  async deleteAndVerify(key) {
    const response = await this.#request(key, "DELETE");
    assert(response.ok, `R2 object deletion failed with HTTP ${response.status}`);
    await this.assertAbsent(key);
  }
}

async function assertDatabaseIdentity(client, expectedProjectRef) {
  const result = await client.query(
    "select private.assert_database_identity('staging', $1::text) as identity",
    [expectedProjectRef],
  );
  const identity = result.rows[0]?.identity;
  assert(
    result.rowCount === 1 &&
      identity?.environment === "staging" &&
      identity?.supabaseProjectRef === expectedProjectRef,
    "The direct database connection is not the independently pinned staging database",
  );
}

async function directAppReferences(client) {
  const result = await client.query(`
    select namespace.nspname as schema_name,
           relation.relname as table_name,
           attribute.attname as column_name
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_class as relation
      on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    join pg_catalog.pg_attribute as attribute
      on attribute.attrelid = relation.oid
     and attribute.attnum = constraint_row.conkey[1]
    where constraint_row.contype = 'f'
      and constraint_row.confrelid = 'auth.users'::regclass
      and cardinality(constraint_row.conkey) = 1
      and namespace.nspname = 'app'
    order by relation.relname, attribute.attname
  `);
  assert(result.rows.length > 0, "No app-to-Auth references were visible to cleanup");
  return result.rows;
}

async function assertNoUserReferences(client, userIds, allowedReferences = new Set()) {
  for (const reference of await directAppReferences(client)) {
    const key = `${reference.table_name}.${reference.column_name}`;
    if (allowedReferences.has(key)) continue;
    const result = await client.query(
      `select count(*)::integer as count
       from ${quotedIdentifier(reference.schema_name)}.${quotedIdentifier(reference.table_name)}
       where ${quotedIdentifier(reference.column_name)} = any($1::uuid[])`,
      [userIds],
    );
    assert(
      result.rows[0]?.count === 0,
      `Acceptance cleanup left user references in app.${key}`,
    );
  }
}

export async function scrubAuditUserReferences(client, userIds) {
  const selectedUserIds = normalizedUserIdSet(userIds);
  const auditRows = await client.query(
    `select audit.id,
            audit.actor_user_id,
            audit.target_type,
            audit.target_id,
            audit.metadata
     from app.collection_audit_logs as audit
     where audit.actor_user_id = any($1::uuid[])
        or (
          audit.target_id = any($1::uuid[])
          and audit.target_type in ('collection_members', 'collection_profiles')
        )
        or exists (
          select 1
          from unnest($2::text[]) as metadata_key(key_name)
          where lower(audit.metadata ->> metadata_key.key_name) = any($3::text[])
        )
     order by audit.id
     for update`,
    [userIds, AUDIT_USER_ID_METADATA_KEYS, [...selectedUserIds]],
  );

  for (const audit of auditRows.rows) {
    const actorUserId =
      typeof audit.actor_user_id === "string" &&
        selectedUserIds.has(audit.actor_user_id.toLowerCase())
        ? null
        : audit.actor_user_id;
    const targetId =
      typeof audit.target_id === "string" &&
        selectedUserIds.has(audit.target_id.toLowerCase()) &&
        ["collection_members", "collection_profiles"].includes(audit.target_type)
        ? null
        : audit.target_id;
    const metadata = scrubAuditMetadataUserIds(audit.metadata, userIds);
    await client.query(
      `update app.collection_audit_logs
       set actor_user_id = $2::uuid,
           target_id = $3::uuid,
           metadata = $4::jsonb
       where id = $1::bigint`,
      [audit.id, actorUserId, targetId, metadata],
    );
  }
}

export async function assertNoAuditUserJsonReferences(client, userIds) {
  const result = await client.query(
    `with recursive audit_nodes(audit_id, value) as (
       select audit.id, audit.metadata
       from app.collection_audit_logs as audit

       union all

       select node.audit_id, child.value
       from audit_nodes as node
       cross join lateral (
         select object_child.value
         from jsonb_each(
           case
             when jsonb_typeof(node.value) = 'object' then node.value
             else '{}'::jsonb
           end
         ) as object_child

         union all

         select array_child.value
         from jsonb_array_elements(
           case
             when jsonb_typeof(node.value) = 'array' then node.value
             else '[]'::jsonb
           end
         ) as array_child
       ) as child
     )
     select count(distinct node.audit_id)::integer as count
     from audit_nodes as node
     where jsonb_typeof(node.value) = 'string'
       and lower(node.value #>> '{}') = any($1::text[])`,
    [[...normalizedUserIdSet(userIds)]],
  );
  assert(
    result.rows[0]?.count === 0,
    "Acceptance cleanup left selected user IDs in audit metadata JSON",
  );
}

async function assertTargetRowsAbsent(client, receipt) {
  const residual = await client.query(
    `select
       (select count(*)::integer from app.collections where id = any($1::uuid[])) as collections,
       (select count(*)::integer from app.file_assets where id = any($2::uuid[])) as assets,
       (select count(*)::integer from app.collection_profiles where user_id = any($3::uuid[])) as collection_profiles,
       (select count(*)::integer from app.collection_member_roles where user_id = any($3::uuid[])) as member_roles`,
    [receipt.collectionIds, receipt.assetIds, receipt.userIds],
  );
  const counts = residual.rows[0];
  assert(
    counts?.collections === 0 &&
      counts?.assets === 0 &&
      counts?.collection_profiles === 0 &&
      counts?.member_roles === 0,
    "Acceptance cleanup left collection, asset, or membership rows behind",
  );
}

class PostgresCleanupRepository {
  #pool;

  constructor(databaseUrl) {
    this.#pool = new Pool({
      application_name: "meoing-staging-acceptance-cleanup",
      connectionString: databaseUrl,
      connectionTimeoutMillis: 20_000,
      idleTimeoutMillis: 5_000,
      max: 1,
    });
  }

  async beginPurge({ expectedProjectRef }) {
    const client = await this.#pool.connect();
    await client.query("begin");
    try {
      await client.query("select set_config('statement_timeout', '30s', true)");
      await client.query("select set_config('lock_timeout', '5s', true)");
      const role = await client.query("select current_user as current_user");
      assert(
        role.rows[0]?.current_user === "postgres",
        "The cleanup database URL must use the staging postgres operations role",
      );
      await assertDatabaseIdentity(client, expectedProjectRef);
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended('meoing:staging-acceptance-cleanup', 0))",
      );
      await client.query(
        "lock table app.collections, app.collection_members, app.file_assets, app.collection_audit_logs in share row exclusive mode",
      );
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      client.release();
      throw error;
    }

    let completed = false;
    return {
      inspect: async ({ candidates }) => {
        const userIds = candidateUserIds(candidates);
        const selectedUsers = await client.query(
          `select auth_user.id,
                  auth_user.email,
                  auth_user.raw_app_meta_data as app_metadata,
                  profile.username as profile_username
           from auth.users as auth_user
           join app.profiles as profile on profile.user_id = auth_user.id
           where auth_user.id = any($1::uuid[])
           order by auth_user.id
           for update of auth_user, profile`,
          [userIds],
        );
        const collections = await client.query(
          `select id
           from app.collections
           where owner_id = any($1::uuid[])
           order by id
           for update`,
          [userIds],
        );
        const collectionIds = collections.rows.map(({ id }) => id);
        const participants = await client.query(
          `with participant_ids as (
             select unnest($1::uuid[]) as user_id
             union
             select member.user_id
             from app.collection_members as member
             where member.collection_id = any($2::uuid[])
             union
             select asset.owner_id
             from app.file_assets as asset
             where asset.collection_id = any($2::uuid[])
               and asset.owner_id is not null
           )
           select auth_user.id,
                  auth_user.email,
                  auth_user.raw_app_meta_data as app_metadata,
                  profile.username as profile_username
           from participant_ids
           join auth.users as auth_user on auth_user.id = participant_ids.user_id
           join app.profiles as profile on profile.user_id = auth_user.id
           order by auth_user.id
           for update of auth_user, profile`,
          [userIds, collectionIds],
        );
        const assets = await client.query(
          `select asset.id,
                  asset.collection_id,
                  asset.owner_id,
                  asset.r2_key,
                  collection.owner_id as collection_owner_id
           from app.file_assets as asset
           left join app.collections as collection on collection.id = asset.collection_id
           where (asset.collection_id is null and asset.owner_id = any($1::uuid[]))
              or asset.collection_id = any($2::uuid[])
           order by asset.id
           for update of asset`,
          [userIds, collectionIds],
        );
        return {
          assets: assets.rows,
          collectionIds,
          participants: participants.rows,
          selectedUsers: selectedUsers.rows,
        };
      },
      purge: async ({ assetIds, assetKeys, candidates, collectionIds }) => {
        const userIds = candidateUserIds(candidates);
        await client.query("select set_config('app.maintenance_cleanup', 'on', true)");
        await client.query(
          "delete from app.collections where id = any($1::uuid[])",
          [collectionIds],
        );
        await client.query(
          "delete from app.file_assets where collection_id is null and owner_id = any($1::uuid[])",
          [userIds],
        );
        await client.query(
          "update app.file_assets set owner_id = null where collection_id is not null and owner_id = any($1::uuid[])",
          [userIds],
        );
        await client.query(
          "update app.collection_members set invited_by = null where invited_by = any($1::uuid[])",
          [userIds],
        );
        await client.query(
          "update app.collection_roles set created_by = null where created_by = any($1::uuid[])",
          [userIds],
        );
        await client.query(
          "update app.collection_member_roles set assigned_by = null where assigned_by = any($1::uuid[])",
          [userIds],
        );
        await client.query(
          "update app.collection_invites set created_by = null where created_by = any($1::uuid[])",
          [userIds],
        );
        await client.query(
          "update app.units set created_by = null where created_by = any($1::uuid[])",
          [userIds],
        );
        await client.query(
          "update app.unit_revisions set created_by = null where created_by = any($1::uuid[])",
          [userIds],
        );
        await client.query(
          `update app.lessons
           set created_by = case when created_by = any($1::uuid[]) then null else created_by end,
               published_by = case when published_by = any($1::uuid[]) then null else published_by end
           where created_by = any($1::uuid[]) or published_by = any($1::uuid[])`,
          [userIds],
        );
        await client.query(
          "delete from app.collection_members where user_id = any($1::uuid[])",
          [userIds],
        );
        await scrubAuditUserReferences(client, userIds);
        await client.query(
          "delete from app.settings where user_id = any($1::uuid[])",
          [userIds],
        );
        await client.query(
          "delete from app.lesson_progress where user_id = any($1::uuid[])",
          [userIds],
        );
        await client.query(
          "delete from app.progress_batches where user_id = any($1::uuid[])",
          [userIds],
        );
        await client.query(
          "delete from app.user_language_stats where user_id = any($1::uuid[])",
          [userIds],
        );
        await client.query(
          "delete from app.collection_user_language_stats where user_id = any($1::uuid[])",
          [userIds],
        );
        await client.query(
          "delete from app.user_character_progress where user_id = any($1::uuid[])",
          [userIds],
        );
        await client.query(
          `update app.profiles
           set display_name = 'Meoing User',
               avatar_asset_id = null,
               bio = null,
               deletion_requested_at = coalesce(deletion_requested_at, statement_timestamp()),
               delete_after = coalesce(delete_after, statement_timestamp() + interval '30 days'),
               api_locked_at = coalesce(api_locked_at, statement_timestamp()),
               revision = revision + 1,
               updated_at = statement_timestamp()
           where user_id = any($1::uuid[])`,
          [userIds],
        );

        const receipt = { assetIds, assetKeys, collectionIds, userIds };
        await assertNoUserReferences(client, userIds, PRE_AUTH_ALLOWED_REFERENCES);
        await assertNoAuditUserJsonReferences(client, userIds);
        await assertTargetRowsAbsent(client, receipt);
        const lockedProfiles = await client.query(
          `select count(*)::integer as count
           from app.profiles
           where user_id = any($1::uuid[])
             and api_locked_at is not null
             and deletion_requested_at is not null
             and delete_after > deletion_requested_at
             and avatar_asset_id is null
             and bio is null`,
          [userIds],
        );
        assert(
          lockedProfiles.rows[0]?.count === userIds.length,
          "Acceptance cleanup did not leave every selected profile locked for an idempotent Auth retry",
        );
        return receipt;
      },
      commit: async () => {
        await client.query("commit");
        completed = true;
      },
      rollback: async () => {
        if (!completed) await client.query("rollback");
      },
      release: () => client.release(),
    };
  }

  async verifyPreAuthPurge({ expectedProjectRef, receipt }) {
    const client = await this.#pool.connect();
    try {
      await assertDatabaseIdentity(client, expectedProjectRef);
      await assertNoUserReferences(client, receipt.userIds, PRE_AUTH_ALLOWED_REFERENCES);
      await assertNoAuditUserJsonReferences(client, receipt.userIds);
      await assertTargetRowsAbsent(client, receipt);
    } finally {
      client.release();
    }
  }

  async verifyAbsent({ expectedProjectRef, receipt }) {
    const client = await this.#pool.connect();
    try {
      await assertDatabaseIdentity(client, expectedProjectRef);
      await assertNoUserReferences(client, receipt.userIds);
      await assertNoAuditUserJsonReferences(client, receipt.userIds);
      await assertTargetRowsAbsent(client, receipt);
    } finally {
      client.release();
    }
  }

  async close() {
    await this.#pool.end();
  }
}

function checkedDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MEOING_CLEANUP_DATABASE_URL must be an absolute PostgreSQL URL");
  }
  assert(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.username.length > 0 &&
      url.password.length > 0 &&
      url.hostname.length > 0 &&
      url.hash === "" &&
      url.searchParams.get("sslmode") !== "disable",
    "MEOING_CLEANUP_DATABASE_URL must be a credentialed TLS PostgreSQL URL",
  );
  return value;
}

export function createStagingAcceptanceDataCleaner({
  databaseUrl,
  fetchImplementation = fetch,
  r2AccessKeyId,
  r2AccountId,
  r2BucketName,
  r2SecretAccessKey,
  requestTimeoutMilliseconds = 20_000,
}) {
  assert(
    R2_ACCOUNT_ID_PATTERN.test(r2AccountId),
    "MEOING_CLEANUP_R2_ACCOUNT_ID must be a lowercase 32-character Cloudflare account ID",
  );
  assert(
    r2BucketName === STAGING_R2_BUCKET,
    `MEOING_CLEANUP_R2_BUCKET_NAME must be exactly ${STAGING_R2_BUCKET}`,
  );
  assert(
    typeof r2AccessKeyId === "string" && r2AccessKeyId.length > 0 &&
      typeof r2SecretAccessKey === "string" && r2SecretAccessKey.length > 0,
    "Bucket-scoped staging R2 cleanup credentials are required",
  );

  const repository = new PostgresCleanupRepository(checkedDatabaseUrl(databaseUrl));
  const objectStore = new R2CleanupObjectStore({
    accessKeyId: r2AccessKeyId,
    accountId: r2AccountId,
    bucketName: r2BucketName,
    fetchImplementation,
    requestTimeoutMilliseconds,
    secretAccessKey: r2SecretAccessKey,
  });
  return {
    purge: ({ candidates, expectedProjectRef }) => purgeStagingAcceptanceData({
      candidates,
      expectedProjectRef,
      objectStore,
      repository,
    }),
    verifyAbsent: async ({ expectedProjectRef, receipt }) => {
      await repository.verifyAbsent({ expectedProjectRef, receipt });
      await inBatches(receipt.assetKeys, 10, async (key) => {
        await objectStore.assertAbsent(key);
      });
    },
    close: () => repository.close(),
  };
}
