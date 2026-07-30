import { Client } from "pg";
import { mapDatabaseError } from "../http/errors";
import { asJsonObject, type JsonObject } from "../types";

export interface MaintenanceRepository {
  cleanup(input: JsonObject): Promise<JsonObject>;
  finalize(input: JsonObject): Promise<JsonObject>;
  observe?(): Promise<JsonObject>;
}

export class PostgresMaintenanceRepository implements MaintenanceRepository {
  readonly #connectionString: string;

  constructor(connectionString: string) {
    this.#connectionString = connectionString;
  }

  async #call(
    functionName: "maintenance_cleanup" | "maintenance_finalize" | "maintenance_observe",
    input: JsonObject,
  ) {
    const client = new Client({
      application_name: "meoing-maintenance",
      connectionString: this.#connectionString,
      connectionTimeoutMillis: 3_000,
      query_timeout: 25_000,
      statement_timeout: 20_000,
    });

    try {
      await client.connect();
      await client.query("begin");
      await client.query("set local role meoing_maintenance");
      const result = await client.query<{ data: unknown }>(
        `select private.${functionName}($1::jsonb) as data`,
        [JSON.stringify(input)],
      );
      await client.query("commit");
      return asJsonObject(result.rows[0]?.data);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw mapDatabaseError(error);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  cleanup(input: JsonObject): Promise<JsonObject> {
    return this.#call("maintenance_cleanup", input);
  }

  finalize(input: JsonObject): Promise<JsonObject> {
    return this.#call("maintenance_finalize", input);
  }

  observe(): Promise<JsonObject> {
    return this.#call("maintenance_observe", {});
  }
}
