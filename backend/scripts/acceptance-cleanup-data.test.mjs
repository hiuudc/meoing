import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AUDIT_USER_ID_METADATA_KEYS,
  assertNoAuditUserJsonReferences,
  assertCleanupAssetScope,
  purgeStagingAcceptanceData,
  scrubAuditMetadataUserIds,
  scrubAuditUserReferences,
} from "./acceptance-cleanup-data.mjs";

const PROJECT_REF = "sdwuwmyrbdaarxokxmsf";
const OWNER_ID = "a0000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-000000000002";
const COLLECTION_ID = "00000000-0000-4000-8000-000000000010";
const PERSONAL_ASSET_ID = "00000000-0000-4000-8000-000000000020";
const COLLECTION_ASSET_ID = "00000000-0000-4000-8000-000000000021";

function participant(id, username, email) {
  return {
    app_metadata: {
      meoing_acceptance: {
        project_ref: PROJECT_REF,
        username,
      },
    },
    email,
    id,
    profile_username: username,
  };
}

function ownerCandidate() {
  return {
    identity: {
      email: "acceptance-owner@auth.meoing.com",
      username: "acceptance.owner",
    },
    userId: OWNER_ID,
  };
}

function cleanupSnapshot() {
  return {
    assets: [
      {
        collection_id: null,
        collection_owner_id: null,
        id: PERSONAL_ASSET_ID,
        owner_id: OWNER_ID,
        r2_key: `users/${OWNER_ID}/${PERSONAL_ASSET_ID}`,
      },
      {
        collection_id: COLLECTION_ID,
        collection_owner_id: OWNER_ID,
        id: COLLECTION_ASSET_ID,
        owner_id: MEMBER_ID,
        r2_key: `collections/${COLLECTION_ID}/${MEMBER_ID}/${COLLECTION_ASSET_ID}`,
      },
    ],
    collectionIds: [COLLECTION_ID],
    participants: [
      participant(
        OWNER_ID,
        "acceptance.owner",
        "acceptance-owner@auth.meoing.com",
      ),
      participant(
        MEMBER_ID,
        "acceptance.member",
        "acceptance-member@auth.meoing.com",
      ),
    ],
    selectedUsers: [
      participant(
        OWNER_ID,
        "acceptance.owner",
        "acceptance-owner@auth.meoing.com",
      ),
    ],
  };
}

test("scrubs selected user IDs from the actual audit metadata allowlist and retains the tombstone", async () => {
  const cleanupSource = readFileSync(
    new URL("./acceptance-cleanup-data.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(cleanupSource, /delete from app\.collection_audit_logs/i);
  assert.deepEqual(AUDIT_USER_ID_METADATA_KEYS, [
    "userId",
    "oldOwnerId",
    "newOwnerId",
  ]);
  assert.deepEqual(
    scrubAuditMetadataUserIds(
      {
        newOwnerId: MEMBER_ID,
        oldOwnerId: OWNER_ID,
        roleId: "00000000-0000-4000-8000-000000000099",
        schemaVersion: 2,
        userId: OWNER_ID.toUpperCase(),
      },
      [OWNER_ID],
    ),
    {
      newOwnerId: MEMBER_ID,
      roleId: "00000000-0000-4000-8000-000000000099",
      schemaVersion: 2,
    },
  );

  const queries = [];
  const client = {
    query: async (text, parameters) => {
      queries.push({ parameters, text });
      if (text.includes("select audit.id")) {
        return {
          rows: [{
            actor_user_id: OWNER_ID,
            id: "17",
            metadata: {
              newOwnerId: MEMBER_ID,
              oldOwnerId: OWNER_ID,
              schemaVersion: 2,
              userId: OWNER_ID,
            },
            target_id: OWNER_ID,
            target_type: "collection_members",
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  await scrubAuditUserReferences(client, [OWNER_ID]);
  assert.equal(queries.length, 2);
  assert.match(queries[0].text, /for update/);
  assert.deepEqual(queries[0].parameters, [
    [OWNER_ID],
    ["userId", "oldOwnerId", "newOwnerId"],
    [OWNER_ID],
  ]);
  assert.match(queries[1].text, /update app\.collection_audit_logs/);
  assert.doesNotMatch(queries[1].text, /delete from app\.collection_audit_logs/);
  assert.deepEqual(queries[1].parameters, [
    "17",
    null,
    null,
    { newOwnerId: MEMBER_ID, schemaVersion: 2 },
  ]);
});

test("fails closed when any selected user UUID remains anywhere in audit metadata JSON", async () => {
  await assertNoAuditUserJsonReferences(
    {
      query: async (text, parameters) => {
        assert.match(text, /with recursive audit_nodes/);
        assert.deepEqual(parameters, [[OWNER_ID]]);
        return { rows: [{ count: 0 }] };
      },
    },
    [OWNER_ID],
  );

  await assert.rejects(
    assertNoAuditUserJsonReferences(
      { query: async () => ({ rows: [{ count: 1 }] }) },
      [OWNER_ID],
    ),
    /left selected user IDs in audit metadata JSON/,
  );
});

test("privileged staging dispatches run only trusted main code with step-scoped secrets", () => {
  const workflowPaths = [
    "../../.github/workflows/cleanup-staging-canaries.yml",
    "../../.github/workflows/staging-acceptance.yml",
  ];
  for (const relativePath of workflowPaths) {
    const workflow = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
    const runtimeGuard = workflow.indexOf('test "$GITHUB_REF" = "refs/heads/main"');
    const checkout = workflow.indexOf(
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    );
    assert.ok(runtimeGuard >= 0 && runtimeGuard < checkout);
    assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(workflow, /persist-credentials: false/);
    assert.doesNotMatch(workflow, /\n    env:/);
    assert.doesNotMatch(workflow, /pull_request_target/);
  }

  const cleanupWorkflow = readFileSync(
    new URL("../../.github/workflows/cleanup-staging-canaries.yml", import.meta.url),
    "utf8",
  );
  assert.ok(
    cleanupWorkflow.indexOf("${{ secrets.") >
      cleanupWorkflow.indexOf("Revoke sessions and delete explicitly selected canaries"),
  );
  const acceptanceWorkflow = readFileSync(
    new URL("../../.github/workflows/staging-acceptance.yml", import.meta.url),
    "utf8",
  );
  assert.ok(
    acceptanceWorkflow.indexOf("${{ secrets.") >
      acceptanceWorkflow.indexOf("Provision staging acceptance accounts"),
  );
});

test("accepts only exact personal and selected-owner collection R2 namespaces", () => {
  const selected = new Set([OWNER_ID]);
  for (const asset of cleanupSnapshot().assets) {
    assert.doesNotThrow(() => assertCleanupAssetScope(asset, selected));
  }
  assert.throws(
    () => assertCleanupAssetScope({
      ...cleanupSnapshot().assets[0],
      r2_key: `users/${MEMBER_ID}/${PERSONAL_ASSET_ID}`,
    }, selected),
    /outside its exact user\/asset namespace/,
  );
  assert.throws(
    () => assertCleanupAssetScope({
      ...cleanupSnapshot().assets[1],
      collection_owner_id: MEMBER_ID,
    }, selected),
    /outside a selected user's owned collection/,
  );
});

test("deletes and verifies personal and owned-collection R2 objects before purging rows", async () => {
  const events = [];
  const snapshot = cleanupSnapshot();
  const receipt = {
    assetIds: snapshot.assets.map(({ id }) => id),
    assetKeys: snapshot.assets.map(({ r2_key: key }) => key),
    collectionIds: snapshot.collectionIds,
    userIds: [OWNER_ID],
  };
  const transaction = {
    inspect: async () => {
      events.push("inspect-and-lock");
      return snapshot;
    },
    purge: async (actual) => {
      events.push("purge-database");
      assert.deepEqual(actual.assetIds, receipt.assetIds);
      assert.deepEqual(actual.assetKeys, receipt.assetKeys);
      assert.deepEqual(actual.collectionIds, receipt.collectionIds);
      return receipt;
    },
    commit: async () => events.push("commit"),
    rollback: async () => events.push("rollback"),
    release: () => events.push("release"),
  };
  const repository = {
    beginPurge: async () => {
      events.push("begin");
      return transaction;
    },
    verifyPreAuthPurge: async ({ receipt: actual }) => {
      events.push("verify-pre-auth");
      assert.deepEqual(actual, receipt);
    },
  };
  const objectStore = {
    deleteAndVerify: async (key) => events.push(`delete-r2:${key}`),
    assertAbsent: async (key) => events.push(`head-r2:${key}`),
  };

  const result = await purgeStagingAcceptanceData({
    candidates: [ownerCandidate()],
    expectedProjectRef: PROJECT_REF,
    objectStore,
    repository,
  });

  assert.deepEqual(result, receipt);
  assert.deepEqual(events, [
    "begin",
    "inspect-and-lock",
    `delete-r2:users/${OWNER_ID}/${PERSONAL_ASSET_ID}`,
    `delete-r2:collections/${COLLECTION_ID}/${MEMBER_ID}/${COLLECTION_ASSET_ID}`,
    "purge-database",
    "commit",
    "release",
    `head-r2:users/${OWNER_ID}/${PERSONAL_ASSET_ID}`,
    `head-r2:collections/${COLLECTION_ID}/${MEMBER_ID}/${COLLECTION_ASSET_ID}`,
    "verify-pre-auth",
  ]);
});

test("rolls back without database deletion when any R2 object cannot be verified absent", async () => {
  const events = [];
  const transaction = {
    inspect: async () => cleanupSnapshot(),
    purge: async () => {
      events.push("purge-database");
      throw new Error("Database purge must not run");
    },
    commit: async () => events.push("commit"),
    rollback: async () => events.push("rollback"),
    release: () => events.push("release"),
  };
  const repository = {
    beginPurge: async () => transaction,
    verifyPreAuthPurge: async () => events.push("verify-pre-auth"),
  };
  const objectStore = {
    deleteAndVerify: async () => {
      throw new Error("R2 deletion verification failed with HTTP 403");
    },
    assertAbsent: async () => events.push("head-r2"),
  };

  await assert.rejects(
    purgeStagingAcceptanceData({
      candidates: [ownerCandidate()],
      expectedProjectRef: PROJECT_REF,
      objectStore,
      repository,
    }),
    /R2 deletion verification failed/,
  );
  assert.deepEqual(events, ["rollback", "release"]);
});

test("refuses an unmarked collaborator before deleting any R2 object", async () => {
  const snapshot = cleanupSnapshot();
  snapshot.participants[1] = {
    ...snapshot.participants[1],
    app_metadata: {},
  };
  let r2Deletes = 0;
  let rollbacks = 0;
  const repository = {
    beginPurge: async () => ({
      inspect: async () => snapshot,
      purge: async () => {
        throw new Error("Database purge must not run");
      },
      commit: async () => {},
      rollback: async () => {
        rollbacks += 1;
      },
      release: () => {},
    }),
    verifyPreAuthPurge: async () => {},
  };
  await assert.rejects(
    purgeStagingAcceptanceData({
      candidates: [ownerCandidate()],
      expectedProjectRef: PROJECT_REF,
      objectStore: {
        deleteAndVerify: async () => {
          r2Deletes += 1;
        },
        assertAbsent: async () => {},
      },
      repository,
    }),
    /without its matching acceptance profile|unowned staging identity/,
  );
  assert.equal(r2Deletes, 0);
  assert.equal(rollbacks, 1);
});
