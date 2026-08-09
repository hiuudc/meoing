import assert from "node:assert/strict";
import test from "node:test";

import {
  localApiDatabaseUrl,
  localApiLogin,
  localApiRoleCreateStatement,
  localApiRoleStatements,
} from "./setup-local-database.mjs";

test("uses the dedicated local API login instead of postgres", () => {
  const url = new URL(localApiDatabaseUrl());

  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "54322");
  assert.equal(url.username, localApiLogin);
  assert.notEqual(url.username, "postgres");
  assert.ok(url.password);
});

test("hardens the local login and grants only runtime role switching", () => {
  const createStatement = localApiRoleCreateStatement("test-password");
  const statements = localApiRoleStatements("test-password").join("\n");

  assert.match(createStatement, /login[\s\S]*nosuperuser[\s\S]*noinherit/i);
  assert.match(createStatement, /noreplication[\s\S]*nobypassrls/i);
  assert.doesNotMatch(statements, /nosuperuser|noreplication|nobypassrls/i);
  assert.match(statements, /password 'test-password'/i);
  assert.match(
    statements,
    /grant meoing_runtime to meoing_api_login[\s\S]*admin false, inherit false, set true/i,
  );
  assert.match(statements, /revoke meoing_maintenance from meoing_api_login/i);
  assert.doesNotMatch(statements, /grant meoing_maintenance to meoing_api_login/i);
});
