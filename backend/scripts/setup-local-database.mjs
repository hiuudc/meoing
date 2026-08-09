#!/usr/bin/env node

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client, escapeLiteral } = pg;

export const localDatabaseAdminUrl =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const localApiLogin = "meoing_api_login";
export const localApiPassword = "meoing-local-api-password";

export function localApiDatabaseUrl(password = localApiPassword) {
  const url = new URL(localDatabaseAdminUrl);
  url.username = localApiLogin;
  url.password = password;
  return url.toString();
}

export function localApiRoleCreateStatement(password = localApiPassword) {
  return `create role ${localApiLogin}
    login
    nosuperuser
    noinherit
    nocreatedb
    nocreaterole
    noreplication
    nobypassrls
    connection limit 25
    password ${escapeLiteral(password)}`;
}

export function localApiRoleStatements(password = localApiPassword) {
  return [
    `alter role ${localApiLogin}
      login
      noinherit
      nocreatedb
      nocreaterole
      connection limit 25
      password ${escapeLiteral(password)}`,
    `alter role ${localApiLogin} set search_path = pg_catalog`,
    `alter role ${localApiLogin}
      set idle_in_transaction_session_timeout = '30s'`,
    `grant meoing_runtime to ${localApiLogin}
      with admin false, inherit false, set true`,
    `revoke meoing_maintenance from ${localApiLogin}`,
  ];
}

function clientConfig(connectionString, applicationName) {
  return {
    application_name: applicationName,
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  };
}

async function closeQuietly(client) {
  await client.end().catch(() => undefined);
}

async function assertLocalIdentity(client) {
  const result = await client.query(
    "select private.assert_database_identity('local', 'local') as identity",
  );
  assert.deepEqual(result.rows[0]?.identity, {
    environment: "local",
    supabaseProjectRef: "local",
  });
}

export async function provisionLocalDatabase({
  adminUrl = process.env.MEOING_LOCAL_DATABASE_ADMIN_URL?.trim()
    || localDatabaseAdminUrl,
  apiUrl = localApiDatabaseUrl(),
  ClientConstructor = Client,
} = {}) {
  const admin = new ClientConstructor(clientConfig(adminUrl, "meoing-local-provision"));
  await admin.connect();
  try {
    await assertLocalIdentity(admin);
    const role = await admin.query(
      `select
         rolsuper,
         rolreplication,
         rolbypassrls
       from pg_roles
       where rolname = $1`,
      [localApiLogin],
    );

    await admin.query("begin");
    try {
      if (role.rowCount === 0) {
        await admin.query(localApiRoleCreateStatement());
      } else {
        assert.deepEqual(
          role.rows[0],
          { rolbypassrls: false, rolreplication: false, rolsuper: false },
          "Existing local API login has unsafe PostgreSQL attributes",
        );
      }
      for (const statement of localApiRoleStatements()) {
        await admin.query(statement);
      }
      await admin.query("commit");
    } catch (error) {
      await admin.query("rollback").catch(() => undefined);
      throw error;
    }
  } finally {
    await closeQuietly(admin);
  }

  const runtime = new ClientConstructor(clientConfig(apiUrl, "meoing-local-api-check"));
  await runtime.connect();
  try {
    await runtime.query("begin");
    await runtime.query("set local role meoing_runtime");
    await assertLocalIdentity(runtime);
    await runtime.query("rollback");
  } finally {
    await closeQuietly(runtime);
  }
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    await provisionLocalDatabase();
    console.log("Local API database login is ready.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
