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
    expect(sql).toContain("agent_state.rejections");
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

  test("stores approval and rejection through one terminal decision lock", async () => {
    const calls: string[] = [];
    const client: AgencySqlClient = {
      query: async <Row>(sql: string) => {
        calls.push(sql);
        return { rowCount: 1, rows: [] as Row[] };
      },
    };
    const store = createPostgresAgencyStore({ client });
    expect(
      await store.saveApproval({
        actionId: "action-1",
        approvalId: "approval-1",
        approvedAt: 100,
        approvedBy: "operator-1",
        approvedUntil: 200,
        bindingDigest: "digest",
      }),
    ).toBe(true);
    expect(calls[0]).toContain(
      "SELECT actor_id FROM agency.actions WHERE action_id = $1 FOR UPDATE",
    );
    expect(calls[0]).toContain("NOT EXISTS");

    expect(
      await store.saveRejection({
        actionId: "action-2",
        bindingDigest: "digest",
        reason: "Unsafe target",
        rejectedAt: 101,
        rejectedBy: "operator-2",
        rejectionId: "rejection-1",
      }),
    ).toBe(true);
    expect(calls[1]).toContain(
      "INSERT INTO agency.rejections (action_id, actor_id, rejected_at, data)",
    );
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
