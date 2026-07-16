import { describe, expect, test } from "bun:test";
import {
  agencyPostgresSchemaSql,
  createPostgresAgencyStore,
  createPostgresHandoffReplayStore,
  type AgencySqlClient,
} from "../src";

describe("Agency PostgreSQL adapters", () => {
  test("emits constrained relational schema and rejects identifier injection", () => {
    const sql = agencyPostgresSchemaSql("agent_state");
    expect(sql).toContain("agent_state.actions");
    expect(sql).toContain("handoff_nonces");
    expect(() => agencyPostgresSchemaSql("public; DROP TABLE users")).toThrow(
      "simple identifier",
    );
  });

  test("consumes execution leases with one conditional UPDATE", async () => {
    const calls: Array<{ parameters?: ReadonlyArray<unknown>; sql: string }> =
      [];
    const client: AgencySqlClient = {
      query: async (sql, parameters) => {
        calls.push({ parameters, sql });
        return { rowCount: 1, rows: [] };
      },
    };
    const store = createPostgresAgencyStore({ client });
    expect(await store.consumeLease("lease-1", 100)).toBe(true);
    expect(calls[0]?.sql).toContain("consumed_at IS NULL");
    expect(calls[0]?.parameters).toEqual(["lease-1", 100]);
  });

  test("stores only a nonce digest and atomically rejects conflicts", async () => {
    const parameters: unknown[][] = [];
    const client: AgencySqlClient = {
      query: async (_sql, values) => {
        parameters.push([...(values ?? [])]);
        return { rowCount: 1, rows: [] };
      },
    };
    const store = createPostgresHandoffReplayStore({
      client,
      now: () => 100,
    });
    expect(await store.consume("sensitive-nonce", 200)).toBe(true);
    expect(parameters[0]?.[0]).not.toBe("sensitive-nonce");
    expect(String(parameters[0]?.[0])).toHaveLength(64);
  });
});
