import { Client } from "pg";
import { ApiError, mapDatabaseError } from "../http/errors";
import { isJsonValue, type JsonObject, type JsonValue } from "../types";

export const RPC_FUNCTIONS = {
  abuseConsume: "private.api_abuse_consume",
  accountDeletionCancel: "private.api_cancel_account_deletion",
  accountDeletionRequest: "private.api_request_account_deletion",
  characterProgressGet: "private.api_character_progress_get",
  characterProgressUpdate: "private.api_character_progress_upsert",
  collectionAuditList: "private.api_audit_list",
  collectionCreate: "private.api_collection_create",
  collectionDelete: "private.api_collection_delete",
  collectionGet: "private.api_collection_get",
  collectionInviteAccept: "private.api_invite_accept",
  collectionInviteCreate: "private.api_invite_create",
  collectionInviteList: "private.api_invite_list",
  collectionInvitePreview: "private.api_invite_preview",
  collectionInviteRevoke: "private.api_invite_revoke",
  collectionLeave: "private.api_collection_leave",
  collectionList: "private.api_collection_list",
  collectionMemberList: "private.api_collection_member_list",
  collectionMemberRemove: "private.api_collection_member_remove",
  collectionProfileUpdate: "private.api_collection_profile_upsert",
  collectionRestore: "private.api_collection_restore",
  collectionRoleAssign: "private.api_role_assign",
  collectionRoleCreate: "private.api_role_create",
  collectionRoleDelete: "private.api_role_delete",
  collectionRoleList: "private.api_role_list",
  collectionRoleUnassign: "private.api_role_unassign",
  collectionRoleUpdate: "private.api_role_update",
  collectionTransfer: "private.api_collection_transfer",
  collectionUpdate: "private.api_collection_update",
  fileDelete: "private.api_file_delete",
  fileDownload: "private.api_file_get",
  fileFinalize: "private.api_file_finalize",
  fileInitialize: "private.api_file_create_pending",
  lessonCreate: "private.api_lesson_create",
  lessonDelete: "private.api_lesson_delete",
  lessonGet: "private.api_lesson_get",
  lessonList: "private.api_lesson_list",
  lessonPublish: "private.api_lesson_publish",
  lessonUnpublish: "private.api_lesson_unpublish",
  meGet: "private.api_get_me",
  profileUpdate: "private.api_update_profile",
  progressBatchSubmit: "private.api_progress_submit_batch",
  progressGet: "private.api_progress_get",
  progressHistory: "private.api_progress_history",
  progressStart: "private.api_progress_start",
  settingsDelete: "private.api_settings_delete",
  settingsGet: "private.api_settings_get",
  settingsUpsert: "private.api_settings_upsert",
  statsCollectionGet: "private.api_stats_collection_get",
  statsGlobalGet: "private.api_stats_get",
  unitCreate: "private.api_unit_create",
  unitDelete: "private.api_unit_delete",
  unitGet: "private.api_unit_get",
  unitList: "private.api_unit_list",
  unitRestore: "private.api_unit_restore",
  unitRevisionList: "private.api_unit_revision_list",
  unitRevisionRestore: "private.api_unit_revision_restore",
  unitUpdate: "private.api_unit_update",
  usernameAvailability: "private.api_username_availability",
  usernameChange: "private.api_change_username",
} as const;

export type RpcOperation = keyof typeof RPC_FUNCTIONS;

export interface DomainRepository {
  call(operation: RpcOperation, actorId: string, input?: JsonObject): Promise<JsonValue>;
  checkHealth(): Promise<void>;
}

export type RepositoryFactory = (env: ApiEnv) => DomainRepository;

function createClient(connectionString: string): Client {
  return new Client({
    application_name: "meoing-api",
    connectionString,
    connectionTimeoutMillis: 3_000,
    query_timeout: 10_000,
    statement_timeout: 8_000,
  });
}

export class PostgresDomainRepository implements DomainRepository {
  readonly #connectionString: string;

  constructor(connectionString: string) {
    this.#connectionString = connectionString;
  }

  async call(
    operation: RpcOperation,
    actorId: string,
    input: JsonObject = {},
  ): Promise<JsonValue> {
    const client = createClient(this.#connectionString);
    try {
      await client.connect();
      await client.query("begin");
      await client.query("set local role meoing_runtime");
      await client.query("select set_config('app.user_id', $1, true)", [actorId]);
      const functionName = RPC_FUNCTIONS[operation];
      const result = await client.query<{ data: unknown }>(
        `select ${functionName}($1::jsonb) as data`,
        [JSON.stringify(input)],
      );
      await client.query("commit");

      const data = result.rows[0]?.data;
      if (!isJsonValue(data)) {
        throw new ApiError(500, "INTERNAL_ERROR", "The database returned an invalid response");
      }
      return data;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // The connection may already be closed; the original error is more useful.
      }
      if (error instanceof ApiError) {
        throw error;
      }
      throw mapDatabaseError(error);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async checkHealth(): Promise<void> {
    const client = createClient(this.#connectionString);
    try {
      await client.connect();
      await client.query("select 1");
    } catch {
      throw new ApiError(503, "INTERNAL_ERROR", "The database is unavailable");
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
